// Live-view permission, lease and liveness, shared by the agent's endpoints
// (routes/desktop.js) and the HR viewer's (routes/admin.js).
//
// A frame arrives about once a second while someone is watching, and the old
// handlers resolved the employee's whole schedule and wrote a Postgres row on
// every one. The schedule and the "is anyone still watching" lease change on a
// scale of minutes/seconds, so they're cached per instance for a short time --
// deliberately per-instance rather than Redis: it's a pure read-through
// optimisation, and it keeps the per-frame cost off the Redis command budget.
// The break check is NOT cached (see permission()).

const { db } = require('../db');
const schedule = require('./schedule');
const T = require('../util/time');

const PERMISSION_CACHE_MS = 30 * 1000;
const LEASE_CACHE_MS = 4 * 1000;
// The viewer renews the request while it is open; a request older than this
// is a viewer that went away without saying so (closed tab, lost network).
const LEASE_WINDOW_MS = 25 * 1000;
// Heartbeats come every 60s; allow for one missed beat plus a slow retry.
const OFFLINE_AFTER_MS = 3 * 60 * 1000;

const permissionCache = new Map(); // deviceId -> { value, expiresAtMs }
const leaseCache = new Map(); // deviceId -> { value, expiresAtMs }

let tableEnsured = false;
async function ensureLiveStreamTable() {
  if (tableEnsured) return;
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
  } catch (_) {
    // Already exists, or no DDL rights: either way the queries below will say.
  }
  tableEnsured = true;
}

/**
 * Whether screen capture is allowed right now: not on a break, inside working
 * hours (+/- 15 min). Only the schedule half is cached. The break half is read
 * fresh on every call, so a break started from the phone stops the very next
 * frame -- the agent can't know about that break locally.
 */
async function permission(employeeId, deviceId, nowMs = T.now()) {
  const activeBreak = await db.prepare(
    'SELECT id FROM break_records WHERE employee_id = ? AND ended_at IS NULL'
  ).get(employeeId);

  let hours = permissionCache.get(deviceId);
  if (!hours || hours.expiresAtMs <= nowMs) {
    const sched = await schedule.resolve(employeeId, T.dateKey(nowMs));
    hours = {
      isWorkingDay: Boolean(sched.isWorkingDay),
      // +/- 15 min around the shift. A missing boundary means "no restriction
      // that side", matching the original per-frame check.
      startAt: sched.scheduledStartAt ? sched.scheduledStartAt - 15 * 60 * 1000 : null,
      endAt: sched.scheduledEndAt ? sched.scheduledEndAt + 15 * 60 * 1000 : null,
      expiresAtMs: nowMs + PERMISSION_CACHE_MS,
    };
    permissionCache.set(deviceId, hours);
  }
  const isWithinWorkingHours = hours.isWorkingDay
    && (hours.startAt === null || nowMs >= hours.startAt)
    && (hours.endAt === null || nowMs <= hours.endAt);

  return {
    onBreak: Boolean(activeBreak),
    outsideWorkingHours: !isWithinWorkingHours,
    isPermitted: !activeBreak && isWithinWorkingHours,
  };
}

/** Whether a viewer is still waiting on this device. `fresh` bypasses the short cache. */
async function leaseActive(deviceId, nowMs = T.now(), { fresh = false } = {}) {
  const hit = leaseCache.get(deviceId);
  if (!fresh && hit && hit.expiresAtMs > nowMs) return hit.value;

  await ensureLiveStreamTable();
  const row = await db.prepare(
    "SELECT requested_at FROM workstation_live_streams WHERE device_id = ? AND status = 'ACTIVE' AND requested_at > ?"
  ).get(deviceId, nowMs - LEASE_WINDOW_MS);
  const value = Boolean(row);
  leaseCache.set(deviceId, { value, expiresAtMs: nowMs + LEASE_CACHE_MS });
  return value;
}

/** Drops cached answers after a request/stop, so the next check sees it immediately. */
function forget(deviceId) {
  leaseCache.delete(deviceId);
  permissionCache.delete(deviceId);
}

/** When the device's agent last sent a heartbeat, or null if never. */
async function lastHeartbeatAt(employeeId, deviceId) {
  const row = await db.prepare(`
    SELECT last_heartbeat_at FROM workstation_sessions
    WHERE employee_id = ? AND device_id = ?
    ORDER BY session_date DESC
    LIMIT 1
  `).get(employeeId, deviceId);
  return row && row.last_heartbeat_at ? Number(row.last_heartbeat_at) : null;
}

module.exports = {
  LEASE_WINDOW_MS, OFFLINE_AFTER_MS,
  ensureLiveStreamTable, permission, leaseActive, forget, lastHeartbeatAt,
};
