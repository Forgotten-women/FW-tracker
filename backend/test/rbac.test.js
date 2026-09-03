// Access-control tests.
//
// Spec section 34 requires: an employee cannot access another employee's
// information, a manager cannot access restricted HR documents without
// permission, and every HR edit is auditable. Those are the tests here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTestDatabase, prepareDatabase, dropDatabase, tableInfo } = require('./helpers/pg');
useTestDatabase('rbac');

test.before(prepareDatabase);


const { db } = require('../src/db');
const rbac = require('../src/domain/rbac');
const T = require('../src/util/time');

const PASSWORD = 'a-long-enough-passphrase';

async function makeEmployee(id, name) {
  await db.prepare(
    'INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = EXCLUDED.active, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at'
  ).run(id, name, 'Staff', T.now(), T.now());
  return id;
}

async function assign(managerEmployeeId, employeeId) {
  await db.prepare(
    'INSERT INTO manager_assignments (manager_employee_id, employee_id, assigned_at) VALUES (?,?,?) ON CONFLICT (manager_employee_id, employee_id) DO UPDATE SET assigned_at = EXCLUDED.assigned_at'
  ).run(managerEmployeeId, employeeId, T.now());
}

// Three employees: a manager, one of their reports, and an unrelated person.
const EMP_MANAGER = makeEmployee('emp_mgr', 'Manager Person');
const EMP_REPORT = makeEmployee('emp_report', 'Reporting Person');
const EMP_OTHER = makeEmployee('emp_other', 'Unrelated Person');
assign(EMP_MANAGER, EMP_REPORT);

const employeeUser = rbac.createUser({
  email: 'employee@test.org', displayName: 'Employee', password: PASSWORD,
  roles: ['employee'], employeeId: EMP_REPORT,
});
const managerUser = rbac.createUser({
  email: 'manager@test.org', displayName: 'Manager', password: PASSWORD,
  roles: ['manager'], employeeId: EMP_MANAGER,
});
const hrUser = rbac.createUser({
  email: 'hr@test.org', displayName: 'HR', password: PASSWORD, roles: ['hr'],
});
const adminUser = rbac.createUser({
  email: 'admin@test.org', displayName: 'Admin', password: PASSWORD, roles: ['super_admin'],
});

const asEmployee = async () => await rbac.describeUser(employeeUser.id);
const asManager = async () => await rbac.describeUser(managerUser.id);
const asHr = async () => await rbac.describeUser(hrUser.id);
const asAdmin = async () => await rbac.describeUser(adminUser.id);

test.after(dropDatabase);

// ---------------------------------------------------------------------------
// Employee isolation
// ---------------------------------------------------------------------------

test('an employee can see only their own record', async () => {
  const me = await asEmployee();
  assert.equal(await rbac.canAccessEmployee(me, EMP_REPORT), true);
  assert.equal(await rbac.canAccessEmployee(me, EMP_OTHER), false);
  assert.equal(await rbac.canAccessEmployee(me, EMP_MANAGER), false);
  assert.deepEqual(await rbac.accessibleEmployeeIds(me), [EMP_REPORT]);
});

test('an employee holds no permission over anyone else', async () => {
  const p = await (await asEmployee()).permissions;
  for (const forbidden of [
    'employee.read', 'employee.write', 'attendance.write', 'leave.approve',
    'warning.issue', 'payroll.read', 'settings.write', 'user.manage', 'audit.read',
  ]) {
    assert.equal(p.has(forbidden), false, `employee must not hold ${forbidden}`);
  }
  assert.equal(p.has('self.read'), true);
  assert.equal(p.has('self.leave.request'), true);
});

// ---------------------------------------------------------------------------
// Manager scoping
// ---------------------------------------------------------------------------

test('a manager sees assigned reports and nobody else', async () => {
  const me = await asManager();
  assert.equal(await rbac.canAccessEmployee(me, EMP_REPORT), true, 'their own report');
  assert.equal(await rbac.canAccessEmployee(me, EMP_MANAGER), true, 'themselves');
  assert.equal(await rbac.canAccessEmployee(me, EMP_OTHER), false, 'an unrelated employee');

  const visible = await (await rbac.accessibleEmployeeIds(me)).sort();
  assert.deepEqual(visible, [EMP_MANAGER, EMP_REPORT].sort());
});

// Spec 3.2 lists exactly what a manager must NOT automatically receive.
test('a manager gets no sensitive personal data by default', async () => {
  const p = await (await asManager()).permissions;
  const mustNotHave = [
    'employee.identity.read',   // passport / ID
    'employee.personal.read',   // home address, date of birth
    'employee.bank.read',       // bank details
    'employee.nextofkin.read',  // next of kin
    'employee.medical.read',    // medical information
    'employee.salary.read',     // salary
  ];
  for (const perm of mustNotHave) {
    assert.equal(p.has(perm), false, `spec 3.2: manager must not hold ${perm} by default`);
  }
  // But they can still do the operational job.
  assert.equal(p.has('attendance.read'), true);
  assert.equal(p.has('leave.approve'), true);
});

test('an explicit grant gives one manager one sensitive permission', async () => {
  assert.equal(await (await asManager()).permissions.has('employee.personal.read'), false);

  await db.prepare(`
    INSERT INTO user_permission_grants (user_id, permission_id, granted_at, granted_by, reason)
    VALUES (?,?,?,?,?)
  `).run(managerUser.id, 'employee.personal.read', T.now(), 'hr', 'Emergency contact duty');

  assert.equal(await (await asManager()).permissions.has('employee.personal.read'), true);
  // A grant widens WHICH FIELDS, never WHICH PEOPLE.
  assert.equal(await rbac.canAccessEmployee(await asManager(), EMP_OTHER), false);
});

test('an expired grant stops applying', async () => {
  await db.prepare(`
    INSERT INTO user_permission_grants (user_id, permission_id, granted_at, granted_by, expires_at, reason)
    VALUES (?,?,?,?,?,?) ON CONFLICT (user_id, permission_id) DO UPDATE SET granted_at = EXCLUDED.granted_at, granted_by = EXCLUDED.granted_by, expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason
  `).run(managerUser.id, 'employee.salary.read', T.now() - 1000, 'hr', T.now() - 1, 'Expired');

  assert.equal(await (await asManager()).permissions.has('employee.salary.read'), false);
});

// ---------------------------------------------------------------------------
// HR and Super Admin
// ---------------------------------------------------------------------------

test('HR reaches the whole workforce and sensitive data', async () => {
  const me = await asHr();
  for (const e of [EMP_MANAGER, EMP_REPORT, EMP_OTHER]) {
    assert.equal(await rbac.canAccessEmployee(me, e), true);
  }
  for (const perm of ['employee.personal.read', 'employee.salary.read', 'payroll.read', 'warning.issue']) {
    assert.equal(me.permissions.has(perm), true, `HR should hold ${perm}`);
  }
});

// Least privilege: HR administers people, Super Admin sets the rules that
// decide who is late and whose pay is affected. Those are different jobs.
test('HR cannot change policy or manage user accounts', async () => {
  const p = await (await asHr()).permissions;
  assert.equal(p.has('settings.write'), false);
  assert.equal(p.has('user.manage'), false);

  const admin = await (await asAdmin()).permissions;
  assert.equal(admin.has('settings.write'), true);
  assert.equal(admin.has('user.manage'), true);
});

// ---------------------------------------------------------------------------
// Passwords and sessions
// ---------------------------------------------------------------------------

test('passwords are salted, and never recoverable from storage', async () => {
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(hrUser.id);
  assert.ok(row.password_hash.startsWith('scrypt$'));
  assert.ok(!row.password_hash.includes(PASSWORD), 'the password must not appear in storage');

  // Same password, different users, different hashes - so the salt is real.
  const other = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(adminUser.id);
  assert.notEqual(row.password_hash, other.password_hash);
});

test('the password policy rejects weak choices', async () => {
  assert.ok(rbac.passwordProblems('short').length > 0);
  assert.ok(rbac.passwordProblems('1234567890123').length > 0, 'digits only');
  assert.ok(rbac.passwordProblems('myforgottenwomenpass').length > 0, 'contains the org name');
  assert.equal(rbac.passwordProblems('a-perfectly-fine-passphrase').length, 0);
});

test('sign-in issues a working session, and the wrong password does not', async () => {
  const ok = await rbac.login({ email: 'hr@test.org', password: PASSWORD, ip: '127.0.0.1' });
  assert.ok(ok.token);
  const resolved = await rbac.resolveSession(ok.token);
  assert.equal(resolved.id, hrUser.id);
  assert.equal(resolved.roles.includes('hr'), true);

  await assert.rejects(
    async () => await rbac.login({ email: 'hr@test.org', password: 'wrong-password-entirely' }),
    /incorrect/i,
  );
});

test('a failed sign-in does not reveal whether the account exists', async () => {
  let noSuchUser, wrongPassword;
  try { await rbac.login({ email: 'nobody@test.org', password: 'x'.repeat(20) }); }
  catch (e) { noSuchUser = e.message; }
  try { await rbac.login({ email: 'admin@test.org', password: 'x'.repeat(20) }); }
  catch (e) { wrongPassword = e.message; }

  assert.equal(noSuchUser, wrongPassword,
    'a different message would let an attacker enumerate valid accounts');
});

test('repeated failures lock the account', async () => {
  const email = 'lockme@test.org';
  await rbac.createUser({ email, displayName: 'Lock Me', password: PASSWORD, roles: ['employee'] });

  for (let i = 0; i < rbac.MAX_FAILED_ATTEMPTS; i++) {
    try { await rbac.login({ email, password: 'definitely-wrong-here' }); } catch {}
  }
  // Even the CORRECT password is refused once locked.
  await assert.rejects(async () => await rbac.login({ email, password: PASSWORD }), /locked/i);
});

test('signing out invalidates the token immediately', async () => {
  const { token } = await rbac.login({ email: 'admin@test.org', password: PASSWORD });
  assert.ok(await rbac.resolveSession(token));
  await rbac.revokeSession(token);
  assert.equal(await rbac.resolveSession(token), null);
});

test('changing a password revokes every existing session', async () => {
  const email = 'rotate@test.org';
  const u = await rbac.createUser({ email, displayName: 'Rotate', password: PASSWORD, roles: ['employee'] });
  const a = await (await rbac.login({ email, password: PASSWORD })).token;
  const b = await (await rbac.login({ email, password: PASSWORD })).token;
  assert.ok(await rbac.resolveSession(a) && await rbac.resolveSession(b));

  await rbac.changePassword({
    userId: u.id, currentPassword: PASSWORD,
    newPassword: 'an-entirely-different-passphrase', actor: 'test',
  });

  // A stolen token must not outlive the password it was obtained under.
  assert.equal(await rbac.resolveSession(a), null);
  assert.equal(await rbac.resolveSession(b), null);
});

// Spec 27: immediate account revocation for leavers.
test('deactivating a user kills their sessions at once', async () => {
  const email = 'leaver@test.org';
  const u = await rbac.createUser({ email, displayName: 'Leaver', password: PASSWORD, roles: ['employee'] });
  const token = await (await rbac.login({ email, password: PASSWORD })).token;
  assert.ok(await rbac.resolveSession(token));

  await db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
  assert.equal(await rbac.resolveSession(token), null, 'a leaver must lose access immediately');
});

test('an expired session stops resolving', async () => {
  const { token } = await rbac.login({ email: 'admin@test.org', password: PASSWORD });
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.prepare('UPDATE user_sessions SET expires_at = ? WHERE token_hash = ?').run(T.now() - 1, hash);
  assert.equal(await rbac.resolveSession(token), null);
});

// ---------------------------------------------------------------------------
// Auditability
// ---------------------------------------------------------------------------

test('user creation and password changes are audited', async () => {
  const actions = (await db.prepare('SELECT DISTINCT action FROM audit_log').all()).map(r => r.action);
  assert.ok(actions.includes('USER_CREATED'));
  assert.ok(actions.includes('PASSWORD_CHANGED'));
});

test('sign-in attempts are recorded with their outcome', async () => {
  const outcomes = (await db.prepare('SELECT DISTINCT outcome FROM login_events').all()).map(r => r.outcome);
  assert.ok(outcomes.includes('SUCCESS'));
  assert.ok(outcomes.includes('BAD_PASSWORD'));
  assert.ok(outcomes.includes('NO_USER'), 'attempts against unknown accounts must still be logged');
});

// ---------------------------------------------------------------------------
// Policy decisions the spec leaves open
// ---------------------------------------------------------------------------

// Spec 9.6 and 35: the lateness reset period is explicitly undecided. Seeding a
// default would silently invent policy that decides who gets a warning.
test('confirmed policy is recorded, unconfirmed policy stays undecided', async () => {
  const rule = await db.prepare("SELECT * FROM warning_rules WHERE id = 'wr_lateness'").get();
  assert.equal(rule.threshold, 3, 'spec 9.1: 3 permitted late occurrences');

  // Spec 9.6 said not to hard-code the reset period until the organisation
  // confirmed it. Confirmed on 2026-08-27 as the calendar month.
  assert.equal(rule.monitoring_period, 'CALENDAR_MONTH');

  // What follows a final written warning is still NOT specified, so the
  // escalation sequence must stop rather than invent an outcome.
  const { config } = require('../src/config');


  assert.deepEqual(config.warningEscalationSequence,
    ['INFORMAL_NOTICE', 'FIRST_WRITTEN', 'FINAL_WRITTEN']);

  // And an unauthorised absence still has no automatic consequence.
  for (const k of ['deductAnnualLeave', 'treatAsUnpaid', 'createWarningTrigger']) {
    assert.equal(config.unauthorisedAbsence[k], null,
      `${k} must remain a per-case decision, not a default`);
  }
});

// Spec 10.2 warns that the wording supplied would apply two consequences to one
// absence. They must stay independently switchable.
test('unauthorised-absence consequences are three separate switches', async () => {
  const cols = (await tableInfo('absence_records')).map(c => c.name);
  for (const c of ['deduct_annual_leave', 'treat_as_unpaid', 'create_warning_trigger']) {
    assert.ok(cols.includes(c), `${c} must be independently controllable`);
  }
  // Null, not 0 or 1: nothing is assumed until a human decides.
  const info = await tableInfo('absence_records');
  for (const c of ['deduct_annual_leave', 'treat_as_unpaid', 'create_warning_trigger']) {
    assert.equal(info.find(x => x.name === c).dflt_value, null,
      `${c} must have no default - the consequence is a decision, not a fallback`);
  }
});

// Spec 18/29: calculated is not the same as approved.
test('payroll adjustments separate calculated from approved amounts', async () => {
  const cols = (await tableInfo('payroll_adjustments')).map(c => c.name);
  for (const c of ['calculated_amount', 'approved_amount', 'approved_by', 'status']) {
    assert.ok(cols.includes(c), `payroll_adjustments needs ${c}`);
  }
});

// Spec 31: salary must not be a single overwriteable field.
test('salary history is versioned with effective dates', async () => {
  const cols = (await tableInfo('salary_history')).map(c => c.name);
  for (const c of ['effective_from', 'effective_to', 'amount', 'created_by']) {
    assert.ok(cols.includes(c), `salary_history needs ${c}`);
  }
});
