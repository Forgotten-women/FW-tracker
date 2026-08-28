// Advanced HR alert tests. Spec sections 20.2, 22 and Phase 8.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `office-alerts-test-${process.pid}.db`);
process.env.DB_FILE = TMP;
process.env.ADMIN_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.OFFICE_CONFIG_FILE = path.join(__dirname, 'fixtures', 'office.test.json');

const { db } = require('../src/db');
const AL = require('../src/domain/alerts');
const T = require('../src/util/time');

// A fixed "today" so the tests do not drift with the wall clock.
const TODAY = '2026-08-27';
function inDays(n) {
  return T.dateKey(T.startOfDay(TODAY) + n * 24 * 60 * 60 * 1000);
}

function makeEmployee(id) {
  db.prepare(
    'INSERT OR REPLACE INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?)'
  ).run(id, 'Test ' + id, 'Engineering', T.now(), T.now());
  return id;
}

function employment(id, employeeId, fields = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO employment_records
      (id, employee_id, job_title, employment_type, start_date, effective_from,
       contract_end_date, probation_review_date, probation_outcome, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(id, employeeId, 'Engineer', 'Full-time', '2025-01-01', '2025-01-01',
         fields.contractEnd || null, fields.probationReview || null,
         fields.probationOutcome || null, T.now());
}

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP + s); } catch {} }
});

// ---------------------------------------------------------------------------
// Contract expiry (spec 20.2: "Contract expires in 30 days")
// ---------------------------------------------------------------------------

test('a contract ending inside 30 days alerts; one further out does not', () => {
  const near = makeEmployee('emp_near');
  employment('er_near', near, { contractEnd: inDays(20) });

  const far = makeEmployee('emp_far');
  employment('er_far', far, { contractEnd: inDays(60) });

  const alerts = AL.currentAlerts(TODAY);
  const keys = alerts.map(a => a.key);
  assert.ok(keys.includes('contract:er_near'), 'ends in 20 days, inside the 30 day window');
  assert.ok(!keys.includes('contract:er_far'), 'ends in 60 days, outside it');
});

test('an overdue contract is flagged as overdue, and sorts first', () => {
  const emp = makeEmployee('emp_overdue');
  employment('er_overdue', emp, { contractEnd: inDays(-5) });

  const alerts = AL.currentAlerts(TODAY);
  const a = alerts.find(x => x.key === 'contract:er_overdue');
  assert.ok(a);
  assert.equal(a.severity, 'overdue');
  assert.equal(a.daysUntil, -5);
  assert.equal(alerts[0].key, 'contract:er_overdue', 'most urgent sorts to the top');
});

// ---------------------------------------------------------------------------
// Probation (spec 20.2: "Probation review due in 7 days")
// ---------------------------------------------------------------------------

test('a probation review inside 7 days alerts', () => {
  const emp = makeEmployee('emp_prob');
  employment('er_prob', emp, { probationReview: inDays(5) });
  assert.ok(AL.currentAlerts(TODAY).some(a => a.key === 'probation:er_prob'));
});

test('a probation review 20 days out does not alert', () => {
  const emp = makeEmployee('emp_prob_far');
  employment('er_prob_far', emp, { probationReview: inDays(20) });
  assert.ok(!AL.currentAlerts(TODAY).some(a => a.key === 'probation:er_prob_far'));
});

// Once an outcome is recorded the date is history, not an outstanding task.
test('a probation review with an outcome recorded no longer alerts', () => {
  const emp = makeEmployee('emp_prob_done');
  employment('er_prob_done', emp, { probationReview: inDays(3), probationOutcome: 'Passed' });
  assert.ok(!AL.currentAlerts(TODAY).some(a => a.key === 'probation:er_prob_done'));
});

// ---------------------------------------------------------------------------
// Document expiry (spec 5)
// ---------------------------------------------------------------------------

test('an expiring document alerts, and carries its confidentiality', () => {
  const emp = makeEmployee('emp_doc');
  db.prepare(`
    INSERT INTO employee_documents
      (id, employee_id, document_type_id, title, expiry_date, confidentiality, created_at, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run('doc1', emp, 'passport_id', 'Passport', inDays(10), 'highly_confidential', T.now(), 'hr');

  const a = AL.currentAlerts(TODAY).find(x => x.key === 'document:doc1');
  assert.ok(a);
  assert.equal(a.type, 'DOCUMENT_EXPIRY');
  assert.equal(a.confidentiality, 'highly_confidential');
});

test('an archived document does not alert', () => {
  const emp = makeEmployee('emp_doc_arch');
  db.prepare(`
    INSERT INTO employee_documents
      (id, employee_id, document_type_id, title, expiry_date, archived_at, created_at, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run('doc_arch', emp, 'passport_id', 'Old passport', inDays(5), T.now(), T.now(), 'hr');
  assert.ok(!AL.currentAlerts(TODAY).some(a => a.key === 'document:doc_arch'));
});

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

test('a dismissed alert disappears', () => {
  const emp = makeEmployee('emp_dismiss');
  employment('er_dismiss', emp, { contractEnd: inDays(15) });
  assert.ok(AL.currentAlerts(TODAY).some(a => a.key === 'contract:er_dismiss'));

  AL.dismissAlert({ alertKey: 'contract:er_dismiss', value: inDays(15), actor: 'user:hr', note: 'Renewal in hand' });
  assert.ok(!AL.currentAlerts(TODAY).some(a => a.key === 'contract:er_dismiss'));
});

// The point of keying dismissal on the value: moving the date must bring the
// alert back, or a dismissal would hide a genuinely new situation.
test('changing the date behind a dismissed alert brings it back', () => {
  const emp = makeEmployee('emp_redate');
  employment('er_redate', emp, { contractEnd: inDays(15) });
  AL.dismissAlert({ alertKey: 'contract:er_redate', value: inDays(15), actor: 'user:hr' });
  assert.ok(!AL.currentAlerts(TODAY).some(a => a.key === 'contract:er_redate'));

  // The contract end date is moved.
  db.prepare('UPDATE employment_records SET contract_end_date = ? WHERE id = ?')
    .run(inDays(10), 'er_redate');

  assert.ok(AL.currentAlerts(TODAY).some(a => a.key === 'contract:er_redate'),
    'a dismissal must not hide a date that has since changed');
});

// ---------------------------------------------------------------------------
// Notifications (spec 22)
// ---------------------------------------------------------------------------

test('HR is notified once per alert, not every day', () => {
  // An HR user to receive the notifications.
  const rbac = require('../src/domain/rbac');
  rbac.createUser({
    email: 'hr-alerts@test.org', displayName: 'HR', password: 'a-long-enough-pass', roles: ['hr'],
  });

  const emp = makeEmployee('emp_notify');
  employment('er_notify', emp, { contractEnd: inDays(10) });

  const first = AL.notifyHr(TODAY);
  assert.ok(first.notified >= 1);

  // Running the scan again the same "day" must not re-notify.
  const second = AL.notifyHr(TODAY);
  const contractAgain = second.notified;
  const sent = db.prepare(
    "SELECT COUNT(*) c FROM notifications WHERE category = 'HR_ALERT' AND body LIKE '%emp_notify%'"
  );
  // The specific contract alert should have been sent exactly once.
  const rows = db.prepare(
    "SELECT COUNT(*) c FROM alert_notifications_sent WHERE alert_key = 'contract:er_notify'"
  ).get().c;
  assert.equal(rows, 1, 'the alert is marked sent once');
});

test('with no HR users, notifying reports it rather than throwing', () => {
  // A fresh throwaway db so there are genuinely no HR users.
  const tmp2 = path.join(os.tmpdir(), `office-alerts-nohr-${process.pid}.db`);
  const D = require('better-sqlite3')(tmp2);
  try {
    // Not wired to the app db; just assert the guard shape on the real one by
    // deactivating HR users first.
    db.prepare("UPDATE users SET active = 0").run();
    const r = AL.notifyHr(TODAY);
    assert.equal(r.notified, 0);
    assert.match(r.reason, /no HR users/i);
  } finally {
    db.prepare("UPDATE users SET active = 1").run();
    try { D.close(); fs.unlinkSync(tmp2); } catch {}
  }
});

// ---------------------------------------------------------------------------
// Performance reviews (ad-hoc, confirmed 2026-08-27)
// ---------------------------------------------------------------------------

test('a scheduled review alerts as its due date approaches', () => {
  const emp = makeEmployee('emp_review');
  const r = AL.scheduleReview({
    employeeId: emp, reviewType: 'ANNUAL', dueDate: inDays(10), actor: 'user:hr',
  });
  assert.equal(r.status, 'SCHEDULED');

  const a = AL.currentAlerts(TODAY).find(x => x.key === `review:${r.id}`);
  assert.ok(a, 'a review due in 10 days is inside the 14 day window');
  assert.equal(a.type, 'PERFORMANCE_REVIEW');
});

test('a completed review no longer alerts', () => {
  const emp = makeEmployee('emp_review_done');
  const r = AL.scheduleReview({ employeeId: emp, dueDate: inDays(5), actor: 'user:hr' });
  AL.recordReviewOutcome({ reviewId: r.id, outcome: 'Met expectations', notes: 'Good year', actor: 'user:hr' });

  assert.ok(!AL.currentAlerts(TODAY).some(x => x.key === `review:${r.id}`));
  assert.equal(AL.reviewsFor(emp)[0].status, 'COMPLETED');
});

test('scheduling and completing a review are validated and audited', () => {
  const emp = makeEmployee('emp_review_val');
  assert.throws(() => AL.scheduleReview({ employeeId: emp, dueDate: 'soon', actor: 'hr' }), /YYYY-MM-DD/);
  assert.throws(() => AL.scheduleReview({ employeeId: 'ghost', dueDate: inDays(5), actor: 'hr' }), /No such employee/);

  const r = AL.scheduleReview({ employeeId: emp, dueDate: inDays(5), actor: 'user:hr' });
  assert.throws(() => AL.recordReviewOutcome({ reviewId: r.id, actor: 'hr' }), /outcome/i);
  AL.recordReviewOutcome({ reviewId: r.id, outcome: 'Done', actor: 'user:hr' });
  assert.throws(
    () => AL.recordReviewOutcome({ reviewId: r.id, outcome: 'Again', actor: 'hr' }),
    /already completed/i,
  );

  const actions = db.prepare('SELECT DISTINCT action FROM audit_log').all().map(x => x.action);
  assert.ok(actions.includes('REVIEW_SCHEDULED'));
  assert.ok(actions.includes('REVIEW_COMPLETED'));
  assert.ok(actions.includes('HR_ALERT_DISMISSED'));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

test('the summary counts each alert type', () => {
  const s = AL.summarise(AL.currentAlerts(TODAY));
  assert.ok(s.total >= 1);
  assert.ok('contractExpiry' in s);
  assert.ok('probationReview' in s);
  assert.ok('documentExpiry' in s);
  assert.ok('performanceReview' in s);
  assert.ok(s.overdue >= 1, 'the overdue contract from earlier is counted');
});
