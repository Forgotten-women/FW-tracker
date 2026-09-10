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
const schedule = require('../domain/schedule');
const T = require('../util/time');
const { config } = require('../config');

async function getOrgSetting(key, defaultValue) {
  try {
    const row = await db.prepare('SELECT value FROM org_settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  } catch (_) {
    return defaultValue;
  }
}

// ---------------------------------------------------------------------------
// POST /api/desktop/heartbeat
// ---------------------------------------------------------------------------
router.post('/heartbeat', requireDevice, async (req, res) => {
  const { employeeId, employeeName, deviceId } = req.auth;
  const {
    eventId = null,
    activeSeconds = 60,
    idleSeconds = 0,
    currentIdleSeconds = 0,
    lockState = 'UNLOCKED', // 'LOCKED', 'UNLOCKED', 'SLEEPING'
    lockDurationSeconds = 0,
    connectedBssid = null,
    ssid = null,
    connectedSsid = null,
    visibleOfficeBssids = [],
    currentWifiMac = null,
    localIp = null,
    isManualBreak = false,
  } = req.body || {};

  const effectiveSsid = ssid || connectedSsid || null;
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);
  const srcIp = req.ip || req.socket.remoteAddress || '';

  // 1. Idempotency Check (Guard against duplicate processing on retries/network glitches)
  if (eventId) {
    try {
      const dedupe = await db.prepare('SELECT event_id FROM desktop_heartbeat_dedupe WHERE event_id = ?').get(eventId);
      if (dedupe) {
        const sessionRow = await db.prepare('SELECT * FROM workstation_sessions WHERE device_id = ? AND session_date = ?').get(deviceId, dateKey);
        return res.json({
          status: 'SUCCESS',
          idempotentDuplicate: true,
          inOffice: sessionRow ? sessionRow.in_office === 1 : false,
          today: {
            dateKey,
            activeSeconds: sessionRow ? sessionRow.active_seconds : 0,
            unverifiedSeconds: sessionRow ? (sessionRow.unverified_seconds || 0) : 0,
            idleSeconds: sessionRow ? sessionRow.idle_seconds : 0,
            breakSeconds: sessionRow ? sessionRow.break_seconds : 0,
            onBreak: sessionRow ? sessionRow.status === 'ON_BREAK' : false,
          },
        });
      }
      await db.prepare('INSERT INTO desktop_heartbeat_dedupe (event_id, device_id, received_at) VALUES (?, ?, ?)')
        .run(eventId, deviceId, nowMs);
    } catch (_) {}
  }

  // 2. Working Hours Window & BYOD App Tracking Toggle
  const sched = await schedule.resolve(employeeId, dateKey);
  const shiftStartThreshold = (sched.scheduledStartAt || nowMs) - 15 * 60 * 1000;
  const shiftEndThreshold = (sched.scheduledEndAt || nowMs) + 15 * 60 * 1000;
  const isWithinWorkingHours = sched.isWorkingDay && (nowMs >= shiftStartThreshold && nowMs <= shiftEndThreshold);
  const outsideWorkingHours = !isWithinWorkingHours;

  const empRow = await db.prepare('SELECT app_tracking_enabled FROM employees WHERE id = ?').get(employeeId);
  const appTrackingEnabled = empRow ? (empRow.app_tracking_enabled !== 0) : true;

  // 3. In-Office Verification (Multi-Signal: Direct BSSID, Air Proximity Beacon, Office Subnet, Office SSID)
  const locationVerdict = presence.classifyLocation({
    bssid: connectedBssid,
    ssid: effectiveSsid,
    visibleOfficeBssids,
    srcIp,
    localIp,
    source: 'APP',
  });
  const inOffice = locationVerdict === 'OFFICE';

  // 4. Settings
  const idleThresholdMins = parseInt(await getOrgSetting('idle_threshold_minutes', '5'), 10) || 5;
  const lockGraceMins = parseInt(await getOrgSetting('lock_screen_grace_minutes', '5'), 10) || 5;
  const approvedProcesses = await getOrgSetting('approved_work_processes', '');

  // Check if employee has an active break in progress (e.g. from mobile app or HR)
  const activeBreak = await db.prepare(
    'SELECT * FROM break_records WHERE employee_id = ? AND ended_at IS NULL'
  ).get(employeeId);
  const breakRecordTaken = await db.prepare(
    'SELECT id FROM break_records WHERE employee_id = ? AND date_key = ? AND ended_at IS NOT NULL LIMIT 1'
  ).get(employeeId, dateKey);

  // 5. Determine current status
  let status = 'ACTIVE';
  if (outsideWorkingHours) {
    status = 'OUTSIDE_HOURS';
  } else if (activeBreak || (isManualBreak && !breakRecordTaken)) {
    status = 'ON_BREAK';
  } else if (lockState === 'LOCKED' || lockState === 'SLEEPING') {
    // If locked longer than the 5-minute grace period, switch to AWAY
    if (lockDurationSeconds > (lockGraceMins * 60)) {
      status = 'AWAY';
    } else {
      status = 'ACTIVE'; // Count the first 5 minutes as active work
    }
  } else if (currentIdleSeconds >= (idleThresholdMins * 60) || (idleSeconds >= 55 && activeSeconds <= 5)) {
    status = 'IDLE';
  }

  // 6. Retroactive Arrival Reconciliation & Presence Logging
  // If this device was actively working earlier this morning while not yet verified
  // (e.g. while Windows was still on phone hotspot), and is now confirmed IN_OFFICE:
  // backfill a presence event at the original session creation time so true arrival is credited.
  const existing = await db.prepare('SELECT * FROM workstation_sessions WHERE device_id = ? AND session_date = ?').get(deviceId, dateKey);
  let reconciledActiveSeconds = 0;

  if (inOffice && !outsideWorkingHours) {
    if (existing && (existing.in_office === 0 || (Number(existing.unverified_seconds || 0) > 0))) {
      const sessionAgeMs = nowMs - Number(existing.created_at);
      const twoHoursMs = 2 * 60 * 60 * 1000;
      if (sessionAgeMs > 60000 && sessionAgeMs <= twoHoursMs) {
        try {
          await presence.recordEvent({
            employeeId,
            deviceId,
            source: 'APP',
            srcIp,
            localIp,
            bssid: connectedBssid,
            ssid: effectiveSsid,
            visibleOfficeBssids,
            mac: currentWifiMac,
            observedAt: Number(existing.created_at),
            note: 'Desktop Agent (Arrival Reconciled)',
          });
        } catch (_) {}
      }
      reconciledActiveSeconds = Number(existing.unverified_seconds || 0);
    }

    if (status === 'ACTIVE' || status === 'IDLE') {
      try {
        await presence.recordEvent({
          employeeId,
          deviceId,
          source: 'APP',
          srcIp,
          localIp,
          bssid: connectedBssid,
          ssid: effectiveSsid,
          visibleOfficeBssids,
          mac: currentWifiMac,
          observedAt: nowMs,
          note: `Desktop Agent (${status})`,
        });
        await presence.recomputeDay(employeeId, dateKey, nowMs);
      } catch (_) {}
    }
  }

  // 7. Upsert workstation session for today
  const sessionId = `ws_${deviceId}_${dateKey}_${crypto.randomUUID().slice(0, 8)}`;
  const numActive = Math.max(0, parseInt(activeSeconds, 10) || 0);
  const numIdle = Math.max(0, parseInt(idleSeconds, 10) || 0);
  const batchTotal = (numActive + numIdle) > 0 ? (numActive + numIdle) : 60;

  let effectiveActive = 0;
  let effectiveIdle = 0;
  let effectiveBreak = 0;
  let addUnverified = 0;

  if (outsideWorkingHours) {
    // Outside working hours: do not credit shift worked minutes
    effectiveActive = 0;
    effectiveIdle = 0;
    effectiveBreak = 0;
  } else if (status === 'ON_BREAK') {
    effectiveBreak = batchTotal;
  } else if (status === 'AWAY' || status === 'IDLE') {
    effectiveIdle = batchTotal;
  } else {
    // ACTIVE
    if (inOffice) {
      effectiveActive = numActive + reconciledActiveSeconds;
      addUnverified = 0;
    } else {
      // Not verified in office yet: preserve work in unverified_seconds rather than permanently losing it
      effectiveActive = 0;
      addUnverified = numActive;
    }
    effectiveIdle = numIdle;
  }

  try {
    if (existing) {
      await db.prepare(`
        UPDATE workstation_sessions
        SET status = ?,
            active_seconds = active_seconds + ?,
            idle_seconds = idle_seconds + ?,
            break_seconds = break_seconds + ?,
            unverified_seconds = CASE WHEN ? = 1 THEN 0 ELSE COALESCE(unverified_seconds, 0) + ? END,
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
        inOffice ? 1 : 0,
        addUnverified,
        lockState,
        connectedBssid,
        inOffice ? 1 : 0,
        nowMs,
        nowMs,
        existing.id
      );
    } else {
      await db.prepare(`
        INSERT INTO workstation_sessions (
          id, device_id, employee_id, status, session_date,
          active_seconds, idle_seconds, break_seconds, unverified_seconds, lock_state,
          connected_bssid, in_office, last_heartbeat_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        deviceId,
        employeeId,
        status,
        dateKey,
        effectiveActive,
        effectiveIdle,
        effectiveBreak,
        addUnverified,
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

  // 8. Record Application Usage (Only when in office, active, within working hours, and app tracking is enabled)
  const entries = [];
  if (inOffice && status === 'ACTIVE' && isWithinWorkingHours && appTrackingEnabled) {
    const appBreakdown = req.body?.appBreakdown;
    let hasBreakdownEntries = false;
    if (appBreakdown && typeof appBreakdown === 'object') {
      for (const [name, secs] of Object.entries(appBreakdown)) {
        const trimmed = String(name || '').trim();
        const s = parseInt(secs, 10) || 0;
        if (trimmed && trimmed !== 'unknown.exe' && s > 0) {
          entries.push({ name: trimmed, seconds: s });
          hasBreakdownEntries = true;
        }
      }
    }
    if (!hasBreakdownEntries) {
      const singleApp = String(req.body?.currentApp || '').trim();
      if (singleApp && singleApp !== 'unknown.exe') {
        entries.push({ name: singleApp, seconds: effectiveActive || 60 });
      } else if (effectiveActive > 0) {
        entries.push({ name: 'Desktop Active', seconds: effectiveActive });
      }
    }
  }

  for (const entry of entries) {
    const appUsageId = `app_${deviceId}_${dateKey}_${crypto.createHash('md5').update(entry.name).digest('hex').slice(0, 8)}`;
    try {
      const existingApp = await db.prepare('SELECT id, active_seconds FROM workstation_app_usage WHERE device_id = ? AND session_date = ? AND app_name = ?').get(deviceId, dateKey, entry.name);
      if (existingApp) {
        await db.prepare(`
          UPDATE workstation_app_usage
          SET active_seconds = active_seconds + ?, last_used_at = ?
          WHERE id = ?
        `).run(entry.seconds, nowMs, existingApp.id);
      } else {
        await db.prepare(`
          INSERT INTO workstation_app_usage (id, employee_id, device_id, session_date, app_name, active_seconds, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(appUsageId, employeeId, deviceId, dateKey, entry.name, entry.seconds, nowMs);
      }
    } catch (err) {
      console.error('[desktop/heartbeat] app_usage error:', err);
    }
  }

  // 9. Fetch updated daily summary and sync break records
  const sessionRow = await db.prepare('SELECT * FROM workstation_sessions WHERE device_id = ? AND session_date = ?').get(deviceId, dateKey);

  const breakRecords = await db.prepare(`
    SELECT * FROM break_records WHERE employee_id = ? AND date_key = ? ORDER BY started_at ASC
  `).all(employeeId, dateKey);

  let totalBreakSecondsFromRecords = 0;
  let hasOpenBreak = false;
  let breakAlreadyTaken = false;

  for (const br of breakRecords) {
    if (br.ended_at) {
      const mins = br.actual_minutes != null ? br.actual_minutes : Math.round((br.ended_at - br.started_at) / 60000);
      totalBreakSecondsFromRecords += (mins * 60);
      breakAlreadyTaken = true;
    } else {
      hasOpenBreak = true;
      const elapsedSecs = Math.max(0, Math.round((nowMs - br.started_at) / 1000));
      totalBreakSecondsFromRecords += elapsedSecs;
    }
  }

  const effectiveBreakSeconds = Math.max(sessionRow ? (sessionRow.break_seconds || 0) : 0, totalBreakSecondsFromRecords);

  if (sessionRow && (sessionRow.break_seconds || 0) < effectiveBreakSeconds) {
    try {
      await db.prepare('UPDATE workstation_sessions SET break_seconds = ? WHERE id = ?').run(effectiveBreakSeconds, sessionRow.id);
    } catch (_) {}
  }

  res.json({
    status: 'SUCCESS',
    workstationStatus: status,
    inOffice,
    locationVerdict,
    appTrackingEnabled,
    outsideWorkingHours,
    shiftWindow: {
      isWorkingDay: sched.isWorkingDay,
      startTime: sched.startTime,
      endTime: sched.endTime,
    },
    today: {
      dateKey,
      activeSeconds: sessionRow ? sessionRow.active_seconds : 0,
      unverifiedSeconds: sessionRow ? (sessionRow.unverified_seconds || 0) : 0,
      idleSeconds: sessionRow ? sessionRow.idle_seconds : 0,
      breakSeconds: effectiveBreakSeconds,
      onBreak: Boolean(hasOpenBreak),
      breakAlreadyTaken: breakAlreadyTaken && !hasOpenBreak,
    },
    policy: {
      idleThresholdMinutes: idleThresholdMins,
      lockScreenGraceMinutes: lockGraceMins,
      approvedWorkProcesses: approvedProcesses,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/desktop/sync-batch
// Flushes offline-queued heartbeats chronologically with idempotency protection
// ---------------------------------------------------------------------------
router.post('/sync-batch', requireDevice, async (req, res) => {
  const { employeeId, employeeName, deviceId } = req.auth;
  const { events = [] } = req.body || {};

  if (!Array.isArray(events) || events.length === 0) {
    return res.json({ status: 'SUCCESS', syncedEventIds: [] });
  }

  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);
  const srcIp = req.ip || req.socket.remoteAddress || '';
  const sched = await schedule.resolve(employeeId, dateKey);

  const syncedEventIds = [];
  let dayNeedsRecompute = false;

  // Sort events chronologically to preserve accurate playback
  const sortedEvents = [...events].sort(
    (a, b) => (Number(a.observedAt || a.createdAt || a.created_at || 0) - Number(b.observedAt || b.createdAt || b.created_at || 0))
  );

  for (const evt of sortedEvents) {
    const eventId = evt.eventId || evt.event_id;
    if (eventId) {
      const dedupe = await db.prepare('SELECT event_id FROM desktop_heartbeat_dedupe WHERE event_id = ?').get(eventId);
      if (dedupe) {
        syncedEventIds.push(eventId);
        continue;
      }
      try {
        await db.prepare('INSERT INTO desktop_heartbeat_dedupe (event_id, device_id, received_at) VALUES (?, ?, ?)')
          .run(eventId, deviceId, nowMs);
      } catch (_) {}
    }

    const evtObserved = Number(evt.observedAt || evt.createdAt || evt.created_at || nowMs);
    const evtDateKey = T.dateKey(evtObserved);
    const effectiveSsid = evt.ssid || evt.connectedSsid || null;

    // Verify location based on BSSID, SSID, and over-the-air beacon snapshot stored in the offline payload
    const locationVerdict = presence.classifyLocation({
      bssid: evt.connectedBssid,
      ssid: effectiveSsid,
      visibleOfficeBssids: evt.visibleOfficeBssids || [],
      srcIp,
      localIp: evt.localIp,
      source: 'APP',
    });
    const inOffice = locationVerdict === 'OFFICE';

    const numActive = Math.max(0, parseInt(evt.activeSeconds || evt.active_seconds, 10) || 0);
    const numIdle = Math.max(0, parseInt(evt.idleSeconds || evt.idle_seconds, 10) || 0);

    const shiftStart = (sched.scheduledStartAt || nowMs) - 15 * 60 * 1000;
    const shiftEnd = (sched.scheduledEndAt || nowMs) + 15 * 60 * 1000;
    const isWithinHours = sched.isWorkingDay && (evtObserved >= shiftStart && evtObserved <= shiftEnd);

    let effectiveActive = 0;
    let addUnverified = 0;

    if (inOffice && isWithinHours) {
      effectiveActive = numActive;
      try {
        await presence.recordEvent({
          employeeId,
          deviceId,
          source: 'APP',
          srcIp,
          localIp: evt.localIp,
          bssid: evt.connectedBssid,
          ssid: effectiveSsid,
          visibleOfficeBssids: evt.visibleOfficeBssids || [],
          observedAt: evtObserved,
          note: 'Desktop Agent (Offline Synced)',
        });
        dayNeedsRecompute = true;
      } catch (_) {}
    } else if (!inOffice && isWithinHours) {
      addUnverified = numActive;
    }

    const existing = await db.prepare('SELECT * FROM workstation_sessions WHERE device_id = ? AND session_date = ?').get(deviceId, evtDateKey);
    if (existing) {
      await db.prepare(`
        UPDATE workstation_sessions
        SET active_seconds = active_seconds + ?,
            idle_seconds = idle_seconds + ?,
            unverified_seconds = CASE WHEN ? = 1 THEN 0 ELSE COALESCE(unverified_seconds, 0) + ? END,
            last_heartbeat_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(effectiveActive, numIdle, inOffice ? 1 : 0, addUnverified, nowMs, nowMs, existing.id);
    } else {
      const sessionId = `ws_${deviceId}_${evtDateKey}_${crypto.randomUUID().slice(0, 8)}`;
      await db.prepare(`
        INSERT INTO workstation_sessions (
          id, device_id, employee_id, status, session_date,
          active_seconds, idle_seconds, break_seconds, unverified_seconds, lock_state,
          connected_bssid, in_office, last_heartbeat_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId, deviceId, employeeId, 'ACTIVE', evtDateKey,
        effectiveActive, numIdle, 0, addUnverified, 'UNLOCKED',
        evt.connectedBssid, inOffice ? 1 : 0, nowMs, evtObserved, nowMs
      );
    }

    if (eventId) syncedEventIds.push(eventId);
  }

  if (dayNeedsRecompute) {
    try {
      await presence.recomputeDay(employeeId, dateKey, nowMs);
    } catch (_) {}
  }

  const sessionRow = await db.prepare('SELECT * FROM workstation_sessions WHERE device_id = ? AND session_date = ?').get(deviceId, dateKey);
  const emp = await db.prepare('SELECT app_tracking_enabled FROM employees WHERE id = ?').get(employeeId);
  const appTrackingEnabled = emp ? emp.app_tracking_enabled !== 0 : true;

  const shiftStart = (sched.scheduledStartAt || nowMs) - 15 * 60 * 1000;
  const shiftEnd = (sched.scheduledEndAt || nowMs) + 15 * 60 * 1000;
  const isWithinWorkingHours = sched.isWorkingDay && (nowMs >= shiftStart && nowMs <= shiftEnd);
  const outsideWorkingHours = !isWithinWorkingHours;

  res.json({
    status: 'SUCCESS',
    syncedEventIds,
    count: syncedEventIds.length,
    appTrackingEnabled,
    outsideWorkingHours,
    today: {
      dateKey,
      activeSeconds: sessionRow ? sessionRow.active_seconds : 0,
      unverifiedSeconds: sessionRow ? (sessionRow.unverified_seconds || 0) : 0,
      idleSeconds: sessionRow ? sessionRow.idle_seconds : 0,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/desktop/break
// ---------------------------------------------------------------------------
router.post('/break', requireDevice, async (req, res) => {
  const { employeeId, employeeName, deviceId } = req.auth;
  const { onBreak = true, reason = '' } = req.body || {};
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);
  const newStatus = onBreak ? 'ON_BREAK' : 'ACTIVE';

  const A = require('../domain/attendance');
  try {
    if (onBreak) {
      const result = await A.startBreak(employeeId, nowMs);
      if (!result.ok) {
        return res.status(400).json({
          status: 'ERROR',
          code: result.reason,
          message: result.message || 'You have already taken your permitted 30-minute break for today. Only one break is permitted per working day.',
        });
      }
    } else {
      const result = await A.endBreak(employeeId, nowMs);
      if (!result.ok && result.reason !== 'NOT_ON_BREAK') {
        return res.status(400).json({
          status: 'ERROR',
          code: result.reason,
          message: 'Could not resume work.',
        });
      }
    }
    await A.recomputeDay(employeeId, dateKey, nowMs);

    await db.prepare(`
      UPDATE workstation_sessions
      SET status = ?, updated_at = ?
      WHERE employee_id = ? AND session_date = ?
    `).run(newStatus, nowMs, employeeId, dateKey);

    await db.prepare('INSERT INTO movements (at, type, employee_id, employee_name, details) VALUES (?,?,?,?,?)')
      .run(nowMs, onBreak ? 'MANUAL_BREAK_STARTED' : 'MANUAL_BREAK_ENDED', employeeId, employeeName, reason || (onBreak ? 'Employee paused work session' : 'Employee resumed work session'));
  } catch (err) {
    console.warn('[desktop/break] break state sync note:', err.message);
    return res.status(500).json({ status: 'ERROR', message: err.message });
  }

  res.json({ status: 'SUCCESS', workstationStatus: newStatus });
});

// ---------------------------------------------------------------------------
// POST /api/desktop/anomaly
// ---------------------------------------------------------------------------
router.post('/anomaly', requireDevice, async (req, res) => {
  const { employeeId, employeeName, deviceId } = req.auth;
  const { processName, windowTitle, durationSeconds = 0, notes = '' } = req.body || {};

  if (!processName) {
    return res.status(400).json({ status: 'ERROR', message: 'processName is required' });
  }

  const nowMs = T.now();
  const anomalyId = 'anom_' + crypto.randomBytes(8).toString('hex');

  try {
    await db.prepare(`
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

    await db.prepare('INSERT INTO movements (at, type, employee_id, employee_name, details) VALUES (?,?,?,?,?)')
      .run(nowMs, 'UNAPPROVED_PROCESS_ALERT', employeeId, employeeName, `Unapproved process "${processName}" active for ${Math.round(durationSeconds / 60)}m`);
  } catch (err) {
    console.error('[desktop/anomaly] insert error:', err);
  }

  res.status(201).json({ status: 'SUCCESS', anomalyId });
});

// ---------------------------------------------------------------------------
// GET /api/desktop/status
// ---------------------------------------------------------------------------
router.get('/status', requireDevice, async (req, res) => {
  const { employeeId, employeeName, employeeRole, deviceId } = req.auth;
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);

  const sessionRow = await db.prepare('SELECT * FROM workstation_sessions WHERE device_id = ? AND session_date = ?').get(deviceId, dateKey);
  const idleThresholdMins = parseInt(await getOrgSetting('idle_threshold_minutes', '5'), 10) || 5;
  const lockGraceMins = parseInt(await getOrgSetting('lock_screen_grace_minutes', '5'), 10) || 5;
  const approvedProcesses = await getOrgSetting('approved_work_processes', '');

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
