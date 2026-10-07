// Support for seeding HR's 2026 attendance workbook (and HR practice going
// forward): payroll's go-live date, carry-forward above 5 days, part-time
// pro-rata leave, work-from-home days, and the opening-balance history lock.

const test = require('node:test');
const assert = require('node:assert');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('hr_workbook');

test.before(prepareDatabase);
test.after(dropDatabase);

const { db } = require('../src/db');
const L = require('../src/domain/leave');
const A = require('../src/domain/attendance');
const P = require('../src/domain/presence');
const PR = require('../src/domain/payroll');
const schedule = require('../src/domain/schedule');
const T = require('../src/util/time');

const MIN = 60 * 1000;

async function makeEmployee(id, startDate, { type = 'Full-time', probationReview = null, entitlement = 20 } = {}) {
  await db.prepare('INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?)')
    .run(id, 'Test ' + id, 'Engineering', T.now(), T.now());
  await db.prepare(`
    INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from,
      probation_start_date, probation_review_date, holiday_entitlement_days, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run('er_' + id, id, 'Engineer', type, startDate, startDate,
    probationReview ? startDate : null, probationReview, entitlement, T.now());
  return id;
}

async function addRequest(employeeId, typeId, start, end, totalDays, isPaid) {
  const id = 'lr_' + employeeId + '_' + start + '_' + typeId;
  await db.prepare(`
    INSERT INTO leave_requests (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days,
      reason, status, is_paid, submitted_at, decided_at, created_at)
    VALUES (?,?,?,?,?,'FULL_DAY',?,?,'APPROVED',?,?,?,?)
  `).run(id, employeeId, typeId, start, end, totalDays, 'test', isPaid, T.now(), T.now(), T.now());
  return id;
}

// ---------------------------------------------------------------------------
// Payroll go-live date
// ---------------------------------------------------------------------------

test('payroll go-live: only unpaid days on or after it are deducted', async () => {
  const emp = await makeEmployee('emp_golive2', '2025-01-01');
  await addRequest(emp, 'unpaid', '2026-07-22', '2026-07-24', 3, 0);
  await addRequest(emp, 'unpaid', '2026-09-30', '2026-09-30', 1, 0);

  const before = await PR.unpaidDaysSummary({ employeeId: emp, windowEnd: '2026-09-30', dailyPrecise: 100 });
  assert.equal(before.totalDays, 4, 'with no go-live date every unpaid day is in scope');

  await db.prepare("INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES ('payroll_go_live_date', '2026-09-01', 0, 'test') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value").run();
  try {
    const after = await PR.unpaidDaysSummary({ employeeId: emp, windowEnd: '2026-09-30', dailyPrecise: 100 });
    assert.equal(after.totalDays, 1, 'July was settled before payroll went live');
  } finally {
    await db.prepare("DELETE FROM org_settings WHERE key = 'payroll_go_live_date'").run();
  }
});

// ---------------------------------------------------------------------------
// Carry-forward above 5 days
// ---------------------------------------------------------------------------

test('management can approve more than 5 days to carry forward', async () => {
  const emp = await makeEmployee('emp_cf7', '2025-10-01');
  // The closing cycle is fully accrued (20) with 13 days used.
  await L.balanceFor(emp, '2026-09-29');
  await addRequest(emp, 'annual', '2025-11-06', '2025-11-06', 13, 1);
  const rec = await L.recordCarryForwardApproval({ employeeId: emp, approvedDays: 7, actor: 'test', today: '2026-09-29' });
  assert.ok(rec, 'recorded');
  await L.rolloverHolidayYear(emp, '2026-10-02');
  const co = await db.prepare("SELECT SUM(days_delta) AS d FROM leave_accrual_ledger WHERE employee_id = ? AND entry_type = 'CARRY_OVER'").get(emp);
  assert.equal(Number(co.d), 7);
  const lapsed = await db.prepare("SELECT COALESCE(SUM(days_delta), 0) AS d FROM leave_accrual_ledger WHERE employee_id = ? AND entry_type = 'FORFEIT'").get(emp);
  assert.equal(Number(lapsed.d), 0, 'nothing lapses: all 7 unused days were approved');
});

test('carry-forward is still limited to the leave actually unused', async () => {
  const emp = await makeEmployee('emp_cf_limit', '2025-10-01');
  await L.balanceFor(emp, '2026-09-29');
  await addRequest(emp, 'annual', '2025-11-06', '2025-11-06', 18, 1);
  await assert.rejects(
    () => L.recordCarryForwardApproval({ employeeId: emp, approvedDays: 7, actor: 'test', today: '2026-09-29' }),
    /only has 2\.00 days available/,
  );
});

// ---------------------------------------------------------------------------
// Part-time pro-rata leave
// ---------------------------------------------------------------------------

test('a part-time arrangement is pro-rata for the whole cycle it falls in', async () => {
  // Joined 6 Jul 2026 on probation (full-time record), part-time at 50% from 8 Sep.
  const emp = await makeEmployee('emp_pt', '2026-07-06', { type: 'Probationary', probationReview: '2027-01-06' });
  await db.prepare(`
    INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from,
      holiday_entitlement_days, created_at)
    VALUES ('er_emp_pt_2', ?, 'Engineer', 'Part-time', '2026-07-06', '2026-09-08', 10, ?)
  `).run(emp, T.now() + 1);

  const b = await L.balanceFor(emp, '2026-10-07');
  assert.equal(b.annualEntitlementDays, 10, 'the cycle entitlement is the part-time 10 days');
  // 3 probation months completed at 5/6 = 0.83 a month.
  assert.equal(b.precise.accruedDays.toFixed(2), '2.50');
});

test('a full-timer on probation still earns 10 over 6 months', async () => {
  const emp = await makeEmployee('emp_ft_prob', '2026-07-06', { type: 'Probationary', probationReview: '2027-01-06' });
  const b = await L.balanceFor(emp, '2026-10-07');
  assert.equal(b.annualEntitlementDays, 20);
  assert.equal(b.precise.accruedDays.toFixed(2), '5.00');
});

// ---------------------------------------------------------------------------
// Work from home
// ---------------------------------------------------------------------------

test('work from home is a working day, never leave used', async () => {
  const emp = await makeEmployee('emp_wfh', '2026-01-01');
  await L.balanceFor(emp, '2026-10-07');
  await addRequest(emp, 'wfh', '2026-10-06', '2026-10-09', 4, 1);

  assert.equal(await schedule.leaveOn(emp, '2026-10-06'), null, 'not a leave day');
  assert.equal(await schedule.wfhOn(emp, '2026-10-06'), true);
  assert.equal(await schedule.wfhOn(emp, '2026-10-10'), false);

  const b = await L.balanceFor(emp, '2026-10-07');
  assert.equal(b.takenDays + b.bookedDays, 0, 'WFH days do not use annual leave');
});

test('approving work from home through the normal flow books no leave', async () => {
  const emp = await makeEmployee('emp_wfh2', '2026-01-01');
  await L.balanceFor(emp, '2026-10-07');
  const r = await L.submitRequest({ employeeId: emp, leaveTypeId: 'wfh', startDate: '2026-10-12', endDate: '2026-10-13', reason: 'Plumber visit' });
  await L.decideRequest({ requestId: r.id, decision: 'APPROVED', notes: 'ok', actor: 'test' });
  const booked = await db.prepare("SELECT COUNT(*) AS n FROM leave_accrual_ledger WHERE employee_id = ? AND entry_type = 'BOOKED'").get(emp);
  assert.equal(Number(booked.n), 0);
  const b = await L.balanceFor(emp, '2026-10-07');
  assert.equal(b.takenDays + b.bookedDays, 0);
});

// ---------------------------------------------------------------------------
// Opening-balance history lock
// ---------------------------------------------------------------------------

test('days covered by HR\'s opening balance are not re-posted on recompute', async () => {
  const emp = await makeEmployee('emp_lock', '2026-01-01');
  const day = '2026-09-23';
  const at = (hhmm) => T.wallClockToEpoch(day, hhmm);
  // Present 11:00-17:00: two hours of early departure.
  for (let t = at('11:00'); t <= at('17:00'); t += 5 * MIN) {
    await P.recordEvent({ employeeId: emp, source: 'APP', srcIp: '192.168.18.59', observedAt: t });
  }
  await A.recomputeDay(emp, day, T.endOfDay(day) + MIN);
  const posted = await A.balanceFor(emp, T.endOfDay(day) + MIN, false);
  assert.ok(posted.balanceMinutes > 0, 'the day posted a deficit');

  // HR's records settle everything up to 2 Oct at 30 minutes.
  await db.prepare(`
    INSERT INTO attendance_deficit_ledger (id, employee_id, date_key, entry_type, minutes_delta, balance_after,
      whole_days_after, carry_forward_after, description, created_at, created_by)
    VALUES ('def_test_open', ?, '2026-10-02', 'HR_OPENING_BALANCE', ?, 30, 0, 30, 'HR records', ?, 'test')
  `).run(emp, 30 - posted.balanceMinutes, T.endOfDay(day) + 2 * MIN);

  // A later recompute of that September day (e.g. a correction) changes its deficit...
  await P.recordEvent({ employeeId: emp, source: 'APP', srcIp: '192.168.18.59', observedAt: at('18:30') });
  await A.recomputeDay(emp, day, T.endOfDay(day) + 3 * MIN);
  // ...but posts nothing: HR's figure stands.
  const after = await A.balanceFor(emp, T.endOfDay(day) + 3 * MIN, false);
  assert.equal(after.balanceMinutes, 30);
});

test('on an approved WFH day an office-based employee\'s off-site phone time is counted', async () => {
  const { app } = require('../src/server');
  const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (method, url, { headers = {}, body } = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    const emp = await json('POST', '/api/admin/employees', { headers: ADMIN, body: { name: 'Home Worker', role: 'Engineer' } });
    const employeeId = emp.body.employee.id;
    await db.prepare(`INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
      VALUES (?, ?, 'Engineer', 'Full-time', '2026-01-01', '2026-01-01', ?)`).run('er_' + employeeId, employeeId, T.now());
    const code = await json('POST', `/api/admin/employees/${employeeId}/enrollment-code`, { headers: ADMIN });
    const phone = await json('POST', '/api/enroll', { body: { code: code.body.code, platform: 'android', model: 'Pixel' } });
    const auth = { Authorization: `Bearer ${phone.body.token}` };
    const homeIp = '10.20.30.40';   // not an office network

    // Without WFH the off-site ping is REMOTE (not counted).
    await json('POST', '/api/attendance/ping', { headers: auth, body: { localIp: homeIp } });
    let last = await db.prepare('SELECT location FROM presence_events WHERE employee_id = ? ORDER BY observed_at DESC LIMIT 1').get(employeeId);
    assert.equal(last.location, 'REMOTE');

    // HR records WFH for today; the next off-site ping is counted.
    const today = T.dateKey();
    const r = await json('POST', `/api/leave/employee/${employeeId}/request`, {
      headers: ADMIN, body: { leaveTypeId: 'wfh', startDate: today, endDate: today, reason: 'Working from home' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await new Promise(res => setTimeout(res, 1100));   // a distinct second for the dedupe key
    await json('POST', '/api/attendance/ping', { headers: auth, body: { localIp: homeIp } });
    last = await db.prepare('SELECT location FROM presence_events WHERE employee_id = ? ORDER BY observed_at DESC LIMIT 1').get(employeeId);
    assert.equal(last.location, 'REMOTE_VERIFIED');
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
