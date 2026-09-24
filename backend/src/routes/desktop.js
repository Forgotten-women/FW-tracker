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
const attendance = require('../domain/attendance');
const schedule = require('../domain/schedule');
const T = require('../util/time');
const { config } = require('../config');
const liveFrame = require('../lib/liveFrame');
const liveDoorbell = require('../lib/liveDoorbell');
const liveView = require('../domain/liveView');

async function getOrgSetting(key, defaultValue) {
  try {
    const row = await db.prepare('SELECT value FROM org_settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  } catch (_) {
    return defaultValue;
  }
}

let liveStreamTableEnsured = false;
async function ensureLiveStreamTable() {
  if (liveStreamTableEnsured) return;
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS workstation_live_streams (
        device_id           TEXT PRIMARY KEY,
        employee_id         TEXT NOT NULL,
        requested_at        BIGINT NOT NULL,
        last_frame_at       BIGINT,
        frame_base64        TEXT,
        status              TEXT NOT NULL DEFAULT 'ACTIVE',
        updated_at          BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_live_stream_updated ON workstation_live_streams (updated_at);
      CREATE INDEX IF NOT EXISTS idx_live_stream_requested ON workstation_live_streams (requested_at);
    `);
    liveStreamTableEnsured = true;
  } catch (err) {
    liveStreamTableEnsured = true;
  }
}

let screenshotsTableEnsured = false;
async function ensureScreenshotsTable() {
  if (screenshotsTableEnsured) return;
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS workstation_screenshots (
        id                  TEXT PRIMARY KEY,
        employee_id         TEXT NOT NULL,
        device_id           TEXT NOT NULL,
        date_key            TEXT NOT NULL,
        captured_at         BIGINT NOT NULL,
        storage_path        TEXT NOT NULL,
        file_size_bytes     BIGINT NOT NULL DEFAULT 0,
        mime_type           TEXT NOT NULL DEFAULT 'image/jpeg',
        active_app          TEXT,
        window_title        TEXT,
        capture_status      TEXT NOT NULL DEFAULT 'SUCCESS',
        created_at          BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ws_shots_emp_date ON workstation_screenshots (employee_id, date_key);
      CREATE INDEX IF NOT EXISTS idx_ws_shots_captured ON workstation_screenshots (captured_at);
    `);

    // Ensure employee columns exist
    try {
      await db.exec(`
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS screenshot_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS screenshot_interval_minutes INTEGER NOT NULL DEFAULT 5;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS screenshot_mode TEXT NOT NULL DEFAULT 'ACTIVE_ONLY';
      `);
    } catch (_) {}

    screenshotsTableEnsured = true;
  } catch (err) {
    screenshotsTableEnsured = true;
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

  const empRow = await db.prepare('SELECT app_tracking_enabled, screenshot_enabled, screenshot_interval_minutes, screenshot_mode FROM employees WHERE id = ?').get(employeeId);
  const appTrackingEnabled = empRow ? (empRow.app_tracking_enabled !== 0) : true;
  const screenshotEnabled = empRow ? (empRow.screenshot_enabled === 1) : false;
  const screenshotIntervalMinutes = empRow ? (parseInt(empRow.screenshot_interval_minutes, 10) || 5) : 5;
  const screenshotMode = empRow ? (empRow.screenshot_mode || 'ACTIVE_ONLY') : 'ACTIVE_ONLY';

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
  let openBreakRecord = null;

  for (const br of breakRecords) {
    if (br.ended_at) {
      const mins = br.actual_minutes != null ? br.actual_minutes : Math.round((br.ended_at - br.started_at) / 60000);
      totalBreakSecondsFromRecords += (mins * 60);
      breakAlreadyTaken = true;
    } else {
      hasOpenBreak = true;
      openBreakRecord = br;
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

  const breakPermittedMinutes = openBreakRecord ? (openBreakRecord.permitted_minutes || 30) : (sched.permittedBreakMinutes || 30);
  const breakStartedAt = openBreakRecord ? openBreakRecord.started_at : null;
  const breakRemainingSeconds = openBreakRecord
    ? Math.max(0, (breakPermittedMinutes * 60) - Math.round((nowMs - openBreakRecord.started_at) / 1000))
    : 0;

  // Office presence time (phone app + Wi-Fi/BSSID verification) -- a
  // deliberately separate figure from this agent's own activeSeconds above.
  // The desktop agent only knows keyboard/mouse activity on THIS machine;
  // presence is tracked independently via presence_events and is what the HR
  // dashboard and payroll actually use. Surfaced here so the desktop widget
  // can show both side by side instead of an employee only ever seeing the
  // (often lower) workstation-only figure with no context for the gap.
  let officePresenceMinutes = null;
  let officePresenceFormatted = null;
  const shiftTargetMinutes = 450; // 7h 30m standard required shift
  let shiftProgressPercent = 0;
  let shiftRemainingMinutes = 450;
  let shiftRemainingFormatted = '7h 30m';
  try {
    const day = await attendance.deriveDay(employeeId, dateKey, nowMs);
    officePresenceMinutes = day.workedMinutes;
    officePresenceFormatted = T.formatMinutes(day.workedMinutes);
    shiftProgressPercent = Math.min(100, Math.round((day.workedMinutes / shiftTargetMinutes) * 100));
    shiftRemainingMinutes = Math.max(0, shiftTargetMinutes - day.workedMinutes);
    shiftRemainingFormatted = `${Math.floor(shiftRemainingMinutes / 60)}h ${shiftRemainingMinutes % 60}m`;
  } catch (_) {}

  // Check if an authorized HR stream request is active (requested within last 25s)
  let liveStreamRequested = false;
  try {
    await ensureLiveStreamTable();
    const streamReq = await db.prepare(
      "SELECT requested_at FROM workstation_live_streams WHERE device_id = ? AND status = 'ACTIVE' AND requested_at > ?"
    ).get(deviceId, nowMs - 25000);
    if (streamReq && status === 'ACTIVE' && inOffice && !outsideWorkingHours && !hasOpenBreak && !isManualBreak) {
      liveStreamRequested = true;
    }
  } catch (_) {}

  res.json({
    status: 'SUCCESS',
    workstationStatus: status,
    inOffice,
    locationVerdict,
    appTrackingEnabled,
    outsideWorkingHours,
    liveStreamRequested,
    // Where to listen for an instant live-view request (see lib/liveDoorbell.js).
    // null when Supabase Realtime isn't configured: the agent then keeps polling.
    liveView: {
      protocol: 2,
      realtime: liveDoorbell.clientConfigFor(deviceId),
    },
    shiftWindow: {
      isWorkingDay: sched.isWorkingDay,
      startTime: sched.startTime,
      endTime: sched.endTime,
    },
    today: {
      dateKey,
      checkInTime: sessionRow && sessionRow.created_at ? T.displayTime(sessionRow.created_at) : null,
      activeSeconds: sessionRow ? sessionRow.active_seconds : 0,
      unverifiedSeconds: sessionRow ? (sessionRow.unverified_seconds || 0) : 0,
      idleSeconds: sessionRow ? sessionRow.idle_seconds : 0,
      breakSeconds: effectiveBreakSeconds,
      onBreak: Boolean(hasOpenBreak),
      breakAlreadyTaken: breakAlreadyTaken && !hasOpenBreak,
      breakPermittedMinutes,
      breakStartedAt,
      breakRemainingSeconds,
      officePresenceMinutes,
      officePresenceFormatted,
      shiftTargetMinutes,
      shiftProgressPercent,
      shiftRemainingMinutes,
      shiftRemainingFormatted,
    },
    policy: {
      idleThresholdMinutes: idleThresholdMins,
      lockScreenGraceMinutes: lockGraceMins,
      approvedWorkProcesses: approvedProcesses,
      screenshotPolicy: {
        enabled: screenshotEnabled,
        intervalMinutes: screenshotIntervalMinutes,
        mode: screenshotMode,
      },
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

  let officePresenceMinutes = null;
  let officePresenceFormatted = null;
  const shiftTargetMinutes = 450;
  let shiftProgressPercent = 0;
  let shiftRemainingMinutes = 450;
  let shiftRemainingFormatted = '7h 30m';
  try {
    const day = await attendance.deriveDay(employeeId, dateKey, nowMs);
    officePresenceMinutes = day.workedMinutes;
    officePresenceFormatted = T.formatMinutes(day.workedMinutes);
    shiftProgressPercent = Math.min(100, Math.round((day.workedMinutes / shiftTargetMinutes) * 100));
    shiftRemainingMinutes = Math.max(0, shiftTargetMinutes - day.workedMinutes);
    shiftRemainingFormatted = `${Math.floor(shiftRemainingMinutes / 60)}h ${shiftRemainingMinutes % 60}m`;
  } catch (_) {}

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
      officePresenceMinutes,
      officePresenceFormatted,
      shiftTargetMinutes,
      shiftProgressPercent,
      shiftRemainingMinutes,
      shiftRemainingFormatted,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/desktop/break
// ---------------------------------------------------------------------------
router.post('/break', requireDevice, async (req, res) => {
  const { employeeId, employeeName, deviceId } = req.auth;
  const { onBreak = true, reason = '', startedAt: reqStartedAt } = req.body || {};
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);
  const newStatus = onBreak ? 'ON_BREAK' : 'ACTIVE';

  let breakStartedAt = null;
  let breakPermittedMinutes = 30;
  let breakDueBackAt = null;

  let atMs = nowMs;
  if (reqStartedAt && Number.isFinite(Number(reqStartedAt))) {
    const customAt = Number(reqStartedAt);
    if (customAt <= nowMs && customAt >= (nowMs - 60 * 60 * 1000)) {
      atMs = customAt;
    }
  }

  const A = require('../domain/attendance');
  const events = require('../events');
  try {
    if (onBreak) {
      const result = await A.startBreak(employeeId, atMs);
      if (!result.ok) {
        return res.status(400).json({
          status: 'ERROR',
          code: result.reason,
          message: result.message || 'You have already taken your permitted 30-minute break for today. Only one break is permitted per working day.',
        });
      }
      breakStartedAt = result.startedAt || atMs;
      breakPermittedMinutes = result.permittedMinutes || 30;
      breakDueBackAt = result.dueBackAt || (atMs + breakPermittedMinutes * 60 * 1000);
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
    const P = require('../domain/presence');
    await P.recomputeDay(employeeId, dateKey, nowMs);

    await db.prepare(`
      UPDATE workstation_sessions
      SET status = ?, updated_at = ?
      WHERE employee_id = ? AND session_date = ?
    `).run(newStatus, nowMs, employeeId, dateKey);

    await db.prepare('INSERT INTO movements (at, type, employee_id, employee_name, details) VALUES (?,?,?,?,?)')
      .run(nowMs, onBreak ? 'MANUAL_BREAK_STARTED' : 'MANUAL_BREAK_ENDED', employeeId, employeeName, reason || (onBreak ? 'Employee paused work session' : 'Employee resumed work session'));

    try {
      events.broadcast('PRESENCE_UPDATED', { employeeId, dateKey });
    } catch (_) {}
  } catch (err) {
    console.warn('[desktop/break] break state sync note:', err.message);
    return res.status(500).json({ status: 'ERROR', message: err.message });
  }

  res.json({
    status: 'SUCCESS',
    workstationStatus: newStatus,
    onBreak,
    breakStartedAt,
    breakPermittedMinutes,
    breakDueBackAt,
  });
});

// ---------------------------------------------------------------------------
// POST /api/desktop/checkout
// ---------------------------------------------------------------------------
router.post('/checkout', requireDevice, async (req, res) => {
  const { employeeId, employeeName, deviceId } = req.auth;
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);

  try {
    const sessionRow = await db.prepare(
      'SELECT id FROM workstation_sessions WHERE device_id = ? AND session_date = ?'
    ).get(deviceId, dateKey);

    if (sessionRow) {
      await db.prepare(
        "UPDATE workstation_sessions SET status = 'CHECKED_OUT', updated_at = ? WHERE id = ?"
      ).run(nowMs, sessionRow.id);
    }

    try {
      await presence.recordEvent({
        employeeId,
        deviceId,
        source: 'APP',
        observedAt: nowMs,
        note: 'Desktop Agent Shift Checkout',
      });
      await presence.recomputeDay(employeeId, dateKey, nowMs);
    } catch (_) {}

    await db.prepare('INSERT INTO movements (at, type, employee_id, employee_name, details) VALUES (?,?,?,?,?)')
      .run(nowMs, 'SHIFT_CHECKED_OUT', employeeId, employeeName, 'Employee completed shift via Desktop Agent');

    res.json({
      status: 'SUCCESS',
      message: 'Checked out shift successfully.',
      checkedOutAt: T.displayTime(nowMs),
    });
  } catch (err) {
    console.error('[desktop/checkout] error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
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

// Base64 JPEG ceiling for one live frame. The agent targets well under this;
// the cap keeps one oversized frame from blowing Upstash's per-request limit.
const MAX_FRAME_BASE64_CHARS = 900 * 1024;

function agentVersionOf(req) {
  const v = String(req.get('x-agent-version') || '').trim();
  return /^[0-9A-Za-z.+-]{1,32}$/.test(v) ? v : null;
}

// ---------------------------------------------------------------------------
// GET /api/desktop/stream-status
// Asked by the agent when its doorbell rings (agent v1.0.32+), or on a timer
// by older agents, to find out whether HR is actually waiting for a stream.
// ---------------------------------------------------------------------------
router.get('/stream-status', requireDevice, async (req, res) => {
  const { employeeId, deviceId } = req.auth;
  const nowMs = T.now();

  try {
    // Always fresh here: this is the call that starts a stream, so a lease
    // cached from before the request was made must not answer "no".
    const [requested, permission] = await Promise.all([
      liveView.leaseActive(deviceId, nowMs, { fresh: true }),
      liveView.permission(employeeId, deviceId, nowMs),
    ]);
    const liveStreamRequested = Boolean(requested && permission.isPermitted);

    // "Laptop notified" for the viewer -- only when there is a request, so the
    // idle polls of older agents don't spend Redis commands.
    if (requested) await liveFrame.setAck(deviceId, nowMs);

    res.json({
      status: 'SUCCESS',
      liveStreamRequested,
      isPermitted: permission.isPermitted,
      onBreak: permission.onBreak,
      outsideWorkingHours: permission.outsideWorkingHours,
    });
  } catch (err) {
    res.json({ status: 'SUCCESS', liveStreamRequested: false });
  }
});

// ---------------------------------------------------------------------------
// POST /api/desktop/live-hello
// The agent reports what it supports when its doorbell subscription comes up,
// so the viewer can say "this laptop runs an older agent" instead of spinning.
// ---------------------------------------------------------------------------
router.post('/live-hello', requireDevice, async (req, res) => {
  const { deviceId } = req.auth;
  const body = req.body || {};
  await liveFrame.setAgentInfo(deviceId, {
    version: agentVersionOf(req),
    doorbell: Boolean(body.doorbell),
    capture: typeof body.capture === 'string' ? body.capture.slice(0, 24) : null,
  });
  res.json({ status: 'SUCCESS' });
});

// ---------------------------------------------------------------------------
// POST /api/desktop/stream-frame
// Ingests real-time transient screen frames from the workstation agent.
//
// Body: { frameBase64 } for a new frame, or { keepalive: true } when the
// screen hasn't changed since the last frame. The response's `continue` tells
// the agent whether anyone is still watching, so it needs no separate status
// polling while streaming and stops within a frame of the viewer closing.
// ---------------------------------------------------------------------------
router.post('/stream-frame', requireDevice, async (req, res) => {
  const { employeeId, deviceId } = req.auth;
  const { frameBase64, keepalive } = req.body || {};
  const nowMs = T.now();

  let cleanFrame = null;
  if (!keepalive) {
    if (!frameBase64 || typeof frameBase64 !== 'string') {
      return res.status(400).json({ status: 'ERROR', message: 'frameBase64 string is required.' });
    }
    cleanFrame = frameBase64.trim();
    const isValidImage = (cleanFrame.startsWith('/9j/') || cleanFrame.startsWith('iVBOR') || cleanFrame.startsWith('data:image/')) && cleanFrame.length > 200;
    if (!isValidImage) {
      return res.status(400).json({ status: 'ERROR', message: 'Invalid or unsupported image frame format.' });
    }
    if (cleanFrame.length > MAX_FRAME_BASE64_CHARS) {
      return res.status(413).json({ status: 'ERROR', message: 'Frame too large; send a smaller or lower-quality frame.', continue: true });
    }
  }

  try {
    // Privacy Safeguard: reject frames immediately if employee is on break or outside office hours
    const permission = await liveView.permission(employeeId, deviceId, nowMs);
    if (!permission.isPermitted) {
      await liveFrame.clearFrame(deviceId);
      return res.json({
        status: 'PAUSED',
        continue: false,
        reason: permission.onBreak ? 'ON_BREAK' : 'OUTSIDE_HOURS',
        message: 'Workstation screen telemetry paused for privacy.'
      });
    }

    const watching = await liveView.leaseActive(deviceId, nowMs);
    if (!watching) {
      await liveFrame.clearFrame(deviceId);
      return res.json({ status: 'SUCCESS', continue: false });
    }

    // The frame bytes go to Redis, never Postgres -- see lib/liveFrame.js.
    if (cleanFrame) {
      await liveFrame.setFrame(deviceId, cleanFrame, nowMs);
    } else {
      await liveFrame.markAlive(deviceId, nowMs);
    }

    res.json({ status: 'SUCCESS', continue: true });
  } catch (err) {
    console.error('[desktop/stream-frame] error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/desktop/screenshot
// Ingests periodic screen captures, uploads to Supabase S3, and records metadata
// ---------------------------------------------------------------------------
router.post('/screenshot', requireDevice, async (req, res) => {
  const { employeeId, deviceId } = req.auth;
  const { frameBase64, activeApp = null, windowTitle = null, captureStatus = 'SUCCESS' } = req.body || {};
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);

  if (!frameBase64 || typeof frameBase64 !== 'string') {
    return res.status(400).json({ status: 'ERROR', message: 'frameBase64 string is required.' });
  }

  let cleanBase64 = frameBase64.trim();
  let mimeType = 'image/jpeg';
  if (cleanBase64.startsWith('data:image/jpeg;base64,')) {
    cleanBase64 = cleanBase64.slice('data:image/jpeg;base64,'.length);
  } else if (cleanBase64.startsWith('data:image/png;base64,')) {
    cleanBase64 = cleanBase64.slice('data:image/png;base64,'.length);
    mimeType = 'image/png';
  }

  const isValidImage = (cleanBase64.startsWith('/9j/') || cleanBase64.startsWith('iVBOR')) && cleanBase64.length > 200;
  if (!isValidImage) {
    return res.status(400).json({ status: 'ERROR', message: 'Invalid or unsupported image format.' });
  }

  // Privacy Safeguard: reject frames if employee is on break or outside working hours
  const activeBreak = await db.prepare(
    'SELECT id FROM break_records WHERE employee_id = ? AND ended_at IS NULL'
  ).get(employeeId);

  const sched = await schedule.resolve(employeeId, dateKey);
  const shiftStartThreshold = (sched.scheduledStartAt || nowMs) - 15 * 60 * 1000;
  const shiftEndThreshold = (sched.scheduledEndAt || nowMs) + 15 * 60 * 1000;
  const isWithinWorkingHours = sched.isWorkingDay && (nowMs >= shiftStartThreshold && nowMs <= shiftEndThreshold);

  if (activeBreak || !isWithinWorkingHours) {
    return res.json({
      status: 'PAUSED',
      reason: activeBreak ? 'ON_BREAK' : 'OUTSIDE_HOURS',
      message: 'Workstation screen capture paused for privacy.'
    });
  }

  try {
    await ensureScreenshotsTable();
    const buffer = Buffer.from(cleanBase64, 'base64');
    const fileSizeBytes = buffer.length;
    const shotId = `shot_${employeeId}_${nowMs}_${crypto.randomUUID().slice(0, 6)}`;
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const storageKey = `screenshots/${employeeId}/${dateKey}/${nowMs}_${deviceId}.${ext}`;

    const storage = require('../domain/storage');
    const saveResult = await storage.saveScreenshot({
      key: storageKey,
      buffer,
      mimeType,
    });

    await db.prepare(`
      INSERT INTO workstation_screenshots (
        id, employee_id, device_id, date_key, captured_at,
        storage_path, file_size_bytes, mime_type, active_app,
        window_title, capture_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      shotId, employeeId, deviceId, dateKey, nowMs,
      saveResult.storageKey || storageKey, fileSizeBytes, mimeType,
      activeApp, windowTitle, captureStatus, nowMs
    );

    res.json({
      status: 'SUCCESS',
      shotId,
      fileSizeBytes,
      storagePath: storageKey,
    });
  } catch (err) {
    console.error('[desktop/screenshot] error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;
