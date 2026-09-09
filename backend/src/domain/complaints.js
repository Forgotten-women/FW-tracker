// Confidential Complaints & Employee Concerns Engine.
//
// Handles confidential submission, document attachments, HR notification,
// lifecycle status updates, and strict access isolation.

const crypto = require('crypto');
const { db, tx, audit } = require('../db');
const storage = require('./storage');
const notifications = require('./notifications');
const rbac = require('./rbac');
const T = require('../util/time');

const COMPLAINT_CATEGORIES = [
  'Salary or payroll deductions',
  'Incorrect attendance records',
  'Leave entitlement',
  'Working hours',
  'Workplace issues',
  'Behaviour or treatment in the office',
  'Problems involving another employee',
  'Problems involving a manager',
  'Harassment, bullying, or inappropriate behaviour',
  'Health and safety concerns',
  'Any other HR or workplace-related issue',
];

const COMPLAINT_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
];

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

function generateReferenceNumber() {
  const year = new Date().getFullYear();
  const hex = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `CMP-${year}-${hex}`;
}

/**
 * Returns all approved categories.
 */
function listCategories() {
  return [...COMPLAINT_CATEGORIES];
}

/**
 * Returns all valid statuses.
 */
function listStatuses() {
  return [...COMPLAINT_STATUSES];
}

/**
 * Submits a new confidential complaint.
 */
async function submitComplaint({
  employeeId,
  category,
  subject,
  description,
  priority = 'NORMAL',
  files = [],
  actor = null,
}) {
  if (!employeeId) throw new Error('Employee ID is required.');
  if (!category || !COMPLAINT_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category. Must be one of: ${COMPLAINT_CATEGORIES.join(', ')}`);
  }
  if (!subject || !String(subject).trim()) throw new Error('Subject is required.');
  if (!description || !String(description).trim()) throw new Error('Detailed description is required.');

  const employee = await db.prepare('SELECT id, name, employee_number, role FROM employees WHERE id = ?').get(employeeId);
  if (!employee) throw new Error('Employee record not found.');

  const cleanPriority = PRIORITIES.includes(String(priority).toUpperCase())
    ? String(priority).toUpperCase()
    : 'NORMAL';

  const complaintId = 'cmp_' + crypto.randomBytes(8).toString('hex');
  const refNumber = generateReferenceNumber();
  const nowMs = T.now();

  const savedAttachments = [];

  await tx(async () => {
    // 1. Insert complaint record
    await db.prepare(`
      INSERT INTO complaints (
        id, reference_number, employee_id, category, subject, description,
        status, priority, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'SUBMITTED', ?, ?, ?)
    `).run(
      complaintId,
      refNumber,
      employeeId,
      category,
      String(subject).trim(),
      String(description).trim(),
      cleanPriority,
      nowMs,
      nowMs
    );

    // 2. Save any uploaded files
    for (const file of files) {
      if (!file || !file.buffer) continue;
      const attachmentId = 'catt_' + crypto.randomBytes(8).toString('hex');
      const safeName = (file.originalname || file.name || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
      const storageKey = `complaints/${complaintId}/${attachmentId}_${safeName}`;
      const mimeType = file.mimetype || 'application/octet-stream';

      const stored = await storage.saveFile({
        key: storageKey,
        buffer: file.buffer,
        mimeType,
      });

      await db.prepare(`
        INSERT INTO complaint_attachments (
          id, complaint_id, file_name, file_size, mime_type, storage_key, storage_provider, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attachmentId,
        complaintId,
        file.originalname || file.name || 'attachment',
        file.size || file.buffer.length,
        mimeType,
        stored.storageKey,
        stored.provider || 'local',
        nowMs
      );

      savedAttachments.push({
        id: attachmentId,
        fileName: file.originalname || file.name || 'attachment',
        fileSize: file.size || file.buffer.length,
        mimeType,
      });
    }

    // 3. Log audit event
    await audit({
      actor: actor || `employee:${employeeId}`,
      action: 'COMPLAINT_SUBMITTED',
      targetType: 'complaint',
      targetId: complaintId,
      after: { referenceNumber: refNumber, category, subject, employeeId },
    });
  });

  // 4. Automatically notify HR / Management in real-time over SSE & Notifications drawer
  try {
    await notifications.notify({
      employeeId: null, // Broadcast to all HR/Management
      userId: null,
      category: 'HR_ALERT',
      title: `Confidential Concern: ${refNumber}`,
      body: `${employee.name} (${employee.employee_number || employee.id}) submitted a confidential concern regarding "${category}".`,
      severity: 'warning',
      link: `/complaints`,
      nowMs,
    });
  } catch (err) {
    console.warn('[complaints] Failed to dispatch HR notification:', err?.message);
  }

  return {
    status: 'SUCCESS',
    id: complaintId,
    referenceNumber: refNumber,
    employeeId,
    employeeName: employee.name,
    employeeNumber: employee.employee_number || null,
    category,
    subject: String(subject).trim(),
    submittedAt: nowMs,
    submittedAtFormatted: T.displayTime(nowMs),
    complaintStatus: 'SUBMITTED',
    attachmentsCount: savedAttachments.length,
    message: `Your concern has been submitted confidentially to HR & Management. Your reference number is ${refNumber}.`,
  };
}

/**
 * Returns all complaints submitted by a given employee.
 */
async function listEmployeeComplaints(employeeId) {
  if (!employeeId) return [];

  const rows = await db.prepare(`
    SELECT c.*, e.name AS employee_name, e.employee_number
    FROM complaints c
    JOIN employees e ON e.id = c.employee_id
    WHERE c.employee_id = ?
    ORDER BY c.created_at DESC
  `).all(employeeId);

  const out = [];
  for (const r of rows) {
    const attachments = await db.prepare(`
      SELECT id, file_name, file_size, mime_type, created_at
      FROM complaint_attachments
      WHERE complaint_id = ?
      ORDER BY created_at ASC
    `).all(r.id);

    out.push({
      id: r.id,
      referenceNumber: r.reference_number,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      employeeNumber: r.employee_number || null,
      category: r.category,
      subject: r.subject,
      description: r.description,
      status: r.status,
      priority: r.priority,
      hrNotes: r.hr_notes || null,
      resolutionNotes: r.resolution_notes || null,
      resolvedAt: r.resolved_at ? Number(r.resolved_at) : null,
      resolvedAtFormatted: r.resolved_at ? T.displayTime(Number(r.resolved_at)) : null,
      resolvedBy: r.resolved_by || null,
      createdAt: Number(r.created_at),
      createdAtFormatted: T.displayTime(Number(r.created_at)),
      updatedAt: Number(r.updated_at),
      attachments: attachments.map(a => ({
        id: a.id,
        fileName: a.file_name,
        fileSize: Number(a.file_size),
        mimeType: a.mime_type,
      })),
    });
  }

  return out;
}

/**
 * Lists complaints visible to an authorized user (HR / Super Admin / Manager).
 */
async function listAllComplaints({ user, status = 'ALL', category = 'ALL', search = '' }) {
  const visibleEmployeeIds = await rbac.accessibleEmployeeIds(user);
  if (!visibleEmployeeIds || visibleEmployeeIds.length === 0) return [];

  const rows = await db.prepare(`
    SELECT c.*, e.name AS employee_name, e.employee_number, e.role AS employee_role
    FROM complaints c
    JOIN employees e ON e.id = c.employee_id
    ORDER BY c.created_at DESC
  `).all();

  const visibleSet = new Set(visibleEmployeeIds);
  const cleanSearch = String(search || '').toLowerCase().trim();

  const filtered = rows.filter(r => {
    // 1. Employee access scoping
    if (!visibleSet.has(r.employee_id)) return false;

    // 2. Status filter
    if (status && status !== 'ALL' && r.status !== status) return false;

    // 3. Category filter
    if (category && category !== 'ALL' && r.category !== category) return false;

    // 4. Search query
    if (cleanSearch) {
      const matchRef = (r.reference_number || '').toLowerCase().includes(cleanSearch);
      const matchSub = (r.subject || '').toLowerCase().includes(cleanSearch);
      const matchDesc = (r.description || '').toLowerCase().includes(cleanSearch);
      const matchEmpName = (r.employee_name || '').toLowerCase().includes(cleanSearch);
      const matchEmpNum = (r.employee_number || '').toLowerCase().includes(cleanSearch);
      if (!matchRef && !matchSub && !matchDesc && !matchEmpName && !matchEmpNum) return false;
    }

    return true;
  });

  const out = [];
  for (const r of filtered) {
    const attachments = await db.prepare(`
      SELECT id, file_name, file_size, mime_type, created_at
      FROM complaint_attachments
      WHERE complaint_id = ?
      ORDER BY created_at ASC
    `).all(r.id);

    out.push({
      id: r.id,
      referenceNumber: r.reference_number,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      employeeNumber: r.employee_number || null,
      employeeRole: r.employee_role || null,
      category: r.category,
      subject: r.subject,
      description: r.description,
      status: r.status,
      priority: r.priority,
      hrNotes: r.hr_notes || null,
      resolutionNotes: r.resolution_notes || null,
      resolvedAt: r.resolved_at ? Number(r.resolved_at) : null,
      resolvedAtFormatted: r.resolved_at ? T.displayTime(Number(r.resolved_at)) : null,
      resolvedBy: r.resolved_by || null,
      createdAt: Number(r.created_at),
      createdAtFormatted: T.displayTime(Number(r.created_at)),
      updatedAt: Number(r.updated_at),
      attachments: attachments.map(a => ({
        id: a.id,
        fileName: a.file_name,
        fileSize: Number(a.file_size),
        mimeType: a.mime_type,
      })),
    });
  }

  return out;
}

/**
 * Checks if the caller has permission to view this specific complaint.
 */
async function canAccessComplaint(auth, complaint) {
  if (!auth || !complaint) return false;

  // Device identity (mobile phone app) - can only access if it's their own complaint
  if (auth.kind === 'device') {
    return auth.employeeId && auth.employeeId === complaint.employee_id;
  }

  // Admin key - super_admin access
  if (auth.kind === 'admin') return true;

  // HR and Super Admin roles
  if (auth.roles && (auth.roles.includes('hr') || auth.roles.includes('super_admin'))) return true;

  // Employee user - can only see themselves
  if (auth.employeeId && auth.employeeId === complaint.employee_id) return true;

  // Manager - can only see assigned reports
  if (auth.roles && auth.roles.includes('manager')) {
    return await rbac.canAccessEmployee(auth, complaint.employee_id);
  }

  return false;
}

/**
 * Gets a complaint by ID with strict confidentiality enforcement.
 */
async function getComplaintById(complaintId, auth) {
  const row = await db.prepare(`
    SELECT c.*, e.name AS employee_name, e.employee_number, e.role AS employee_role
    FROM complaints c
    JOIN employees e ON e.id = c.employee_id
    WHERE c.id = ?
  `).get(complaintId);

  if (!row) return null;

  const allowed = await canAccessComplaint(auth, row);
  if (!allowed) {
    // Return null so caller issues a 404, never leaking complaint existence
    return null;
  }

  const attachments = await db.prepare(`
    SELECT id, file_name, file_size, mime_type, created_at
    FROM complaint_attachments
    WHERE complaint_id = ?
    ORDER BY created_at ASC
  `).all(complaintId);

  return {
    id: row.id,
    referenceNumber: row.reference_number,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    employeeNumber: row.employee_number || null,
    employeeRole: row.employee_role || null,
    category: row.category,
    subject: row.subject,
    description: row.description,
    status: row.status,
    priority: row.priority,
    hrNotes: row.hr_notes || null,
    resolutionNotes: row.resolution_notes || null,
    resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
    resolvedAtFormatted: row.resolved_at ? T.displayTime(Number(row.resolved_at)) : null,
    resolvedBy: row.resolved_by || null,
    createdAt: Number(row.created_at),
    createdAtFormatted: T.displayTime(Number(row.created_at)),
    updatedAt: Number(row.updated_at),
    attachments: attachments.map(a => ({
      id: a.id,
      fileName: a.file_name,
      fileSize: Number(a.file_size),
      mimeType: a.mime_type,
    })),
  };
}

/**
 * Updates complaint status, HR notes, and/or resolution details.
 */
async function updateComplaintStatus({
  complaintId,
  status,
  hrNotes,
  resolutionNotes,
  actor,
  actorName = null,
}) {
  const complaint = await db.prepare('SELECT * FROM complaints WHERE id = ?').get(complaintId);
  if (!complaint) throw new Error('Complaint not found.');

  if (status && !COMPLAINT_STATUSES.includes(status)) {
    throw new Error(`Invalid status. Must be one of: ${COMPLAINT_STATUSES.join(', ')}`);
  }

  const newStatus = status || complaint.status;
  const nowMs = T.now();
  const isResolving = (newStatus === 'RESOLVED' || newStatus === 'CLOSED') && !complaint.resolved_at;

  const resolvedAt = isResolving ? nowMs : (newStatus === 'RESOLVED' || newStatus === 'CLOSED' ? complaint.resolved_at : null);
  const resolvedBy = isResolving ? (actorName || actor) : (newStatus === 'RESOLVED' || newStatus === 'CLOSED' ? complaint.resolved_by : null);

  const updatedHrNotes = hrNotes !== undefined ? (hrNotes ? String(hrNotes).trim() : null) : complaint.hr_notes;
  const updatedResolutionNotes = resolutionNotes !== undefined ? (resolutionNotes ? String(resolutionNotes).trim() : null) : complaint.resolution_notes;

  await tx(async () => {
    await db.prepare(`
      UPDATE complaints
      SET status = ?, hr_notes = ?, resolution_notes = ?, resolved_at = ?, resolved_by = ?, updated_at = ?
      WHERE id = ?
    `).run(newStatus, updatedHrNotes, updatedResolutionNotes, resolvedAt, resolvedBy, nowMs, complaintId);

    await audit({
      actor: actor || 'hr',
      action: 'COMPLAINT_STATUS_UPDATED',
      targetType: 'complaint',
      targetId: complaintId,
      before: { status: complaint.status, hrNotes: complaint.hr_notes },
      after: { status: newStatus, hrNotes: updatedHrNotes, resolutionNotes: updatedResolutionNotes, resolvedAt, resolvedBy },
    });
  });

  // Notify the employee of the update
  try {
    await notifications.notify({
      employeeId: complaint.employee_id,
      userId: null,
      category: 'HR_ALERT',
      title: `Concern Update: ${complaint.reference_number}`,
      body: `Your concern "${complaint.subject}" has been marked as ${newStatus}.${updatedHrNotes ? ` HR Note: ${updatedHrNotes}` : ''}`,
      severity: newStatus === 'RESOLVED' ? 'info' : 'warning',
      link: '/complaints',
      nowMs,
    });
  } catch (err) {
    console.warn('[complaints] Failed to notify employee:', err?.message);
  }

  return {
    status: 'SUCCESS',
    id: complaintId,
    referenceNumber: complaint.reference_number,
    complaintStatus: newStatus,
    hrNotes: updatedHrNotes,
    resolutionNotes: updatedResolutionNotes,
    resolvedAt: resolvedAt ? Number(resolvedAt) : null,
    resolvedAtFormatted: resolvedAt ? T.displayTime(Number(resolvedAt)) : null,
    resolvedBy,
    updatedAt: nowMs,
  };
}

/**
 * Streams or downloads an attachment file.
 */
async function getAttachmentFile(complaintId, attachmentId, auth) {
  const complaint = await db.prepare('SELECT * FROM complaints WHERE id = ?').get(complaintId);
  if (!complaint) return null;

  const allowed = await canAccessComplaint(auth, complaint);
  if (!allowed) return null;

  const attachment = await db.prepare(`
    SELECT * FROM complaint_attachments WHERE id = ? AND complaint_id = ?
  `).get(attachmentId, complaintId);
  if (!attachment) return null;

  const buffer = await storage.getFileBuffer(attachment.storage_key);
  return {
    buffer,
    fileName: attachment.file_name,
    mimeType: attachment.mime_type,
    fileSize: Number(attachment.file_size),
  };
}

module.exports = {
  COMPLAINT_CATEGORIES,
  COMPLAINT_STATUSES,
  PRIORITIES,
  listCategories,
  listStatuses,
  submitComplaint,
  listEmployeeComplaints,
  listAllComplaints,
  getComplaintById,
  updateComplaintStatus,
  getAttachmentFile,
};
