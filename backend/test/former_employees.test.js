// Former employees (HR update, 2026-11-17): separated from the live
// workforce, history kept, rehire keeps the Employee ID, IDs never reused.

const test = require('node:test');
const assert = require('node:assert');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('former_employees');

const { app } = require('../src/server');
const { db } = require('../src/db');
const people = require('../src/domain/people');
const P = require('../src/domain/presence');
const T = require('../src/util/time');

const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
let server;
let base;

test.before(async () => {
  await prepareDatabase();
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  await dropDatabase();
});

const call = async (method, url, body) => {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...ADMIN }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function makeEmployee(name, number, startDate = '2025-01-06') {
  const r = await call('POST', '/api/admin/employees', { name, role: 'Engineer', employeeNumber: number, startDate });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.employee.id;
  await db.prepare(`
    INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING
  `).run('er_' + id, id, 'Engineer', 'Full-time', startDate, startDate, T.now());
  return id;
}

const yesterday = () => T.dateKey(T.now() - 86_400_000);
const tomorrow = () => T.dateKey(T.now() + 86_400_000);

test('a former employee leaves the live workforce but keeps every record', async () => {
  const id = await makeEmployee('Former Fatima', 'PK901');
  const before = (await P.liveBoard()).map(e => e.employeeId);
  assert.ok(before.includes(id), 'on the board while employed');

  await assert.rejects(people.setStatus({ employeeId: id, status: 'Former employee', reason: 'Resigned', actor: 'test' }), /final employment date/i);
  await assert.rejects(people.setStatus({ employeeId: id, status: 'Former employee', finalEmploymentDate: yesterday(), reason: '', actor: 'test' }), /reason/i);

  const r = await people.setStatus({
    employeeId: id, status: 'Former employee', finalEmploymentDate: yesterday(), reason: 'Resigned', approvedBy: 'HR Manager', actor: 'user:hr',
  });
  assert.equal(r.status, 'Former employee');
  assert.equal(r.scheduled, false);

  const after = (await P.liveBoard()).map(e => e.employeeId);
  assert.ok(!after.includes(id), 'not in any live category');

  const emp = await db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  assert.equal(emp.active, 0);
  assert.equal(emp.employee_number, 'PK901', 'the record and its ID remain');
  assert.equal(emp.final_employment_date, yesterday());

  const list = await call('GET', '/api/admin/former-employees?q=pk901');
  assert.equal(list.status, 200);
  assert.equal(list.body.count, 1);
  assert.equal(list.body.employees[0].employmentStatus, 'Former employee');
  assert.equal(list.body.employees[0].finalEmploymentDate, yesterday());
  assert.equal(list.body.employees[0].employmentStartDate, '2025-01-06');
  assert.equal(list.body.employees[0].updatedBy, 'user:hr');

  const summary = await call('GET', '/api/dashboard/summary');
  assert.equal(summary.body.stats.formerEmployees >= 1, true, 'shown as its own count');
  assert.ok(!summary.body.notArrived.some(e => e.employeeId === id), 'not "Not arrived"');

  const history = await db.prepare("SELECT * FROM employment_status_history WHERE employee_id = ? AND to_status = 'Former employee'").all(id);
  assert.equal(history.length, 1);
  assert.match(history[0].reason, /approved by HR Manager/);
});

test('a final date still ahead keeps them working until it passes', async () => {
  const id = await makeEmployee('Notice Nadia', 'PK902');
  const r = await people.setStatus({
    employeeId: id, status: 'Former employee', finalEmploymentDate: tomorrow(), reason: 'Contract ending', actor: 'user:hr',
  });
  assert.equal(r.scheduled, true);
  assert.ok((await P.liveBoard()).some(e => e.employeeId === id), 'still employed until the final date');

  // Two days later the daily job moves them.
  const later = T.now() + 2 * 86_400_000;
  const moved = await people.applyScheduledFormerEmployees(later);
  assert.equal(moved.moved, 1);
  const emp = await db.prepare('SELECT active, employment_status, former_pending FROM employees WHERE id = ?').get(id);
  assert.deepEqual({ ...emp }, { active: 0, employment_status: 'Former employee', former_pending: 0 });
});

test('rehiring keeps the same permanent Employee ID and the earlier history', async () => {
  const id = await makeEmployee('Rehire Rabia', 'PK903');
  await people.setStatus({ employeeId: id, status: 'Former employee', finalEmploymentDate: yesterday(), reason: 'Left', actor: 'user:hr' });
  const r = await people.setStatus({ employeeId: id, status: 'Active', reason: 'Rehired for the new project', actor: 'user:hr' });
  assert.equal(r.rehired, true);
  const emp = await db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  assert.equal(emp.active, 1);
  assert.equal(emp.employee_number, 'PK903');
  assert.ok((await P.liveBoard()).some(e => e.employeeId === id));
  const steps = (await db.prepare('SELECT to_status FROM employment_status_history WHERE employee_id = ? ORDER BY changed_at, id').all(id)).map(r => r.to_status);
  assert.deepEqual(steps, ['Former employee', 'Active'], 'both changes kept');
});

test('an Employee ID is never reused, even when its owner has left', async () => {
  const dup = await call('POST', '/api/admin/employees', { name: 'New Joiner', role: 'Engineer', employeeNumber: 'pk901' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.message, 'Employee ID already assigned. Please use a new Employee ID.');

  const fresh = await call('POST', '/api/admin/employees', { name: 'Next Joiner', role: 'Engineer' });
  assert.equal(fresh.status, 201);
  assert.ok(!['PK901', 'PK902', 'PK903'].includes(fresh.body.employee.employeeNumber), 'a new, unused ID');

  const edit = await call('PATCH', `/api/admin/employees/${fresh.body.employee.id}`, { employeeNumber: 'PK777' });
  assert.equal(edit.status, 400, 'an assigned ID cannot be changed');
});
