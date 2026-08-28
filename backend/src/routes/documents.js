// Document vault API. Spec sections 5 and 27.

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const router = express.Router();

const { db } = require('../db');
const {
  requireUserOrAdminKey, requireEmployeeAccess, requireDevice,
} = require('../middleware/auth');
const docs = require('../domain/documents');
const rbac = require('../domain/rbac');

// In memory, size-capped: the buffer is written to the private store and then
// dropped. 15 MB covers a scanned multi-page contract without inviting abuse.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

// ---------------------------------------------------------------------------
// HR / manager
// ---------------------------------------------------------------------------

router.get('/employee/:employeeId',
  requireUserOrAdminKey('document.read'), requireEmployeeAccess(),
  (req, res) => {
    res.json({
      status: 'SUCCESS',
      documents: docs.listFor(req.params.employeeId, req.auth.permissions),
    });
  });

router.post('/employee/:employeeId',
  requireUserOrAdminKey('document.write'), requireEmployeeAccess(),
  upload.single('file'),
  (req, res) => {
    if (!req.file) return res.status(400).json({ status: 'ERROR', message: 'A file is required (field name "file").' });
    try {
      const r = docs.upload({
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

// Exchanges the caller's permission for a one-minute download token, so the
// link that reaches the browser is short-lived and single-use.
router.post('/:documentId/download-token', requireUserOrAdminKey('document.read'), (req, res) => {
  const doc = db.prepare('SELECT employee_id FROM employee_documents WHERE id = ?').get(req.params.documentId);
  if (!doc) return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  if (!rbac.canAccessEmployee(req.auth, doc.employee_id)) {
    return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  }

  try {
    const grant = docs.issueDownloadToken({
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

// The actual download. The token IS the authorisation, so this route takes no
// admin key - but the token is single-use, one-minute, and was only issued to
// someone who held the permission.
router.get('/download/:token', (req, res) => {
  const file = docs.redeemDownloadToken(req.params.token, { ip: req.ip });
  if (!file) {
    return res.status(404).json({ status: 'ERROR', message: 'This download link has expired or was already used.' });
  }
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`);
  fs.createReadStream(file.path).pipe(res);
});

router.get('/:documentId/access-log', requireUserOrAdminKey('audit.read'), (req, res) => {
  res.json({ status: 'SUCCESS', log: docs.accessLog(req.params.documentId) });
});

router.post('/:documentId/archive', requireUserOrAdminKey('document.write'), (req, res) => {
  const doc = db.prepare('SELECT employee_id FROM employee_documents WHERE id = ?').get(req.params.documentId);
  if (!doc) return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  if (!rbac.canAccessEmployee(req.auth, doc.employee_id)) {
    return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  }
  try {
    docs.archive({ documentId: req.params.documentId, reason: req.body?.reason || null, actor: req.auth.actor });
    res.json({ status: 'SUCCESS' });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Employee (device token) - own documents only
// ---------------------------------------------------------------------------

router.get('/mine', requireDevice, (req, res) => {
  // An employee may see their own permitted documents. Spec 3.1.
  const permitted = new Set(['document.read', 'self.document.read']);
  res.json({ status: 'SUCCESS', documents: docs.listFor(req.auth.employeeId, permitted) });
});

router.post('/mine/:documentId/download-token', requireDevice, (req, res) => {
  const doc = db.prepare('SELECT employee_id FROM employee_documents WHERE id = ?').get(req.params.documentId);
  if (!doc || doc.employee_id !== req.auth.employeeId) {
    return res.status(404).json({ status: 'ERROR', message: 'No such document.' });
  }
  // An employee may open their own normal and sensitive documents, but not
  // their highly-confidential or medical records through the app - the same
  // filter the /mine list uses, so the two never disagree.
  const employeePermitted = new Set(['document.read', 'self.document.read']);
  const required = docs.requiredReadPermission(req.params.documentId);
  if (!employeePermitted.has(required)) {
    return res.status(403).json({ status: 'ERROR', message: 'This document is not available in the app.' });
  }
  const grant = docs.issueDownloadToken({
    documentId: req.params.documentId,
    permissions: employeePermitted,
    actor: `employee:${req.auth.employeeId}`,
    ip: req.ip,
  });
  if (!grant) return res.status(403).json({ status: 'ERROR', message: 'This document is not available to you.' });
  res.json({ status: 'SUCCESS', ...grant });
});

router.post('/mine/:documentId/acknowledge', requireDevice, (req, res) => {
  try {
    const r = docs.acknowledge({ documentId: req.params.documentId, employeeId: req.auth.employeeId });
    res.json({ status: 'SUCCESS', ...r });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;
