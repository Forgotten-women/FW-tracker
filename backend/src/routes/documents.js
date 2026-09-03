const express = require('express');
const multer = require('multer');
const fs = require('fs');
const router = express.Router();

const { db } = require('../db');
const {
  requireUserOrAdminKey, requireEmployeeAccess, requireDevice,
} = require('../middleware/auth');
const docs = require('../domain/documents');
const storage = require('../domain/storage');
const rbac = require('../domain/rbac');

// In memory, size-capped to 15 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

// ---------------------------------------------------------------------------
// Document Types
// ---------------------------------------------------------------------------

router.get('/types', async (req, res) => {
  res.json({
    status: 'SUCCESS',
    types: await docs.listDocumentTypes(),
  });
});

// ---------------------------------------------------------------------------
// HR / Admin Management & Verification Queue
// ---------------------------------------------------------------------------

router.get('/pending-verification', requireUserOrAdminKey('document.read'), async (req, res) => {
  res.json({
    status: 'SUCCESS',
    pendingDocuments: await docs.listPendingVerification(),
  });
});

router.post('/:documentId/verify', requireUserOrAdminKey('document.write'), async (req, res) => {
  try {
    const result = await docs.verifyDocument({
      documentId: req.params.documentId,
      verifiedBy: req.auth.actor,
      actor: req.auth.actor,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/:documentId/reject', requireUserOrAdminKey('document.write'), async (req, res) => {
  try {
    const result = await docs.rejectDocument({
      documentId: req.params.documentId,
      rejectionReason: req.body?.reason || req.body?.rejectionReason,
      rejectedBy: req.auth.actor,
      actor: req.auth.actor,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.get('/employee/:employeeId/kyc-checklist',
  requireUserOrAdminKey('document.read'), requireEmployeeAccess(),
  async (req, res) => {
    try {
      const checklist = await docs.kycChecklistFor(req.params.employeeId);
      res.json({ status: 'SUCCESS', ...checklist });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

router.get('/employee/:employeeId',
  requireUserOrAdminKey('document.read'), requireEmployeeAccess(),
  async (req, res) => {
    res.json({
      status: 'SUCCESS',
      documents: await docs.listFor(req.params.employeeId, req.auth.permissions),
    });
  });

router.post('/employee/:employeeId',
  requireUserOrAdminKey('document.write'), requireEmployeeAccess(),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ status: 'ERROR', message: 'A file is required (field name "file").' });
    try {
      const r = await docs.upload({
        employeeId: req.params.employeeId,
        documentTypeId: req.body?.documentTypeId,
        title: req.body?.title,
        effectiveDate: req.body?.effectiveDate || null,
        expiryDate: req.body?.expiryDate || null,
        file: req.file,
        actor: req.auth.actor,
      });
      res.status(201).json({ status: 'SUCCESS', ...r });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

// Exchanges the caller's permission for a one-minute download token
router.post('/:documentId/download-token', requireUserOrAdminKey('document.read'), async (req, res) => {
  const doc = await db.prepare('SELECT employee_id FROM employee_documents WHERE id = ?').get(req.params.documentId);
  if (!doc) return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  if (!await rbac.canAccessEmployee(req.auth, doc.employee_id)) {
    return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  }

  try {
    const grant = await docs.issueDownloadToken({
      documentId: req.params.documentId,
      permissions: req.auth.permissions,
      actor: req.auth.actor,
      ip: req.ip,
    });
    if (!grant) {
      return res.status(403).json({
        status: 'ERROR',
        message: 'You do not have permission to open this document.',
      });
    }
    res.json({ status: 'SUCCESS', ...grant });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// The actual download via token
router.get('/download/:token', async (req, res) => {
  const file = await docs.redeemDownloadToken(req.params.token, { ip: req.ip });
  if (!file) {
    return res.status(404).json({ status: 'ERROR', message: 'This download link has expired or was already used.' });
  }

  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(file.filename || 'document').replace(/"/g, '')}"`);

  if (file.path && fs.existsSync(file.path)) {
    return fs.createReadStream(file.path).pipe(res);
  }

  try {
    const buf = await storage.getFileBuffer(file.path);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (err) {
    res.status(404).json({ status: 'ERROR', message: 'File not found in storage.' });
  }
});

router.get('/:documentId/access-log', requireUserOrAdminKey('audit.read'), async (req, res) => {
  res.json({ status: 'SUCCESS', log: await docs.accessLog(req.params.documentId) });
});

router.delete('/:documentId', requireUserOrAdminKey('document.write'), async (req, res) => {
  const doc = await db.prepare('SELECT employee_id FROM employee_documents WHERE id = ?').get(req.params.documentId);
  if (!doc) return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  if (!await rbac.canAccessEmployee(req.auth, doc.employee_id)) {
    return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  }
  try {
    const result = await docs.deleteDocument({ documentId: req.params.documentId, actor: req.auth.actor });
    res.json({ status: 'SUCCESS', ...result });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/:documentId/delete', requireUserOrAdminKey('document.write'), async (req, res) => {
  const doc = await db.prepare('SELECT employee_id FROM employee_documents WHERE id = ?').get(req.params.documentId);
  if (!doc) return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  if (!await rbac.canAccessEmployee(req.auth, doc.employee_id)) {
    return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  }
  try {
    const result = await docs.deleteDocument({ documentId: req.params.documentId, actor: req.auth.actor });
    res.json({ status: 'SUCCESS', ...result });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/:documentId/archive', requireUserOrAdminKey('document.write'), async (req, res) => {
  const doc = await db.prepare('SELECT employee_id FROM employee_documents WHERE id = ?').get(req.params.documentId);
  if (!doc) return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  if (!await rbac.canAccessEmployee(req.auth, doc.employee_id)) {
    return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  }
  try {
    await docs.archive({ documentId: req.params.documentId, reason: req.body?.reason || null, actor: req.auth.actor });
    res.json({ status: 'SUCCESS' });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Employee Mobile App (Device Token)
// ---------------------------------------------------------------------------

router.get('/mine/kyc-checklist', requireDevice, async (req, res) => {
  try {
    const checklist = await docs.kycChecklistFor(req.auth.employeeId);
    res.json({ status: 'SUCCESS', ...checklist });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/mine/upload', requireDevice, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ status: 'ERROR', message: 'A file is required (field name "file").' });
  }
  try {
    const r = await docs.upload({
      employeeId: req.auth.employeeId,
      documentTypeId: req.body?.documentTypeId,
      title: req.body?.title,
      effectiveDate: req.body?.effectiveDate || null,
      expiryDate: req.body?.expiryDate || null,
      file: req.file,
      actor: `employee:${req.auth.employeeId}`,
      status: 'PENDING_VERIFICATION',
    });
    res.status(201).json({ status: 'SUCCESS', ...r });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/mine/request-update', requireDevice, async (req, res) => {
  const { documentTypeId, documentName, reason } = req.body || {};
  if (!reason || !reason.trim()) {
    return res.status(400).json({ status: 'ERROR', message: 'A reason or description for the update is required.' });
  }
  const employee = await db.prepare('SELECT name, role FROM employees WHERE id = ?').get(req.auth.employeeId);
  const employeeName = employee ? employee.name : 'An employee';

  try {
    const notif = require('../domain/notifications');
    notif.send({
      type: 'DOCUMENT_UPDATE_REQUEST',
      title: 'Document Update Requested',
      body: `${employeeName} requested an update for ${documentName || 'a personnel document'}: "${reason}"`,
      targetRole: 'hr',
      metadata: {
        employeeId: req.auth.employeeId,
        employeeName,
        documentTypeId,
        documentName,
        reason,
      },
    });
  } catch (_) {}

  res.status(201).json({
    status: 'SUCCESS',
    message: 'Your document update request has been submitted to HR for review and processing.',
  });
});

router.get('/mine', requireDevice, async (req, res) => {
  const permitted = new Set(['document.read', 'self.document.read']);
  res.json({ status: 'SUCCESS', documents: await docs.listFor(req.auth.employeeId, permitted) });
});

router.post('/mine/:documentId/download-token', requireDevice, async (req, res) => {
  const doc = await db.prepare('SELECT employee_id FROM employee_documents WHERE id = ?').get(req.params.documentId);
  if (!doc || doc.employee_id !== req.auth.employeeId) {
    return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  }
  const employeePermitted = new Set(['document.read', 'self.document.read']);
  const required = await docs.requiredReadPermission(req.params.documentId);
  if (!employeePermitted.has(required)) {
    return res.status(403).json({ status: 'ERROR', message: 'This document is not available in the app.' });
  }
  const grant = await docs.issueDownloadToken({
    documentId: req.params.documentId,
    permissions: employeePermitted,
    actor: `employee:${req.auth.employeeId}`,
    ip: req.ip,
  });
  if (!grant) return res.status(403).json({ status: 'ERROR', message: 'This document is not available to you.' });
  res.json({ status: 'SUCCESS', ...grant });
});

router.post('/mine/:documentId/acknowledge', requireDevice, async (req, res) => {
  try {
    const r = await docs.acknowledge({ documentId: req.params.documentId, employeeId: req.auth.employeeId });
    res.json({ status: 'SUCCESS', ...r });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.delete('/mine/:documentId', requireDevice, async (req, res) => {
  const doc = await db.prepare('SELECT employee_id FROM employee_documents WHERE id = ?').get(req.params.documentId);
  if (!doc || doc.employee_id !== req.auth.employeeId) {
    return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  }
  try {
    const result = await docs.deleteDocument({ documentId: req.params.documentId, actor: `employee:${req.auth.employeeId}` });
    res.json({ status: 'SUCCESS', ...result });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/mine/:documentId/delete', requireDevice, async (req, res) => {
  const doc = await db.prepare('SELECT employee_id FROM employee_documents WHERE id = ?').get(req.params.documentId);
  if (!doc || doc.employee_id !== req.auth.employeeId) {
    return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  }
  try {
    const result = await docs.deleteDocument({ documentId: req.params.documentId, actor: `employee:${req.auth.employeeId}` });
    res.json({ status: 'SUCCESS', ...result });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;
