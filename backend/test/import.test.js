// Historical attendance import tests. Spec section 24.
//
// The rule being pinned is the one the spec states outright: "Never silently
// import invalid rows."

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('import');


const { db } = require('../src/db');
const I = require('../src/domain/import');
const A = require('../src/domain/attendance');
const T = require('../src/util/time');

test.before(prepareDatabase);

async function makeEmployee(id, name, number = null) {
  await db.prepare(`
    INSERT INTO employees (id, name, role, active, employee_number, created_at, updated_at)
    VALUES (?,?,?,1,?,?,?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = EXCLUDED.active, employee_number = EXCLUDED.employee_number, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
  `).run(id, name, 'Engineering', number, T.now(), T.now());
  return id;
}

makeEmployee('emp_aa', 'Abdullah Shahid', 'FW001');
makeEmployee('emp_bb', 'Fatima Khan', 'FW002');

test.after(dropDatabase);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('CSV parsing handles quotes, embedded commas and blank lines', async () => {
  const rows = I.parseCsv('a,b\n"one, two",three\n\n"say ""hi""",four\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['one, two', 'three'],
    ['say "hi"', 'four'],
  ]);
});

test('column headers are matched flexibly', async () => {
  // A hand-made spreadsheet will not match a fixed header, and rejecting the
  // file over spacing would just send HR back to reformat it.
  const { mapping } = I.mapColumns(['Employee ID', 'clock_in', 'Clock-Out', 'DATE']);
  assert.equal(mapping.employeeId, 0);
  assert.equal(mapping.clockIn, 1);
  assert.equal(mapping.clockOut, 2);
  assert.equal(mapping.date, 3);
});

test('times are accepted in 12 and 24 hour form', async () => {
  assert.equal(I.parseTime('11:00'), '11:00');
  assert.equal(I.parseTime('2:35 PM'), '14:35');
  assert.equal(I.parseTime('12:30 AM'), '00:30');
  assert.equal(I.parseTime('12:30 PM'), '12:30');
  assert.equal(I.parseTime('25:00'), null);
  assert.equal(I.parseTime('rubbish'), null);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('a file missing required columns is rejected as a whole', async () => {
  const result = await I.preview('Clock In,Clock Out\n11:00,19:00\n');
  assert.equal(result.ok, false);
  assert.match(result.error, /missing/i);
});

test('valid rows and invalid rows are reported separately', async () => {
  const csv = [
    'Employee ID,Date,Clock In,Clock Out',
    'FW001,2026-08-03,11:00,19:00',        // fine
    'FW999,2026-08-03,11:00,19:00',        // unknown employee
    'FW002,not-a-date,11:00,19:00',        // bad date
    'FW002,2026-08-03,11:00,rubbish',      // bad time
    'FW001,2026-08-04,19:00,11:00',        // out before in
  ].join('\n');

  const r = await I.preview(csv);
  assert.equal(r.ok, true);
  assert.equal(r.summary.rowsRead, 5);
  assert.equal(r.summary.valid, 1);
  assert.equal(r.summary.invalid, 4);
  assert.equal(r.summary.unknownEmployees, 1);

  // Every rejection carries a reason a human can act on.
  for (const row of r.invalid) {
    assert.ok(row.problems.length > 0);
    assert.ok(row.rowNumber >= 2, 'the row number must point at the file');
  }
  assert.ok(r.invalid.some(x => /Unknown employee/.test(x.problems[0])));
  assert.ok(r.invalid.some(x => x.problems.some(p => /before clock in/.test(p))));
});

test('employees match by id, employee number or name', async () => {
  const csv = [
    'Employee,Date,Clock In',
    'Abdullah Shahid,2026-08-05,11:00',
    'FW002,2026-08-05,11:00',
  ].join('\n');
  const r = await I.preview(csv);
  assert.equal(r.summary.valid, 2);
  assert.deepEqual(r.valid.map(v => v.employeeId).sort(), ['emp_aa', 'emp_bb']);
});

// A date like 03/04/2026 means different things in different countries, and
// guessing silently would put someone's attendance on the wrong day.
test('an ambiguous date is reported rather than guessed', async () => {
  const r = await I.preview('Employee ID,Date,Clock In\nFW001,03/04/2026,11:00\n');
  assert.equal(r.summary.valid, 0);
  assert.match(r.invalid[0].problems[0], /Ambiguous date/);
});

test('an unambiguous day-first date is accepted', async () => {
  const r = await I.preview('Employee ID,Date,Clock In\nFW001,26/08/2026,11:00\n');
  assert.equal(r.summary.valid, 1);
  assert.equal(r.valid[0].dateKey, '2026-08-26');
});

test('duplicate rows for one employee-day are caught', async () => {
  const csv = [
    'Employee ID,Date,Clock In',
    'FW001,2026-08-06,11:00',
    'FW001,2026-08-06,12:00',
  ].join('\n');
  const r = await I.preview(csv);
  assert.equal(r.summary.valid, 1);
  assert.match(r.invalid[0].problems[0], /Duplicate/);
});

test('an unpaired break is caught', async () => {
  const r = await I.preview('Employee ID,Date,Clock In,Break Start,Clock Out\nFW001,2026-08-07,11:00,14:00,19:00\n');
  assert.equal(r.summary.valid, 0);
  assert.match(r.invalid[0].problems[0], /Break start with no break end/);
});

test('preview writes nothing', async () => {
  const before = (await db.prepare('SELECT COUNT(*) c FROM attendance_events').get()).c;
  await I.preview('Employee ID,Date,Clock In,Clock Out\nFW001,2026-08-08,11:00,19:00\n');
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM attendance_events').get()).c, before);
});

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

test('committing imports valid rows and skips invalid ones', async () => {
  const csv = [
    'Employee ID,Date,Clock In,Break Start,Break End,Clock Out',
    'FW001,2026-08-10,11:17,14:00,14:42,18:53',
    'FW999,2026-08-10,11:00,,,19:00',
  ].join('\n');

  const r = await I.commit(csv, { actor: 'user:test' });
  assert.equal(r.summary.imported, 1);
  assert.equal(r.summary.invalid, 1, 'the unknown employee is still reported, not dropped');

  const events = await db.prepare(
    "SELECT event_type, source FROM attendance_events WHERE employee_id = 'emp_aa' AND date_key = '2026-08-10' ORDER BY occurred_at"
  ).all();
  assert.deepEqual(events.map(e => e.event_type), ['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT']);
  // Spec 7.1: the source stays visible, so an imported row is never mistaken
  // for something a sensor observed.
  assert.ok(events.every(e => e.source === 'IMPORT'));
});

test('imported days are derived, matching the spec 8.1 worked example', async () => {
  const row = await db.prepare(
    "SELECT * FROM attendance_daily_summary WHERE employee_id = 'emp_aa' AND date_key = '2026-08-10'"
  ).get();

  assert.ok(row, 'the imported day must be derived, not left raw');
  assert.equal(row.late_minutes, 17);
  assert.equal(row.excess_break_minutes, 12);
  assert.equal(row.early_departure_minutes, 7);
  assert.equal(row.daily_deficit_minutes, 36);
  assert.equal(row.is_late_occurrence, 1);
});

test('re-importing the same day is skipped unless replacement is asked for', async () => {
  const csv = 'Employee ID,Date,Clock In,Clock Out\nFW001,2026-08-10,11:00,19:00\n';

  const again = await I.commit(csv, { actor: 'user:test' });
  assert.equal(again.summary.imported, 0, 'existing data is not silently overwritten');

  const replaced = await I.commit(csv, { actor: 'user:test', replaceExisting: true });
  assert.equal(replaced.summary.imported, 1);
  assert.equal(replaced.summary.replaced, 1);

  // The superseded rows are voided, not deleted. Spec 26.
  const voided = (await db.prepare(
    "SELECT COUNT(*) c FROM attendance_events WHERE employee_id = 'emp_aa' AND date_key = '2026-08-10' AND voided_at IS NOT NULL"
  ).get()).c;
  assert.ok(voided > 0, 'the replaced import must remain in history');

  // And the day now reflects the replacement: 11:00 start, so no lateness.
  const row = await db.prepare(
    "SELECT * FROM attendance_daily_summary WHERE employee_id = 'emp_aa' AND date_key = '2026-08-10'"
  ).get();
  assert.equal(row.late_minutes, 0);
  assert.equal(row.is_late_occurrence, 0);
});

test('the import is audited with its counts', async () => {
  const entry = await db.prepare(
    "SELECT * FROM audit_log WHERE action = 'ATTENDANCE_IMPORTED' ORDER BY at DESC LIMIT 1"
  ).get();
  assert.ok(entry);
  const after = JSON.parse(entry.after_json);
  assert.ok(Number.isFinite(after.imported));
  assert.ok(Number.isFinite(after.skippedInvalid));
  assert.match(entry.note, /rejected/);
});

test('imported lateness feeds the occurrence count', async () => {
  // Four late days imported at once should reach the threshold, exactly as if
  // they had been observed live.
  const csv = [
    'Employee ID,Date,Clock In,Clock Out',
    'FW002,2026-09-01,11:30,19:00',
    'FW002,2026-09-02,11:25,19:00',
    'FW002,2026-09-03,11:40,19:00',
    'FW002,2026-09-04,11:20,19:00',
  ].join('\n');

  const r = await I.commit(csv, { actor: 'user:test' });
  assert.equal(r.summary.imported, 4);

  const status = await A.latenessStatus('emp_bb', '2026-09-15');
  assert.equal(status.count, 4);
  assert.equal(status.thresholdReached, true);

  // Still only a referral. Spec 9.3.
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM formal_warnings').get()).c, 0);
});
