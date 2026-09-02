const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `office-statements-test-${process.pid}.db`);
process.env.DB_FILE = TMP;
process.env.ADMIN_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.OFFICE_CONFIG_FILE = path.join(__dirname, 'fixtures', 'office.test.json');

const { db } = require('../src/db');
const PR = require('../src/domain/payroll');
const T = require('../src/util/time');

function makeEmployee(id, startDate = null) {
  db.prepare(
    'INSERT OR REPLACE INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?)'
  ).run(id, 'Statement Worker ' + id, 'Engineering', T.now(), T.now());
  if (startDate) {
    db.prepare(`
      INSERT OR REPLACE INTO employment_records
        (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run('er_' + id, id, 'Engineer', 'Full-time', startDate, startDate, T.now());
  }
  return id;
}

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP + s); } catch {} }
});

test('Employee Payroll Statements Domain & Policy Gating', async (t) => {
  const empId = makeEmployee('emp_stmt_1', '2026-07-01');

  PR.setSalary({
    employeeId: empId,
    amount: 200000,
    effectiveFrom: '2026-07-01',
    reason: 'Initial salary',
    currency: 'PKR',
    actor: 'admin',
  });

  const period = PR.createPeriod({
    name: 'August 2026 Payroll',
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    exchangeRate: 360.0,
    actor: 'admin',
  });

  const adj = PR.proposeAdjustment({
    periodId: period.id,
    employeeId: empId,
    adjustmentType: 'OVERTIME',
    calculatedAmount: 15000,
    explanation: 'Weekend release deployment',
    actor: 'admin',
  });

  PR.decideAdjustment({
    adjustmentId: adj.id,
    decision: 'APPROVED',
    approvedAmount: 15000,
    notes: 'Approved by line manager',
    actor: 'admin',
  });

  await t.test('1. Statements are locked when show_salary_to_employees is 0', () => {
    db.prepare("INSERT OR REPLACE INTO org_settings (key, value, updated_at) VALUES ('show_salary_to_employees', '0', ?)")
      .run(T.now());

    const res = PR.employeeStatements(empId);
    assert.equal(res.enabled, false);
    assert.match(res.message, /restricted/i);
    assert.equal(res.periods.length, 0);
  });

  await t.test('2. Statements return full period details when show_salary_to_employees is 1', () => {
    db.prepare("INSERT OR REPLACE INTO org_settings (key, value, updated_at) VALUES ('show_salary_to_employees', '1', ?)")
      .run(T.now());

    const res = PR.employeeStatements(empId);
    assert.equal(res.enabled, true);
    assert.equal(res.currentSalary.monthly, 200000);
    assert.equal(res.currentSalary.currency, 'PKR');
    assert.ok(res.periods.length >= 1);

    const aug = res.periods.find((p) => p.periodId === period.id);
    assert.ok(aug);
    assert.equal(aug.name, 'August 2026 Payroll');
    assert.equal(aug.monthlyGross, 200000);
    assert.equal(aug.workingDaysCount, 21);
    assert.equal(aug.basePayable, 193846.15);
    assert.equal(aug.adjustmentsTotal, 15000);
    assert.equal(aug.netPayable, 208846.15);
    assert.equal(aug.exchangeRate, 360.0);
    assert.equal(aug.adjustments.length, 1);
    assert.equal(aug.adjustments[0].type, 'OVERTIME');
  });
});
