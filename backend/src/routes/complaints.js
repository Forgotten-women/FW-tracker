// Complaints & Employee Concerns API Routes.
//
// Supports confidential employee submission with attachments,
// status lifecycle updates, HR review and resolution.

const express = require('express');
const multer = require('multer');
const router = express.Router();

const {
  requireDevice,
  requireUser,
  requireUserOrAdminKey,
} = require('../middleware/auth');
const complaints = require('../domain/complaints');

// In-memory upload buffer capped to 15MB, maximum 5 files per submission
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 },
});

/**
 * Flexible middleware: Accepts either an enrolled mobile device token
 * OR a logged-in user session with an associated employee ID.
 */
function requireEmployeeAuth(req, res, next) {
  // 1. Try mobile device token first
  requireDevice(req, res, (deviceErr) => {
    if (!deviceErr && req.auth && req.auth.employeeId) {
      return next();
    }

    // 2. Try user session
    requireUser(req, res, (userErr) => {
      if (userErr) {
        return res.status(401).json({
          status: 'ERROR',
          code: 'AUTH_REQUIRED',
          message: 'Authentication required to access employee concerns.',
        });
      }

      if (!req.auth.employeeId && !req.auth.roles?.includes('super_admin') && !req.auth.roles?.includes('hr')) {
        return res.status(403).json({
          status: 'ERROR',
          message: 'No associated employee account found.',
        });
      }

      next();
    });
  });
}

// ---------------------------------------------------------------------------
// Public / Employee Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/complaints/categories
 * Returns the 11 designated complaint categories.
 */
router.get('/categories', (req, res) => {
  res.json({
    status: 'SUCCESS',
    categories: complaints.listCategories(),
    statuses: complaints.listStatuses(),
  });
});

/**
 * POST /api/complaints
 * Confidential submission of a concern or complaint.
 * Accepts multipart/form-data with 'files' or standard JSON.
 */
router.post('/', requireEmployeeAuth, upload.array('files', 5), async (req, res) => {
  try {
    const employeeId = req.auth.employeeId || req.body?.employeeId;
    if (!employeeId) {
      return res.status(400).json({ status: 'ERROR', message: 'Employee ID could not be resolved from session.' });
    }

    const { category, subject, description, priority } = req.body || {};

    const result = await complaints.submitComplaint({
      employeeId,
      category,
      subject,
      description,
      priority,
      files: req.files || [],
      actor: req.auth.actor || `employee:${employeeId}`,
    });

    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

/**
 * GET /api/complaints/mine
 * Returns only complaints submitted by the requesting employee.
 */
router.get('/mine', requireEmployeeAuth, async (req, res) => {
  try {
    const employeeId = req.auth.employeeId;
    if (!employeeId) {
      return res.status(400).json({ status: 'ERROR', message: 'No employee account linked to this session.' });
    }

    const list = await complaints.listEmployeeComplaints(employeeId);
    res.json({
      status: 'SUCCESS',
      complaints: list,
    });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// HR / Management Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/complaints
 * Lists complaints visible to authorized HR / Managers / Super Admin.
 */
router.get('/', requireUserOrAdminKey('complaint.read'), async (req, res) => {
  try {
    const list = await complaints.listAllComplaints({
      user: req.auth,
      status: req.query.status || 'ALL',
      category: req.query.category || 'ALL',
      search: req.query.search || '',
    });

    res.json({
      status: 'SUCCESS',
      count: list.length,
      complaints: list,
    });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

/**
 * GET /api/complaints/:id
 * Detailed view of a complaint. Strictly checks authorization.
 */
router.get('/:id', requireEmployeeAuth, async (req, res) => {
  try {
    const item = await complaints.getComplaintById(req.params.id, req.auth);
    if (!item) {
      return res.status(404).json({ status: 'ERROR', message: 'No such complaint.' });
    }

    res.json({
      status: 'SUCCESS',
      complaint: item,
    });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

/**
 * POST /api/complaints/:id/status
 * Updates status, HR notes, and/or resolution notes.
 */
router.post('/:id/status', requireUserOrAdminKey('complaint.write'), async (req, res) => {
  try {
    const { status, hrNotes, resolutionNotes } = req.body || {};
    const updated = await complaints.updateComplaintStatus({
      complaintId: req.params.id,
      status,
      hrNotes,
      resolutionNotes,
      actor: req.auth.actor || 'hr',
      actorName: req.auth.name || req.auth.actor,
    });

    res.json(updated);
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

/**
 * GET /api/complaints/:id/attachments/:attachmentId
 * Securely downloads or previews an attached file.
 */
router.get('/:id/attachments/:attachmentId', requireEmployeeAuth, async (req, res) => {
  try {
    const file = await complaints.getAttachmentFile(req.params.id, req.params.attachmentId, req.auth);
    if (!file || !file.buffer) {
      return res.status(404).json({ status: 'ERROR', message: 'Attachment not found or access denied.' });
    }

    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(file.fileName || 'attachment').replace(/"/g, '')}"`);
    res.setHeader('Content-Length', file.buffer.length);

    res.send(file.buffer);
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;
