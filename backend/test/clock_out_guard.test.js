// End shift / phone clock-out pressed on arrival must not end the day, and HR
// can reopen a day after any clock-out. People pressed End shift on arriving
// (25 Sep - 7 Oct, within 25 minutes of 11:00); once End shift became a real
// clock-out that ended their working day before it began.

const test = require('node:test');
const assert = require('node:assert');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('clock_out_guard');

const { app } = require('../src/server');
const { db } = require('../src/db');
const T = require('../src/util/time');

const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
// Wednesday 23 Sep 2026 in Asia/Karachi (UTC+5); the test shift is 11:00-19:00.
const at = (hhmm) => T.wallClockToEpoch('2026-09-23', hhmm);
let clock = at('10:50');
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
  const laptop = await json('POST', '/api/enroll', { body: { code: code.body.code, platform: 'macos', model: 'MacBook' } });
  return {
    employeeId: emp.body.employee.id,
    phone: { Authorization: `Bearer ${phone.body.token}` },
    laptop: { Authorization: `Bearer ${laptop.body.token}` },
  };
}

const heartbeat = (auth) => json('POST', '/api/desktop/heartbeat', {
  headers: auth,
  body: { lockState: 'UNLOCKED', lockDurationSeconds: 0, activeSeconds: 60, idleSeconds: 0, localIp: '192.168.18.70' },
});

const clockOuts = (employeeId) => db.prepare(
  "SELECT source, occurred_at, voided_at FROM attendance_events WHERE employee_id = ? AND event_type = 'CLOCK_OUT' ORDER BY created_at"
).all(employeeId);

test('End shift on arrival, before the shift or before arriving does not end the day', async () => {
  const p = await enrolPair('Morning Presser');

  // Before the shift starts.
  clock = at('10:55');
  let r = await json('POST', '/api/desktop/checkout', { headers: p.laptop });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'TOO_EARLY');

  // On arrival, inside the first hour, from the laptop and the phone.
  clock = at('11:01');
  await heartbeat(p.laptop);
  r = await json('POST', '/api/desktop/checkout', { headers: p.laptop });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'TOO_EARLY');
  assert.match(r.body.message, /isn't available until/);
  r = await json('POST', '/api/attendance/clock-out', { headers: p.phone });
  assert.equal(r.status, 409);

  assert.equal((await clockOuts(p.employeeId)).length, 0, 'no clock-out was written');
  const refused = await db.prepare("SELECT COUNT(*) AS n FROM movements WHERE employee_id = ? AND type = 'END_SHIFT_REFUSED'").get(p.employeeId);
  assert.equal(Number(refused.n), 2, 'HR can see the refused laptop presses');

  const hb = await heartbeat(p.laptop);
  assert.equal(hb.body.today.day.checkedOut, false);
  assert.notEqual(hb.body.workstationStatus, 'CHECKED_OUT');
});

test('End shift with no arrival recorded today is refused', async () => {
  const p = await enrolPair('Never Arrived');
  clock = at('13:00');
  const r = await json('POST', '/api/desktop/checkout', { headers: p.laptop });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NOT_ARRIVED');
  assert.equal((await clockOuts(p.employeeId)).length, 0);
});

test('a real End shift later in the day still works', async () => {
  const p = await enrolPair('Leaves Early');
  clock = at('11:00');
  await heartbeat(p.laptop);
  clock = at('15:30');
  await heartbeat(p.laptop);
  const r = await json('POST', '/api/desktop/checkout', { headers: p.laptop });
  assert.equal(r.status, 200);
  const outs = await clockOuts(p.employeeId);
  assert.equal(outs.length, 1);
  assert.equal(outs[0].source, 'DESKTOP_AGENT');
});

test('HR can resume a shift after any clock-out, and choose whether the gap counts', async () => {
  const p = await enrolPair('Resumed By HR');
  clock = at('11:00');
  await heartbeat(p.laptop);
  for (let t = at('11:05'); t <= at('13:00'); t += 5 * 60000) { clock = t; await heartbeat(p.laptop); }
  const out = await json('POST', '/api/desktop/checkout', { headers: p.laptop });
  assert.equal(out.status, 200);

  // HR clock-outs and the employee's own are both reopened by HR; the
  // employee's own resume refuses an HR one.
  clock = at('13:40');
  const r = await json('POST', `/api/attendance/employee/${p.employeeId}/resume`, {
    headers: ADMIN, body: { creditGap: true, reason: 'Pressed by mistake' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.today.day.checkedOut, false);
  // Worked straight through 11:00-13:40: the 40 minutes after the clock-out count.
  assert.ok(r.body.today.day.workedMinutes >= 159, `worked ${r.body.today.day.workedMinutes}`);

  const outs = await clockOuts(p.employeeId);
  assert.equal(outs.length, 1);
  assert.ok(outs[0].voided_at, 'the clock-out is voided, not deleted');
  const mv = await db.prepare("SELECT details FROM movements WHERE employee_id = ? AND type = 'SHIFT_RESUMED'").get(p.employeeId);
  assert.match(mv.details, /HR resumed the shift.*Pressed by mistake/);

  // The laptop credits again.
  clock = at('13:41');
  const hb = await heartbeat(p.laptop);
  assert.equal(hb.body.workstationStatus, 'ACTIVE');

  // Nothing left to resume.
  const again = await json('POST', `/api/attendance/employee/${p.employeeId}/resume`, { headers: ADMIN, body: {} });
  assert.equal(again.status, 409);
});

test('without creditGap the time between the clock-out and the resume is not counted', async () => {
  const p = await enrolPair('Really Away');
  clock = at('11:00');
  await heartbeat(p.laptop);
  for (let t = at('11:05'); t <= at('13:00'); t += 5 * 60000) { clock = t; await heartbeat(p.laptop); }
  await json('POST', '/api/desktop/checkout', { headers: p.laptop });
  clock = at('14:00');
  const r = await json('POST', `/api/attendance/employee/${p.employeeId}/resume`, { headers: ADMIN, body: { creditGap: false } });
  assert.equal(r.status, 200);
  assert.ok(r.body.today.day.workedMinutes <= 121, `worked ${r.body.today.day.workedMinutes}`);
});

test('HR cannot resume once the automatic clock-out time has passed', async () => {
  const p = await enrolPair('Too Late');
  clock = at('11:00');
  await heartbeat(p.laptop);
  clock = at('20:01');
  await require('../src/jobs').autoClockOut(clock);
  assert.equal((await clockOuts(p.employeeId)).length, 1);
  const r = await json('POST', `/api/attendance/employee/${p.employeeId}/resume`, { headers: ADMIN, body: {} });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'SHIFT_OVER');
});
