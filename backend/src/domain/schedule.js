// Which schedule applies to an employee on a given date.
//
// Everything in the attendance engine depends on this. "Late" is meaningless
// without knowing what time this person was due to start, and spec section 6 is
// explicit that the schedule must be configurable "because future employees,
// departments or offices may use different schedules" - so nothing here reads a
// constant.
//
// Resolution order, most specific first:
//   1. the working pattern on the employee's current employment record
//   2. the pattern flagged as the organisation default
//   3. config/office.json
//
// The office calendar overrides all three: a public holiday or an organisation
// closure is not a working day no matter what pattern applies.

const { db } = require('../db');
const { config } = require('../config');
const T = require('../util/time');
const holidays = require('./holidays');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const selectEmploymentPattern = db.prepare(`
  SELECT wp.*, er.office_id
  FROM employment_records er
  LEFT JOIN working_patterns wp ON wp.id = er.working_pattern_id
  WHERE er.employee_id = ?
    AND er.effective_from <= ?
    AND (er.effective_to IS NULL OR er.effective_to >= ?)
  ORDER BY er.effective_from DESC
  LIMIT 1
`);

const selectDefaultPattern = db.prepare(
  'SELECT * FROM working_patterns WHERE is_default = 1 AND active = 1 LIMIT 1'
);

// The organisation default is read for every employee without their own
// pattern on every derivation -- 19 times per dashboard refresh -- and only
// changes when HR edits shifts (routes/shifts.js calls invalidate()). Other
// instances pick an edit up within the TTL.
const DEFAULT_PATTERN_TTL_MS = 60 * 1000;
let defaultPatternCache = null; // { value, expiresAtMs }

async function getDefaultPattern() {
  if (defaultPatternCache && defaultPatternCache.expiresAtMs > Date.now()) {
    return defaultPatternCache.value;
  }
  const value = await selectDefaultPattern.get();
  defaultPatternCache = { value, expiresAtMs: Date.now() + DEFAULT_PATTERN_TTL_MS };
  return value;
}

function invalidate() {
  defaultPatternCache = null;
}

const selectEmployeeOffice = db.prepare('SELECT office_id FROM employees WHERE id = ?');

const selectCalendarDay = db.prepare(
  'SELECT * FROM calendar_days WHERE office_id = ? AND date = ?'
);

// Friday prayers (Jumu'ah): every Friday 13:00-14:00 office time (config.timeZone,
// Asia/Karachi). Laptop idle in this hour is not idle: it counts as active.
const FRIDAY_PRAYER = { start: '13:00', end: '14:00' };

/** [start, end] epoch ms of a date's Friday prayer hour, or null on other days. */
function prayerWindow(dateKey) {
  if (weekdayKey(dateKey) !== 'fri') return null;
  return [T.wallClockToEpoch(dateKey, FRIDAY_PRAYER.start), T.wallClockToEpoch(dateKey, FRIDAY_PRAYER.end)];
}

/** Milliseconds of [from, to] inside the Friday prayer hour of dateKey. */
function prayerOverlapMs(dateKey, from, to) {
  const w = prayerWindow(dateKey);
  if (!w) return 0;
  return Math.max(0, Math.min(to, w[1]) - Math.max(from, w[0]));
}

/** The local weekday key for a date, e.g. 'mon'. */
function weekdayKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * The schedule in force for one employee on one date.
 *
 * Always returns something usable - a missing employment record falls back to
 * the organisation default rather than throwing, because an employee with no
 * schedule should still show up on the dashboard rather than crashing it.
 */
async function resolve(employeeId, dateKey = T.dateKey()) {
  const row = await selectEmploymentPattern.get(employeeId, dateKey, dateKey);
  const pattern = (row && row.id) ? row : await getDefaultPattern();

  const workingDays = (pattern?.working_days || config.office.workingDays?.join(',') || 'mon,tue,wed,thu,fri')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  const startTime = pattern?.start_time || config.workStartTime;
  const endTime = pattern?.end_time || config.workEndTime;
  const permittedBreakMinutes = pattern?.permitted_break_minutes
    ?? config.office.permittedBreakMinutes ?? 30;
  const dayEquivalentMinutes = pattern?.day_equivalent_minutes
    ?? config.office.dayEquivalentMinutes ?? 480;

  // A NULL grace on the pattern means "use the organisation setting", not
  // "zero" - those are different statements and conflating them would decide
  // policy by accident.
  const graceMinutes = pattern?.grace_minutes ?? config.latenessGraceMinutes;

  const day = weekdayKey(dateKey);
  let isWorkingDay = workingDays.includes(day);
  let nonWorkingReason = isWorkingDay ? null : 'Rest day';

  // 1. Designated Bank / Public Holidays (Organisation-wide policy: 5 approved days)
  const bankHoliday = await holidays.isBankHoliday(dateKey);
  if (bankHoliday && bankHoliday.isActive) {
    isWorkingDay = false;
    nonWorkingReason = bankHoliday.name;
    return {
      employeeId,
      dateKey,
      patternId: pattern?.id || null,
      patternName: pattern?.name || 'Organisation default',
      isWorkingDay: false,
      nonWorkingReason: bankHoliday.name,
      calendarDayType: 'PUBLIC_HOLIDAY',
      isPaidNonWorkingDay: true,
      startTime,
      endTime,
      permittedBreakMinutes,
      dayEquivalentMinutes,
      graceMinutes,
      officeId: row?.office_id || null,
      scheduledStartAt: T.wallClockToEpoch(dateKey, startTime),
      scheduledEndAt: T.wallClockToEpoch(dateKey, endTime),
      latestOnTimeAt: T.wallClockToEpoch(dateKey, startTime) + graceMinutes * 60000 + 59999,
      bankHoliday,
    };
  }

  // Office calendar. Spec 16: an employee must not lose annual leave for a day
  // configured as a paid office closure.
  const officeId = row?.office_id || (await selectEmployeeOffice.get(employeeId))?.office_id;
  let calendarEntry = null;
  if (officeId) {
    calendarEntry = await selectCalendarDay.get(officeId, dateKey) || null;
    if (calendarEntry && calendarEntry.day_type !== 'WORKING') {
      isWorkingDay = false;
      nonWorkingReason = calendarEntry.name || calendarEntry.day_type;
    }
  }

  return {
    employeeId,
    dateKey,
    patternId: pattern?.id || null,
    patternName: pattern?.name || 'Organisation default',
    isWorkingDay,
    nonWorkingReason,
    calendarDayType: calendarEntry?.day_type || (isWorkingDay ? 'WORKING' : 'REST_DAY'),
    isPaidNonWorkingDay: calendarEntry ? !!calendarEntry.is_paid : false,
    startTime,
    endTime,
    permittedBreakMinutes,
    dayEquivalentMinutes,
    graceMinutes,
    workingDays: pattern?.working_days || 'mon,tue,wed,thu,fri',
    officeId: officeId || null,

    // Absolute instants, so callers never re-derive them and risk disagreeing.
    scheduledStartAt: T.wallClockToEpoch(dateKey, startTime),
    scheduledEndAt: T.wallClockToEpoch(dateKey, endTime),
    // The latest arrival that is still not late (10 mins grace on 11:00 means up to 11:10:59 is on time; 11:11 is late).
    latestOnTimeAt: T.wallClockToEpoch(dateKey, startTime) + graceMinutes * 60000 + 59999,
  };
}

/** Scheduled working dates in a range, for absence detection and reports (Batch optimized). */
async function workingDaysBetween(employeeId, fromKey, toKey) {
  // Fast path: Pre-fetch pattern, office, and calendar days for the range to avoid N x 4 round-trip queries
  const [empPatternRow, defaultPattern, empOffice] = await Promise.all([
    selectEmploymentPattern.get(employeeId, toKey, fromKey),
    getDefaultPattern(),
    selectEmployeeOffice.get(employeeId),
  ]);

  const pattern = (empPatternRow && empPatternRow.id) ? empPatternRow : defaultPattern;
  const workingDays = (pattern?.working_days || config.office.workingDays?.join(',') || 'mon,tue,wed,thu,fri')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  const officeId = empPatternRow?.office_id || empOffice?.office_id;
  const calendarMap = new Map();
  if (officeId) {
    const calendarRows = await db.prepare(
      'SELECT date, day_type FROM calendar_days WHERE office_id = ? AND date >= ? AND date <= ?'
    ).all(officeId, fromKey, toKey);
    for (const r of calendarRows) {
      calendarMap.set(r.date, r.day_type);
    }
  }

  const out = [];
  let cursor = T.startOfDay(fromKey);
  const end = T.startOfDay(toKey);
  // Bounded so a malformed range cannot spin.
  for (let guard = 0; cursor <= end && guard < 800; guard++) {
    const key = T.dateKey(cursor);
    const day = weekdayKey(key);
    let isWorking = workingDays.includes(day);

    if (isWorking) {
      const bankHoliday = await holidays.isBankHoliday(key);
      if (bankHoliday && bankHoliday.isActive) {
        isWorking = false;
      } else if (calendarMap.has(key) && calendarMap.get(key) !== 'WORKING') {
        isWorking = false;
      }
    }

    if (isWorking) out.push(key);
    cursor = T.endOfDay(key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Approved leave on a date
//
// Kept apart from resolve() on purpose: a leave day is still a scheduled
// working day (payroll and leave counting depend on that), it is just one the
// employee is not expected to work.
// ---------------------------------------------------------------------------

// Work from home (leave type 'wfh') is a working day, not time off: it is
// excluded here and answered by wfhOn() instead.
const selectLeaveOn = db.prepare(`
  SELECT id, day_portion FROM leave_requests
  WHERE employee_id = ? AND status = 'APPROVED' AND cancelled_at IS NULL
    AND leave_type_id <> 'wfh'
    AND start_date <= ? AND end_date >= ?
  ORDER BY created_at DESC
`);

const selectWfhOn = db.prepare(`
  SELECT id FROM leave_requests
  WHERE employee_id = ? AND status = 'APPROVED' AND cancelled_at IS NULL
    AND leave_type_id = 'wfh'
    AND start_date <= ? AND end_date >= ?
  LIMIT 1
`);

/**
 * True when the employee has approved work from home covering dateKey. On
 * such a day they are treated as a remote worker: phone and laptop time away
 * from the office is recorded as REMOTE_VERIFIED and counted as worked.
 */
async function wfhOn(employeeId, dateKey) {
  return Boolean(await selectWfhOn.get(employeeId, dateKey, dateKey));
}

/**
 * Approved leave covering dateKey, or null. Any leave type counts (paid,
 * unpaid, sick): pay is payroll's question, attendance only needs to know the
 * person was not due in.
 *
 * Returns { requestId, fullDay, half } where half is 'FIRST_HALF' (morning
 * off) or 'SECOND_HALF' (afternoon off) for a part-day request. A part-day
 * value that names neither half is treated as a full day rather than guessed.
 */
async function leaveOn(employeeId, dateKey) {
  const rows = await selectLeaveOn.all(employeeId, dateKey, dateKey);
  if (!rows.length) return null;
  let partDay = null;
  for (const r of rows) {
    const p = String(r.day_portion || 'FULL_DAY').toUpperCase();
    const half = /(^|_)(AM|MORNING|FIRST)/.test(p) ? 'FIRST_HALF'
      : /(^|_)(PM|AFTERNOON|SECOND)/.test(p) ? 'SECOND_HALF'
      : null;
    if (p === 'FULL_DAY' || p === 'FULL' || !half) return { requestId: r.id, fullDay: true, half: null };
    partDay = partDay || { requestId: r.id, fullDay: false, half };
  }
  return partDay;
}

module.exports = { resolve, workingDaysBetween, weekdayKey, invalidate, leaveOn, wfhOn, prayerWindow, prayerOverlapMs, FRIDAY_PRAYER };
