// Dedicated IT Administration REST Endpoints
// Protected exclusively by IT Master Key (for Admin) and requireDevice (for Agent)

const express = require('express');
const router = express.Router();
const itRelay = require('../lib/itRelay');
const { requireDevice } = require('../middleware/auth');

async function requireItMasterKey(req, res, next) {
  const masterKey = await itRelay.getMasterKey();
  const provided = req.headers['x-it-key'] || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null) || req.query.key;

  if (!masterKey || provided !== masterKey) {
    return res.status(401).json({ status: 'ERROR', message: 'Unauthorized: IT Master Key required.' });
  }
  next();
}

// GET /api/it/workstations (Admin only)
router.get('/workstations', requireItMasterKey, async (req, res) => {
  try {
    const list = await itRelay.getWorkstationsList();
    res.json({ status: 'SUCCESS', count: list.length, workstations: list });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;
