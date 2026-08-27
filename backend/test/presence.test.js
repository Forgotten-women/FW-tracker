// Regression tests for the presence derivation engine.
//
// Each test here pins one of the correctness bugs found in the original
// JSON-backed implementation.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the DB at a throwaway file before anything requires src/db.
const TMP = path.join(os.tmpdir(), `office-test-${process.pid}.db`);
process.env.DB_FILE = TMP;
process.env.ADMIN_API_KEY = 'test-key';

const { db } = require('../src/db');
const P = require('../src/domain/presence');
const T = require('../src/util/time');

const MIN = 60 * 1000;

function makeEmployee(id, name = 'Test Person') {
  db.prepare(
    'INSERT OR REPLACE INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?)'
  ).run(id, name, 'Engineering', Date.now(), Date.now());
  return id;
}

function makeDevice(deviceId, employeeId) {
  db.prepare(
    'INSERT OR REPLACE INTO devices (id, employee_id, platform, model, enrolled_at) VALUES (?,?,?,?,?)'
  ).run(deviceId, employeeId, 'android', 'TestPhone', Date.now());
  return deviceId;
}

/** Emit an APP sighting that will classify as OFFICE. */
function ping(employeeId, deviceId, atMs) {
  return P.recordEvent({
    employeeId, deviceId, source: 'APP',
    srcIp: '192.168.18.59', bssid: null, ssid: 'Trans K 2.4G',
    observedAt: atMs,
  });
}

test.after(() => {
  try { db.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP + suffix); } catch {}
  }
});

test('no events yields NOT_CHECKED_IN', () => {
  const emp = makeEmployee('e_none');
  const d = P.deriveDay(emp, T.dateKey(), T.now());
  assert.equal(d.status, 'NOT_CHECKED_IN');
  assert.equal(d.totalMinutes, 0);
  assert.deepEqual(d.sessions, []);
});

test('continuous pings form one open session and count minutes', () => {
  const emp = makeEmployee('e_cont');
  const dev = makeDevice('d_cont', emp);
  const now = T.wallClockToEpoch(T.dateKey(), '12:00');
  // 09:00 -> 12:00, one ping a minute apart is far inside the grace window.
  for (let m = 0; m <= 180; m += 5) ping(emp, dev, now - (180 - m) * MIN);

  const d = P.deriveDay(emp, T.dateKey(now), now);
  assert.equal(d.status, 'IN_OFFICE', 'last ping is at now, so still active');
  assert.equal(d.sessions.length, 1);
  assert.equal(d.sessions[0].open, true);
  assert.equal(d.totalMinutes, 180);
});

test('a gap longer than the grace period splits the session', () => {
  const emp = makeEmployee('e_gap');
  const dev = makeDevice('d_gap', emp);
  const base = T.wallClockToEpoch(T.dateKey(), '09:00');
  // 09:00-10:00 present, then a 90 minute absence, then 11:30-12:00 present.
  for (let m = 0; m <= 60; m += 5) ping(emp, dev, base + m * MIN);
  for (let m = 150; m <= 180; m += 5) ping(emp, dev, base + m * MIN);

  const now = base + 180 * MIN;
  const d = P.deriveDay(emp, T.dateKey(base), now);
  assert.equal(d.sessions.length, 2, 'gap > 15m grace should close the first session');
  assert.equal(d.sessions[0].minutes, 60);
  assert.equal(d.sessions[1].minutes, 30);
  assert.equal(d.totalMinutes, 90, 'the 90 minute absence must NOT be paid');
});

test('three-state model: IN_OFFICE -> GRACE_PERIOD -> AWAY', () => {
  const emp = makeEmployee('e_states');
  const dev = makeDevice('d_states', emp);
  const base = T.wallClockToEpoch(T.dateKey(), '09:00');
  ping(emp, dev, base);

  // activeThreshold = 3m, gracePeriod = 15m
  assert.equal(P.deriveDay(emp, T.dateKey(base), base + 1 * MIN).status, 'IN_OFFICE');
  assert.equal(P.deriveDay(emp, T.dateKey(base), base + 5 * MIN).status, 'GRACE_PERIOD');
  assert.equal(P.deriveDay(emp, T.dateKey(base), base + 40 * MIN).status, 'AWAY');
});

// The regression that matters most. In the original code checkDepartures() only
// ever looked at the CURRENT day, so a session left open across midnight was
// never closed, and getEmployeeWorkStats kept measuring currentSessionStart
// against "now" - producing hours of phantom work that grew forever.
test('a day in the past is closed and its minutes do not grow', () => {
  const emp = makeEmployee('e_rollover');
  const dev = makeDevice('d_rollover', emp);

  const today = T.dateKey();
  const yesterday = T.dateKey(T.startOfDay(today) - 12 * 60 * MIN);
  const start = T.wallClockToEpoch(yesterday, '09:00');

  // Yesterday: present 09:00 to 17:00, then the phone leaves. No closing event.
  for (let m = 0; m <= 480; m += 10) ping(emp, dev, start + m * MIN);

  const noonToday = T.wallClockToEpoch(today, '12:00');
  const midnightTonight = T.wallClockToEpoch(today, '23:59');

  const atNoon = P.deriveDay(emp, yesterday, noonToday);
  const atMidnight = P.deriveDay(emp, yesterday, midnightTonight);

  assert.equal(atNoon.status, 'CLOSED');
  assert.equal(atNoon.totalMinutes, 480, 'should be exactly the 8 hours worked');
  assert.equal(
    atNoon.totalMinutes, atMidnight.totalMinutes,
    'a past day must be immutable as time advances - this is the phantom-hours bug'
  );
  assert.equal(atNoon.sessions.every(s => !s.open), true, 'no session may stay open on a past day');
});

test('events cannot leak across the midnight boundary', () => {
  const emp = makeEmployee('e_boundary');
  const dev = makeDevice('d_boundary', emp);
  const today = T.dateKey();
  const yesterday = T.dateKey(T.startOfDay(today) - 12 * 60 * MIN);

  ping(emp, dev, T.wallClockToEpoch(yesterday, '23:50'));
  ping(emp, dev, T.wallClockToEpoch(today, '00:10'));

  const y = P.deriveDay(emp, yesterday, T.wallClockToEpoch(today, '12:00'));
  const t = P.deriveDay(emp, today, T.wallClockToEpoch(today, '12:00'));
  assert.equal(y.eventCount, 1, 'yesterday sees only its own event');
  assert.equal(t.eventCount, 1, 'today sees only its own event');
});

// The app buffers heartbeats while the server is unreachable and replays them
// with their ORIGINAL timestamps. Replay must not double-count.
test('replaying a buffered heartbeat is idempotent', () => {
  const emp = makeEmployee('e_dedupe');
  const dev = makeDevice('d_dedupe', emp);
  const at = T.wallClockToEpoch(T.dateKey(), '10:00');

  const first = ping(emp, dev, at);
  const replay = ping(emp, dev, at);

  assert.equal(first.inserted, true);
  assert.equal(replay.inserted, false, 'the same sighting must insert once');

  const count = db.prepare(
    'SELECT COUNT(*) c FROM presence_events WHERE employee_id = ?'
  ).get(emp).c;
  assert.equal(count, 1);
});

// Anti-buddy-punching. The old /mobile-ping trusted a client-supplied
// employeeId with no location check, so an employee at home could mark
// themselves present with a one-line script.
test('a heartbeat from outside the office does not count as attendance', () => {
  const emp = makeEmployee('e_remote');
  const dev = makeDevice('d_remote', emp);
  const at = T.wallClockToEpoch(T.dateKey(), '10:00');

  const r = P.recordEvent({
    employeeId: emp, deviceId: dev, source: 'APP',
    srcIp: '203.0.113.9', bssid: 'aa:aa:aa:aa:aa:aa', observedAt: at,
  });

  assert.equal(r.location, 'REMOTE');
  const d = P.deriveDay(emp, T.dateKey(at), at + MIN);
  assert.equal(d.status, 'NOT_CHECKED_IN', 'a remote ping must not create office attendance');
  assert.equal(d.totalMinutes, 0);
});

test('classifyLocation requires both office IP and office BSSID', () => {
  // With no BSSIDs configured the check degrades to source-IP only, and
  // config.configWarnings() surfaces that at startup.
  assert.equal(P.classifyLocation({ srcIp: '192.168.18.5', bssid: null, source: 'APP' }), 'OFFICE');
  assert.equal(P.classifyLocation({ srcIp: '8.8.8.8', bssid: null, source: 'APP' }), 'REMOTE');
  // Hardware sensors sit inside the office, so what they see is office by definition.
  assert.equal(P.classifyLocation({ srcIp: null, bssid: null, source: 'ESP_SNIFFER' }), 'OFFICE');
});

test('the cached attendance row matches a fresh derivation', () => {
  const emp = makeEmployee('e_cache');
  const dev = makeDevice('d_cache', emp);
  const base = T.wallClockToEpoch(T.dateKey(), '09:00');
  for (let m = 0; m <= 60; m += 5) ping(emp, dev, base + m * MIN);

  const now = base + 61 * MIN;
  const derived = P.recomputeDay(emp, T.dateKey(base), now);
  const row = db.prepare(
    'SELECT * FROM attendance_days WHERE employee_id = ? AND date_key = ?'
  ).get(emp, T.dateKey(base));

  assert.equal(row.total_minutes, derived.totalMinutes);
  assert.equal(row.status, derived.status);
  assert.equal(JSON.parse(row.sessions_json).length, derived.sessions.length);
});
