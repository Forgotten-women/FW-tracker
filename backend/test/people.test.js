// Employee master record and profile tests. Spec sections 4, 31, 37.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('people');

test.before(prepareDatabase);


const { db } = require('../src/db');
const people = require('../src/domain/people');
const leave = require('../src/domain/leave');
const T = require('../src/util/time');

async function makeEmployee(id, name = 'Test Person') {
  await db.prepare(
    'INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = EXCLUDED.active, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at'
  ).run(id, name, 'Engineering', T.now(), T.now());
  return id;
}

test.after(dropDatabase);

// ---------------------------------------------------------------------------
// Employment records (spec 4.2, 31)
// ---------------------------------------------------------------------------

test('setting an employment record requires a start date and a reason', async () => {
  const emp = await makeEmployee('emp_er');
  await assert.rejects(async () => await people.setEmployment({ employeeId: emp, jobTitle: 'Eng', changeReason: 'x', actor: 'hr' }), /startDate/);
  await assert.rejects(async () => await people.setEmployment({ employeeId: emp, jobTitle: 'Eng', startDate: '2025-01-01', actor: 'hr' }), /reason/i);
});

test('the first employment record sets the start date that unblocks leave', async () => {
  const emp = await makeEmployee('emp_unblock');
  assert.equal(await (await leave.holidayYearFor(emp, '2025-06-01')).blocked, true, 'blocked before');

  await people.setEmployment({
    employeeId: emp, jobTitle: 'Engineer', startDate: '2025-01-01',
    changeReason: 'New hire', actor: 'user:hr',
  });

  const year = await leave.holidayYearFor(emp, '2025-06-01');
  assert.equal(year.blocked, false, 'unblocked once a start date exists');
  assert.equal(year.yearStart, '2025-01-01');
});

test('a change in terms is versioned, never overwritten', async () => {
  const emp = await makeEmployee('emp_promo');
  await people.setEmployment({ employeeId: emp, jobTitle: 'Engineer', startDate: '2025-01-01', changeReason: 'Hire', actor: 'hr' });
  await people.setEmployment({
    employeeId: emp, jobTitle: 'Senior Engineer', startDate: '2025-01-01',
    effectiveFrom: '2026-06-01', changeReason: 'Promotion', actor: 'hr',
  });

  const history = await people.employmentHistory(emp);
  assert.equal(history.length, 2, 'both records kept');
  assert.equal(await (await people.currentEmployment(emp)).job_title, 'Senior Engineer');
  const old = history.find(h => h.job_title === 'Engineer');
  assert.equal(old.effective_to, '2026-05-31', 'the old record is closed the day before the new one');
});

test('an invalid employment type is rejected', async () => {
  const emp = await makeEmployee('emp_type');
  await assert.rejects(
    async () => await people.setEmployment({ employeeId: emp, jobTitle: 'X', startDate: '2025-01-01', employmentType: 'Freelance-ish', changeReason: 'x', actor: 'hr' }),
    /employmentType/,
  );
});

// ---------------------------------------------------------------------------
// Status (spec 4.3, 27)
// ---------------------------------------------------------------------------

test('a status change is recorded in history and requires a reason', async () => {
  const emp = await makeEmployee('emp_status');
  await assert.rejects(async () => await people.setStatus({ employeeId: emp, status: 'Suspended', actor: 'hr' }), /reason/i);

  await people.setStatus({ employeeId: emp, status: 'Probation', reason: 'Standard 3-month probation', actor: 'user:hr' });
  const row = await db.prepare('SELECT * FROM employees WHERE id = ?').get(emp);
  assert.equal(row.employment_status, 'Probation');

  const hist = await db.prepare('SELECT * FROM employment_status_history WHERE employee_id = ?').all(emp);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].to_status, 'Probation');
});

// Spec 27: a leaver loses access immediately.
test('marking someone a leaver deactivates them and revokes their devices', async () => {
  const emp = await makeEmployee('emp_leaver');
  await db.prepare(`
    INSERT INTO devices (id, employee_id, platform, model, enrolled_at) VALUES (?,?,?,?,?)
  `).run('dev_leaver', emp, 'android', 'X', T.now());
  await db.prepare(`
    INSERT INTO device_tokens (token_hash, device_id, issued_at) VALUES (?,?,?)
  `).run('hash_leaver', 'dev_leaver', T.now());

  await people.setStatus({ employeeId: emp, status: 'Left employment', reason: 'Resigned', actor: 'user:hr' });

  assert.equal((await db.prepare('SELECT active FROM employees WHERE id = ?').get(emp)).active, 0);
  assert.ok((await db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get('dev_leaver')).revoked_at);
  assert.ok((await db.prepare('SELECT revoked_at FROM device_tokens WHERE token_hash = ?').get('hash_leaver')).revoked_at);
});

// ---------------------------------------------------------------------------
// Sensitive detail groups
// ---------------------------------------------------------------------------

test('personal and bank details are stored, and bank values never hit the audit log', async () => {
  const emp = await makeEmployee('emp_sensitive');
  await people.setPersonal({ employeeId: emp, fields: { dateOfBirth: '1990-01-01', city: 'London', nationalId: 'AB123456C' }, actor: 'user:hr' });
  await people.setBank({ employeeId: emp, fields: { accountNumber: '12345678', sortCode: '11-22-33', bankName: 'Test Bank' }, actor: 'user:hr' });

  const p = await db.prepare('SELECT * FROM employee_personal WHERE employee_id = ?').get(emp);
  assert.equal(p.city, 'London');
  assert.equal(p.national_id, 'AB123456C');

  // The audit log records THAT bank details changed, never the numbers.
  const bankAudit = await db.prepare("SELECT * FROM audit_log WHERE action = 'BANK_UPDATED'").all();
  assert.ok(bankAudit.length >= 1);
  for (const a of bankAudit) {
    const blob = `${a.before_json || ''}${a.after_json || ''}${a.note || ''}`;
    assert.ok(!blob.includes('12345678'), 'the account number must not appear in the audit log');
  }
});

test('a primary emergency contact demotes any previous primary', async () => {
  const emp = await makeEmployee('emp_ec');
  await people.addEmergencyContact({ employeeId: emp, name: 'First', isPrimary: true, actor: 'hr' });
  await people.addEmergencyContact({ employeeId: emp, name: 'Second', isPrimary: true, actor: 'hr' });

  const primaries = await db.prepare('SELECT name FROM emergency_contacts WHERE employee_id = ? AND is_primary = 1').all(emp);
  assert.equal(primaries.length, 1, 'only one primary at a time');
  assert.equal(primaries[0].name, 'Second');
});

// ---------------------------------------------------------------------------
// The consolidated profile (spec 37) - the permission gating is the point
// ---------------------------------------------------------------------------

test('a profile includes only the field groups the caller may see', async () => {
  const emp = await makeEmployee('emp_profile', 'Alice Example');
  await people.setEmployment({ employeeId: emp, jobTitle: 'Engineer', startDate: '2025-01-01', changeReason: 'Hire', actor: 'hr' });
  await people.setPersonal({ employeeId: emp, fields: { city: 'Karachi' }, actor: 'hr' });
  await people.setBank({ employeeId: emp, fields: { bankName: 'Bank' }, actor: 'hr' });
  await people.addEmergencyContact({ employeeId: emp, name: 'Kin', actor: 'hr' });

  // A manager: basic employment, but none of the sensitive groups.
  const asManager = await people.profile(emp, { permissions: new Set(['employee.read']) });
  assert.equal(asManager.name, 'Alice Example');
  assert.equal(asManager.employment.jobTitle, 'Engineer');
  assert.equal(asManager.personal, undefined, 'no personal without the permission');
  assert.equal(asManager.bank, undefined, 'no bank without the permission');
  assert.equal(asManager.emergencyContacts, undefined);
  assert.ok(asManager.restricted.includes('bank details'));
  assert.ok(asManager.restricted.includes('personal details'));

  // HR: the sensitive groups appear.
  const asHr = await people.profile(emp, {
    permissions: new Set(['employee.read', 'employee.personal.read', 'employee.bank.read', 'employee.nextofkin.read']),
  });
  assert.equal(asHr.personal.city, 'Karachi');
  assert.equal(asHr.bank.bankName, 'Bank');
  assert.equal(asHr.emergencyContacts.length, 1);
  assert.ok(!asHr.restricted.includes('bank details'));
});

test('a profile for an unknown employee is null', async () => {
  assert.equal(await people.profile('ghost', { permissions: new Set(['employee.read']) }), null);
});

// ---------------------------------------------------------------------------
// Org structure
// ---------------------------------------------------------------------------

test('departments and offices can be created and listed', async () => {
  await people.createOffice({ name: 'Karachi Office', timeZone: 'Asia/Karachi', actor: 'user:hr' });
  await people.createDepartment({ name: 'Engineering', actor: 'user:hr' });

  assert.ok(await (await people.listOffices()).some(o => o.name === 'Karachi Office'));
  assert.ok(await (await people.listDepartments()).some(d => d.name === 'Engineering'));
});

test('a manager assignment is scoped and cannot be self-referential', async () => {
  const mgr = await makeEmployee('emp_mgr2', 'Manager');
  const rpt = await makeEmployee('emp_rpt2', 'Report');

  await assert.rejects(async () => await people.assignManager({ managerEmployeeId: mgr, employeeId: mgr, actor: 'hr' }), /themselves/);

  await people.assignManager({ managerEmployeeId: mgr, employeeId: rpt, actor: 'user:hr' });
  const rbac = require('../src/domain/rbac');


  const managerUser = { roles: ['manager'], employeeId: mgr };
  assert.equal(await rbac.canAccessEmployee(managerUser, rpt), true, 'now manages the report');

  await people.endManagerAssignment({ managerEmployeeId: mgr, employeeId: rpt, actor: 'user:hr' });
  assert.equal(await rbac.canAccessEmployee(managerUser, rpt), false, 'no longer manages them');
});

test('the master-record lifecycle is audited', async () => {
  const actions = (await db.prepare('SELECT DISTINCT action FROM audit_log').all()).map(r => r.action);
  for (const expected of [
    'EMPLOYMENT_CREATED', 'EMPLOYMENT_UPDATED', 'STATUS_CHANGED',
    'PERSONAL_UPDATED', 'BANK_UPDATED', 'MANAGER_ASSIGNED', 'DEPARTMENT_CREATED', 'OFFICE_CREATED',
  ]) {
    assert.ok(actions.includes(expected), `missing audit action: ${expected}`);
  }
});
