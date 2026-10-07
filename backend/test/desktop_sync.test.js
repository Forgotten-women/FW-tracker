// Desktop agent <-> phone consistency: break state read by the agent after a
// phone break, the start-up status probe booking no time, the reason the
// widget is (not) counting, and an Exit being put on the record.

const test = require('node:test');
const assert = require('node:assert');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('desktop_sync');

const { app } = require('../src/server');
const { db } = require('../src/db');
const T = require('../src/util/time');

const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
// Wednesday 23 Sep 2026, 14:00 in Asia/Karachi -- inside the 11:00-19:00 test hours.
let clock = Date.UTC(2026, 8, 23, 9, 0, 0);
const realNow = T.now;

let base;
let server;

test.before(async () => {
  T.now = () => clock;
  await prepareDatabase();
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  T.now = realNow;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  await dropDatabase();
});

const json = async (method, url, { headers = {}, body } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

async function enrolPair(name) {
  const emp = await json('POST', '/api/admin/employees', { headers: ADMIN, body: { name, role: 'Engineer' } });
  const code = await json('POST', `/api/admin/employees/${emp.body.employee.id}/enrollment-code`, { headers: ADMIN });
  const phone = await json('POST', '/api/enroll', { body: { code: code.body.code, platform: 'android', model: 'Pixel' } });
  const laptop = await json('POST', '/api/enroll', { body: { code: code.body.code, platform: 'windows', model: 'Latitude' } });
  return {
    employeeId: emp.body.employee.id,
    phone: { Authorization: `Bearer ${phone.body.token}` },
    laptop: { Authorization: `Bearer ${laptop.body.token}` },
    laptopId: laptop.body.deviceId,
  };
}

const heartbeat = (auth, body) => json('POST', '/api/desktop/heartbeat', {
  headers: auth,
  body: { lockState: 'UNLOCKED', lockDurationSeconds: 0, ...body },
});

test('a break started on the phone is what the laptop reads back', async () => {
  const p = await enrolPair('Phone Breaker');

  let state = await json('GET', '/api/desktop/break-state', { headers: p.laptop });
  assert.equal(state.body.onBreak, false);

  const started = await json('POST', '/api/attendance/break/start', { headers: p.phone });
  assert.equal(started.status, 201);

  state = await json('GET', '/api/desktop/break-state', { headers: p.laptop });
  assert.equal(state.body.onBreak, true);
  assert.equal(state.body.breakStartedAt, clock);
  assert.equal(state.body.breakDueBackAt, clock + state.body.breakPermittedMinutes * 60 * 1000);

  clock += 20 * 60 * 1000;
  const ended = await json('POST', '/api/attendance/break/end', { headers: p.phone });
  assert.equal(ended.status, 200);

  state = await json('GET', '/api/desktop/break-state', { headers: p.laptop });
  assert.equal(state.body.onBreak, false);
  assert.equal(state.body.breakAlreadyTaken, true);
});

test("the agent's zero-length status probe books no time, even during a break", async () => {
  const p = await enrolPair('Probe Sender');
  await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0 });
  await json('POST', '/api/attendance/break/start', { headers: p.phone });

  const before = await db.prepare('SELECT break_seconds, idle_seconds FROM workstation_sessions WHERE device_id = ?').get(p.laptopId);
  const probe = await heartbeat(p.laptop, { activeSeconds: 0, idleSeconds: 0 });
  assert.equal(probe.status, 200);
  const after = await db.prepare('SELECT break_seconds, idle_seconds FROM workstation_sessions WHERE device_id = ?').get(p.laptopId);

  assert.equal(Number(after.idle_seconds), Number(before.idle_seconds));
  // break_seconds may be topped up from the break record's real elapsed time,
  // but never by a phantom 60s for the probe itself.
  assert.ok(Number(after.break_seconds) < Number(before.break_seconds) + 60);
});

test('the heartbeat says why time is or is not being counted', async () => {
  const p = await enrolPair('Credit Reader');
  const hb = await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0 });
  // No office network in the test fixture and not a remote worker.
  assert.equal(hb.body.creditState, 'UNVERIFIED');

  const evening = clock;
  clock = Date.UTC(2026, 8, 23, 16, 0, 0); // 21:00 Karachi
  const late = await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0 });
  assert.equal(late.body.creditState, 'OUTSIDE_HOURS');
  clock = evening;
});

test('exiting the agent is recorded rather than looking like missing data', async () => {
  const p = await enrolPair('Agent Quitter');
  await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0 });

  const stopped = await json('POST', '/api/desktop/agent-stopped', { headers: p.laptop, body: { reason: 'Exited from the tray menu' } });
  assert.equal(stopped.status, 200);

  const movement = await db.prepare(
    "SELECT * FROM movements WHERE employee_id = ? AND type = 'DESKTOP_AGENT_STOPPED'"
  ).get(p.employeeId);
  assert.ok(movement, 'the stop is in the movements feed');
  const session = await db.prepare('SELECT status FROM workstation_sessions WHERE device_id = ?').get(p.laptopId);
  assert.equal(session.status, 'AGENT_STOPPED');
});

test('the daily target is the full working day, break included, as attendance judges it', async () => {
  const p = await enrolPair('Target Tester');
  const hb = await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0 });
  const t = hb.body.today;
  assert.equal(t.shiftTargetMinutes, 480, '8h day (7h 30m + the 30m break), not a fixed 450');
  assert.equal(t.shiftBreakIncludedMinutes, 30);
  const credited = Math.max(0, t.officePresenceMinutes - t.shiftExcessBreakMinutes);
  assert.equal(t.shiftRemainingMinutes, Math.max(0, 480 - credited));
  assert.equal(t.shiftProgressPercent, Math.min(100, Math.round((credited / 480) * 100)));
});

test('an HR-entered clock-in replaces the first sighting on the live board, lateness included', async () => {
  const P = require('../src/domain/presence');
  const p = await enrolPair('Late Arrival');
  await json('POST', '/api/attendance/ping', { headers: p.phone, body: { ssid: 'Trans K 2.4G' } });
  const dateKey = T.dateKey(clock);
  const before = (await P.liveBoard(clock)).find(r => r.employeeId === p.employeeId);

  await db.prepare(`
    INSERT INTO attendance_events (id, employee_id, date_key, occurred_at, event_type, source, created_at, created_by)
    VALUES (?,?,?,?, 'CLOCK_IN', 'ADMIN', ?, 'admin')
  `).run('ae_test_' + p.employeeId, p.employeeId, dateKey, T.wallClockToEpoch(dateKey, '11:00'), clock);

  const after = (await P.liveBoard(clock)).find(r => r.employeeId === p.employeeId);
  assert.ok(after, 'on the board');
  assert.match(after.firstCheckIn, /^11:00/);
  assert.equal(after.isLate, false);
  assert.equal(after.lateMinutes, 0);
  assert.equal(after.checkInSetByHr, true);
  if (before && before.firstCheckIn !== '--') assert.notEqual(before.firstCheckIn, after.firstCheckIn);
});

// ---------------------------------------------------------------------------
// Approved leave, and remote workers
// ---------------------------------------------------------------------------

async function approvedLeave(employeeId, dateKey, dayPortion = 'FULL_DAY') {
  await db.prepare(`
    INSERT INTO leave_requests (id, employee_id, leave_type_id, start_date, end_date, day_portion,
      total_days, status, submitted_at, decided_at, created_at)
    VALUES (?, ?, 'annual', ?, ?, ?, 1, 'APPROVED', ?, ?, ?)
  `).run('lr_' + employeeId + dateKey, employeeId, dateKey, dateKey, dayPortion, clock, clock, clock);
}

test('on an approved leave day the laptop counts nothing and the board says On leave', async () => {
  const p = await enrolPair('On Leave');
  await approvedLeave(p.employeeId, '2026-09-23');

  const hb = await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0, localIp: '192.168.18.40' });
  assert.equal(hb.body.onLeave, true);
  assert.equal(hb.body.creditState, 'OUTSIDE_HOURS', 'treated like outside hours, which every agent understands');
  assert.equal(hb.body.policy.screenshotPolicy.enabled, false);

  const ws = await db.prepare('SELECT active_seconds FROM workstation_sessions WHERE employee_id = ?').get(p.employeeId);
  assert.equal(Number(ws.active_seconds), 0);

  // The phone still reports from the office, late; none of it is scored.
  await json('POST', '/api/attendance/ping', { headers: p.phone, body: { localIp: '192.168.18.41' } });
  const summary = await json('GET', '/api/dashboard/summary', { headers: ADMIN });
  const row = summary.body.onLeave.find(e => e.employeeId === p.employeeId);
  assert.ok(row, 'listed under onLeave, not dropped from the board');
  assert.equal(row.status, 'ON_LEAVE');
  assert.equal(row.isLate, false);
  assert.equal(row.dailyDeficitMinutes, 0);
  assert.equal(row.totalMinutes, 0);

  const A = require('../src/domain/attendance');
  const day = await A.deriveDay(p.employeeId, '2026-09-23', clock);
  assert.equal(day.attendanceStatus, 'ON_LEAVE');
  assert.equal(day.dailyDeficitMinutes, 0);
});

test("a remote worker's phone away from the office counts as remote work", async () => {
  const remote = await enrolPair('Remote Worker');
  const office = await enrolPair('Office Worker');
  await db.prepare("UPDATE employees SET work_mode = 'REMOTE', remote_allowed = 1 WHERE id = ?").run(remote.employeeId);

  // No office network: the source address (127.0.0.1) is not an office subnet.
  const r = await json('POST', '/api/attendance/ping', { headers: remote.phone, body: {} });
  assert.equal(r.body.verified, true);
  assert.equal(r.body.location, 'REMOTE_VERIFIED');
  assert.equal(r.body.notCountedReason, null);

  const o = await json('POST', '/api/attendance/ping', { headers: office.phone, body: {} });
  assert.equal(o.body.verified, false, 'an office worker at home is still not counted');

  const summary = await json('GET', '/api/dashboard/summary', { headers: ADMIN });
  const row = summary.body.inOffice.find(e => e.employeeId === remote.employeeId);
  assert.ok(row, 'shown as active, not "Not arrived"');
  assert.match(row.statusLabel, /Remote/);
  assert.ok(summary.body.notArrived.some(e => e.employeeId === office.employeeId));
});

// A break whose "End break" never reached the server (the 1 Oct DNS failure)
// made every heartbeat on later days count as break time.
test('a break left open from an earlier day is closed and stops counting as break', async () => {
  const p = await enrolPair('Stuck Break');
  const yesterday = '2026-09-22';
  const startedAt = Date.UTC(2026, 8, 22, 11, 14, 0);
  await db.prepare(`
    INSERT INTO break_records (id, employee_id, date_key, started_at, ended_at, permitted_minutes, actual_minutes, excess_minutes, created_at)
    VALUES (?, ?, ?, ?, NULL, 30, NULL, 0, ?)
  `).run('brk_stuck_' + p.employeeId, p.employeeId, yesterday, startedAt, startedAt);

  const hb = await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0, localIp: '192.168.18.42' });
  assert.notEqual(hb.body.workstationStatus, 'ON_BREAK');
  assert.equal(hb.body.creditState, 'COUNTED');

  const b = await db.prepare('SELECT ended_at, actual_minutes, excess_minutes FROM break_records WHERE id = ?').get('brk_stuck_' + p.employeeId);
  assert.equal(Number(b.ended_at), startedAt + 30 * 60000, 'closed at the end of the allowance');
  assert.equal(Number(b.excess_minutes), 0, 'a request that failed costs no excess');

  const state = await json('GET', '/api/desktop/break-state', { headers: p.laptop });
  assert.equal(state.body.onBreak, false);
  const ws = await db.prepare('SELECT active_seconds, break_seconds FROM workstation_sessions WHERE employee_id = ?').get(p.employeeId);
  assert.equal(Number(ws.break_seconds), 0);
  assert.ok(Number(ws.active_seconds) > 0);
});

// ---------------------------------------------------------------------------
// One "today" for every app (2026-10-05): the phone, the laptop and the
// dashboard must show the same figures for the same person at the same moment.
// ---------------------------------------------------------------------------

// One pair shared by the tests below: the enrolment limiter allows 20 per IP
// per 10 minutes, and this file already enrols many devices.
let sharedPair = null;
const shared = async () => (sharedPair = sharedPair || await enrolPair('Same Numbers'));

test('the phone, laptop and dashboard all get the same day view', async () => {
  const p = await shared();
  await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0, localIp: '192.168.18.43' });
  await json('POST', '/api/attendance/ping', { headers: p.phone, body: { localIp: '192.168.18.44' } });

  const ping = await json('POST', '/api/attendance/ping', { headers: p.phone, body: { localIp: '192.168.18.44' } });
  const home = await json('GET', '/api/attendance/home-summary', { headers: p.phone });
  const hb = await heartbeat(p.laptop, { activeSeconds: 0, idleSeconds: 0, localIp: '192.168.18.43' });
  const board = await json('GET', '/api/dashboard/summary', { headers: ADMIN });
  const row = [...board.body.inOffice, ...board.body.grace, ...board.body.away, ...board.body.notArrived]
    .find(e => e.employeeId === p.employeeId);

  const views = {
    ping: ping.body.attendance.day,
    home: home.body.today.day,
    laptop: hb.body.today.day,
    dashboard: row.day,
  };
  for (const [name, v] of Object.entries(views)) assert.ok(v, `${name} has a day view`);
  for (const name of ['home', 'laptop', 'dashboard']) {
    assert.deepEqual(views[name], views.ping, `${name} day view equals the phone's`);
  }
  // The legacy fields older apps read are the same figure.
  assert.equal(ping.body.attendance.totalMinutes, views.ping.workedMinutes);
  assert.equal(hb.body.today.officePresenceMinutes, views.ping.workedMinutes);
  assert.equal(hb.body.today.shiftProgressPercent, views.ping.progressPercent);
  assert.equal(home.body.workingHours.daily.percent, views.ping.progressPercent);
});

test('laptop counters can never exceed the time that has passed', async () => {
  const p = await shared();
  await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0, localIp: '192.168.18.45' });
  // A burst of duplicate/replayed heartbeats claiming far more time than elapsed.
  for (let i = 0; i < 5; i++) {
    await heartbeat(p.laptop, { activeSeconds: 600, idleSeconds: 600, localIp: '192.168.18.45' });
  }
  const ws = await db.prepare('SELECT active_seconds, idle_seconds, break_seconds, created_at FROM workstation_sessions WHERE employee_id = ?').get(p.employeeId);
  const counted = Number(ws.active_seconds) + Number(ws.idle_seconds) + Number(ws.break_seconds);
  assert.ok(counted <= (clock - Number(ws.created_at)) / 1000 + 120, `counted ${counted}s`);
});

test('an hour after the shift ends, anyone not clocked out is clocked out automatically', async () => {
  const p = await shared();
  await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0, localIp: '192.168.18.46' });
  const jobs = require('../src/jobs');
  const saved = clock;
  try {
    clock = Date.UTC(2026, 8, 23, 14, 30, 0);          // 19:30 PKT: not yet
    assert.equal(await jobs.autoClockOut(clock), 0);
    clock = Date.UTC(2026, 8, 23, 15, 1, 0);           // 20:01 PKT
    assert.ok(await jobs.autoClockOut(clock) >= 1);
    const out = await db.prepare(`SELECT occurred_at FROM attendance_events WHERE employee_id = ? AND event_type = 'CLOCK_OUT'`).all(p.employeeId);
    assert.equal(out.length, 1);
    assert.ok(Number(out[0].occurred_at) <= Date.UTC(2026, 8, 23, 14, 0, 0), 'no later than the 19:00 shift end');
    assert.equal(await jobs.autoClockOut(clock), 0, 'only once');

    // After clock-out the laptop credits nothing and says the shift ended.
    const hb = await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0, localIp: '192.168.18.46' });
    assert.equal(hb.body.workstationStatus, 'CHECKED_OUT');
    assert.equal(hb.body.today.day.checkedOut, true);
  } finally {
    clock = saved;
  }
});

test('before the shift starts a verified laptop is BEFORE_SHIFT, not COUNTED', async () => {
  const p = await shared();                              // enrolment limiter: reuse the shared pair
  const saved = clock;
  try {
    clock = Date.UTC(2026, 8, 24, 5, 52, 0);             // Thu 24 Sep, 10:52 PKT, inside the 10:45 window
    const hb = await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0, localIp: '192.168.18.47' });
    assert.equal(hb.body.creditState, 'BEFORE_SHIFT');
    assert.equal(hb.body.today.day.workedMinutes, 0);
    assert.equal(hb.body.today.day.counting, false);
  } finally {
    clock = saved;
  }
});

test('a mistaken End shift can be resumed the same day; an automatic clock-out cannot', async () => {
  const p = await shared();
  const saved = clock;
  try {
    clock = Date.UTC(2026, 8, 25, 8, 30, 0);             // Fri 25 Sep, 13:30 PKT
    await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0, localIp: '192.168.18.48' });
    const out = await json('POST', '/api/desktop/checkout', { headers: p.laptop });
    assert.equal(out.status, 200);
    let hb = await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0, localIp: '192.168.18.48' });
    assert.equal(hb.body.today.day.checkedOut, true);
    assert.equal(hb.body.today.day.canResume, true);

    clock += 5 * 60000;
    const r = await json('POST', '/api/desktop/resume', { headers: p.laptop });
    assert.equal(r.status, 200);
    hb = await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0, localIp: '192.168.18.48' });
    assert.equal(hb.body.workstationStatus, 'ACTIVE');
    assert.equal(hb.body.today.day.checkedOut, false);

    // Nothing to resume now.
    assert.equal((await json('POST', '/api/desktop/resume', { headers: p.laptop })).status, 409);

    // The automatic clock-out (20:00) cannot be resumed by the employee.
    clock = Date.UTC(2026, 8, 25, 15, 1, 0);
    await require('../src/jobs').autoClockOut(clock);
    const late = await json('POST', '/api/desktop/resume', { headers: p.laptop });
    assert.equal(late.status, 409);
  } finally {
    clock = saved;
  }
});
