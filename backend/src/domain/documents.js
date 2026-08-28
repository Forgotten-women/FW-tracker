// Employee document vault. Spec sections 5 and 27.
//
// Documents are the most sensitive thing the system holds - passports, medical
// notes, disciplinary letters. So:
//   - files live in a gitignored private directory, NEVER web-served, and are
//     reached only through this module (spec 27: private file storage)
//   - a download needs a short-lived signed token, not a guessable path
//     (spec 27: signed/time-limited access URLs)
//   - reads are logged, not only writes (spec 27: audit of sensitive document
//     access)
//   - replacing a document adds a version; nothing is overwritten (spec 26)
//   - the confidentiality level decides which permission is needed to read it,
//     so a medical note is not reachable with the permission that opens a job
//     description

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, tx, audit, DATA_DIR } = require('../db');
const T = require('../util/time');

const STORE = path.join(DATA_DIR, 'documents');
if (!fs.existsSync(STORE)) fs.mkdirSync(STORE, { recursive: true });

const id = (p) => p + '_' + crypto.randomBytes(8).toString('hex');

// document_access_log.user_id is a foreign key into users. An actor may be a
// system or device identity with no user row, so it is stored only when it
// resolves; the action is logged regardless.
function resolveUserId(actor) {
  const raw = String(actor || '').replace(/^user:/, '');
  if (!raw) return null;
  return db.prepare('SELECT id FROM users WHERE id = ?').get(raw) ? raw : null;
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
// Upload
// ---------------------------------------------------------------------------

/**
 * Stores an uploaded file and creates (or versions) its document record.
 *
 * `file` is a multer file: { buffer, originalname, mimetype, size }. The bytes
 * are written under a random name so the path reveals nothing, and a checksum
 * is kept so corruption or tampering is detectable.
 */
function upload({
  employeeId, documentTypeId, title, file, effectiveDate = null, expiryDate = null, actor,
}) {
  const type = db.prepare('SELECT * FROM document_types WHERE id = ?').get(documentTypeId);
  if (!type) throw new Error('Unknown document type.');
  if (!file || !file.buffer) throw new Error('A file is required.');
  if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(employeeId)) throw new Error('No such employee.');
  if (type.requires_expiry && !expiryDate) {
    throw new Error(`A ${type.name} needs an expiry date.`);
  }

  const nowMs = T.now();
  const storedName = id('file') + path.extname(file.originalname || '').slice(0, 10);
  const storagePath = path.join(STORE, storedName);
  const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');

  fs.writeFileSync(storagePath, file.buffer);

  // Replacing an existing document of the same type for this employee adds a
  // version rather than a second record. A fresh type is a new document.
  let doc = db.prepare(
    'SELECT * FROM employee_documents WHERE employee_id = ? AND document_type_id = ? AND archived_at IS NULL'
  ).get(employeeId, documentTypeId);

  let documentId;
  let version;

  const run = tx(() => {
    if (doc) {
      documentId = doc.id;
      version = doc.current_version + 1;
      db.prepare(`
        UPDATE employee_documents SET current_version = ?, title = ?, effective_date = ?, expiry_date = ?
        WHERE id = ?
      `).run(version, title || doc.title, effectiveDate, expiryDate, documentId);
    } else {
      documentId = id('doc');
      version = 1;
      db.prepare(`
        INSERT INTO employee_documents
          (id, employee_id, document_type_id, title, current_version, effective_date,
           expiry_date, confidentiality, created_at, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(documentId, employeeId, documentTypeId, title || type.name, version,
             effectiveDate, expiryDate, type.confidentiality, nowMs, actor);
    }

    db.prepare(`
      INSERT INTO document_versions
        (id, document_id, version, filename, storage_path, mime_type, size_bytes, checksum, uploaded_at, uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id('dv'), documentId, version, file.originalname || storedName, storagePath,
           file.mimetype || 'application/octet-stream', file.size || file.buffer.length, checksum, nowMs, actor);

    // Documents that require acknowledgement (contracts, warnings, policies)
    // raise an outstanding acknowledgement for the employee. Spec 5.
    if (type.requires_acknowledgement) {
      db.prepare(`
        INSERT INTO document_acknowledgements (id, document_id, employee_id, requested_at)
        VALUES (?,?,?,?)
        ON CONFLICT(document_id, employee_id) DO UPDATE SET requested_at = excluded.requested_at, acknowledged_at = NULL
      `).run(id('da'), documentId, employeeId, nowMs);
    }

    audit({
      actor, action: version === 1 ? 'DOCUMENT_UPLOADED' : 'DOCUMENT_VERSIONED',
      targetType: 'document', targetId: documentId,
      after: { employeeId, type: documentTypeId, version, expiryDate },
    });
  });
  run();

  return { documentId, version, confidentiality: type.confidentiality };
}

// ---------------------------------------------------------------------------
// Listing and metadata
// ---------------------------------------------------------------------------

/**
 * Documents for an employee, filtered to those the caller may READ.
 *
 * A document the caller cannot open is not listed at all - its very existence
 * (a medical note, a disciplinary letter) is itself disclosure.
 */
function listFor(employeeId, permissions = new Set()) {
  const rows = db.prepare(`
    SELECT d.*, dt.name AS type_name, dt.requires_acknowledgement
    FROM employee_documents d
    JOIN document_types dt ON dt.id = d.document_type_id
    WHERE d.employee_id = ? AND d.archived_at IS NULL
    ORDER BY d.created_at DESC
  `).all(employeeId);

  return rows
    .filter(d => permissions.has(readPermissionFor(d.document_type_id, d.confidentiality)))
    .map(d => {
      const ack = db.prepare(
        'SELECT * FROM document_acknowledgements WHERE document_id = ? AND employee_id = ?'
      ).get(d.id, employeeId);
      return {
        id: d.id,
        type: d.type_name,
        typeId: d.document_type_id,
        title: d.title,
        version: d.current_version,
        confidentiality: d.confidentiality,
        effectiveDate: d.effective_date,
        expiryDate: d.expiry_date,
        uploadedAt: T.displayTime(d.created_at),
        acknowledgementRequired: !!ack && !ack.acknowledged_at,
        acknowledgedAt: ack?.acknowledged_at ? T.displayTime(ack.acknowledged_at) : null,
      };
    });
}

function requiredReadPermission(documentId) {
  const d = db.prepare('SELECT document_type_id, confidentiality FROM employee_documents WHERE id = ?').get(documentId);
  if (!d) return null;
  return readPermissionFor(d.document_type_id, d.confidentiality);
}

// ---------------------------------------------------------------------------
// Signed downloads (spec 27)
// ---------------------------------------------------------------------------

// Short-lived, single-use download grants. In memory and swept, like the SSE
// tickets - a document link must not be a durable, shareable URL.
const grants = new Map(); // token -> { documentId, version, expires, permission }
const GRANT_TTL_MS = 60 * 1000;

/**
 * Issues a one-minute download token for a document the caller may read.
 * Returns null if the caller lacks the permission the document requires.
 */
function issueDownloadToken({ documentId, permissions, actor, ip = null }) {
  const perm = requiredReadPermission(documentId);
  if (!perm) throw new Error('No such document.');
  if (!permissions.has(perm)) return null;

  const token = crypto.randomBytes(24).toString('hex');
  const nowMs = T.now();
  grants.set(token, { documentId, expires: nowMs + GRANT_TTL_MS });
  for (const [k, g] of grants) if (g.expires < nowMs) grants.delete(k);

  // A link being ISSUED is logged, as well as the eventual view. Spec 27.
  db.prepare(`
    INSERT INTO document_access_log (document_id, user_id, at, action, ip) VALUES (?,?,?,?,?)
  `).run(documentId, resolveUserId(actor), nowMs, 'LINK_ISSUED', ip);

  return { token, expiresInMs: GRANT_TTL_MS };
}

/**
 * Redeems a download token. Single use. Returns the file to stream, or null.
 */
function redeemDownloadToken(token, { ip = null } = {}) {
  const g = grants.get(token);
  if (!g) return null;
  grants.delete(token);
  if (g.expires < T.now()) return null;

  const version = db.prepare(`
    SELECT dv.* FROM document_versions dv
    JOIN employee_documents d ON d.id = dv.document_id
    WHERE dv.document_id = ? AND dv.version = d.current_version
  `).get(g.documentId);
  if (!version || !fs.existsSync(version.storage_path)) return null;

  db.prepare(`
    INSERT INTO document_access_log (document_id, user_id, at, action, ip) VALUES (?,?,?,?,?)
  `).run(g.documentId, null, T.now(), 'DOWNLOAD', ip);

  return {
    path: version.storage_path,
    filename: version.filename,
    mimeType: version.mime_type,
  };
}

function accessLog(documentId, limit = 100) {
  return db.prepare(
    'SELECT * FROM document_access_log WHERE document_id = ? ORDER BY at DESC LIMIT ?'
  ).all(documentId, limit).map(r => ({
    at: T.displayTime(r.at), action: r.action, by: r.user_id, ip: r.ip,
  }));
}

// ---------------------------------------------------------------------------
// Acknowledgement (employee side) and archive
// ---------------------------------------------------------------------------

function acknowledge({ documentId, employeeId, nowMs = T.now() }) {
  const ack = db.prepare(
    'SELECT * FROM document_acknowledgements WHERE document_id = ? AND employee_id = ?'
  ).get(documentId, employeeId);
  if (!ack) throw new Error('No acknowledgement is outstanding for this document.');
  if (ack.acknowledged_at) return { alreadyAcknowledged: true };

  db.prepare('UPDATE document_acknowledgements SET acknowledged_at = ? WHERE id = ?').run(nowMs, ack.id);
  audit({ actor: `employee:${employeeId}`, action: 'DOCUMENT_ACKNOWLEDGED', targetType: 'document', targetId: documentId });
  return { acknowledged: true };
}

function archive({ documentId, reason, actor }) {
  const doc = db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(documentId);
  if (!doc) throw new Error('No such document.');
  db.prepare('UPDATE employee_documents SET archived_at = ? WHERE id = ?').run(T.now(), documentId);
  audit({ actor, action: 'DOCUMENT_ARCHIVED', targetType: 'document', targetId: documentId, note: reason });
  return { archived: true };
}

module.exports = {
  upload, listFor, requiredReadPermission,
  issueDownloadToken, redeemDownloadToken, accessLog,
  acknowledge, archive, readPermissionFor, STORE,
};
