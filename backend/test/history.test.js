// Attendance history for any past date: the employee's own (phone) and HR's
// view of any employee. Built from persisted day rows, so it must still work
// after the raw presence events have been removed by retention.

const test = require('node:test');
const assert = require('node:assert');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('history');
// The office is recognised by source address; trust the test's X-Forwarded-For.
process.env.TRUST_PROXY = 'true';

const { app } = require('../src/server');
const { db } = require('../src/db');
const T = require('../src/util/time');
const P = require('../src/domain/presence');

const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
const OFFICE = { 'X-Forwarded-For': '192.168.18.59' };
const pkt = (dateKey, hh, mm = 0) => T.wallClockToEpoch(dateKey, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);

let clock = pkt('2026-09-01', 9); // Tue 1 Sep 2026
const realNow = T.now;
let base;
let server;
let emp;

const json = async (method, url, { headers = {}, body } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

// Phone pings from the office every 10 minutes (inside the 15-minute grace,
// so the day is one unbroken session) between two wall-clock times; then the
// day is derived and persisted -- what the real pings and the rollover job
// leave behind.
async function workDay(dateKey, fromHH, fromMM, toHH, toMM) {
  for (let t = pkt(dateKey, fromHH, fromMM); t <= pkt(dateKey, toHH, toMM); t += 10 * 60 * 1000) {
    clock = t;
    const r = await json('POST', '/api/attendance/ping', { headers: { ...emp.phone, ...OFFICE }, body: { ssid: 'Test Office WiFi' } });
    assert.equal(r.status, 200);
  }
  await P.recomputeDay(emp.id, dateKey, pkt(dateKey, 23, 0));
}

test.before(async () => {
  T.now = () => clock;
  await prepareDatabase();
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const created = await json('POST', '/api/admin/employees', {
    headers: ADMIN, body: { name: 'History Subject', role: 'Analyst', startDate: '2026-09-01' },
  });
  const code = await json('POST', `/api/admin/employees/${created.body.employee.id}/enrollment-code`, { headers: ADMIN });
  const phone = await json('POST', '/api/enroll', { body: { code: code.body.code, platform: 'android', model: 'P' } });
  emp = { id: created.body.employee.id, phone: { Authorization: `Bearer ${phone.body.token}` } };

  await workDay('2026-09-01', 11, 0, 19, 0);   // Tue: on time, full day
  await workDay('2026-09-02', 11, 45, 19, 0);  // Wed: late
  // Thu 3 Sep: nothing recorded (absent). Fri 4 Sep: approved annual leave.
  await db.prepare(`
    INSERT INTO leave_requests (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days, reason, status, submitted_at, decided_at, created_at)
    VALUES ('lr_hist', ?, 'annual', '2026-09-04', '2026-09-04', 'FULL', 1, 'Family', 'APPROVED', ?, ?, ?)
  `).run(emp.id, clock, clock, clock);

  // Retention would delete these; history must not depend on them.
  await db.prepare('DELETE FROM presence_events WHERE employee_id = ?').run(emp.id);

  clock = pkt('2026-09-07', 14); // Mon 7 Sep, 2 pm
});

test.after(async () => {
  T.now = realNow;
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  await dropDatabase();
});

test('the employee sees any past range, one entry per day, from the persisted records', async () => {
  const r = await json('GET', '/api/attendance/mine/days?from=2026-08-30&to=2026-09-07', { headers: emp.phone });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.days.map(d => [d.dateKey, d]));
  assert.equal(r.body.days.length, 9);

  assert.equal(by['2026-08-31'].status, 'NOT_EMPLOYED');
  assert.equal(by['2026-09-01'].status, 'ON_TIME');
  assert.ok(by['2026-09-01'].workedMinutes >= 450, 'a full day survives the raw events being deleted');
  assert.equal(by['2026-09-01'].firstIn !== null, true);

  assert.equal(by['2026-09-02'].status, 'LATE');
  assert.ok(by['2026-09-02'].deficit.lateMinutes > 0);

  assert.equal(by['2026-09-03'].status, 'ABSENT');
  assert.equal(by['2026-09-04'].status, 'ON_LEAVE');
  assert.equal(by['2026-09-04'].leave.type, 'Paid annual leave');
  assert.equal(by['2026-09-05'].status, 'REST_DAY');
  assert.equal(by['2026-09-06'].weekday, 'Sun');
  assert.equal(by['2026-09-07'].isToday, true);
  assert.equal(by['2026-09-07'].status, 'NOT_STARTED');
});

test('ranges are validated: bad dates, reversed, too long; the future is clamped to today', async () => {
  assert.equal((await json('GET', '/api/attendance/mine/days?from=2026-9-1&to=2026-09-07', { headers: emp.phone })).status, 400);
  assert.equal((await json('GET', '/api/attendance/mine/days?from=2026-09-07&to=2026-09-01', { headers: emp.phone })).status, 400);
  assert.equal((await json('GET', '/api/attendance/mine/days?from=2026-01-01&to=2026-09-07', { headers: emp.phone })).status, 400);
  const future = await json('GET', '/api/attendance/mine/days?from=2026-09-06&to=2026-12-31', { headers: emp.phone });
  assert.equal(future.status, 200);
  assert.deepEqual(future.body.days.map(d => d.dateKey), ['2026-09-06', '2026-09-07']);
});

test('one day in full: the employee gets the timeline, HR also gets the movements log', async () => {
  const mine = await json('GET', '/api/attendance/mine/day/2026-09-02', { headers: emp.phone });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.day.status, 'LATE');
  assert.ok(mine.body.day.sessions.length >= 1);
  assert.equal(mine.body.day.movements, undefined, 'HR-only detail is not sent to the phone');
  assert.equal(mine.body.day.topApps, undefined);

  const hr = await json('GET', `/api/dashboard/employees/${emp.id}/day/2026-09-02`, { headers: ADMIN });
  assert.equal(hr.status, 200);
  assert.ok(Array.isArray(hr.body.day.movements));
  assert.ok(Array.isArray(hr.body.day.topApps));
  assert.equal(hr.body.day.employee.name, 'History Subject');

  assert.equal((await json('GET', '/api/attendance/mine/day/2026-09-30', { headers: emp.phone })).status, 400, 'future');
});

test('HR reads any employee; the employee routes need the device token', async () => {
  const hr = await json('GET', `/api/dashboard/employees/${emp.id}/days?from=2026-09-01&to=2026-09-04`, { headers: ADMIN });
  assert.equal(hr.status, 200);
  assert.deepEqual(hr.body.days.map(d => d.status), ['ON_TIME', 'LATE', 'ABSENT', 'ON_LEAVE']);

  assert.equal((await json('GET', '/api/dashboard/employees/emp_nope/days?from=2026-09-01&to=2026-09-04', { headers: ADMIN })).status, 404);
  assert.equal((await json('GET', '/api/attendance/mine/days?from=2026-09-01&to=2026-09-04')).status, 401);
  assert.equal((await json('GET', `/api/dashboard/employees/${emp.id}/days?from=2026-09-01&to=2026-09-04`)).status, 401);
});

test('an approved leave wins over a pending one on the same day, and correction details arrive parsed', async () => {
  await db.prepare(`
    INSERT INTO leave_requests (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days, reason, status, submitted_at, created_at)
    VALUES ('lr_pending_overlap', ?, 'unpaid', '2026-09-04', '2026-09-04', 'FULL', 1, 'Duplicate', 'PENDING', ?, ?)
  `).run(emp.id, clock, clock);
  await db.prepare(`
    INSERT INTO attendance_corrections (id, employee_id, date_key, requested_by, requested_at, requested_change, reason, status)
    VALUES ('ac_hist', ?, '2026-09-02', ?, ?, ?, 'Traffic', 'PENDING')
  `).run(emp.id, `employee:${emp.id}`, clock, JSON.stringify({ arrivalTime: '11:05' }));

  const leaveDay = await json('GET', '/api/attendance/mine/day/2026-09-04', { headers: emp.phone });
  assert.equal(leaveDay.body.day.status, 'ON_LEAVE');
  assert.equal(leaveDay.body.day.leave.status, 'APPROVED');

  const late = await json('GET', '/api/attendance/mine/day/2026-09-02', { headers: emp.phone });
  assert.deepEqual(late.body.day.correctionRequests[0].requestedChange, { arrivalTime: '11:05' });
  assert.equal(late.body.day.corrections.pending, 1);
});

test('days after the contract ends are not reported as absences', async () => {
  await db.prepare('UPDATE employment_records SET contract_end_date = ? WHERE employee_id = ? AND effective_to IS NULL')
    .run('2026-09-02', emp.id);
  const r = await json('GET', '/api/attendance/mine/days?from=2026-09-01&to=2026-09-03', { headers: emp.phone });
  assert.deepEqual(r.body.days.map(d => d.status), ['ON_TIME', 'LATE', 'NOT_EMPLOYED']);
  assert.equal(r.body.days[2].statusLabel, 'After employment ended');
  await db.prepare('UPDATE employment_records SET contract_end_date = NULL WHERE employee_id = ?').run(emp.id);
});

test('with no employment record, the date the employee was added stands in for the start', async () => {
  const created = await json('POST', '/api/admin/employees', { headers: ADMIN, body: { name: 'No Record', role: 'Temp' } });
  await db.prepare('DELETE FROM employment_records WHERE employee_id = ?').run(created.body.employee.id);
  const r = await json('GET', `/api/dashboard/employees/${created.body.employee.id}/days?from=2026-09-01&to=2026-09-07`, { headers: ADMIN });
  assert.equal(r.status, 200);
  assert.equal(r.body.employmentStart, '2026-09-07');
  assert.equal(r.body.days[0].status, 'NOT_EMPLOYED');
});

test('leave spanning a weekend only counts working days as leave', async () => {
  await db.prepare(`
    INSERT INTO leave_requests (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days, reason, status, submitted_at, decided_at, created_at)
    VALUES ('lr_weekend', ?, 'annual', '2026-08-28', '2026-08-31', 'FULL', 2, 'Trip', 'APPROVED', ?, ?, ?)
  `).run(emp.id, clock, clock, clock);
  await db.prepare('UPDATE employment_records SET start_date = ? WHERE employee_id = ?').run('2026-08-01', emp.id);
  const r = await json('GET', '/api/attendance/mine/days?from=2026-08-28&to=2026-08-31', { headers: emp.phone });
  assert.deepEqual(r.body.days.map(d => d.status), ['ON_LEAVE', 'REST_DAY', 'REST_DAY', 'ON_LEAVE']);
  assert.ok('employmentEnd' in r.body);
});
