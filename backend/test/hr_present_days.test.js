// Days HR recorded from its own records (before the tracker ran), and the
// laptop recording the real arrival time before the working window opens.

const test = require('node:test');
const assert = require('node:assert');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('hr_present_days');

const { app } = require('../src/server');
const { db } = require('../src/db');
const A = require('../src/domain/attendance');
const P = require('../src/domain/presence');
const T = require('../src/util/time');

const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
const MIN = 60 * 1000;
// Wednesday 23 Sep 2026, Asia/Karachi; the test shift is 11:00-19:00.
const DAY = '2026-09-23';
const at = (hhmm, day = DAY) => T.wallClockToEpoch(day, hhmm);
let clock = at('08:00');
const realNow = T.now;
let base, server;

test.before(async () => {
  T.now = () => clock;
  await prepareDatabase();
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  T.now = realNow;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  await dropDatabase();
});

const json = async (method, url, { headers = {}, body } = {}) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

async function makeEmployee(id) {
  await db.prepare('INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?)')
    .run(id, 'Test ' + id, 'Engineering', T.now(), T.now());
  await db.prepare(`INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
    VALUES (?, ?, 'Engineer', 'Full-time', '2026-01-01', '2026-01-01', ?)`).run('er_' + id, id, T.now());
  return id;
}

async function hrDay(employeeId, day, pairs) {
  let n = 0;
  for (const [a, b] of pairs) {
    for (const [type, t] of [['CLOCK_IN', a], ['CLOCK_OUT', b]]) {
      await db.prepare(`INSERT INTO attendance_events (id, employee_id, date_key, occurred_at, event_type, source, created_at, created_by)
        VALUES (?,?,?,?,?,'HR_RECORDS',?,'test')`).run(`ae_${employeeId}_${day}_${++n}`, employeeId, day, at(t, day), type, T.now());
    }
  }
}

test('a day HR recorded as present, with no tracking, counts the full shift', async () => {
  const emp = await makeEmployee('emp_hr_full');
  const day = '2026-08-12';
  await hrDay(emp, day, [['11:00', '19:00']]);
  const d = await A.deriveDay(emp, day, at('23:00', day));
  assert.equal(d.attendanceStatus, 'PRESENT');
  assert.equal(d.day.workedMinutes, 480);
  assert.equal(d.lateMinutes, 0);
});

test('HR-recorded late arrival and a gap are measured like tracked time', async () => {
  const emp = await makeEmployee('emp_hr_times');
  await hrDay(emp, '2026-05-11', [['11:30', '19:00']]);
  const late = await A.deriveDay(emp, '2026-05-11', at('23:00', '2026-05-11'));
  assert.equal(late.attendanceStatus, 'LATE');
  assert.equal(late.day.workedMinutes, 450);

  // Out at 1pm, back at 5pm.
  await hrDay(emp, '2026-08-20', [['11:00', '13:00'], ['17:00', '19:00']]);
  const gap = await A.deriveDay(emp, '2026-08-20', at('23:00', '2026-08-20'));
  assert.equal(gap.day.workedMinutes, 240);
});

test('on a tracked day the tracker\'s presence wins over HR clock times', async () => {
  const emp = await makeEmployee('emp_hr_tracked');
  const day = '2026-08-13';
  for (let t = at('11:00', day); t <= at('15:00', day); t += 5 * MIN) {
    await P.recordEvent({ employeeId: emp, source: 'APP', srcIp: '192.168.18.59', observedAt: t });
  }
  await hrDay(emp, day, [['11:00', '19:00']]);
  const d = await A.deriveDay(emp, day, at('23:00', day));
  assert.ok(d.day.workedMinutes <= 241, `worked ${d.day.workedMinutes}: presence, not HR's 8 h`);
});

test('the laptop records the arrival time before the working window opens, crediting nothing', async () => {
  const emp = await json('POST', '/api/admin/employees', { headers: ADMIN, body: { name: 'Early Bird', role: 'Engineer' } });
  const employeeId = emp.body.employee.id;
  await db.prepare(`INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
    VALUES (?, ?, 'Engineer', 'Full-time', '2026-01-01', '2026-01-01', ?)`).run('er_' + employeeId, employeeId, T.now());
  const code = await json('POST', `/api/admin/employees/${employeeId}/enrollment-code`, { headers: ADMIN });
  const laptop = await json('POST', '/api/enroll', { body: { code: code.body.code, platform: 'windows', model: 'Latitude' } });
  const auth = { Authorization: `Bearer ${laptop.body.token}` };
  const beat = (body) => json('POST', '/api/desktop/heartbeat', { headers: auth, body: { lockState: 'UNLOCKED', lockDurationSeconds: 0, localIp: '192.168.18.71', ...body } });

  // 07:30 is more than 3 hours before the shift: not an arrival.
  clock = at('07:30');
  await beat({ activeSeconds: 0, idleSeconds: 0 });
  // 10:20, locked: nobody at the laptop.
  clock = at('10:20');
  await beat({ activeSeconds: 0, idleSeconds: 600, lockState: 'LOCKED', lockDurationSeconds: 900 });
  let d = await A.deriveDay(employeeId, DAY, clock);
  assert.equal(d.firstInAt, null, 'neither counts as arrival');

  // 10:25: logged in (the agent's start-up probe), then working.
  clock = at('10:25');
  const probe = await beat({ activeSeconds: 0, idleSeconds: 0 });
  assert.equal(probe.body.workstationStatus, 'OUTSIDE_HOURS', 'still outside the working window');
  clock = at('10:35');
  await beat({ activeSeconds: 600, idleSeconds: 0 });
  d = await A.deriveDay(employeeId, DAY, clock);
  assert.equal(T.displayTime(d.firstInAt), T.displayTime(at('10:25')), 'first-in is the real arrival');
  assert.equal(d.day.workedMinutes, 0, 'nothing worked before the shift');
  const ws = await db.prepare('SELECT active_seconds FROM workstation_sessions WHERE employee_id = ?').get(employeeId);
  assert.equal(Number(ws?.active_seconds || 0), 0, 'laptop counters credit nothing outside hours');

  // Worked time still starts at 11:00.
  for (let t = at('10:45'); t <= at('11:30'); t += 5 * MIN) { clock = t; await beat({ activeSeconds: 300, idleSeconds: 0 }); }
  d = await A.deriveDay(employeeId, DAY, clock);
  assert.equal(T.displayTime(d.firstInAt), T.displayTime(at('10:25')));
  assert.equal(d.lateMinutes, 0);
  assert.ok(d.day.workedMinutes >= 29 && d.day.workedMinutes <= 31, `worked ${d.day.workedMinutes} (from 11:00)`);
});

test('a suspected no-show clears once approved leave covers the day', async () => {
  const emp = await makeEmployee('emp_noshow_leave');
  const day = '2026-09-25';
  await db.prepare(`INSERT INTO absence_records (id, employee_id, date_key, absence_type, detected_at, status)
    VALUES ('ab_test_1', ?, ?, 'SUSPECTED_NO_SHOW', ?, 'PENDING_REVIEW')`).run(emp, day, T.now());
  await db.prepare(`INSERT INTO leave_requests (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days,
    reason, status, is_paid, submitted_at, decided_at, created_at) VALUES ('lr_test_ns', ?, 'annual', ?, ?, 'FULL_DAY', 1, 'test', 'APPROVED', 1, ?, ?, ?)`)
    .run(emp, day, day, T.now(), T.now(), T.now());
  await A.recomputeDay(emp, day, at('23:00', day));
  const left = await db.prepare("SELECT COUNT(*) AS n FROM absence_records WHERE employee_id = ? AND status = 'PENDING_REVIEW'").get(emp);
  assert.equal(Number(left.n), 0);
});

test('HR-excused lateness keeps the arrival time but nothing is late', async () => {
  const emp = await makeEmployee('emp_late_excused');
  const day = '2026-09-14';
  await hrDay(emp, day, [['11:50', '19:00']]);
  const before = await A.deriveDay(emp, day, at('23:00', day));
  assert.equal(before.attendanceStatus, 'LATE');
  await db.prepare(`INSERT INTO attendance_events (id, employee_id, date_key, occurred_at, event_type, source, created_at, created_by)
    VALUES ('ae_excuse_1', ?, ?, ?, 'LATE_EXCUSED', 'HR_RECORDS', ?, 'test')`).run(emp, day, at('11:00', day), T.now());
  const d = await A.deriveDay(emp, day, at('23:00', day));
  assert.equal(d.attendanceStatus, 'PRESENT');
  assert.equal(d.lateMinutes, 0);
  assert.equal(d.isLateOccurrence, false);
  assert.equal(d.lateExcused, true);
  assert.equal(T.displayTime(d.firstInAt), T.displayTime(at('11:50', day)), 'arrival unchanged');
  assert.equal(d.dailyDeficitMinutes, 0);
});

test('Friday prayers: going out 13:00-14:00 is worked, not a gap; the same on Thursday is a gap', async () => {
  const emp = await makeEmployee('emp_friday_gap');
  await hrDay(emp, '2026-09-25', [['11:00', '13:00'], ['14:00', '19:00']]);   // Friday
  const fri = await A.deriveDay(emp, '2026-09-25', at('23:00', '2026-09-25'));
  assert.equal(fri.day.workedMinutes, 480);
  assert.equal(fri.unauthorisedMissingMinutes, 0);
  assert.equal(fri.dailyDeficitMinutes, 0);
  await hrDay(emp, '2026-09-24', [['11:00', '13:00'], ['14:00', '19:00']]);   // Thursday
  const thu = await A.deriveDay(emp, '2026-09-24', at('23:00', '2026-09-24'));
  assert.equal(thu.day.workedMinutes, 420);
  assert.equal(thu.unauthorisedMissingMinutes, 60);
});

test('HR manual time that covers all the lateness: on time, not late; partly covered: still late', async () => {
  const emp = await makeEmployee('emp_hr_late_cover');
  const credit = async (day, mins) => db.prepare(`INSERT INTO attendance_deficit_ledger (id, employee_id, date_key, entry_type, minutes_delta,
      balance_after, whole_days_after, carry_forward_after, description, created_at, created_by)
    VALUES (?, ?, ?, 'HR_ADJUSTMENT', ?, 0, 0, 0, 'HR Manual Entry: arrived on time', ?, 'test')`).run(`def_t_${day}`, emp, day, -mins, T.now());
  await hrDay(emp, '2026-09-21', [['11:30', '19:00']]);   // 20 min late beyond grace
  await credit('2026-09-21', 20);
  const full = await A.deriveDay(emp, '2026-09-21', at('23:00', '2026-09-21'));
  assert.equal(full.isLateOccurrence, false);
  assert.equal(full.attendanceStatus, 'RECOVERED');
  assert.equal(full.dailyDeficitMinutes, 0);

  await hrDay(emp, '2026-09-22', [['11:30', '19:00']]);
  await credit('2026-09-22', 10);
  const part = await A.deriveDay(emp, '2026-09-22', at('23:00', '2026-09-22'));
  assert.equal(part.attendanceStatus, 'LATE');
  assert.equal(part.dailyDeficitMinutes, 10);
});
