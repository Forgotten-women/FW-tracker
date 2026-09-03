// Employee document vault & Staff KYC Repository. Spec sections 5 and 27.
//
// Documents are the most sensitive thing the system holds - passports, medical
// notes, disciplinary letters, CVs, utility bills, and identity cards.
//
// Features:
//   - Storage is saved locally to private disk and synced to Supabase / AWS S3.
//   - Single-use, time-limited signed download tokens (1 minute TTL).
//   - Full read/write audit logging in document_access_log.
//   - Non-overwriting versioning on changes.
//   - Multi-tier confidentiality gating.
//   - Dual-channel upload & verification lifecycle (PENDING_VERIFICATION -> VERIFIED / REJECTED).
//   - KYC checklist assessment for onboarding and compliance.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, tx, audit, DATA_DIR } = require('../db');
const storage = require('./storage');
const N = require('./notifications');
const T = require('../util/time');

const STORE = path.join(DATA_DIR, 'documents');
if (!fs.existsSync(STORE)) fs.mkdirSync(STORE, { recursive: true });

const id = (p) => p + '_' + crypto.randomBytes(8).toString('hex');

// document_access_log.user_id is a foreign key into users. An actor may be a
// system or device identity with no user row, so it is stored only when it
// resolves; the action is logged regardless.
async function resolveUserId(actor) {
  const raw = String(actor || '').replace(/^user:/, '');
  if (!raw) return null;
  return await db.prepare('SELECT id FROM users WHERE id = ?').get(raw) ? raw : null;
}

// Which permission a confidentiality level requires to read.
const READ_PERMISSION = {
  normal: 'document.read',
  sensitive: 'document.read',
  highly_confidential: 'employee.identity.read',
};

// Medical documents are gated on the medical permission specifically.
function readPermissionFor(documentTypeId, confidentiality) {
  if (documentTypeId === 'medical') return 'employee.medical.read';
  return READ_PERMISSION[confidentiality] || 'document.read';
}

// ---------------------------------------------------------------------------
// Document Types
// ---------------------------------------------------------------------------

async function listDocumentTypes() {
  return await db.prepare('SELECT * FROM document_types ORDER BY name ASC').all();
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Stores an uploaded file in local disk and cloud storage (Supabase), and
 * creates (or versions) its document record.
 *
 * `file` is a multer file: { buffer, originalname, mimetype, size }.
 */
async function upload({
  employeeId,
  documentTypeId,
  title,
  file,
  effectiveDate = null,
  expiryDate = null,
  actor,
  status = null,
}) {
  const type = await db.prepare('SELECT * FROM document_types WHERE id = ?').get(documentTypeId);
  if (!type) throw new Error('Unknown document type: ' + documentTypeId);
  if (!file || !file.buffer) throw new Error('A file is required.');
  if (!await db.prepare('SELECT 1 FROM employees WHERE id = ?').get(employeeId)) {
    throw new Error('No such employee: ' + employeeId);
  }
  if (type.requires_expiry && !expiryDate) {
    throw new Error(`A ${type.name} needs an expiry date.`);
  }

  const nowMs = T.now();
  const fileExt = (file.originalname ? file.originalname.slice(file.originalname.lastIndexOf('.')) : '').slice(0, 8);
  const storedName = id('file') + (fileExt || '.dat');
  const storagePath = path.join(STORE, storedName);
  const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');

  // Always write locally to secure private disk
  fs.writeFileSync(storagePath, file.buffer);

  // If cloud storage is available, upload in cloud as well
  let storageProvider = 'local';
  if (storage.isCloudConfigured()) {
    storageProvider = 'supabase';
    const cloudKey = `${employeeId}/${storedName}`;
    storage.saveFile({
      key: cloudKey,
      buffer: file.buffer,
      mimeType: file.mimetype || 'application/octet-stream',
    }).catch(err => {
      console.warn('[documents] Background cloud sync warning:', err.message);
    });
  }

  const isEmployeeUpload = String(actor || '').startsWith('employee:');
  const initialStatus = status || (isEmployeeUpload ? 'PENDING_VERIFICATION' : 'VERIFIED');
  const verifiedBy = initialStatus === 'VERIFIED' ? actor : null;
  const verifiedAt = initialStatus === 'VERIFIED' ? nowMs : null;

  // Replacing an existing document of the same type for this employee adds a
  // version rather than a second record. A fresh type is a new document.
  let doc = await db.prepare(
    'SELECT * FROM employee_documents WHERE employee_id = ? AND document_type_id = ? AND archived_at IS NULL'
  ).get(employeeId, documentTypeId);

  let documentId;
  let version;

  await tx(async () => {
    if (doc) {
      documentId = doc.id;
      version = doc.current_version + 1;
      await db.prepare(`
        UPDATE employee_documents
        SET current_version = ?,
            title = ?,
            effective_date = ?,
            expiry_date = ?,
            verification_status = ?,
            verified_by = ?,
            verified_at = ?,
            rejection_reason = NULL,
            storage_provider = ?
        WHERE id = ?
      `).run(
        version,
        title || doc.title,
        effectiveDate,
        expiryDate,
        initialStatus,
        verifiedBy,
        verifiedAt,
        storageProvider,
        documentId
      );
    } else {
      documentId = id('doc');
      version = 1;
      await db.prepare(`
        INSERT INTO employee_documents
          (id, employee_id, document_type_id, title, current_version, effective_date,
           expiry_date, confidentiality, verification_status, verified_by, verified_at,
           storage_provider, created_at, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        documentId,
        employeeId,
        documentTypeId,
        title || type.name,
        version,
        effectiveDate,
        expiryDate,
        type.confidentiality,
        initialStatus,
        verifiedBy,
        verifiedAt,
        storageProvider,
        nowMs,
        actor
      );
    }

    await db.prepare(`
      INSERT INTO document_versions
        (id, document_id, version, filename, storage_path, mime_type, size_bytes,
         checksum, storage_provider, uploaded_at, uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id('dv'),
      documentId,
      version,
      file.originalname || storedName,
      storagePath,
      file.mimetype || 'application/octet-stream',
      file.size || file.buffer.length,
      checksum,
      storageProvider,
      nowMs,
      actor
    );

    // Documents requiring acknowledgement
    if (type.requires_acknowledgement) {
      await db.prepare(`
        INSERT INTO document_acknowledgements (id, document_id, employee_id, requested_at)
        VALUES (?,?,?,?)
        ON CONFLICT(document_id, employee_id) DO UPDATE SET requested_at = excluded.requested_at, acknowledged_at = NULL
      `).run(id('da'), documentId, employeeId, nowMs);
    }

    await audit({
      actor,
      action: version === 1 ? 'DOCUMENT_UPLOADED' : 'DOCUMENT_VERSIONED',
      targetType: 'document',
      targetId: documentId,
      after: {
        employeeId,
        type: documentTypeId,
        version,
        storageProvider,
        verificationStatus: initialStatus,
        expiryDate,
      },
    });
  });

  

  if (initialStatus === 'PENDING_VERIFICATION') {
    try {
      const emp = await db.prepare('SELECT name FROM employees WHERE id = ?').get(employeeId);
      const empName = emp?.name || employeeId;
      await N.notify({
        category: 'DOCUMENT',
        title: `Document Uploaded: ${empName}`,
        body: `${empName} uploaded ${title || type.name} for HR verification.`,
        severity: 'info',
        link: `/documents?employee=${employeeId}`,
        nowMs,
      });
    } catch (_) {}
  }

  return {
    documentId,
    version,
    verificationStatus: initialStatus,
    confidentiality: type.confidentiality,
    storageProvider,
  };
}

// ---------------------------------------------------------------------------
// Verification & Rejection
// ---------------------------------------------------------------------------

async function verifyDocument({ documentId, verifiedBy, actor }) {
  const doc = await db.prepare('SELECT * FROM employee_documents WHERE id = ? AND archived_at IS NULL').get(documentId);
  if (!doc) throw new Error('No such active document.');

  const nowMs = T.now();
  await db.prepare(`
    UPDATE employee_documents
    SET verification_status = 'VERIFIED',
        verified_by = ?,
        verified_at = ?,
        rejection_reason = NULL
    WHERE id = ?
  `).run(verifiedBy || actor, nowMs, documentId);

  await audit({
    actor,
    action: 'DOCUMENT_VERIFIED',
    targetType: 'document',
    targetId: documentId,
    after: { verifiedBy: verifiedBy || actor, verifiedAt: nowMs },
  });

  try {
    await N.notify({
      employeeId: doc.employee_id,
      category: 'DOCUMENT',
      title: 'Document Verified',
      body: `Your document "${doc.title}" has been verified by HR.`,
      severity: 'info',
      link: '/documents',
      nowMs,
    });
  } catch (_) {}

  return { status: 'SUCCESS', documentId, verificationStatus: 'VERIFIED' };
}

async function rejectDocument({ documentId, rejectionReason, rejectedBy, actor }) {
  if (!rejectionReason || !rejectionReason.trim()) {
    throw new Error('A rejection reason is required explaining what needs correction.');
  }

  const doc = await db.prepare('SELECT * FROM employee_documents WHERE id = ? AND archived_at IS NULL').get(documentId);
  if (!doc) throw new Error('No such active document.');

  const nowMs = T.now();
  await db.prepare(`
    UPDATE employee_documents
    SET verification_status = 'REJECTED',
        verified_by = ?,
        verified_at = ?,
        rejection_reason = ?
    WHERE id = ?
  `).run(rejectedBy || actor, nowMs, rejectionReason.trim(), documentId);

  await audit({
    actor,
    action: 'DOCUMENT_REJECTED',
    targetType: 'document',
    targetId: documentId,
    after: { rejectedBy: rejectedBy || actor, rejectedAt: nowMs, rejectionReason },
  });

  try {
    await N.notify({
      employeeId: doc.employee_id,
      category: 'DOCUMENT',
      title: 'Document Rejected by HR',
      body: `Your document "${doc.title}" was rejected. Reason: ${rejectionReason.trim()}`,
      severity: 'warning',
      link: '/documents',
      nowMs,
    });
  } catch (_) {}

  return { status: 'SUCCESS', documentId, verificationStatus: 'REJECTED' };
}

// ---------------------------------------------------------------------------
// Listing and KYC Checklist
// ---------------------------------------------------------------------------

async function listFor(employeeId, permissions = new Set()) {
  const rows = await db.prepare(`
    SELECT d.*, dt.name AS type_name, dt.requires_acknowledgement
    FROM employee_documents d
    JOIN document_types dt ON dt.id = d.document_type_id
    WHERE d.employee_id = ? AND d.archived_at IS NULL
    ORDER BY d.created_at DESC
  `).all(employeeId);

  return Promise.all(rows
    .filter(d => permissions.has(readPermissionFor(d.document_type_id, d.confidentiality)))
    .map(async d => {
      const ack = await db.prepare(
        'SELECT * FROM document_acknowledgements WHERE document_id = ? AND employee_id = ?'
      ).get(d.id, employeeId);

      const latestVersion = await db.prepare(
        'SELECT filename, size_bytes, mime_type, storage_provider FROM document_versions WHERE document_id = ? AND version = ?'
      ).get(d.id, d.current_version);

      return {
        id: d.id,
        type: d.type_name,
        typeId: d.document_type_id,
        title: d.title,
        version: d.current_version,
        filename: latestVersion?.filename || null,
        sizeBytes: latestVersion?.size_bytes || 0,
        mimeType: latestVersion?.mime_type || null,
        storageProvider: d.storage_provider || 'local',
        confidentiality: d.confidentiality,
        verificationStatus: d.verification_status || 'VERIFIED',
        verifiedBy: d.verified_by,
        verifiedAt: d.verified_at ? T.displayTime(d.verified_at) : null,
        rejectionReason: d.rejection_reason || null,
        effectiveDate: d.effective_date,
        expiryDate: d.expiry_date,
        uploadedAt: T.displayTime(d.created_at),
        acknowledgementRequired: !!ack && !ack.acknowledged_at,
        acknowledgedAt: ack?.acknowledged_at ? T.displayTime(ack.acknowledged_at) : null,
      };
    }));
}

async function listPendingVerification() {
  const rows = await db.prepare(`
    SELECT d.*, dt.name AS type_name, e.name AS employee_name, e.role AS employee_role,
           v.filename, v.size_bytes, v.mime_type
    FROM employee_documents d
    JOIN document_types dt ON dt.id = d.document_type_id
    JOIN employees e ON e.id = d.employee_id
    LEFT JOIN document_versions v ON v.document_id = d.id AND v.version = d.current_version
    WHERE d.verification_status = 'PENDING_VERIFICATION' AND d.archived_at IS NULL
    ORDER BY d.created_at ASC
  `).all();

  return rows.map(r => ({
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    employeeRole: r.employee_role,
    documentTypeId: r.document_type_id,
    documentTypeName: r.type_name,
    title: r.title,
    version: r.current_version,
    filename: r.filename,
    sizeBytes: r.size_bytes,
    mimeType: r.mime_type,
    storageProvider: r.storage_provider,
    effectiveDate: r.effective_date,
    expiryDate: r.expiry_date,
    uploadedAt: T.displayTime(r.created_at),
  }));
}

/**
 * Derives the complete staff KYC checklist for an employee.
 */
async function kycChecklistFor(employeeId) {
  const employee = await db.prepare('SELECT id, name, role FROM employees WHERE id = ?').get(employeeId);
  if (!employee) throw new Error('No such employee: ' + employeeId);

  const MANDATORY_REQUIREMENTS = [
    { typeId: 'cv_resume', name: 'CV / Resume', description: 'Up-to-date resume or curriculum vitae' },
    { typeId: 'nic_card', name: 'National Identity Card (CNIC)', description: 'Government ID card scan (front & back)' },
    { typeId: 'next_of_kin', name: 'Next of Kin / Emergency Contact Form', description: 'Next-of-kin verification form & ID' },
    { typeId: 'utility_bill', name: 'Home Utility Bill', description: 'Recent electricity/gas bill (within last 3 months)' },
    { typeId: 'employment_contract', name: 'Employment Contract', description: 'Signed company employment contract' },
  ];

  const OPTIONAL_REQUIREMENTS = [
    { typeId: 'education_degree', name: 'Educational Degrees & Transcripts', description: 'Highest degree / diploma certificates' },
    { typeId: 'experience_letter', name: 'Experience & Relieving Letters', description: 'Previous employer experience certificates' },
    { typeId: 'police_verification', name: 'Police Clearance Certificate', description: 'Character certificate or background check' },
  ];

  const docsMap = new Map();
  const rows = await db.prepare(`
    SELECT d.*, dt.name AS type_name, v.filename, v.size_bytes
    FROM employee_documents d
    JOIN document_types dt ON dt.id = d.document_type_id
    LEFT JOIN document_versions v ON v.document_id = d.id AND v.version = d.current_version
    WHERE d.employee_id = ? AND d.archived_at IS NULL
  `).all(employeeId);

  for (const r of rows) {
    docsMap.set(r.document_type_id, r);
  }

  function evaluateItem(req, isMandatory) {
    const doc = docsMap.get(req.typeId);
    let status = 'MISSING';
    let documentId = null;
    let filename = null;
    let rejectionReason = null;
    let expiryDate = null;
    let uploadedAt = null;

    if (doc) {
      documentId = doc.id;
      filename = doc.filename;
      status = doc.verification_status || 'VERIFIED';
      rejectionReason = doc.rejection_reason;
      expiryDate = doc.expiry_date;
      uploadedAt = T.displayTime(doc.created_at);
    }

    return {
      typeId: req.typeId,
      name: req.name,
      description: req.description,
      isMandatory,
      status, // 'VERIFIED' | 'PENDING_VERIFICATION' | 'REJECTED' | 'MISSING'
      documentId,
      filename,
      rejectionReason,
      expiryDate,
      uploadedAt,
    };
  }

  const mandatory = MANDATORY_REQUIREMENTS.map(r => evaluateItem(r, true));
  const optional = OPTIONAL_REQUIREMENTS.map(r => evaluateItem(r, false));

  const totalMandatory = mandatory.length;
  const verifiedCount = mandatory.filter(m => m.status === 'VERIFIED').length;
  const pendingCount = mandatory.filter(m => m.status === 'PENDING_VERIFICATION').length;
  const rejectedCount = mandatory.filter(m => m.status === 'REJECTED').length;
  const missingCount = mandatory.filter(m => m.status === 'MISSING').length;

  let overallKycStatus = 'INCOMPLETE';
  if (verifiedCount === totalMandatory) {
    overallKycStatus = 'COMPLETE';
  } else if (missingCount === 0) {
    overallKycStatus = 'PENDING_REVIEW';
  }

  return {
    employeeId: employee.id,
    employeeName: employee.name,
    employeeRole: employee.role,
    overallKycStatus,
    completionPercentage: Math.round((verifiedCount / totalMandatory) * 100),
    summary: {
      totalMandatory,
      verifiedCount,
      pendingCount,
      rejectedCount,
      missingCount,
    },
    mandatoryChecklist: mandatory,
    optionalChecklist: optional,
  };
}

async function requiredReadPermission(documentId) {
  const d = await db.prepare('SELECT document_type_id, confidentiality FROM employee_documents WHERE id = ?').get(documentId);
  if (!d) return null;
  return readPermissionFor(d.document_type_id, d.confidentiality);
}

// ---------------------------------------------------------------------------
// Signed Downloads (Spec 27)
// ---------------------------------------------------------------------------

const grants = new Map();
const GRANT_TTL_MS = 60 * 1000;

async function issueDownloadToken({ documentId, permissions, actor, ip = null }) {
  const perm = await requiredReadPermission(documentId);
  if (!perm) throw new Error('No such document.');
  if (!permissions.has(perm)) return null;

  const token = crypto.randomBytes(24).toString('hex');
  const nowMs = T.now();
  grants.set(token, { documentId, expires: nowMs + GRANT_TTL_MS });
  for (const [k, g] of grants) if (g.expires < nowMs) grants.delete(k);

  await db.prepare(`
    INSERT INTO document_access_log (document_id, user_id, at, action, ip) VALUES (?,?,?,?,?)
  `).run(documentId, await resolveUserId(actor), nowMs, 'LINK_ISSUED', ip);

  return { token, expiresInMs: GRANT_TTL_MS };
}

async function redeemDownloadToken(token, { ip = null } = {}) {
  const g = grants.get(token);
  if (!g) return null;
  grants.delete(token);
  if (g.expires < T.now()) return null;

  const version = await db.prepare(`
    SELECT dv.* FROM document_versions dv
    JOIN employee_documents d ON d.id = dv.document_id
    WHERE dv.document_id = ? AND dv.version = d.current_version
  `).get(g.documentId);
  if (!version) return null;

  await db.prepare(`
    INSERT INTO document_access_log (document_id, user_id, at, action, ip) VALUES (?,?,?,?,?)
  `).run(g.documentId, null, T.now(), 'DOWNLOAD', ip);

  return {
    path: version.storage_path,
    filename: version.filename,
    mimeType: version.mime_type || 'application/octet-stream',
  };
}

async function accessLog(documentId, limit = 100) {
  return (await db.prepare(
    'SELECT * FROM document_access_log WHERE document_id = ? ORDER BY at DESC LIMIT ?'
  ).all(documentId, limit)).map(r => ({
    at: T.displayTime(r.at), action: r.action, by: r.user_id, ip: r.ip,
  }));
}

// ---------------------------------------------------------------------------
// Acknowledgement and Archiving
// ---------------------------------------------------------------------------

async function acknowledge({ documentId, employeeId, nowMs = T.now() }) {
  const ack = await db.prepare(
    'SELECT * FROM document_acknowledgements WHERE document_id = ? AND employee_id = ?'
  ).get(documentId, employeeId);
  if (!ack) throw new Error('No acknowledgement is outstanding for this document.');
  if (ack.acknowledged_at) return { alreadyAcknowledged: true };

  await db.prepare('UPDATE document_acknowledgements SET acknowledged_at = ? WHERE id = ?').run(nowMs, ack.id);
  await audit({ actor: `employee:${employeeId}`, action: 'DOCUMENT_ACKNOWLEDGED', targetType: 'document', targetId: documentId });
  return { acknowledged: true };
}

async function archive({ documentId, reason, actor }) {
  const doc = await db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(documentId);
  if (!doc) throw new Error('No such document.');
  await db.prepare('UPDATE employee_documents SET archived_at = ? WHERE id = ?').run(T.now(), documentId);
  await audit({ actor, action: 'DOCUMENT_ARCHIVED', targetType: 'document', targetId: documentId, note: reason });
  return { archived: true };
}

async function deleteDocument({ documentId, actor }) {
  const doc = await db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(documentId);
  if (!doc) throw new Error('No such document.');

  const versions = await db.prepare('SELECT * FROM document_versions WHERE document_id = ?').all(documentId);
  for (const v of versions) {
    if (v.storage_path) {
      await storage.deleteFile(v.storage_path).catch(() => {});
    }
  }

  await tx(async () => {
    await db.prepare('DELETE FROM document_access_log WHERE document_id = ?').run(documentId);
    await db.prepare('DELETE FROM document_acknowledgements WHERE document_id = ?').run(documentId);
    await db.prepare('DELETE FROM document_versions WHERE document_id = ?').run(documentId);
    await db.prepare('DELETE FROM employee_documents WHERE id = ?').run(documentId);

    await audit({
      actor,
      action: 'DOCUMENT_DELETED',
      targetType: 'document',
      targetId: documentId,
      before: {
        employeeId: doc.employee_id,
        type: doc.document_type_id,
        title: doc.title,
      },
    });
  });
  
  return { deleted: true, documentId };
}

module.exports = {
  STORE,
  listDocumentTypes,
  upload,
  verifyDocument,
  rejectDocument,
  deleteDocument,
  listFor,
  listPendingVerification,
  kycChecklistFor,
  requiredReadPermission,
  issueDownloadToken,
  redeemDownloadToken,
  accessLog,
  acknowledge,
  archive,
  readPermissionFor,
};

