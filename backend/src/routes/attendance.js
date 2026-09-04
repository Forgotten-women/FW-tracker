// Presence ingest and read APIs.
//
// Every route is authenticated. The employee identity on an app heartbeat comes
// from the bearer token, never from the request body - the old /mobile-ping
// took a client-supplied employeeId, which made marking someone else present a
// one-line script.

const express = require('express');
const router = express.Router();

const { db } = require('../db');
const { config } = require('../config');
const { requireDevice, requireSensor, requireAdmin } = require('../middleware/auth');
const P = require('../domain/presence');
const bindings = require('../domain/bindings');
const events = require('../events');
const T = require('../util/time');

const MAX_OBSERVATIONS = 500;   // one batch of replayed offline heartbeats
const MAX_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000;

const insertMovement = db.prepare(
  'INSERT INTO movements (at, type, employee_id, employee_name, details) VALUES (?,?,?,?,?)'
);

/**
 * Emit a movement entry when the derived status crosses a boundary.
 * Movements are now a consequence of derivation rather than something written
 * by hand at each call site, so they cannot drift from the actual state.
 */
async function emitTransition(employeeId, employeeName, before, after, nowMs) {
  const from = before.status;
  const to = after.status;
  if (from === to) return null;

  let type = null;
  if (from === 'NOT_CHECKED_IN' && (to === 'IN_OFFICE' || to === 'GRACE_PERIOD')) type = 'ARRIVED';
  else if (from === 'AWAY' && (to === 'IN_OFFICE' || to === 'GRACE_PERIOD')) type = 'RECONNECTED';
  else if (to === 'AWAY') type = 'DEPARTED';
  if (!type) return null;

  const details = type === 'DEPARTED'
    ? `No activity for ${after.inactivityMinutes} mins`
    : 'Detected on office Wi-Fi';

  await insertMovement.run(nowMs, type, employeeId, employeeName, details);
  events.broadcast('MOVEMENT', { type, employeeId, employeeName, details, time: T.displayTime(nowMs) });
  return type;
}

// ---------------------------------------------------------------------------
// 1. Phone app heartbeat  (device token)
// ---------------------------------------------------------------------------
//
// Accepts either a single observation or a batch. The app buffers heartbeats
// locally while the server is unreachable and replays them with their ORIGINAL
// timestamps; recordEvent dedupes, so replay is idempotent.
router.post('/ping', requireDevice, async (req, res) => {
  const { employeeId, deviceId, employeeName, employeeRole } = req.auth;
  const nowMs = T.now();
  const srcIp = T.normalizeIp(req.ip || req.socket.remoteAddress);

  const body = req.body || {};
  const localIp = body.localIp || null;
  const observations = Array.isArray(body.observations) && body.observations.length
    ? body.observations
    : [{ observedAt: body.observedAt, ssid: body.ssid, bssid: body.bssid }];

  if (observations.length > MAX_OBSERVATIONS) {
    return res.status(413).json({
      status: 'ERROR',
      message: `At most ${MAX_OBSERVATIONS} observations per request.`,
    });
  }

  const before = await P.deriveDay(employeeId, T.dateKey(nowMs), nowMs);

  let accepted = 0, duplicates = 0, rejected = 0;
  const touchedDays = new Set();
  // The location verdict for the NEWEST observation in this batch. This is
  // what the app reports to the user, so it must describe this heartbeat, not
  // whatever attendance already existed for the day.
  let latestObservedAt = -1;
  let latestLocation = 'UNKNOWN';
  let latestReason = null;

  for (const o of observations) {
    // A client-supplied timestamp is clamped: never in the future, never more
    // than a week old. Otherwise a phone with a wrong clock (or a hostile one)
    // could write attendance into arbitrary days.
    let observedAt = Number(o?.observedAt);
    if (!Number.isFinite(observedAt)) observedAt = nowMs;
    if (observedAt > nowMs + 60000 || observedAt < nowMs - MAX_BACKDATE_MS) {
      rejected++;
      continue;
    }

    const r = await P.recordEvent({
      employeeId, deviceId, source: 'APP',
      srcIp,
      localIp,
      ssid: o?.ssid ?? body.ssid ?? null,
      bssid: o?.bssid ?? body.bssid ?? null,
      observedAt,
    });
    if (r.inserted) accepted++; else duplicates++;
    if (observedAt > latestObservedAt) {
      latestObservedAt = observedAt;
      latestLocation = r.location;
      latestReason = r.reason;
    }
    touchedDays.add(T.dateKey(observedAt));
  }

  // Establish or refresh the MAC binding while we have an authenticated
  // request to correlate against. This is what lets presence survive the app
  // being closed: the sensors keep recognising this phone afterwards.
  const binding = await bindings.bindFromAuthenticatedPing({
    employeeId, deviceId, srcIp, nowMs,
  });

  for (const day of touchedDays) await P.recomputeDay(employeeId, day, nowMs);

  const after = await P.deriveDay(employeeId, T.dateKey(nowMs), nowMs);
  await emitTransition(employeeId, employeeName, before, after, nowMs);
  events.broadcast('PRESENCE_UPDATED', { employeeId, status: after.status });

  res.json({
    status: 'SUCCESS',
    accepted, duplicates, rejected,
    // Whether THIS heartbeat was accepted as office presence, so the app can
    // show an honest state instead of claiming "IN OFFICE" regardless.
    verified: latestLocation === 'OFFICE',
    location: latestLocation,
    // Says WHY it did not count. With BSSID enforcement on, a phone that has
    // lost location permission reports no access point and stops being
    // counted, which is indistinguishable from absence unless we say so.
    notCountedReason: latestReason,
    serverTime: T.displayTime(nowMs),
    serverTimeMs: nowMs,
    attendance: await P.presentDay(after, { name: employeeName, role: employeeRole }),
    // Lets the app tell the employee whether closing it will interrupt their
    // attendance, instead of leaving them to find out from a payslip.
    presenceContinues: binding.bound,
    bindingState: binding.reason,
  });
});

// GET /api/attendance/me - the app's own record for today.
router.get('/me', requireDevice, async (req, res) => {
  const { employeeId, employeeName, employeeRole, deviceId } = req.auth;
  const nowMs = T.now();
  const d = await P.deriveDay(employeeId, T.dateKey(nowMs), nowMs);
  res.json({
    status: 'SUCCESS',
    employee: { id: employeeId, name: employeeName, role: employeeRole, deviceId },
    attendance: await P.presentDay(d, { name: employeeName, role: employeeRole }),
    serverTimeMs: nowMs,
  });
});

// GET /api/attendance/my-history?days=7
router.get('/my-history', requireDevice, async (req, res) => {
  const { employeeId, employeeName, employeeRole } = req.auth;
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 60);
  const nowMs = T.now();
  const dayKeys = [];
  for (let i = 0; i < days; i++) {
    dayKeys.push(T.dateKey(nowMs - i * 24 * 60 * 60 * 1000));
  }
  const out = await Promise.all(
    dayKeys.map(async (key) => {
      const d = await P.deriveDay(employeeId, key, nowMs);
      return P.presentDay(d, { name: employeeName, role: employeeRole });
    })
  );
  res.json({ status: 'SUCCESS', days: out });
});

// ---------------------------------------------------------------------------
// 2. Hardware sensor heartbeat  (HMAC signed)
// ---------------------------------------------------------------------------
//
// Corroboration only. A network sighting can confirm that *a* device is on the
// office Wi-Fi, but it can never name a person: MAC randomisation and DHCP
// lease reuse make that attribution unsound, and getting it wrong would put
// the hours of one employee onto the payroll record of another.
router.post('/heartbeat', requireSensor, async (req, res) => {
  const { sensorId } = req.auth;
  const nowMs = T.now();
  const devices = Array.isArray(req.body?.devices) ? req.body.devices : [];

  if (devices.length > MAX_OBSERVATIONS) {
    return res.status(413).json({ status: 'ERROR', message: 'Too many devices in one report.' });
  }

  let recorded = 0;
  const touched = new Set();
  for (const d of devices) {
    const mac = T.normalizeMac(d?.mac);
    const ip = T.normalizeIp(d?.ip);
    if (!mac && !ip) continue;
    // Routers, the server itself and broadcast addresses are not people.
    if (ip && config.infrastructureIps.has(ip)) continue;

    const r = await P.recordEvent({
      employeeId: null,
      source: 'ESP_SNIFFER',
      mac: mac || null,
      srcIp: ip || null,
      rssi: d?.rssi ?? null,
      observedAt: Number(d?.at) || nowMs,
      note: `sensor:${sensorId}`,
    });
    if (r.inserted) recorded++;
    if (r.employeeId) touched.add(r.employeeId);
  }

  // A bound sighting is now somebody's attendance, so refresh it immediately -
  // the live dashboard should not lag a sensor report by a maintenance tick.
  for (const empId of touched) await P.recomputeDay(empId, T.dateKey(nowMs), nowMs);

  res.json({
    status: 'SUCCESS',
    sensorId,
    attributed: touched.size,
    recorded,
    // Lets the firmware resync if its clock has drifted out of the signature
    // freshness window.
    serverTimeMs: nowMs,
    serverTime: T.displayTime(nowMs),
  });
});

// ---------------------------------------------------------------------------
// 3. Dashboard reads  (admin key)
// ---------------------------------------------------------------------------

// Uses the SAME derivation as /api/dashboard/summary. Previously this route
// filtered on a denormalised employee.status field while the dashboard
// recomputed from the ledger, so the two could disagree about the same person.
router.get('/live', requireAdmin, async (req, res) => {
  const nowMs = T.now();
  const board = await P.liveBoard(nowMs);
  res.json({
    status: 'SUCCESS',
    inOffice: board.filter(e => e.status === 'IN_OFFICE'),
    grace: board.filter(e => e.status === 'GRACE_PERIOD'),
    away: board.filter(e => e.status === 'AWAY'),
    notArrived: board.filter(e => e.status === 'NOT_CHECKED_IN'),
    serverTime: T.displayTime(nowMs),
  });
});

router.get('/logs', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const rows = await db.prepare('SELECT * FROM movements ORDER BY at DESC LIMIT ?').all(limit);
  res.json({
    status: 'SUCCESS',
    total: (await db.prepare('SELECT COUNT(*) c FROM movements').get()).c,
    logs: rows.map(m => ({
      id: m.id,
      time: T.displayTime(m.at),
      date: T.dateKey(m.at),
      type: m.type,
      employeeName: m.employee_name || 'Unknown',
      details: m.details || '',
    })),
  });
});

module.exports = router;
