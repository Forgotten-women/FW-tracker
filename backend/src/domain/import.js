// Historical attendance import. Spec section 24.
//
// The governing rule from the spec is one line: "Never silently import invalid
// rows." So this is deliberately a two-step flow - validate and preview first,
// commit only after a human has seen what will happen. Every row is either
// imported or reported with the reason it was not.
//
// Imported rows are written as attendance_events with source IMPORT, which
// keeps them distinguishable from anything a sensor observed. Spec 7.1: "The
// source must always remain visible in the audit trail."

const crypto = require('crypto');
const { db, tx, audit } = require('../db');
const A = require('./attendance');
const T = require('../util/time');

// Column names accepted for each field, lower-cased and stripped of spaces,
// underscores and hyphens. Spreadsheets exported by hand rarely match a fixed
// header, and rejecting a whole file over "Clock In" versus "clock_in" would
// send HR back to reformat it for no reason.
const COLUMN_ALIASES = {
  employeeId:   ['employeeid', 'employeenumber', 'empid', 'id', 'staffid'],
  employeeName: ['employeename', 'name', 'fullname', 'employee'],
  date:         ['date', 'workdate', 'attendancedate', 'day'],
  clockIn:      ['clockin', 'in', 'starttime', 'timein', 'arrival'],
  breakStart:   ['breakstart', 'breakout', 'lunchstart'],
  breakEnd:     ['breakend', 'breakin', 'lunchend'],
  clockOut:     ['clockout', 'out', 'endtime', 'timeout', 'departure'],
  leaveType:    ['leavetype', 'leave', 'absencetype'],
  status:       ['attendancestatus', 'status'],
  notes:        ['notes', 'note', 'comment', 'comments'],
};

function normaliseHeader(h) {
  return String(h || '').toLowerCase().replace(/[\s_\-.]/g, '');
}

/** Maps the file's headers onto known fields. */
function mapColumns(headers) {
  const mapping = {};
  const unmapped = [];

  headers.forEach((h, index) => {
    const key = normaliseHeader(h);
    const field = Object.keys(COLUMN_ALIASES).find(f => COLUMN_ALIASES[f].includes(key));
    if (field && mapping[field] === undefined) mapping[field] = index;
    else if (!field) unmapped.push(h);
  });

  return { mapping, unmapped };
}

/**
 * Minimal CSV reader: quoted fields, escaped quotes, embedded commas and
 * newlines. Enough for a spreadsheet export, and it does not drag in a
 * dependency for one endpoint.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;

function parseDate(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (DATE_RE.test(v)) return v;
  const dmy = v.match(DMY_RE);
  if (dmy) {
    // Day-first, matching UK and Pakistani convention. An ambiguous value like
    // 03/04/2026 is reported rather than guessed at, below.
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

function isAmbiguousDate(raw) {
  const m = String(raw || '').trim().match(DMY_RE);
  if (!m) return false;
  const [, a, b] = m;
  // Both parts could be a month, so day-first versus month-first changes the
  // date. Worth flagging rather than silently choosing.
  return Number(a) <= 12 && Number(b) <= 12 && Number(a) !== Number(b);
}

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i;

function parseTime(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  const m = v.match(TIME_RE);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[4] ? m[4].toLowerCase() : null;

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Validates a file without writing anything.
 *
 * Returns every row classified as valid or invalid, with a reason. Spec 24 asks
 * for exactly this summary before HR confirms.
 */
async function preview(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return { ok: false, error: 'The file needs a header row and at least one data row.' };
  }

  const headers = rows[0].map(h => String(h).trim());
  const { mapping, unmapped } = mapColumns(headers);

  const missing = [];
  if (mapping.employeeId === undefined && mapping.employeeName === undefined) {
    missing.push('an employee identifier (Employee ID or Employee Name)');
  }
  if (mapping.date === undefined) missing.push('Date');

  if (missing.length) {
    return {
      ok: false,
      error: `The file is missing ${missing.join(' and ')}.`,
      headersFound: headers,
    };
  }

  const employeesById = new Map(
    (await db.prepare('SELECT id, name, employee_number FROM employees').all())
      .map(e => [e.id, e]),
  );
  const employeesByNumber = new Map(
    [...employeesById.values()].filter(e => e.employee_number)
      .map(e => [String(e.employee_number).toLowerCase(), e]),
  );
  const employeesByName = new Map(
    [...employeesById.values()].map(e => [e.name.trim().toLowerCase(), e]),
  );

  const valid = [];
  const invalid = [];
  const seen = new Set();

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const at = (field) => mapping[field] === undefined ? '' : (cells[mapping[field]] ?? '');
    const problems = [];

    // --- employee ---
    //
    // Each candidate value is tried against id, employee number AND name,
    // rather than assuming a column called "Employee ID" holds an id and one
    // called "Employee" holds a name. A hand-made export very often has a
    // single identifier column containing whichever of the two the author had
    // to hand, and refusing those rows would be pedantry, not validation.
    const rawId = String(at('employeeId')).trim();
    const rawName = String(at('employeeName')).trim();

    const lookup = (value) => {
      if (!value) return null;
      const key = value.toLowerCase();
      return employeesById.get(value)
        || employeesByNumber.get(key)
        || employeesByName.get(key)
        || null;
    };

    const employee = lookup(rawId) || lookup(rawName);
    if (!employee) {
      problems.push(`Unknown employee: ${rawId || rawName || '(blank)'}`);
    }

    // --- date ---
    const rawDate = String(at('date')).trim();
    const dateKey = parseDate(rawDate);
    if (!dateKey) problems.push(`Unreadable date: ${rawDate || '(blank)'}`);
    else if (isAmbiguousDate(rawDate)) {
      problems.push(`Ambiguous date "${rawDate}" - could be day-first or month-first. Use YYYY-MM-DD.`);
    }

    // --- times ---
    const times = {};
    for (const field of ['clockIn', 'breakStart', 'breakEnd', 'clockOut']) {
      const raw = String(at(field)).trim();
      if (!raw) { times[field] = null; continue; }
      const parsed = parseTime(raw);
      if (!parsed) problems.push(`Unreadable ${field}: ${raw}`);
      times[field] = parsed;
    }

    if (times.clockIn && times.clockOut && dateKey) {
      if (T.wallClockToEpoch(dateKey, times.clockOut) < T.wallClockToEpoch(dateKey, times.clockIn)) {
        problems.push(`Clock out (${times.clockOut}) is before clock in (${times.clockIn})`);
      }
    }
    if (times.breakStart && !times.breakEnd) problems.push('Break start with no break end');
    if (times.breakEnd && !times.breakStart) problems.push('Break end with no break start');

    // --- duplicates within the file ---
    if (employee && dateKey) {
      const key = `${employee.id}|${dateKey}`;
      if (seen.has(key)) problems.push('Duplicate row for this employee and date');
      seen.add(key);
    }

    const record = {
      rowNumber: i + 1,
      employeeId: employee?.id ?? null,
      employeeName: employee?.name ?? (rawName || rawId),
      dateKey,
      ...times,
      leaveType: String(at('leaveType')).trim() || null,
      notes: String(at('notes')).trim() || null,
    };

    if (problems.length) invalid.push({ ...record, problems });
    else valid.push(record);
  }

  // How many valid rows would overwrite something already recorded.
  let wouldReplace = 0;
  for (const r of valid) {
    const existing = (await db.prepare(
      "SELECT COUNT(*) c FROM attendance_events WHERE employee_id = ? AND date_key = ? AND source = 'IMPORT' AND voided_at IS NULL"
    ).get(r.employeeId, r.dateKey)).c;
    if (existing) wouldReplace++;
  }

  return {
    ok: true,
    headersFound: headers,
    unmappedColumns: unmapped,
    mappedFields: Object.keys(mapping),
    summary: {
      rowsRead: rows.length - 1,
      valid: valid.length,
      invalid: invalid.length,
      wouldReplaceExisting: wouldReplace,
      unknownEmployees: invalid.filter(r => r.problems.some(p => p.startsWith('Unknown employee'))).length,
      badDatesOrTimes: invalid.filter(r => r.problems.some(p => /date|time|Clock/i.test(p))).length,
    },
    valid,
    invalid,
  };
}

/**
 * Commits a previously previewed file.
 *
 * Only rows that validate are written. Invalid rows are returned again so the
 * caller can show what was skipped and why - never dropped in silence.
 */
async function commit(csvText, { actor, replaceExisting = false }) {
  const result = await preview(csvText);
  if (!result.ok) return result;

  const nowMs = T.now();
  let imported = 0;
  let replaced = 0;
  const touched = new Set();

  const insertEvent = db.prepare(`
    INSERT INTO attendance_events
      (id, employee_id, date_key, occurred_at, event_type, source, created_at, created_by, adjustment_reason)
    VALUES (?,?,?,?,?, 'IMPORT', ?, ?, ?)
  `);
  const insertBreak = db.prepare(`
    INSERT INTO break_records
      (id, employee_id, date_key, started_at, ended_at, permitted_minutes,
       actual_minutes, excess_minutes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);

  await tx(async () => {
    for (const r of result.valid) {
      const existing = await db.prepare(
        "SELECT id FROM attendance_events WHERE employee_id = ? AND date_key = ? AND source = 'IMPORT' AND voided_at IS NULL"
      ).all(r.employeeId, r.dateKey);

      if (existing.length) {
        if (!replaceExisting) continue;
        // Voided, not deleted. Spec 26: corrections are versioned changes, so
        // the superseded import stays visible in history.
        for (const e of existing) {
          await db.prepare('UPDATE attendance_events SET voided_at = ?, voided_reason = ? WHERE id = ?')
            .run(nowMs, `Replaced by import at ${T.displayTime(nowMs)}`, e.id);
        }
        await db.prepare('DELETE FROM break_records WHERE employee_id = ? AND date_key = ?')
          .run(r.employeeId, r.dateKey);
        replaced++;
      }

      const mk = async (type, hhmm) => {
        if (!hhmm) return;
        await insertEvent.run(
          'ae_' + crypto.randomBytes(8).toString('hex'),
          r.employeeId, r.dateKey, T.wallClockToEpoch(r.dateKey, hhmm),
          type, nowMs, actor, r.notes,
        );
      };

      await mk('CLOCK_IN', r.clockIn);
      await mk('BREAK_START', r.breakStart);
      await mk('BREAK_END', r.breakEnd);
      await mk('CLOCK_OUT', r.clockOut);

      if (r.breakStart && r.breakEnd) {
        const started = T.wallClockToEpoch(r.dateKey, r.breakStart);
        const ended = T.wallClockToEpoch(r.dateKey, r.breakEnd);
        const permitted = (await require('./schedule').resolve(r.employeeId, r.dateKey)).permittedBreakMinutes;
        const actual = Math.max(0, Math.round((ended - started) / 60000));
        await insertBreak.run(
          'brk_' + crypto.randomBytes(8).toString('hex'),
          r.employeeId, r.dateKey, started, ended, permitted,
          actual, Math.max(0, actual - permitted), nowMs,
        );
      }

      imported++;
      touched.add(`${r.employeeId}|${r.dateKey}`);
    }

    await audit({
      actor, action: 'ATTENDANCE_IMPORTED',
      targetType: 'attendance',
      after: {
        rowsRead: result.summary.rowsRead,
        imported, replaced,
        skippedInvalid: result.invalid.length,
      },
      note: `${imported} row(s) imported, ${result.invalid.length} rejected`,
    });
  });

  // Derive every affected day so the ledger and summaries reflect the import.
  for (const key of touched) {
    const [employeeId, dateKey] = key.split('|');
    await A.recomputeDay(employeeId, dateKey, T.endOfDay(dateKey) + 1);
  }

  return {
    ...result,
    committed: true,
    summary: { ...result.summary, imported, replaced, skipped: result.valid.length - imported },
  };
}

module.exports = { preview, commit, parseCsv, mapColumns, parseDate, parseTime };
