// Renewing a contract changes only the contract dates on the current terms,
// keeps the record's id, and clears the expiry alert.

const test = require('node:test');
const assert = require('node:assert');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('contract_renewal');

const { db } = require('../src/db');
const people = require('../src/domain/people');
const AL = require('../src/domain/alerts');
const T = require('../src/util/time');

const realNow = T.now;
test.before(async () => { T.now = () => T.wallClockToEpoch('2026-10-09', '12:00'); await prepareDatabase(); });
test.after(async () => { T.now = realNow; await dropDatabase(); });

test('renewing keeps the record, moves the end date, and the alert goes', async () => {
  await db.prepare('INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?)')
    .run('emp_c', 'Contract Person', 'Coordinator', T.now(), T.now());
  await db.prepare(`INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, contract_start_date,
      contract_end_date, effective_from, created_at) VALUES ('er_c', 'emp_c', 'Coordinator', 'Permanent', '2025-10-13', '2025-10-13', '2026-10-12', '2025-10-13', ?)`)
    .run(T.now());
  assert.ok((await AL.currentAlerts('2026-10-09')).some(a => a.key === 'contract:er_c'));

  await assert.rejects(people.renewContract({ employeeId: 'emp_c', contractEndDate: '2026-10-01', reason: 'x', actor: 't' }), /after the current one/);
  await assert.rejects(people.renewContract({ employeeId: 'emp_c', contractEndDate: '2027-10-12', reason: '', actor: 't' }), /reason/);

  const r = await people.renewContract({ employeeId: 'emp_c', contractEndDate: '2027-10-12', reason: 'Renewed for a year', actor: 't' });
  assert.deepEqual(r, { employeeId: 'emp_c', contractStartDate: '2026-10-13', contractEndDate: '2027-10-12' });
  const er = await db.prepare("SELECT * FROM employment_records WHERE employee_id = 'emp_c'").all();
  assert.equal(er.length, 1);
  assert.equal(er[0].id, 'er_c');
  assert.equal(er[0].contract_end_date, '2027-10-12');
  assert.ok(!(await AL.currentAlerts('2026-10-09')).some(a => a.key === 'contract:er_c'), 'the expiry alert is gone');

  await people.renewContract({ employeeId: 'emp_c', contractEndDate: null, reason: 'Made permanent', actor: 't' });
  assert.equal((await db.prepare("SELECT contract_end_date FROM employment_records WHERE id = 'er_c'").get()).contract_end_date, null);
});
