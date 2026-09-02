// Desktop Workstation Agent API Routes
//
// Ingests heartbeats from the Tauri / Rust Desktop Agent on Windows & macOS.
// Tracks active work minutes, screen lock states (with 5-minute grace period),
// idle time, manual breaks, and unapproved process anomaly alerts.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { db, tx, audit } = require('../db');
const { requireDevice } = require('../middleware/auth');
const presence = require('../domain/presence');
const T = require('../util/time');
const { config } = require('../config');

function getOrgSetting(key, defaultValue) {
  try {
    const row = db.prepare('SELECT value FROM org_settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  } catch (_) {
    return defaultValue;
  }
}

// ---------------------------------------------------------------------------
// POST /api/desktop/heartbeat
// ---------------------------------------------------------------------------
router.post('/heartbeat', requireDevice, (req, res) => {
  const { employeeId, employeeName, deviceId } = req.auth;
  const {
    activeSeconds = 60,
    idleSeconds = 0,
    lockState = 'UNLOCKED', // 'LOCKED', 'UNLOCKED', 'SLEEPING'
    lockDurationSeconds = 0,
    connectedBssid = null,
    currentWifiMac = null,
    isManualBreak = false,
  } = req.body || {};

  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);
  const srcIp = req.ip || req.socket.remoteAddress || '';

  // 1. In-Office Verification
  const locationVerdict = presence.classifyLocation({
    bssid: connectedBssid,
    srcIp,
    source: 'APP',
  });
  const inOffice = locationVerdict === 'OFFICE';

  // 2. Settings
  const idleThresholdMins = parseInt(getOrgSetting('idle_threshold_minutes', '5'), 10) || 5;
  const lockGraceMins = parseInt(getOrgSetting('lock_screen_grace_minutes', '5'), 10) || 5;
  const approvedProcesses = getOrgSetting('approved_work_processes', '');

  // 3. Determine current status
  let status = 'ACTIVE';
  if (isManualBreak) {
    status = 'ON_BREAK';
  } else if (lockState === 'LOCKED' || lockState === 'SLEEPING') {
    // If locked longer than the 5-minute grace period, switch to AWAY
    if (lockDurationSeconds > (lockGraceMins * 60)) {
      status = 'AWAY';
    } else {
      status = 'ACTIVE'; // Count the first 5 minutes as active work
    }
  } else if (idleSeconds >= (idleThresholdMins * 60)) {
    status = 'IDLE';
  }

  // 4. Record presence event in central presence log if in office and active
  if (inOffice && (status === 'ACTIVE' || status === 'IDLE')) {
    try {
      presence.recordEvent({
        employeeId,
        deviceId,
        source: 'APP',
        srcIp,
        bssid: connectedBssid,
        mac: currentWifiMac,
        observedAt: nowMs,
        note: `Desktop Agent (${status})`,
      });
    } catch (_) {}
  }

  // 5. Upsert workstation session for today
  const sessionId = `ws_${employeeId}_${dateKey}`;
  const effectiveActive = (status === 'ACTIVE' && inOffice) ? Math.max(0, parseInt(activeSeconds, 10) || 0) : 0;
  const effectiveIdle = (status === 'IDLE') ? Math.max(0, parseInt(idleSeconds, 10) || 0) : 0;
  const effectiveBreak = (status === 'ON_BREAK' || status === 'AWAY') ? 60 : 0;

  try {
    const existing = db.prepare('SELECT * FROM workstation_sessions WHERE device_id = ? AND session_date = ?').get(deviceId, dateKey);
    if (existing) {
      db.prepare(`
        UPDATE workstation_sessions
        SET status = ?,
            active_seconds = active_seconds + ?,
            idle_seconds = idle_seconds + ?,
            break_seconds = break_seconds + ?,
            lock_state = ?,
            connected_bssid = ?,
            in_office = ?,
            last_heartbeat_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        status,
        effectiveActive,
        effectiveIdle,
        effectiveBreak,
        lockState,
        connectedBssid,
        inOffice ? 1 : 0,
        nowMs,
        nowMs,
        existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO workstation_sessions (
          id, device_id, employee_id, status, session_date,
          active_seconds, idle_seconds, break_seconds, lock_state,
          connected_bssid, in_office, last_heartbeat_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        deviceId,
        employeeId,
        status,
        dateKey,
        effectiveActive,
        effectiveIdle,
        effectiveBreak,
        lockState,
        connectedBssid,
        inOffice ? 1 : 0,
        nowMs,
        nowMs,
        nowMs
      );
    }
  } catch (err) {
    console.error('[desktop/heartbeat] session update error:', err);
  }

  // 6. Record Application Usage
  const appName = String(req.body?.currentApp || '').trim();
  if (appName && appName !== 'unknown.exe' && status === 'ACTIVE') {
    const appUsageId = `app_${deviceId}_${dateKey}_${crypto.createHash('md5').update(appName).digest('hex').slice(0, 8)}`;
    try {
      const existingApp = db.prepare('SELECT id, active_seconds FROM workstation_app_usage WHERE device_id = ? AND session_date = ? AND app_name = ?').get(deviceId, dateKey, appName);
      if (existingApp) {
        db.prepare(`
          UPDATE workstation_app_usage
          SET active_seconds = active_seconds + ?, last_used_at = ?
          WHERE id = ?
        `).run(parseInt(activeSeconds, 10) || 60, nowMs, existingApp.id);
      } else {
        db.prepare(`
          INSERT INTO workstation_app_usage (id, employee_id, device_id, session_date, app_name, active_seconds, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(appUsageId, employeeId, deviceId, dateKey, appName, parseInt(activeSeconds, 10) || 60, nowMs);
      }
    } catch (err) {
      console.error('[desktop/heartbeat] app_usage error:', err);
    }
  }

  // 7. Fetch updated daily summary
  const sessionRow = db.prepare('SELECT * FROM workstation_sessions WHERE device_id = ? AND session_date = ?').get(deviceId, dateKey);

  res.json({
    status: 'SUCCESS',
    workstationStatus: status,
    inOffice,
    locationVerdict,
    today: {
      dateKey,
      activeSeconds: sessionRow ? sessionRow.active_seconds : 0,
      idleSeconds: sessionRow ? sessionRow.idle_seconds : 0,
      breakSeconds: sessionRow ? sessionRow.break_seconds : 0,
    },
    policy: {
      idleThresholdMinutes: idleThresholdMins,
      lockScreenGraceMinutes: lockGraceMins,
      approvedWorkProcesses: approvedProcesses,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/desktop/break
// ---------------------------------------------------------------------------
router.post('/break', requireDevice, (req, res) => {
  const { employeeId, employeeName, deviceId } = req.auth;
  const { onBreak = true, reason = '' } = req.body || {};
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);
  const newStatus = onBreak ? 'ON_BREAK' : 'ACTIVE';

  try {
    db.prepare(`
      UPDATE workstation_sessions
      SET status = ?, updated_at = ?
      WHERE device_id = ? AND session_date = ?
    `).run(newStatus, nowMs, deviceId, dateKey);

    db.prepare('INSERT INTO movements (at, type, employee_id, employee_name, details) VALUES (?,?,?,?,?)')
      .run(nowMs, onBreak ? 'MANUAL_BREAK_STARTED' : 'MANUAL_BREAK_ENDED', employeeId, employeeName, reason || (onBreak ? 'Employee paused work session' : 'Employee resumed work session'));
  } catch (_) {}

  res.json({ status: 'SUCCESS', workstationStatus: newStatus });
});

// ---------------------------------------------------------------------------
// POST /api/desktop/anomaly
// ---------------------------------------------------------------------------
router.post('/anomaly', requireDevice, (req, res) => {
  const { employeeId, employeeName, deviceId } = req.auth;
  const { processName, windowTitle, durationSeconds = 0, notes = '' } = req.body || {};

  if (!processName) {
    return res.status(400).json({ status: 'ERROR', message: 'processName is required' });
  }

  const nowMs = T.now();
  const anomalyId = 'anom_' + crypto.randomBytes(8).toString('hex');

  try {
    db.prepare(`
      INSERT INTO process_anomalies (
        id, employee_id, device_id, process_name, window_title, duration_seconds, detected_at, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      anomalyId,
      employeeId,
      deviceId,
      String(processName).slice(0, 100),
      windowTitle ? String(windowTitle).slice(0, 200) : null,
      parseInt(durationSeconds, 10) || 0,
      nowMs,
      notes ? String(notes).slice(0, 300) : null
    );

    db.prepare('INSERT INTO movements (at, type, employee_id, employee_name, details) VALUES (?,?,?,?,?)')
      .run(nowMs, 'UNAPPROVED_PROCESS_ALERT', employeeId, employeeName, `Unapproved process "${processName}" active for ${Math.round(durationSeconds / 60)}m`);
  } catch (err) {
    console.error('[desktop/anomaly] insert error:', err);
  }

  res.status(201).json({ status: 'SUCCESS', anomalyId });
});

// ---------------------------------------------------------------------------
// GET /api/desktop/status
// ---------------------------------------------------------------------------
router.get('/status', requireDevice, (req, res) => {
  const { employeeId, employeeName, employeeRole, deviceId } = req.auth;
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);

  const sessionRow = db.prepare('SELECT * FROM workstation_sessions WHERE device_id = ? AND session_date = ?').get(deviceId, dateKey);
  const idleThresholdMins = parseInt(getOrgSetting('idle_threshold_minutes', '5'), 10) || 5;
  const lockGraceMins = parseInt(getOrgSetting('lock_screen_grace_minutes', '5'), 10) || 5;
  const approvedProcesses = getOrgSetting('approved_work_processes', '');

  res.json({
    status: 'SUCCESS',
    employee: { id: employeeId, name: employeeName, role: employeeRole },
    deviceId,
    workstation: sessionRow || {
      status: 'OFFLINE',
      active_seconds: 0,
      idle_seconds: 0,
      break_seconds: 0,
      in_office: 0,
      lock_state: 'UNLOCKED',
    },
    policy: {
      idleThresholdMinutes: idleThresholdMins,
      lockScreenGraceMinutes: lockGraceMins,
      approvedWorkProcesses: approvedProcesses,
    },
  });
});

module.exports = router;
