// Advanced HR alert tests. Spec sections 20.2, 22 and Phase 8.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('alerts');

test.before(prepareDatabase);


const { db } = require('../src/db');
const AL = require('../src/domain/alerts');
const T = require('../src/util/time');

// A fixed "today" so the tests do not drift with the wall clock.
const TODAY = '2026-08-27';
function inDays(n) {
  return T.dateKey(T.startOfDay(TODAY) + n * 24 * 60 * 60 * 1000);
}

async function makeEmployee(id) {
  await db.prepare(
    'INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = EXCLUDED.active, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at'
  ).run(id, 'Test ' + id, 'Engineering', T.now(), T.now());
  return id;
}

async function employment(id, employeeId, fields = {}) {
  await db.prepare(`
    INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from,
       contract_end_date, probation_review_date, probation_outcome, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET employee_id = EXCLUDED.employee_id, job_title = EXCLUDED.job_title, employment_type = EXCLUDED.employment_type, start_date = EXCLUDED.start_date, effective_from = EXCLUDED.effective_from, contract_end_date = EXCLUDED.contract_end_date, probation_review_date = EXCLUDED.probation_review_date, probation_outcome = EXCLUDED.probation_outcome, created_at = EXCLUDED.created_at
  `).run(id, employeeId, 'Engineer', 'Full-time', '2025-01-01', '2025-01-01',
         fields.contractEnd || null, fields.probationReview || null,
         fields.probationOutcome || null, T.now());
}

test.after(dropDatabase);

// ---------------------------------------------------------------------------
// Contract expiry (spec 20.2: "Contract expires in 30 days")
// ---------------------------------------------------------------------------

test('a contract ending inside 30 days alerts; one further out does not', async () => {
  const near = await makeEmployee('emp_near');
  await employment('er_near', near, { contractEnd: inDays(20) });

  const far = await makeEmployee('emp_far');
  await employment('er_far', far, { contractEnd: inDays(60) });

  const alerts = await AL.currentAlerts(TODAY);
  const keys = alerts.map(a => a.key);
  assert.ok(keys.includes('contract:er_near'), 'ends in 20 days, inside the 30 day window');
  assert.ok(!keys.includes('contract:er_far'), 'ends in 60 days, outside it');
});

test('an overdue contract is flagged as overdue, and sorts first', async () => {
  const emp = await makeEmployee('emp_overdue');
  await employment('er_overdue', emp, { contractEnd: inDays(-5) });

  const alerts = await AL.currentAlerts(TODAY);
  const a = alerts.find(x => x.key === 'contract:er_overdue');
  assert.ok(a);
  assert.equal(a.severity, 'overdue');
  assert.equal(a.daysUntil, -5);
  assert.equal(alerts[0].key, 'contract:er_overdue', 'most urgent sorts to the top');
});

// ---------------------------------------------------------------------------
// Probation (spec 20.2: "Probation review due in 7 days")
// ---------------------------------------------------------------------------

test('a probation review inside 7 days alerts', async () => {
  const emp = await makeEmployee('emp_prob');
  await employment('er_prob', emp, { probationReview: inDays(5) });
  assert.ok(await (await AL.currentAlerts(TODAY)).some(a => a.key === 'probation:er_prob'));
});

test('a probation review 20 days out does not alert', async () => {
  const emp = await makeEmployee('emp_prob_far');
  await employment('er_prob_far', emp, { probationReview: inDays(20) });
  assert.ok(!await (await AL.currentAlerts(TODAY)).some(a => a.key === 'probation:er_prob_far'));
});

// Once an outcome is recorded the date is history, not an outstanding task.
test('a probation review with an outcome recorded no longer alerts', async () => {
  const emp = await makeEmployee('emp_prob_done');
  await employment('er_prob_done', emp, { probationReview: inDays(3), probationOutcome: 'Passed' });
  assert.ok(!await (await AL.currentAlerts(TODAY)).some(a => a.key === 'probation:er_prob_done'));
});

// ---------------------------------------------------------------------------
// Document expiry (spec 5)
// ---------------------------------------------------------------------------

test('an expiring document alerts, and carries its confidentiality', async () => {
  const emp = await makeEmployee('emp_doc');
  await db.prepare(`
    INSERT INTO employee_documents
      (id, employee_id, document_type_id, title, expiry_date, confidentiality, created_at, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run('doc1', emp, 'passport_id', 'Passport', inDays(10), 'highly_confidential', T.now(), 'hr');

  const a = await (await AL.currentAlerts(TODAY)).find(x => x.key === 'document:doc1');
  assert.ok(a);
  assert.equal(a.type, 'DOCUMENT_EXPIRY');
  assert.equal(a.confidentiality, 'highly_confidential');
});

test('an archived document does not alert', async () => {
  const emp = await makeEmployee('emp_doc_arch');
  await db.prepare(`
    INSERT INTO employee_documents
      (id, employee_id, document_type_id, title, expiry_date, archived_at, created_at, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run('doc_arch', emp, 'passport_id', 'Old passport', inDays(5), T.now(), T.now(), 'hr');
  assert.ok(!await (await AL.currentAlerts(TODAY)).some(a => a.key === 'document:doc_arch'));
});

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

test('a dismissed alert disappears', async () => {
  const emp = await makeEmployee('emp_dismiss');
  await employment('er_dismiss', emp, { contractEnd: inDays(15) });
  assert.ok(await (await AL.currentAlerts(TODAY)).some(a => a.key === 'contract:er_dismiss'));

  await AL.dismissAlert({ alertKey: 'contract:er_dismiss', value: inDays(15), actor: 'user:hr', note: 'Renewal in hand' });
  assert.ok(!await (await AL.currentAlerts(TODAY)).some(a => a.key === 'contract:er_dismiss'));
});

// The point of keying dismissal on the value: moving the date must bring the
// alert back, or a dismissal would hide a genuinely new situation.
test('changing the date behind a dismissed alert brings it back', async () => {
  const emp = await makeEmployee('emp_redate');
  await employment('er_redate', emp, { contractEnd: inDays(15) });
  await AL.dismissAlert({ alertKey: 'contract:er_redate', value: inDays(15), actor: 'user:hr' });
  assert.ok(!await (await AL.currentAlerts(TODAY)).some(a => a.key === 'contract:er_redate'));

  // The contract end date is moved.
  await db.prepare('UPDATE employment_records SET contract_end_date = ? WHERE id = ?')
    .run(inDays(10), 'er_redate');

  assert.ok(await (await AL.currentAlerts(TODAY)).some(a => a.key === 'contract:er_redate'),
    'a dismissal must not hide a date that has since changed');
});

// ---------------------------------------------------------------------------
// Notifications (spec 22)
// ---------------------------------------------------------------------------

test('HR is notified once per alert, not every day', async () => {
  // An HR user to receive the notifications.
  const rbac = require('../src/domain/rbac');
  await rbac.createUser({
    email: 'hr-alerts@test.org', displayName: 'HR', password: 'a-long-enough-pass', roles: ['hr'],
  });

  const emp = await makeEmployee('emp_notify');
  await employment('er_notify', emp, { contractEnd: inDays(10) });

  const first = await AL.notifyHr(TODAY);
  assert.ok(first.notified >= 1);

  // Running the scan again the same "day" must not re-notify.
  const second = await AL.notifyHr(TODAY);
  const contractAgain = second.notified;
  const sent = db.prepare(
    "SELECT COUNT(*) c FROM notifications WHERE category = 'HR_ALERT' AND body LIKE '%emp_notify%'"
  );
  // The specific contract alert should have been sent exactly once.
  const rows = (await db.prepare(
    "SELECT COUNT(*) c FROM alert_notifications_sent WHERE alert_key = 'contract:er_notify'"
  ).get()).c;
  assert.equal(rows, 1, 'the alert is marked sent once');
});

test('with no HR users, notifying reports it rather than throwing', async () => {
  // A fresh throwaway db so there are genuinely no HR users.
  const tmp2 = path.join(os.tmpdir(), `office-alerts-nohr-${process.pid}.db`);
  const D = require('better-sqlite3')(tmp2);


  try {
    // Not wired to the app db; just assert the guard shape on the real one by
    // deactivating HR users first.
    await db.prepare("UPDATE users SET active = 0").run();
    const r = await AL.notifyHr(TODAY);
    assert.equal(r.notified, 0);
    assert.match(r.reason, /no HR users/i);
  } finally {
    await db.prepare("UPDATE users SET active = 1").run();
    try { D.close(); fs.unlinkSync(tmp2); } catch {}
  }
});

// ---------------------------------------------------------------------------
// Performance reviews (ad-hoc, confirmed 2026-08-27)
// ---------------------------------------------------------------------------

test('a scheduled review alerts as its due date approaches', async () => {
  const emp = await makeEmployee('emp_review');
  const r = await AL.scheduleReview({
    employeeId: emp, reviewType: 'ANNUAL', dueDate: inDays(10), actor: 'user:hr',
  });
  assert.equal(r.status, 'SCHEDULED');

  const a = await (await AL.currentAlerts(TODAY)).find(x => x.key === `review:${r.id}`);
  assert.ok(a, 'a review due in 10 days is inside the 14 day window');
  assert.equal(a.type, 'PERFORMANCE_REVIEW');
});

test('a completed review no longer alerts', async () => {
  const emp = await makeEmployee('emp_review_done');
  const r = await AL.scheduleReview({ employeeId: emp, dueDate: inDays(5), actor: 'user:hr' });
  await AL.recordReviewOutcome({ reviewId: r.id, outcome: 'Met expectations', notes: 'Good year', actor: 'user:hr' });

  assert.ok(!await (await AL.currentAlerts(TODAY)).some(x => x.key === `review:${r.id}`));
  assert.equal(await (await AL.reviewsFor(emp))[0].status, 'COMPLETED');
});

test('scheduling and completing a review are validated and audited', async () => {
  const emp = await makeEmployee('emp_review_val');
  await assert.rejects(async () => await AL.scheduleReview({ employeeId: emp, dueDate: 'soon', actor: 'hr' }), /YYYY-MM-DD/);
  await assert.rejects(async () => await AL.scheduleReview({ employeeId: 'ghost', dueDate: inDays(5), actor: 'hr' }), /No such employee/);

  const r = await AL.scheduleReview({ employeeId: emp, dueDate: inDays(5), actor: 'user:hr' });
  await assert.rejects(async () => await AL.recordReviewOutcome({ reviewId: r.id, actor: 'hr' }), /outcome/i);
  await AL.recordReviewOutcome({ reviewId: r.id, outcome: 'Done', actor: 'user:hr' });
  await assert.rejects(
    async () => await AL.recordReviewOutcome({ reviewId: r.id, outcome: 'Again', actor: 'hr' }),
    /already completed/i,
  );

  const actions = (await db.prepare('SELECT DISTINCT action FROM audit_log').all()).map(x => x.action);
  assert.ok(actions.includes('REVIEW_SCHEDULED'));
  assert.ok(actions.includes('REVIEW_COMPLETED'));
  assert.ok(actions.includes('HR_ALERT_DISMISSED'));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

test('the summary counts each alert type', async () => {
  const s = AL.summarise(await AL.currentAlerts(TODAY));
  assert.ok(s.total >= 1);
  assert.ok('contractExpiry' in s);
  assert.ok('probationReview' in s);
  assert.ok('documentExpiry' in s);
  assert.ok('performanceReview' in s);
  assert.ok(s.overdue >= 1, 'the overdue contract from earlier is counted');
});
