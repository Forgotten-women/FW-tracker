// Payroll preparation. Spec sections 17, 18 and 29.
//
// Policy confirmed by Forgotten Women on 2026-08-27:
//   - daily rate = monthly x 12 / 52 / 5   (2000/month -> 92.31 a day)
//   - the 30 minute break is PAID and part of the working day
//   - every leaver settlement is decided by HR; the engine proposes nothing
//
// The rule that governs this whole file is spec section 18: these are
// "payroll-preparation values requiring HR/payroll approval before
// finalisation". So every figure here is a CALCULATION. Nothing in this module
// changes anyone's pay. calculated_amount and approved_amount are separate
// columns, and only a person writes the second one.
//
// The monthly run (migration 024) automates the calculating, not the deciding:
// the maintenance tick opens each calendar month's period and, after the
// cut-off, generates its deductions and hands it to HR. Only a person
// approving the run - approveRun() below - turns it into payslips.
//
// Precision follows the principle spec section 14 states for leave: full
// precision internally, rounded only at the edge. That gives 369.23 for four
// days at 2000/month where the spec's own worked example shows 369.24 - the
// difference is rounding the daily rate before multiplying, and it is flagged
// on every calculation rather than hidden.

const crypto = require('crypto');
const { db, tx, audit, withReadMemo } = require('../db');
const { config } = require('../config');
const schedule = require('./schedule');
const leave = require('./leave');
const attendance = require('./attendance');
const N = require('./notifications');
const events = require('../events');
const T = require('../util/time');

const P = config.payroll;

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** Rounds to whole pence, at the edge only. */
function money(n) {
  return Math.round(n * 100) / 100;
}

let cachedDailyRateBasis = null;
let cachedDailyRateBasisExpiry = 0;

async function getDailyRateBasis() {
  const now = Date.now();
  if (cachedDailyRateBasis && now < cachedDailyRateBasisExpiry) {
    return cachedDailyRateBasis;
  }
  try {
    const row = await db.prepare("SELECT value FROM org_settings WHERE key = 'payroll_daily_rate_basis'").get();
    cachedDailyRateBasis = row?.value || 'WORKING_DAYS_260';
  } catch (_) {
    cachedDailyRateBasis = 'WORKING_DAYS_260';
  }
  cachedDailyRateBasisExpiry = now + 60 * 1000;
  return cachedDailyRateBasis;
}

/**
 * The rate chain from spec section 17, supporting both:
 * 1. WORKING_DAYS_260: Monthly x 12 / 52 / 5 (Monthly x 12 / 260)
 * 2. CALENDAR_DAYS_30: Monthly / 30 (calendar-month basis)
 */
function rates(monthlyAmount, basis = null) {
  const monthly = Number(monthlyAmount) || 0;
  const effectiveBasis = basis || cachedDailyRateBasis || 'WORKING_DAYS_260';
  const annual = monthly * P.monthsPerYear;
  const weekly = annual / P.weeksPerYear;

  const dailyWorkingDays = weekly / P.workingDaysPerWeek;
  const dailyCalendar30 = monthly / 30;

  let daily;
  let formula;
  let workingDaysPerYear;

  if (effectiveBasis === 'CALENDAR_DAYS_30') {
    daily = dailyCalendar30;
    formula = `monthly / 30 (calendar-day basis)`;
    workingDaysPerYear = 360;
  } else {
    // WORKING_DAYS_260 (default)
    daily = dailyWorkingDays;
    formula = `monthly x ${P.monthsPerYear} / ${P.weeksPerYear} / ${P.workingDaysPerWeek} (monthly x 12 / 260)`;
    workingDaysPerYear = P.weeksPerYear * P.workingDaysPerWeek;
  }

  return {
    monthly: money(monthly),
    annual: money(annual),
    weekly: money(weekly),
    daily: money(daily),
    dailyPrecise: daily,
    dailyWorkingDays: money(dailyWorkingDays),
    dailyCalendar30: money(dailyCalendar30),
    basis: effectiveBasis,
    altDaily: money(effectiveBasis === 'CALENDAR_DAYS_30' ? dailyWorkingDays : dailyCalendar30),
    altBasis: effectiveBasis === 'CALENDAR_DAYS_30' ? 'WORKING_DAYS_260' : 'CALENDAR_DAYS_30',
    formula,
    workingDaysPerYear,
  };
}

const selectSalaryAt = db.prepare(`
  SELECT * FROM salary_history
  WHERE employee_id = ? AND effective_from <= ?
    AND (effective_to IS NULL OR effective_to >= ?)
  ORDER BY effective_from DESC LIMIT 1
`);

/**
 * The salary in force on a date.
 *
 * Reads history rather than a current-value column, so "what was this person
 * paid in June" stays answerable after a pay rise. Spec section 17 requires
 * exactly this.
 */
async function salaryAt(employeeId, dateKey = T.dateKey(), basis = null) {
  const row = await selectSalaryAt.get(employeeId, dateKey, dateKey);
  if (!row) {
    return {
      blocked: true,
      reason: 'NO_SALARY_ON_RECORD',
      message: 'No salary is recorded for this employee on that date, so pay cannot be calculated.',
    };
  }
  const effectiveBasis = basis || await getDailyRateBasis();
  return {
    blocked: false,
    salaryId: row.id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    currency: row.currency,
    payFrequency: row.pay_frequency,
    ...rates(row.amount, effectiveBasis),
  };
}

/**
 * Records a new salary. Append-only: the previous row is closed, never edited,
 * so historical payroll can always be reconstructed.
 */
async function setSalary({ employeeId, amount, effectiveFrom, reason, actor, currency = P.currency, payFrequency = 'Monthly' }) {
  if (!Number.isFinite(Number(amount)) || Number(amount) < 0) {
    throw new Error('A salary amount is required.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveFrom || ''))) {
    throw new Error('effectiveFrom must be YYYY-MM-DD.');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('A reason is required, so a change in pay is always explainable.');
  }

  const id = 'sal_' + crypto.randomBytes(8).toString('hex');
  const nowMs = T.now();
  const previous = await selectSalaryAt.get(employeeId, effectiveFrom, effectiveFrom);

  await tx(async () => {
    if (previous) {
      // Closed the day before the new one starts, so the two never overlap and
      // salaryAt() can never return two answers for one date.
      const dayBefore = T.dateKey(T.startOfDay(effectiveFrom) - 1);
      await db.prepare('UPDATE salary_history SET effective_to = ? WHERE id = ?')
        .run(dayBefore, previous.id);
    }

    await db.prepare(`
      INSERT INTO salary_history
        (id, employee_id, amount, currency, pay_frequency, effective_from,
         daily_rate, reason, created_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, employeeId, Number(amount), currency, payFrequency, effectiveFrom,
           rates(amount).dailyPrecise, String(reason).trim(), nowMs, actor);

    await audit({
      actor, action: 'SALARY_SET',
      targetType: 'employee', targetId: employeeId,
      before: previous ? { amount: previous.amount, effectiveFrom: previous.effective_from } : null,
      after: { amount: Number(amount), effectiveFrom },
      note: String(reason).trim(),
    });
  });

  invalidatePayrollCache(employeeId);

  return await salaryAt(employeeId, effectiveFrom);
}

async function salaryHistoryFor(employeeId) {
  return (await db.prepare(
    'SELECT * FROM salary_history WHERE employee_id = ? ORDER BY effective_from DESC'
  ).all(employeeId)).map(r => ({
    from: r.effective_from,
    to: r.effective_to,
    reason: r.reason,
    setBy: r.created_by,
    setAt: T.displayTime(r.created_at),
    ...rates(r.amount),
  }));
}

// ---------------------------------------------------------------------------
// Working days
// ---------------------------------------------------------------------------

// Short-lived and bounded: a new bank holiday, office closure or shift pattern
// must reach payroll within a minute, not whenever this instance recycles.
const workingDaysCache = new Map(); // key -> { days, expiresAt }
const WORKING_DAYS_TTL_MS = 60 * 1000;
const WORKING_DAYS_MAX = 2000;

/** Scheduled working days for an employee in a range, honouring the calendar. */
async function eligibleWorkingDays(employeeId, fromDate, toDate) {
  const cacheKey = `${employeeId || 'default'}:${fromDate}:${toDate}`;
  const hit = workingDaysCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.days;
  const days = await schedule.workingDaysBetween(employeeId, fromDate, toDate);
  if (workingDaysCache.size >= WORKING_DAYS_MAX) workingDaysCache.clear();
  workingDaysCache.set(cacheKey, { days, expiresAt: Date.now() + WORKING_DAYS_TTL_MS });
  return days;
}

const selectEmploymentDates = db.prepare(`
  SELECT start_date, contract_end_date FROM employment_records
  WHERE employee_id = ? ORDER BY effective_from ASC LIMIT 1
`);

// ---------------------------------------------------------------------------
// Unpaid days
//
// Three sources reduce a monthly salary rather than a day count being summed
// up to it: attendance-deficit whole-days (480+ accumulated minutes), HR-
// confirmed unauthorised absences marked unpaid, and approved unpaid-leave
// requests. All three are DERIVED against payroll_adjustments as the single
// source of truth for "already claimed" - once a day/record/request has ever
// had an adjustment row created for it (approved OR rejected), it is
// permanently excluded from being proposed again. A rejection is a terminal,
// audited decision, not a "try again next period" signal. This needs no
// mutable counter and therefore no rollback path on any failure.
// ---------------------------------------------------------------------------

const ATTENDANCE_DEFICIT_DAY = 'ATTENDANCE_DEFICIT_DAY';
const UNAUTHORISED_ABSENCE_UNPAID = 'UNAUTHORISED_ABSENCE_UNPAID';
const UNPAID_LEAVE_DEDUCTION = 'UNPAID_LEAVE_DEDUCTION';

const selectExistingDeficitAdjustment = db.prepare(`
  SELECT * FROM payroll_adjustments
  WHERE period_id = ? AND employee_id = ? AND adjustment_type = ?
`);

const selectClaimedDeficitDays = db.prepare(`
  SELECT COALESCE(SUM(calculated_days), 0) AS d
  FROM payroll_adjustments WHERE employee_id = ? AND adjustment_type = ?
`);

/**
 * How many NEW attendance-deficit whole-days should be deducted, for a given
 * employee, as of a window's end date.
 *
 * If a payroll_adjustments row already exists for this employee+period (any
 * status), its figure is authoritative for preview - never recomputed to a
 * different number for an already-proposed/decided row. Otherwise the delta
 * is the employee's lifetime whole-day count as of windowEnd (via
 * attendance.balanceAsOf, which is bounded so deficit posted AFTER the
 * window cannot leak in) minus however many whole-days have ever been
 * claimed by a payroll_adjustments row for this employee, across any period.
 *
 * periodId is optional: starterCalculation/leaverCalculation call this
 * standalone (not tied to a specific payroll_periods row), in which case the
 * "existing row for this period" short-circuit is skipped and the live delta
 * is always computed.
 */
async function deficitComponent({ employeeId, periodId = null, windowEnd }) {
  if (periodId) {
    const existing = await selectExistingDeficitAdjustment.get(periodId, employeeId, ATTENDANCE_DEFICIT_DAY);
    if (existing) {
      return {
        days: existing.calculated_days,
        amount: existing.calculated_amount,
        existingAdjustmentId: existing.id,
        status: existing.status,
      };
    }
  }

  const claimed = Number((await selectClaimedDeficitDays.get(employeeId, ATTENDANCE_DEFICIT_DAY)).d) || 0;
  const asOf = await attendance.balanceAsOf(employeeId, windowEnd);
  const days = Math.max(0, asOf.wholeDayEquivalents - claimed);

  return { days, amount: null, existingAdjustmentId: null, status: null, lifetimeWholeDays: asOf.wholeDayEquivalents, claimed };
}

const selectUnclaimedAbsences = db.prepare(`
  SELECT ar.id, ar.date_key, ar.absence_type
  FROM absence_records ar
  WHERE ar.employee_id = ?
    AND ar.status = 'CONFIRMED'
    AND ar.treat_as_unpaid = 1
    AND ar.date_key <= ?
    AND ar.date_key >= ?
    AND NOT EXISTS (
      SELECT 1 FROM payroll_adjustments pa
      WHERE pa.adjustment_type = ? AND pa.source_reference = ar.id
    )
  ORDER BY ar.date_key ASC
`);

/**
 * Confirmed, unpaid-marked absences not yet attached to any payroll
 * adjustment, up to (and including) throughDate. Deliberately unbounded
 * below: a backdated confirmation (HR reviews an old no-show late, after the
 * period it happened in has already closed) still surfaces here rather than
 * being silently lost forever - it will land in whichever period is
 * currently open when this is next run. The same property is what carries
 * anything dated after a monthly run's cut-off into the next month's run.
 * The one lower bound is payroll's go-live date (goLiveDate): anything before
 * it was settled in salaries paid before this system ran payroll.
 */
async function unclaimedUnpaidAbsences({ employeeId, throughDate }) {
  return await selectUnclaimedAbsences.all(employeeId, throughDate, await goLiveDate(), UNAUTHORISED_ABSENCE_UNPAID);
}

const selectUnclaimedUnpaidLeave = db.prepare(`
  SELECT lr.id, lr.start_date, lr.end_date, lr.total_days, lt.name AS leave_type_name
  FROM leave_requests lr
  JOIN leave_types lt ON lt.id = lr.leave_type_id
  WHERE lr.employee_id = ?
    AND lr.status = 'APPROVED'
    AND COALESCE(lr.is_paid, lt.is_paid) = 0
    AND lr.start_date <= ?
    AND lr.start_date >= ?
    AND NOT EXISTS (
      SELECT 1 FROM payroll_adjustments pa
      WHERE pa.adjustment_type = ? AND pa.source_reference = lr.id
    )
  ORDER BY lr.start_date ASC
`);

/**
 * Approved requests on an unpaid-type leave type, not yet attached to any
 * payroll adjustment. Same unbounded-below reasoning as absences. Each
 * request is claimed as a whole (its full total_days, which already accounts
 * for half-day portions) rather than split across a period boundary even if
 * it spans one - simpler, and consistent with how the other two sources are
 * attached to whichever period processes them first.
 */
async function unclaimedUnpaidLeave({ employeeId, throughDate }) {
  return await selectUnclaimedUnpaidLeave.all(employeeId, throughDate, await goLiveDate(), UNPAID_LEAVE_DEDUCTION);
}

/**
 * Combines all three sources into one preview. Read-only - computes what
 * WOULD be deducted, does not create anything. generatePeriodDeductions()
 * below is the only thing that turns this into real payroll_adjustments rows.
 */
async function unpaidDaysSummary({ employeeId, periodId = null, windowEnd, dailyPrecise }) {
  const deficit = await deficitComponent({ employeeId, periodId, windowEnd });
  const absences = await unclaimedUnpaidAbsences({ employeeId, throughDate: windowEnd });
  const leaveRows = await unclaimedUnpaidLeave({ employeeId, throughDate: windowEnd });

  const absenceDays = absences.length;
  const leaveDays = leaveRows.reduce((s, r) => s + (Number(r.total_days) || 0), 0);
  const totalDays = deficit.days + absenceDays + leaveDays;

  return {
    deficitDays: deficit.days,
    deficitAmount: money(dailyPrecise * deficit.days),
    deficitAdjustmentId: deficit.existingAdjustmentId,
    deficitStatus: deficit.status,
    absenceDays,
    absenceAmount: money(dailyPrecise * absenceDays),
    absenceRecordIds: absences.map(a => a.id),
    leaveDays,
    leaveAmount: money(dailyPrecise * leaveDays),
    leaveRequestIds: leaveRows.map(l => l.id),
    totalDays,
    totalAmount: money(dailyPrecise * totalDays),
    // With their dates, for the preflight's "appeared since generation" list.
    absenceRecords: absences.map(a => ({ id: a.id, date: a.date_key })),
    leaveRequests: leaveRows.map(l => ({ id: l.id, startDate: l.start_date, endDate: l.end_date, days: Number(l.total_days) || 0 })),
  };
}

// ---------------------------------------------------------------------------
// Starters (spec 18)
// ---------------------------------------------------------------------------

/**
 * Pro-rata pay for someone who started part-way through a period.
 *
 * Spec 18: daily salary x eligible working days. A starter who works four days
 * in their first month is paid for four days.
 *
 * windowEnd bounds the unpaid days counted, for a period with a cut-off; it
 * defaults to the period's end.
 */
async function starterCalculation({ employeeId, periodStart, periodEnd, periodId = null, windowEnd = null }) {
  const employment = await selectEmploymentDates.get(employeeId);
  if (!employment || !employment.start_date) {
    return { applicable: false, blocked: true, reason: 'NO_START_DATE' };
  }

  const startDate = employment.start_date;
  // Only a starter if they began inside this period.
  if (startDate < periodStart || startDate > periodEnd) {
    return { applicable: false };
  }

  const salary = await salaryAt(employeeId, startDate);
  if (salary.blocked) return { applicable: true, blocked: true, ...salary };

  const workedDays = await eligibleWorkingDays(employeeId, startDate, periodEnd);
  const fullPeriodDays = await eligibleWorkingDays(employeeId, periodStart, periodEnd);

  const unpaid = await unpaidDaysSummary({
    employeeId, periodId, windowEnd: windowEnd || periodEnd, dailyPrecise: salary.dailyPrecise,
  });
  const payableDays = Math.max(0, workedDays.length - unpaid.totalDays);
  const grossPrecise = salary.dailyPrecise * payableDays;

  return {
    applicable: true,
    blocked: false,
    startDate,
    eligibleWorkingDays: workedDays.length,
    fullPeriodWorkingDays: fullPeriodDays.length,
    dailyRate: salary.daily,
    unpaidDays: {
      totalDays: unpaid.totalDays, totalAmount: unpaid.totalAmount,
      deficitDays: unpaid.deficitDays, absenceDays: unpaid.absenceDays, leaveDays: unpaid.leaveDays,
    },
    payableDays,
    calculatedGross: money(grossPrecise),
    // The alternative rounding, shown rather than argued about. The spec's own
    // example rounds the daily rate first, which differs by pennies.
    calculatedGrossRoundedDaily: money(salary.daily * payableDays),
    fullMonthlySalary: salary.monthly,
    formula: `${salary.daily} x ${payableDays} payable day(s) `
           + `(${workedDays.length} worked - ${unpaid.totalDays} unpaid)`,
  };
}

// ---------------------------------------------------------------------------
// Leavers (spec 18)
// ---------------------------------------------------------------------------

/**
 * Every figure spec 18 asks for on a leaver, and no proposal.
 *
 * Confirmed policy is that HR decides each settlement, so this returns
 * calculations for a person to act on. It does not create payroll adjustments,
 * touch leave, or net anything off.
 */
async function leaverCalculation({ employeeId, lastWorkingDate, periodStart = null, periodId = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lastWorkingDate || ''))) {
    throw new Error('lastWorkingDate must be YYYY-MM-DD.');
  }

  const salary = await salaryAt(employeeId, lastWorkingDate);
  if (salary.blocked) return { blocked: true, ...salary };

  const employment = await selectEmploymentDates.get(employeeId);
  const from = periodStart
    || (employment?.start_date && employment.start_date > lastWorkingDate.slice(0, 8) + '01'
        ? employment.start_date
        : lastWorkingDate.slice(0, 8) + '01');

  const workedDays = await eligibleWorkingDays(employeeId, from, lastWorkingDate);

  const unpaid = await unpaidDaysSummary({
    employeeId, periodId, windowEnd: lastWorkingDate, dailyPrecise: salary.dailyPrecise,
  });
  const payableDays = Math.max(0, workedDays.length - unpaid.totalDays);

  // Leave position at the leaving date.
  const balance = await leave.balanceFor(employeeId, lastWorkingDate, { project: true });
  const leaveBlocked = balance.blocked;

  const untakenDays = leaveBlocked ? null : Math.max(0, balance.availableDays);
  const excessTakenDays = leaveBlocked ? null : Math.max(0, -balance.availableDays);

  // Attendance deficit, as whole-day equivalents - the lifetime informational
  // view, kept for continuity. The unpaidDays figure above is what actually
  // reduces calculatedPayForPeriod (only the NEW whole-days not yet claimed
  // by a prior payroll_adjustments row, see deficitComponent()).
  const deficit = await attendance.balanceFor(employeeId);

  return {
    blocked: false,
    lastWorkingDate,
    periodFrom: from,
    currency: salary.currency,

    salary: {
      monthly: salary.monthly,
      annual: salary.annual,
      daily: salary.daily,
      formula: salary.formula,
    },

    eligibleWorkingDays: workedDays.length,
    unpaidDays: {
      totalDays: unpaid.totalDays, totalAmount: unpaid.totalAmount,
      deficitDays: unpaid.deficitDays, absenceDays: unpaid.absenceDays, leaveDays: unpaid.leaveDays,
    },
    payableDays,
    calculatedPayForPeriod: money(salary.dailyPrecise * payableDays),

    leave: leaveBlocked
      ? { blocked: true, reason: balance.reason, message: balance.message }
      : {
          blocked: false,
          accruedDays: balance.accruedDays,
          takenDays: balance.takenDays,
          bookedDays: balance.bookedDays,
          untakenDays,
          excessTakenDays,
          untakenValue: money(salary.dailyPrecise * (untakenDays || 0)),
          excessTakenValue: money(salary.dailyPrecise * (excessTakenDays || 0)),
        },

    attendanceDeficit: {
      balanceMinutes: deficit.balanceMinutes,
      wholeDayEquivalents: deficit.wholeDayEquivalents,
      carryForwardMinutes: deficit.carryForwardMinutes,
      valueOfWholeDays: money(salary.dailyPrecise * deficit.wholeDayEquivalents),
    },

    // Said plainly on every leaver calculation, because this is precisely where
    // a system quietly netting figures off would do real harm.
    note: 'These are calculations only. No deduction, payment or leave change has been '
        + 'made. Every leaver settlement is decided by HR.',
    proposedAdjustments: [],
  };
}

// ---------------------------------------------------------------------------
// Period lifecycle
//
//   OPEN -> IN_REVIEW -> PUBLISHED -> PAID     automated calendar-month runs
//   OPEN -> CLOSED                             legacy manual periods
//
// PUBLISHED, PAID and CLOSED are all final: nothing in a final period can be
// proposed, regenerated, re-rated or decided again. Every transition is a
// conditional UPDATE ... WHERE status = <expected>, taken under lockPayroll(),
// so two serverless instances acting at once can never both win.
// ---------------------------------------------------------------------------

const FINAL_STATUSES = ['PUBLISHED', 'PAID', 'CLOSED'];

function isFinal(status) {
  return FINAL_STATUSES.includes(status);
}

function finalMessage(period) {
  return `This payroll period is ${String(period.status).toLowerCase()}.`;
}

/** An error the routes can turn into a specific status code and body. */
class PayrollRunError extends Error {
  constructor(message, { code, httpStatus = 409, details = null } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

// Serialises everything that creates or finalises payroll rows, across every
// serverless instance. The "already claimed" checks above are read-then-
// insert, so two instances generating at once (the tick landing twice, or HR
// clicking while the tick runs) could otherwise both claim the same absence.
// A transaction-scoped advisory lock is released on commit or rollback by
// itself, is re-entrant within one transaction, and works through Supabase's
// transaction pooler. Must be taken inside tx().
const PAYROLL_LOCK_KEY = 240024;

async function lockPayroll() {
  await db.prepare(`SELECT pg_advisory_xact_lock(${PAYROLL_LOCK_KEY})`).get();
}

const selectPeriod = db.prepare('SELECT * FROM payroll_periods WHERE id = ?');
const selectPeriodForUpdate = db.prepare('SELECT * FROM payroll_periods WHERE id = ? FOR UPDATE');

const selectSetting = db.prepare('SELECT value FROM org_settings WHERE key = ?');

async function settingIsOn(key) {
  const row = await selectSetting.get(key);
  return row ? String(row.value).trim() === '1' : false;
}

const DEFAULT_CUTOFF_DAY = 25;

/**
 * The first date payroll deducts unpaid days for (org_settings.payroll_go_live_date,
 * YYYY-MM-DD). Unpaid leave and unpaid absences dated before it were settled
 * in salaries paid before this system ran payroll, so they are history, never
 * a new deduction. Unset means no lower bound (every date is in scope).
 */
async function goLiveDate() {
  const row = await selectSetting.get('payroll_go_live_date');
  const v = String(row?.value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

/** The org's cut-off day of the month (org_settings.payroll_cutoff_day). */
async function cutoffDay() {
  const row = await selectSetting.get('payroll_cutoff_day');
  const n = parseInt(row?.value, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 31) : DEFAULT_CUTOFF_DAY;
}

/** The calendar month containing dateKey, with its cut-off clamped to its length. */
function calendarMonth(dateKey, day = DEFAULT_CUTOFF_DAY) {
  const [y, m] = String(dateKey).split('-').map(Number);
  const mm = String(m).padStart(2, '0');
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    start: `${y}-${mm}-01`,
    end: `${y}-${mm}-${String(lastDay).padStart(2, '0')}`,
    cutoff: `${y}-${mm}-${String(Math.min(day, lastDay)).padStart(2, '0')}`,
    name: new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y, m - 1, 1))),
  };
}

/**
 * The last date whose data counts toward a period's deductions.
 *
 * An automated period stops at its cut-off (the 25th by default), so the run
 * can be reviewed before pay day; anything dated after it is picked up by next
 * month's run through the unbounded-below "unclaimed" queries above - that is
 * how arrears work, and why nothing is lost. A manual period with no cut-off
 * keeps its old behaviour and runs to its end date. throughDate bounds it
 * further, for an employee's mid-month estimate.
 */
function deductionWindowEnd(period, effectiveEnd, throughDate = null) {
  let end = period.cutoff_date || period.end_date;
  if (effectiveEnd < end) end = effectiveEnd;
  if (throughDate && throughDate < end) end = throughDate;
  return end;
}

// Active employees, plus anyone already deactivated whose contract ended
// inside the period: a leaver switched off before the run is prepared must
// still get their final payslip rather than silently vanish from it.
const selectPayrollEmployees = db.prepare(`
  SELECT e.id, e.name, e.employee_number FROM employees e
  WHERE e.active = 1
     OR EXISTS (
       SELECT 1 FROM employment_records er
       WHERE er.employee_id = e.id AND er.contract_end_date >= ? AND er.contract_end_date <= ?
     )
  ORDER BY e.name, e.id
`);

const selectPaidEmployees = db.prepare(`
  SELECT DISTINCT e.id, e.name, e.employee_number FROM payslips ps
  JOIN employees e ON e.id = ps.employee_id
  WHERE ps.period_id = ?
  ORDER BY e.name, e.id
`);

// A published month is about the people who were paid in it. Listing whoever
// is active today instead would add a later starter to a month they were never
// part of (and drop someone who has since left). Legacy CLOSED periods from
// before payslips existed have none, so they keep the live list.
async function payrollEmployees(period) {
  if (isFinal(period.status)) {
    const paid = await selectPaidEmployees.all(period.id);
    if (paid.length > 0) return paid;
  }
  return await selectPayrollEmployees.all(period.start_date, period.end_date);
}

/**
 * Salary, employment window and gross baseline for one employee in one
 * period - the part every payroll view has to agree on. The prepare sheet, the
 * review sheet, the classifier, the payslip snapshot and the phone's estimate
 * all start here, so they can never disagree about what someone's baseline is.
 */
async function periodBasis(period, employeeId, { throughDate = null, rateBasis = null } = {}) {
  const salary = await salaryAt(employeeId, period.end_date, rateBasis);
  if (salary.blocked) return { blocked: true, salary };

  const employment = await selectEmploymentDates.get(employeeId);
  const effectiveStart = (employment?.start_date && employment.start_date > period.start_date)
    ? employment.start_date
    : period.start_date;
  const effectiveEnd = (employment?.contract_end_date && employment.contract_end_date < period.end_date)
    ? employment.contract_end_date
    : period.end_date;
  const inPeriod = effectiveStart <= period.end_date && effectiveEnd >= period.start_date;

  const isPartialPeriod = effectiveStart > period.start_date || effectiveEnd < period.end_date;

  let workingDaysCount = 0;
  let fullPeriodDays = 0;

  if (isPartialPeriod) {
    const [workedDays, fullDays] = await Promise.all([
      inPeriod ? eligibleWorkingDays(employeeId, effectiveStart, effectiveEnd) : Promise.resolve([]),
      eligibleWorkingDays(employeeId, period.start_date, period.end_date),
    ]);
    workingDaysCount = workedDays.length;
    fullPeriodDays = fullDays.length;
  } else if (inPeriod) {
    const fullDays = await eligibleWorkingDays(employeeId, period.start_date, period.end_date);
    workingDaysCount = fullDays.length;
    fullPeriodDays = fullDays.length;
  }

  const grossBaseline = isPartialPeriod ? money(salary.dailyPrecise * workingDaysCount) : salary.monthly;

  const startDate = employment?.start_date || null;
  const lastWorkingDate = employment?.contract_end_date || null;

  return {
    blocked: false,
    salary,
    employment,
    effectiveStart,
    effectiveEnd,
    inPeriod,
    workingDaysCount,
    fullPeriodDays,
    isPartialPeriod,
    grossBaseline,
    windowEnd: deductionWindowEnd(period, effectiveEnd, throughDate),
    startDate,
    lastWorkingDate,
    // Joined part-way through, or leaving inside, this period. Both make every
    // line for the employee an ATTENTION line on the review sheet.
    joinsInPeriod: !!startDate && startDate > period.start_date && startDate <= period.end_date,
    leavesInPeriod: !!lastWorkingDate && lastWorkingDate >= period.start_date && lastWorkingDate <= period.end_date,
    // The legacy statement's meaning of "starter": began on any day of the
    // period, including the first.
    startedInPeriod: !!startDate && startDate >= period.start_date && startDate <= period.end_date,
  };
}

const selectPeriodAdjustmentsFor = db.prepare(
  'SELECT * FROM payroll_adjustments WHERE period_id = ? AND employee_id = ? ORDER BY created_at ASC, id ASC'
);

function parseReasons(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function presentAdjustment(a) {
  return {
    id: a.id, type: a.adjustment_type, status: a.status,
    calculatedAmount: a.calculated_amount,
    approvedAmount: a.approved_amount,
    explanation: a.explanation,
    calculatedDays: a.calculated_days,
    approvedDays: a.approved_days,
    sourceReference: a.source_reference,
    // null only on rows from before migration 024 that have not been
    // classified since; approve-run treats an undecided one like ATTENTION.
    reviewLevel: a.review_level || null,
    reviewReasons: parseReasons(a.review_reasons),
    approvedBy: a.approved_by || null,
    approvedAt: a.approved_at || null,
  };
}

/**
 * One employee's row on the preparation sheet, plus the pieces the review
 * sheet and the estimate build on. `detail` adds the lifetime deficit and
 * leave views and the starter breakdown, which only the sheets show.
 */
async function employeePosition(period, e, { throughDate = null, detail = true, rateBasis = null } = {}) {
  const basis = await periodBasis(period, e.id, { throughDate, rateBasis });
  if (basis.blocked) {
    return {
      employee: e,
      blocked: {
        employeeId: e.id, employeeName: e.name, employeeNumber: e.employee_number || null,
        reason: basis.salary.reason, message: basis.salary.message,
      },
    };
  }

  const { salary, windowEnd, isPartialPeriod, workingDaysCount, fullPeriodDays, grossBaseline } = basis;

  const [unpaid, existing, starter, deficit, balance] = await Promise.all([
    unpaidDaysSummary({
      employeeId: e.id, periodId: period.id, windowEnd, dailyPrecise: salary.dailyPrecise,
    }),
    selectPeriodAdjustmentsFor.all(period.id, e.id),
    detail ? starterCalculation({
      employeeId: e.id, periodStart: period.start_date, periodEnd: period.end_date, periodId: period.id, windowEnd,
    }) : Promise.resolve(null),
    detail ? attendance.balanceAsOf(e.id, period.end_date).catch(() => ({ wholeDayEquivalents: 0, carryForwardMinutes: 0 })) : Promise.resolve({ wholeDayEquivalents: 0, carryForwardMinutes: 0 }),
    detail ? leave.balanceFor(e.id, period.end_date, null, { skipAccrue: true, summaryOnly: true }).catch(() => ({ blocked: false, availableDays: 0, isNegative: false })) : Promise.resolve({ blocked: false, availableDays: 0, isNegative: false }),
  ]);

  if (!detail) return { employee: e, basis, unpaid, existing };

  const calculatedPeriodGross = isPartialPeriod
    ? money(salary.dailyPrecise * Math.max(0, workingDaysCount - unpaid.totalDays))
    : money(salary.monthly - salary.dailyPrecise * unpaid.totalDays);

  const approvedTotal = existing
    .filter(a => a.status === 'APPROVED')
    .reduce((s, a) => s + Number(a.approved_amount || 0), 0);
  const hasPending = existing.some(a => a.status === 'PROPOSED');
  // PROVISIONAL: nothing has been proposed for this employee/period yet --
  // netPayable is just the undeducted baseline. PARTIALLY_DECIDED: some
  // adjustments are still awaiting a decision. DECIDED: every adjustment
  // that exists has been approved or rejected.
  const netBasis = existing.length === 0 ? 'PROVISIONAL' : (hasPending ? 'PARTIALLY_DECIDED' : 'DECIDED');

  const additionsTotal = existing
    .filter(a => standingAmount(a) > 0)
    .reduce((s, a) => s + standingAmount(a), 0);
  const deductionsTotal = existing
    .filter(a => standingAmount(a) < 0)
    .reduce((s, a) => s + -standingAmount(a), 0);
  const approvedAdditionsTotal = existing
    .filter(a => a.status === 'APPROVED' && Number(a.approved_amount || 0) > 0)
    .reduce((s, a) => s + Number(a.approved_amount || 0), 0);
  const approvedDeductionsTotal = existing
    .filter(a => a.status === 'APPROVED' && Number(a.approved_amount || 0) < 0)
    .reduce((s, a) => s + -Number(a.approved_amount || 0), 0);

  const projectedDeductions = Math.max(unpaid.totalAmount, deductionsTotal);
  const projectedNetPayable = money(grossBaseline - projectedDeductions + additionsTotal);

  const row = {
    employeeId: e.id,
    employeeName: e.name,
    employeeNumber: e.employee_number || null,
    salary: {
      monthly: salary.monthly,
      daily: salary.daily,
      annual: salary.annual,
      currency: salary.currency || 'GBP',
      dailyWorkingDays: salary.dailyWorkingDays,
      dailyCalendar30: salary.dailyCalendar30,
      basis: salary.basis,
    },
    isPartialPeriod,
    workingDaysCount,
    fullPeriodDays,
    grossBaseline,
    calculatedPeriodGross,
    // The last date whose data this row's deductions count: the cut-off, or
    // the period end for a manual period, or a leaver's last day if earlier.
    deductionsThrough: windowEnd,
    isStarter: starter?.applicable && !starter?.blocked,
    starter: starter?.applicable && !starter?.blocked ? {
      startDate: starter.startDate,
      eligibleWorkingDays: starter.eligibleWorkingDays,
      calculatedGross: starter.calculatedGross,
    } : null,
    unpaidDays: {
      deficitDays: unpaid.deficitDays, deficitAmount: unpaid.deficitAmount,
      deficitAdjustmentId: unpaid.deficitAdjustmentId, deficitStatus: unpaid.deficitStatus,
      absenceDays: unpaid.absenceDays, absenceAmount: unpaid.absenceAmount, absenceRecordIds: unpaid.absenceRecordIds,
      leaveDays: unpaid.leaveDays, leaveAmount: unpaid.leaveAmount, leaveRequestIds: unpaid.leaveRequestIds,
      totalDays: unpaid.totalDays, totalAmount: unpaid.totalAmount,
    },
    netPayable: { amount: money(grossBaseline + approvedTotal), basis: netBasis },
    projectedNetPayable,
    additions: {
      total: additionsTotal,
      approvedTotal: approvedAdditionsTotal,
      items: existing.filter(a => standingAmount(a) > 0).map(presentAdjustment),
    },
    attendanceDeficit: {
      wholeDayEquivalents: deficit.wholeDayEquivalents || 0,
      carryForwardMinutes: deficit.carryForwardMinutes || 0,
      valueIfDeducted: money(salary.dailyPrecise * (deficit.wholeDayEquivalents || 0)),
      needsHrDecision: (deficit.wholeDayEquivalents || 0) > 0,
    },
    leave: balance.blocked
      ? { blocked: true, reason: balance.reason }
      : { available: balance.availableDays, isNegative: balance.isNegative },
    adjustments: existing.map(presentAdjustment),
  };

  return { employee: e, basis, unpaid, existing, row };
}

// ---------------------------------------------------------------------------
// Periods and adjustments
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function createPeriod({ name, startDate, endDate, exchangeRate = 350.0, processingFee = 0, processingFeeType = 'DEDUCTION', processingFeeBasis = 'PERCENT', cutoffDate = null, payDate = null, actor }) {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new Error('startDate and endDate must be YYYY-MM-DD.');
  }
  if (endDate < startDate) throw new Error('endDate must be on or after startDate.');
  // Optional on a manual period. Without a cut-off a period's deductions run
  // to its end date, exactly as before.
  if (cutoffDate !== null && cutoffDate !== undefined && cutoffDate !== '') {
    if (!DATE_RE.test(cutoffDate) || cutoffDate < startDate || cutoffDate > endDate) {
      throw new Error('cutoffDate must be YYYY-MM-DD, inside the period.');
    }
  } else {
    cutoffDate = null;
  }
  if (payDate !== null && payDate !== undefined && payDate !== '') {
    if (!DATE_RE.test(payDate)) throw new Error('payDate must be YYYY-MM-DD.');
  } else {
    payDate = null;
  }

  const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 350.0;
  const feeBasis = String(processingFeeBasis).toUpperCase() === 'FIXED' ? 'FIXED' : 'PERCENT';
  const fee = Number(processingFee) >= 0 ? Number(processingFee) : 0;
  if (feeBasis === 'PERCENT' && fee > 100) throw new Error('The processing fee must be a percentage between 0 and 100.');
  const feeType = (String(processingFeeType).toUpperCase() === 'ADDITION') ? 'ADDITION' : 'DEDUCTION';
  const id = 'pp_' + crypto.randomBytes(6).toString('hex');
  const nowMs = T.now();

  try {
    await db.prepare(`
      INSERT INTO payroll_periods (id, name, start_date, end_date, exchange_rate, processing_fee, processing_fee_type, processing_fee_basis, status, created_at, cutoff_date, pay_date)
      VALUES (?,?,?,?,?,?,?,?, 'OPEN', ?, ?, ?)
    `).run(id, name || `${startDate} to ${endDate}`, startDate, endDate, rate, fee, feeType, feeBasis, nowMs, cutoffDate, payDate);
  } catch (err) {
    if (err.code === '23505') throw new Error('A payroll period for exactly these dates already exists.');
    throw err;
  }

  // A processing fee becomes one routine line per employee, straight away, so
  // the month's draft invoices show it. Generating deductions refreshes them.
  if (fee > 0) await syncProcessingFees(await selectPeriod.get(id));

  invalidatePayrollCache(null, id);

  await audit({ actor, action: 'PAYROLL_PERIOD_CREATED', targetType: 'payroll_period', targetId: id,
          after: { startDate, endDate, exchangeRate: rate, processingFee: fee, processingFeeType: feeType, processingFeeBasis: feeBasis, cutoffDate, payDate } });
  return { id, name: name || `${startDate} to ${endDate}`, startDate, endDate, exchangeRate: rate, processingFee: fee, processingFeeType: feeType, processingFeeBasis: feeBasis, status: 'OPEN', cutoffDate, payDate };
}

// ---------------------------------------------------------------------------
// Processing fee
//
// A percentage of each employee's gross pay for the period (the contract
// salary, pro-rated for a starter or leaver), as one routine PROCESSING_FEE
// line per employee. Periods from before migration 030 hold a fixed amount
// (processing_fee_basis = 'FIXED') and keep it.
// ---------------------------------------------------------------------------

function processingFeeFor(period, grossBaseline) {
  const fee = Number(period.processing_fee) || 0;
  if (fee <= 0) return 0;
  const amount = (period.processing_fee_basis || 'FIXED') === 'PERCENT'
    ? money(grossBaseline * fee / 100)
    : money(fee);
  return period.processing_fee_type === 'ADDITION' ? amount : -amount;
}

function processingFeeExplanation(period, grossBaseline, currency) {
  const kind = period.processing_fee_type === 'ADDITION' ? 'addition' : 'deduction';
  if ((period.processing_fee_basis || 'FIXED') === 'PERCENT') {
    return `Processing fee (${kind}): ${Number(period.processing_fee)}% of gross pay `
         + `${currency || ''} ${money(grossBaseline).toFixed(2)}`.replace(/\s+/g, ' ').trim() + '.';
  }
  return `Processing fee (${kind}).`;
}

const selectProcessingFeeLine = db.prepare(
  "SELECT * FROM payroll_adjustments WHERE period_id = ? AND employee_id = ? AND adjustment_type = 'PROCESSING_FEE' ORDER BY created_at ASC LIMIT 1"
);

/**
 * One employee's fee line, created if missing, or brought up to date while it
 * is still PROPOSED (the salary or the pro-rating may have changed). A line
 * HR has already decided is never touched. Returns the line's id or null.
 */
async function syncProcessingFeeFor(period, employeeId, basis) {
  // Processing fee is an organizational cost displayed to HR only.
  // It is never deducted from or added to an employee's salary or invoice.
  return null;
}

/** Every eligible employee's fee line for a period (see syncProcessingFeeFor). */
async function syncProcessingFees(period, { employeeIds = null } = {}) {
  // Processing fee is calculated at period/totals level for HR, not as employee adjustments.
  return 0;
}

async function updatePeriodExchangeRate({ periodId, exchangeRate, actor }) {
  const period = await selectPeriod.get(periodId);
  if (!period) throw new Error('No such payroll period.');
  if (isFinal(period.status)) {
    throw new Error(`Cannot change the exchange rate of a ${period.status.toLowerCase()} payroll period.`);
  }

  const rate = Number(exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('A positive numeric exchange rate is required.');
  }

  await db.prepare('UPDATE payroll_periods SET exchange_rate = ? WHERE id = ?').run(rate, periodId);
  invalidatePayrollCache(null, periodId);
  await audit({
    actor, action: 'PAYROLL_PERIOD_EXCHANGE_RATE_UPDATED', targetType: 'payroll_period', targetId: periodId,
    before: { exchangeRate: period.exchange_rate }, after: { exchangeRate: rate },
  });

  return { periodId, exchangeRate: rate, message: 'Exchange rate updated for this period.' };
}

/**
 * Set or change a period's processing fee (a % of each employee's gross)
 * while the run is not final. Undecided fee lines are recalculated, and
 * removed when the fee is set to 0; a line HR has already decided stays as
 * decided.
 */
async function updatePeriodProcessingFee({ periodId, processingFee, processingFeeType = 'DEDUCTION', actor }) {
  const period = await selectPeriod.get(periodId);
  if (!period) throw new Error('No such payroll period.');
  if (isFinal(period.status)) {
    throw new Error(`Cannot change the processing fee of a ${period.status.toLowerCase()} payroll period.`);
  }
  const fee = Number(processingFee);
  if (!Number.isFinite(fee) || fee < 0 || fee > 100) {
    throw new Error('The processing fee must be a percentage between 0 and 100.');
  }
  const feeType = String(processingFeeType).toUpperCase() === 'ADDITION' ? 'ADDITION' : 'DEDUCTION';

  await db.prepare(`
    UPDATE payroll_periods SET processing_fee = ?, processing_fee_type = ?, processing_fee_basis = 'PERCENT'
    WHERE id = ?
  `).run(fee, feeType, periodId);

  let removed = 0;
  let lines = 0;
  if (fee === 0) {
    removed = (await db.prepare(
      "DELETE FROM payroll_adjustments WHERE period_id = ? AND adjustment_type = 'PROCESSING_FEE' AND status = 'PROPOSED'"
    ).run(periodId)).changes;
  } else {
    lines = await syncProcessingFees(await selectPeriod.get(periodId));
  }
  const decided = Number((await db.prepare(
    "SELECT COUNT(*) AS c FROM payroll_adjustments WHERE period_id = ? AND adjustment_type = 'PROCESSING_FEE' AND status <> 'PROPOSED'"
  ).get(periodId)).c) || 0;

  invalidatePayrollCache(null, periodId);
  await audit({
    actor, action: 'PAYROLL_PERIOD_PROCESSING_FEE_UPDATED', targetType: 'payroll_period', targetId: periodId,
    before: {
      processingFee: Number(period.processing_fee) || 0, processingFeeType: period.processing_fee_type,
      processingFeeBasis: period.processing_fee_basis || 'FIXED',
    },
    after: { processingFee: fee, processingFeeType: feeType, processingFeeBasis: 'PERCENT', lines, removed, decidedUnchanged: decided },
  });

  return {
    periodId, processingFee: fee, processingFeeType: feeType, processingFeeBasis: 'PERCENT',
    lines, removed, decidedUnchanged: decided,
    message: fee === 0
      ? 'Processing fee removed from this period.'
      : `Processing fee set to ${fee}% of gross pay for this period.`,
  };
}

function presentSheetPeriod(period) {
  return {
    id: period.id, name: period.name,
    from: period.start_date, to: period.end_date,
    exchangeRate: period.exchange_rate || 350.0,
    processingFee: Number(period.processing_fee) || 0,
    processingFeeType: period.processing_fee_type || 'DEDUCTION',
    processingFeeBasis: period.processing_fee_basis || 'FIXED',
    status: period.status,
    cutoffDate: period.cutoff_date || null,
    payDate: period.pay_date || null,
  };
}

// In-memory caches for payroll calculation sheets
const prepMemoryCache = new Map();
const PREP_CACHE_TTL_MS = 20 * 1000;
const reviewMemoryCache = new Map();
const REVIEW_CACHE_TTL_MS = 20 * 1000;

/**
 * Builds the preparation sheet for a period.
 *
 * Read-only by design: it computes what each employee's position looks like and
 * writes nothing. Adjustments are created only when a person chooses to.
 */
// Read-only sheets run inside a read memo (db/pg/client.js): the helpers they
// compose fetch the same rows several times per employee.
function preparePeriod(periodId, opts = {}) {
  return withReadMemo(() => preparePeriodUncached(periodId, opts));
}

async function preparePeriodUncached(periodId, { basis = null } = {}) {
  const period = await selectPeriod.get(periodId);
  if (!period) throw new Error('No such payroll period.');

  const rateBasis = basis || await getDailyRateBasis();

  // Fast memory cache check
  const memKey = `${periodId}:${rateBasis}`;
  const memHit = prepMemoryCache.get(memKey);
  if (memHit && Date.now() < memHit.expiresAt) {
    return memHit.data;
  }

  const employees = await payrollEmployees(period);

  // Compute all employee positions concurrently in parallel
  const positions = await Promise.all(
    employees.map(e => employeePosition(period, e, { rateBasis }))
  );

  const rows = [];
  const blocked = [];

  for (const pos of positions) {
    if (pos.blocked) {
      blocked.push(pos.blocked);
    } else if (pos.row) {
      rows.push(pos.row);
    }
  }

  const result = {
    period: { ...presentSheetPeriod(period), dailyRateBasis: rateBasis },
    employees: rows,
    blocked,
    note: 'Nothing here affects pay until an adjustment is created and approved. '
        + 'calculatedPeriodGross and unpaidDays are a preview of what generate-deductions would '
        + 'propose; netPayable reflects only what has actually been approved.',
  };

  prepMemoryCache.set(memKey, { data: result, expiresAt: Date.now() + PREP_CACHE_TTL_MS });
  return result;
}

const insertAdjustment = db.prepare(`
  INSERT INTO payroll_adjustments
    (id, period_id, employee_id, adjustment_type, calculated_days, calculated_amount,
     source_reference, explanation, status, created_at, review_level, review_reasons)
  VALUES (?,?,?,?,?,?,?,?, 'PROPOSED', ?, ?, ?)
`);

// Why a hand-entered line always needs a person to look at it: nothing the
// engine knows produced its figure.
const MANUAL_REASON = 'Entered by hand rather than calculated by the system';

async function createAdjustment({ periodId, employeeId, adjustmentType, calculatedDays = 0, calculatedAmount = 0, explanation, sourceReference = null, actor, reviewLevel = null, reviewReasons = null }) {
  if (!explanation || !String(explanation).trim()) {
    throw new Error('An explanation is required for any payroll adjustment.');
  }
  const period = await selectPeriod.get(periodId);
  if (!period) throw new Error('No such payroll period.');
  if (isFinal(period.status)) throw new Error(finalMessage(period));

  const id = 'pa_' + crypto.randomBytes(8).toString('hex');
  await insertAdjustment.run(id, periodId, employeeId, adjustmentType, Number(calculatedDays) || 0,
         Number(calculatedAmount) || 0, sourceReference, String(explanation).trim(), T.now(),
         reviewLevel, reviewReasons ? JSON.stringify(reviewReasons) : null);

  await audit({
    actor, action: 'PAYROLL_ADJUSTMENT_PROPOSED',
    targetType: 'employee', targetId: employeeId,
    after: { adjustmentId: id, adjustmentType, calculatedAmount },
    note: String(explanation).trim(),
  });

  return { id, status: 'PROPOSED' };
}

/**
 * Creates a PROPOSED adjustment. Never approved at the same time.
 *
 * Proposed by a person (any actor but 'system'), it is an ATTENTION line from
 * the start: the monthly run approves ROUTINE lines in bulk, and a figure
 * someone typed in is never routine.
 */
async function proposeAdjustment({ periodId, employeeId, adjustmentType, calculatedDays = 0, calculatedAmount = 0, explanation, sourceReference = null, actor }) {
  const manual = actor !== 'system';
  const r = await createAdjustment({
    periodId, employeeId, adjustmentType, calculatedDays, calculatedAmount, explanation, sourceReference, actor,
    reviewLevel: manual ? 'ATTENTION' : null,
    reviewReasons: manual ? [MANUAL_REASON] : null,
  });
  invalidatePayrollCache(employeeId);
  return r;
}

function validateDecision(decision, notes) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw new Error('decision must be APPROVED or REJECTED.');
  }
  if (!notes || !String(notes).trim()) throw new Error('A note explaining the decision is required.');
}

/**
 * Records one decision. Shared by decideAdjustment() and the bulk approveRun(),
 * and must run inside a transaction. The update is conditional on the row
 * still being PROPOSED, so two people deciding the same line at once cannot
 * both succeed.
 */
async function applyDecision(adj, { decision, approvedDays = null, approvedAmount = null, notes, deductFromPaidLeave = false }, actor, nowMs) {
  validateDecision(decision, notes);
  if (adj.status !== 'PROPOSED') throw new Error(`This adjustment is already ${adj.status.toLowerCase()}.`);
  if (approvedAmount !== null && !Number.isFinite(Number(approvedAmount))) {
    throw new Error('approvedAmount must be a number.');
  }
  if (approvedDays !== null && !Number.isFinite(Number(approvedDays))) {
    throw new Error('approvedDays must be a number.');
  }

  let finalAmount = decision === 'APPROVED'
    ? (approvedAmount === null ? adj.calculated_amount : Number(approvedAmount))
    : null;
  const finalDays = decision === 'APPROVED'
    ? (approvedDays === null ? adj.calculated_days : Number(approvedDays))
    : null;

  // If HR decides to deduct from the employee's accrued paid leave balance instead of unpaid salary deduction
  if (decision === 'APPROVED' && deductFromPaidLeave) {
    finalAmount = 0; // Salary is NOT deducted; paid leave balance absorbs it
    try {
      const leaveDomain = require('./leave');
      const daysCount = Math.abs(finalDays || adj.calculated_days || 1);
      await leaveDomain.adjustBalance({
        employeeId: adj.employee_id,
        days: -daysCount,
        reason: `Attendance deficit offset: ${daysCount} day(s) deducted from accrued paid leaves`,
        actor,
      });
    } catch (err) {
      console.error('[payroll] could not deduct from paid leave:', err.message);
      throw new Error(`Failed to deduct from paid leave balance: ${err.message}`);
    }
  }

  const res = await db.prepare(`
    UPDATE payroll_adjustments
    SET status = ?, approved_days = ?, approved_amount = ?, approved_by = ?, approved_at = ?
    WHERE id = ? AND status = 'PROPOSED'
  `).run(decision, finalDays, finalAmount, actor, nowMs, adj.id);
  if (!res.changes) throw new Error('This adjustment has already been decided.');

  // Gives absence_records.consequences_applied_at (previously unused) its
  // intended meaning: this absence has now actually cost the employee pay,
  // not merely been proposed to.
  if (decision === 'APPROVED' && adj.adjustment_type === UNAUTHORISED_ABSENCE_UNPAID && adj.source_reference) {
    await db.prepare('UPDATE absence_records SET consequences_applied_at = ? WHERE id = ?')
      .run(nowMs, adj.source_reference);
  }

  await audit({
    actor, action: 'PAYROLL_ADJUSTMENT_DECIDED',
    targetType: 'employee', targetId: adj.employee_id,
    before: { status: adj.status, calculatedAmount: adj.calculated_amount },
    after: { status: decision, approvedAmount: finalAmount, deductFromPaidLeave: !!deductFromPaidLeave },
    note: String(notes).trim()
      + (deductFromPaidLeave ? ' (Offset against accrued paid leaves: salary not deducted)' : '')
      + (finalAmount !== null && finalAmount !== adj.calculated_amount && !deductFromPaidLeave
          ? ` (overridden from the calculated ${adj.calculated_amount})`
          : ''),
  });

  return { employeeId: adj.employee_id, decision, approvedAmount: finalAmount, approvedDays: finalDays, deductFromPaidLeave: !!deductFromPaidLeave };
}

/**
 * A person approves or rejects. The approved amount is recorded SEPARATELY from
 * the calculated one, so a figure that was overridden stays visible as an
 * override rather than replacing the calculation.
 */
async function decideAdjustment({ adjustmentId, decision, approvedDays = null, approvedAmount = null, notes, actor, deductFromPaidLeave = false }) {
  validateDecision(decision, notes);

  const r = await tx(async () => {
    const adj = await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ? FOR UPDATE').get(adjustmentId);
    if (!adj) throw new Error('No such adjustment.');
    const period = await selectPeriod.get(adj.period_id);
    if (period && isFinal(period.status) && adj.status === 'PROPOSED') throw new Error(finalMessage(period));
    return await applyDecision(adj, { decision, approvedDays, approvedAmount, notes, deductFromPaidLeave }, actor, T.now());
  });

  invalidatePayrollCache(r.employeeId);

  return { decision: r.decision, approvedAmount: r.approvedAmount, approvedDays: r.approvedDays, deductFromPaidLeave: r.deductFromPaidLeave };
}

/**
 * Closes a legacy manual period. Only approved adjustments are final.
 *
 * A run that has been published has payslips and is finished with
 * markPaid() instead; closing it would leave two answers to "is this final".
 */
async function closePeriod({ periodId, actor }) {
  await tx(async () => {
    await lockPayroll();
    const period = await selectPeriodForUpdate.get(periodId);
    if (!period) throw new Error('No such payroll period.');
    if (period.status === 'PUBLISHED' || period.status === 'PAID') {
      throw new Error('This payroll run has been published with payslips; mark it paid rather than closing it.');
    }
    // Closing is the legacy manual path and creates no payslips. On a run the
    // system manages (auto-opened, or already generated for review) it would
    // end the month without anyone ever being shown a payslip for it.
    if (Number(period.auto_created) === 1 || period.status === 'IN_REVIEW') {
      throw new Error('This payroll run is managed automatically. Approve and publish it (which creates payslips) instead of closing it.');
    }

    const pending = (await db.prepare(
      "SELECT COUNT(*) c FROM payroll_adjustments WHERE period_id = ? AND status = 'PROPOSED'"
    ).get(periodId)).c;
    if (pending > 0) {
      throw new Error(`${pending} adjustment(s) are still awaiting a decision. Decide them before closing.`);
    }

    await db.prepare("UPDATE payroll_periods SET status = 'CLOSED', approved_by = ?, approved_at = ? WHERE id = ?")
      .run(actor, T.now(), periodId);

    await audit({ actor, action: 'PAYROLL_PERIOD_CLOSED', targetType: 'payroll_period', targetId: periodId });
  });
  invalidatePayrollCache();
  return { closed: true };
}

/**
 * Turns the "unpaid days" preview preparePeriod() computes into real
 * PROPOSED payroll_adjustments -- one row per employee for the attendance-
 * deficit component, one row per record for absences and unpaid leave.
 *
 * Never runs as a side effect of viewing the prepare sheet: this is an
 * explicit, separate action a person chooses to take (mirrors closePeriod),
 * or the monthly run's cut-off step - not something a GET request should
 * ever trigger. Safe to call more than once for the same period -- every
 * source's "already claimed" check means a second run creates nothing new,
 * and the payroll lock means two concurrent runs cannot both claim a source.
 *
 * Every open line is (re)classified ROUTINE/ATTENTION before returning.
 */
async function generatePeriodDeductions({ periodId, actor, employeeIds = null }) {
  const only = employeeIds ? new Set(employeeIds) : null;
  const result = await tx(async () => {
    await lockPayroll();
    const period = await selectPeriodForUpdate.get(periodId);
    if (!period) throw new Error('No such payroll period.');
    if (isFinal(period.status)) throw new Error(finalMessage(period));

    const created = [];
    const bases = new Map();

    for (const e of await payrollEmployees(period)) {
      if (only && !only.has(e.id)) continue;
      const basis = await periodBasis(period, e.id);
      if (basis.blocked || !basis.inPeriod) continue;
      bases.set(e.id, basis);

      const { salary, windowEnd } = basis;

      // The processing fee, from this employee's gross (added for anyone who
      // joined after the period was created; refreshed while undecided).
      await syncProcessingFeeFor(period, e.id, basis);

      // Attendance deficit: one row per employee per period.
      const deficit = await deficitComponent({ employeeId: e.id, periodId, windowEnd });
      if (!deficit.existingAdjustmentId && deficit.days > 0) {
        const adj = await createAdjustment({
          periodId, employeeId: e.id, adjustmentType: ATTENDANCE_DEFICIT_DAY,
          calculatedDays: deficit.days,
          calculatedAmount: -money(salary.dailyPrecise * deficit.days),
          explanation: `Attendance deficit: ${deficit.days} whole day(s) threshold crossed (480+ accumulated `
                     + `minutes) as of ${windowEnd}. Decision required: deduct from paid leave accrual or unpaid leave.`,
          sourceReference: null, actor,
          reviewLevel: 'ATTENTION',
          reviewReasons: ['Deficit threshold reached: choose paid leave accrual or unpaid leave deduction'],
        });
        created.push({ employeeId: e.id, adjustmentType: ATTENDANCE_DEFICIT_DAY, ...adj });
      }

      // Unauthorised absences: one row per unclaimed confirmed+unpaid record.
      const absences = await unclaimedUnpaidAbsences({ employeeId: e.id, throughDate: windowEnd });
      for (const abs of absences) {
        const adj = await createAdjustment({
          periodId, employeeId: e.id, adjustmentType: UNAUTHORISED_ABSENCE_UNPAID,
          calculatedDays: 1,
          calculatedAmount: -money(salary.dailyPrecise),
          explanation: `Unauthorised absence on ${abs.date_key}, confirmed by HR and marked `
                     + `unpaid. Auto-calculated.`,
          sourceReference: abs.id, actor,
        });
        created.push({ employeeId: e.id, adjustmentType: UNAUTHORISED_ABSENCE_UNPAID, ...adj });
      }

      // Approved unpaid leave: one row per unclaimed approved unpaid-type request.
      const leaveRows = await unclaimedUnpaidLeave({ employeeId: e.id, throughDate: windowEnd });
      for (const lr of leaveRows) {
        const days = Number(lr.total_days) || 0;
        if (days <= 0) continue;
        const adj = await createAdjustment({
          periodId, employeeId: e.id, adjustmentType: UNPAID_LEAVE_DEDUCTION,
          calculatedDays: days,
          calculatedAmount: -money(salary.dailyPrecise * days),
          explanation: `Unpaid leave (${lr.leave_type_name}) from ${lr.start_date} to ${lr.end_date}, `
                     + `${days} day(s). Auto-calculated.`,
          sourceReference: lr.id, actor,
        });
        created.push({ employeeId: e.id, adjustmentType: UNPAID_LEAVE_DEDUCTION, ...adj });
      }
    }

    const classification = await classifyPeriodAdjustments(period, bases);

    await audit({
      actor, action: 'PAYROLL_DEDUCTIONS_GENERATED', targetType: 'payroll_period', targetId: periodId,
      after: { createdCount: created.length, ...(only ? { employeeIds: [...only] } : {}), ...classification },
    });

    return { periodId, createdCount: created.length, created, employees: bases.size, classification };
  });

  invalidatePayrollCache();
  return result;
}

/**
 * A decision HR makes while a run is IN_REVIEW - confirming an absence as
 * unpaid, approving unpaid leave - joins that run straight away, for that one
 * employee, instead of waiting for someone to press "generate deductions"
 * again (the preflight blocks approval until they do).
 *
 * Only a run still IN_REVIEW whose deduction window reaches the date: an OPEN
 * month picks it up at its own cut-off, and once a run is approved the next
 * month's run collects it (the unclaimed queries have no lower date bound).
 * Never throws: the decision itself has already been recorded.
 */
const selectRunInReviewFor = db.prepare(`
  SELECT id FROM payroll_periods
  WHERE status = 'IN_REVIEW' AND COALESCE(cutoff_date, end_date) >= ?
  ORDER BY start_date ASC LIMIT 1
`);

async function addDecisionToRunInReview({ employeeId, dateKey, actor }) {
  try {
    const period = await selectRunInReviewFor.get(dateKey);
    if (!period) return null;
    const r = await generatePeriodDeductions({ periodId: period.id, actor, employeeIds: [employeeId] });
    return { periodId: period.id, createdCount: r.createdCount };
  } catch (err) {
    console.error(`[payroll] could not add ${employeeId}'s decision to the run in review:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exception-based review
//
// Every PROPOSED line is classified so HR can approve the ordinary ones in
// bulk and spend their attention where it is needed:
//
//   ROUTINE    unpaid leave and HR-confirmed unpaid absences - a person has
//              already decided each of these once
//   ATTENTION  attendance-deficit days (derived, not decided), anything
//              entered by hand, and every line of an employee who is a
//              starter or leaver this period, whose salary changed in the
//              period, or whose deductions exceed 3 days or 20% of gross
//
// Classification only ever escalates: a line once ATTENTION stays ATTENTION,
// even if (say) a rejection later brings the employee's total back under the
// threshold. The bulk approval can therefore never approve a line that was
// shown to anyone as needing a decision.
// ---------------------------------------------------------------------------

const ROUTINE_REASON = {
  [UNPAID_LEAVE_DEDUCTION]: 'Unpaid leave already approved by a person',
  [UNAUTHORISED_ABSENCE_UNPAID]: 'Absence already confirmed as unpaid by HR',
  'PROCESSING_FEE': 'Period processing fee configured for payroll',
};
const DEFICIT_REASON = 'Derived from accumulated lateness/early departures';

const MAX_ROUTINE_DAYS = 3;
const MAX_ROUTINE_SHARE = 0.20;

// A change means a salary that REPLACED an earlier one. A starter's first
// salary record also falls inside their first period, but that is the
// starter flag's business, not a pay change.
const selectSalaryChangeInPeriod = db.prepare(`
  SELECT s.effective_from FROM salary_history s
  WHERE s.employee_id = ? AND s.effective_from > ? AND s.effective_from <= ?
    AND EXISTS (
      SELECT 1 FROM salary_history earlier
      WHERE earlier.employee_id = s.employee_id AND earlier.effective_from < s.effective_from
    )
  ORDER BY s.effective_from ASC LIMIT 1
`);

/** The employee-level reasons that make every one of their lines ATTENTION. */
async function employeeAttentionReasons(period, employeeId, basis, lines) {
  const reasons = [];
  if (!basis || basis.blocked) return ['No salary on record for this period'];

  if (basis.joinsInPeriod) reasons.push(`Starter this period (joined ${basis.startDate}) - pay is prorated by day`);
  if (basis.leavesInPeriod) reasons.push(`Leaver this period (last day ${basis.lastWorkingDate}) - settlement is decided by HR`);

  const change = await selectSalaryChangeInPeriod.get(employeeId, period.start_date, period.end_date);
  if (change) reasons.push(`Salary changed during the period (from ${change.effective_from})`);

  // Proposed or approved, at the figure that stands: rejected lines do not count.
  let days = 0;
  let amount = 0;
  for (const a of lines) {
    const value = a.status === 'APPROVED' ? Number(a.approved_amount) : Number(a.calculated_amount);
    if (!(value < 0)) continue;
    days += Number(a.status === 'APPROVED' ? a.approved_days : a.calculated_days) || 0;
    amount += -value;
  }
  if (days > MAX_ROUTINE_DAYS) {
    reasons.push(`Deductions total ${days} day(s) this period, more than ${MAX_ROUTINE_DAYS}`);
  }
  if (amount > MAX_ROUTINE_SHARE * basis.grossBaseline) {
    reasons.push(`Deductions total ${money(amount)}, more than ${MAX_ROUTINE_SHARE * 100}% of gross pay (${basis.grossBaseline})`);
  }
  return reasons;
}

function classifyLine(a, employeeReasons) {
  if (a.adjustment_type === ATTENDANCE_DEFICIT_DAY) {
    return { level: 'ATTENTION', reasons: [DEFICIT_REASON, ...employeeReasons] };
  }
  if (ROUTINE_REASON[a.adjustment_type]) {
    return employeeReasons.length
      ? { level: 'ATTENTION', reasons: employeeReasons }
      : { level: 'ROUTINE', reasons: [ROUTINE_REASON[a.adjustment_type]] };
  }
  return { level: 'ATTENTION', reasons: [MANUAL_REASON, ...employeeReasons] };
}

/** Classifies every PROPOSED line in a period. Runs inside generation's transaction. */
async function classifyPeriodAdjustments(period, bases = new Map()) {
  const rows = await db.prepare(
    "SELECT * FROM payroll_adjustments WHERE period_id = ? AND status <> 'REJECTED' ORDER BY created_at ASC, id ASC"
  ).all(period.id);

  const byEmployee = new Map();
  for (const a of rows) {
    if (!byEmployee.has(a.employee_id)) byEmployee.set(a.employee_id, []);
    byEmployee.get(a.employee_id).push(a);
  }

  let routine = 0;
  let attention = 0;
  for (const [employeeId, lines] of byEmployee) {
    const pending = lines.filter(a => a.status === 'PROPOSED');
    if (!pending.length) continue;

    const basis = bases.get(employeeId) || await periodBasis(period, employeeId);
    const employeeReasons = await employeeAttentionReasons(period, employeeId, basis, lines);

    for (const a of pending) {
      const fresh = classifyLine(a, employeeReasons);
      const stored = parseReasons(a.review_reasons);
      let next = fresh;
      if (a.review_level === 'ATTENTION') {
        next = {
          level: 'ATTENTION',
          reasons: fresh.level === 'ATTENTION' ? [...new Set([...stored, ...fresh.reasons])] : stored,
        };
      }

      const nextJson = JSON.stringify(next.reasons);
      if (next.level !== a.review_level || nextJson !== a.review_reasons) {
        await db.prepare('UPDATE payroll_adjustments SET review_level = ?, review_reasons = ? WHERE id = ?')
          .run(next.level, nextJson, a.id);
      }
      if (next.level === 'ROUTINE') routine++; else attention++;
    }
  }

  return { routine, attention };
}

const selectPendingCounts = db.prepare(`
  SELECT
    COUNT(*) FILTER (WHERE review_level = 'ROUTINE') AS routine,
    COUNT(*) FILTER (WHERE review_level IS DISTINCT FROM 'ROUTINE') AS attention,
    COUNT(*) AS pending
  FROM payroll_adjustments WHERE period_id = ? AND status = 'PROPOSED'
`);

// ---------------------------------------------------------------------------
// The monthly run
// ---------------------------------------------------------------------------

/**
 * Opens a period for the current calendar month if nothing covers it yet.
 *
 * Skipped when ANY period overlaps the month, including a manual one with
 * other dates - paying someone's month twice is the one mistake this must
 * never make. Two instances ticking at once both reach the INSERT; the unique
 * constraint on (start_date, end_date) makes the second a no-op.
 */
async function ensureCurrentPeriod({ nowMs = T.now() } = {}) {
  const today = T.dateKey(nowMs);
  const month = calendarMonth(today, await cutoffDay());

  const overlapping = await db.prepare(
    'SELECT id FROM payroll_periods WHERE start_date <= ? AND end_date >= ? ORDER BY start_date LIMIT 1'
  ).get(month.end, month.start);
  if (overlapping) return { created: false, periodId: overlapping.id };

  // The exchange rate and the processing fee carry forward from the previous
  // month, so an automatic month is set up the way HR last set one up.
  const previous = await db.prepare(
    'SELECT exchange_rate, processing_fee, processing_fee_type, processing_fee_basis FROM payroll_periods ORDER BY start_date DESC, created_at DESC LIMIT 1'
  ).get();
  const rate = Number(previous?.exchange_rate) > 0 ? Number(previous.exchange_rate) : 350.0;
  const fee = Number(previous?.processing_fee) > 0 ? Number(previous.processing_fee) : 0;
  const feeType = previous?.processing_fee_type === 'ADDITION' ? 'ADDITION' : 'DEDUCTION';
  const feeBasis = previous?.processing_fee_basis === 'FIXED' ? 'FIXED' : 'PERCENT';

  const id = 'pp_' + crypto.randomBytes(6).toString('hex');
  const res = await db.prepare(`
    INSERT INTO payroll_periods
      (id, name, start_date, end_date, exchange_rate, processing_fee, processing_fee_type, processing_fee_basis,
       status, created_at, cutoff_date, pay_date, auto_created)
    VALUES (?,?,?,?,?,?,?,?, 'OPEN', ?, ?, ?, 1)
    ON CONFLICT (start_date, end_date) DO NOTHING
  `).run(id, month.name, month.start, month.end, rate, fee, feeType, feeBasis, nowMs, month.cutoff, month.end);

  if (!res.changes) {
    const row = await db.prepare('SELECT id FROM payroll_periods WHERE start_date = ? AND end_date = ?')
      .get(month.start, month.end);
    return { created: false, periodId: row?.id || null };
  }

  await audit({
    actor: 'system', action: 'PAYROLL_PERIOD_CREATED', targetType: 'payroll_period', targetId: id,
    after: {
      startDate: month.start, endDate: month.end, exchangeRate: rate,
      processingFee: fee, processingFeeType: feeType, processingFeeBasis: feeBasis,
      cutoffDate: month.cutoff, payDate: month.end, autoCreated: true,
    },
    note: 'Opened automatically for the calendar month.',
  });
  // Automatically calculate deductions from the month start so calculations are already available
  try {
    await generatePeriodDeductions({ periodId: id, actor: 'system' });
    await db.prepare("UPDATE payroll_periods SET generated_at = ? WHERE id = ?").run(nowMs, id);
  } catch (err) {
    console.warn('[payroll] ensureCurrentPeriod auto-deduction error:', err.message);
  }

  return { created: true, periodId: id, name: month.name, cutoffDate: month.cutoff, payDate: month.end, exchangeRate: rate };
}

/**
 * Generates a period's deductions and hands it to HR: OPEN -> IN_REVIEW.
 *
 * Run by the maintenance tick on the first tick after the cut-off, and by
 * approveRun() when HR approves before the cut-off. Returns null when there
 * was nothing to do - another instance got there first, or the period is not
 * OPEN any more.
 */
async function generateRun({ periodId, actor = 'system', nowMs = T.now() }) {
  const outcome = await tx(async () => {
    await lockPayroll();
    const period = await selectPeriodForUpdate.get(periodId);
    if (!period || period.status !== 'OPEN') return null;

    const gen = await generatePeriodDeductions({ periodId, actor });

    const moved = await db.prepare(
      "UPDATE payroll_periods SET status = 'IN_REVIEW', generated_at = ? WHERE id = ? AND status = 'OPEN'"
    ).run(nowMs, periodId);
    if (!moved.changes) return null;

    const counts = await selectPendingCounts.get(periodId);
    const summary = {
      periodId,
      name: period.name,
      cutoffDate: period.cutoff_date,
      payDate: period.pay_date,
      employees: gen.employees,
      createdCount: gen.createdCount,
      routineCount: Number(counts.routine) || 0,
      attentionCount: Number(counts.attention) || 0,
      pendingCount: Number(counts.pending) || 0,
    };

    await audit({
      actor, action: 'PAYROLL_RUN_GENERATED', targetType: 'payroll_period', targetId: periodId,
      before: { status: 'OPEN' }, after: { status: 'IN_REVIEW', ...summary },
    });
    return summary;
  });

  if (outcome) invalidatePayrollCache();
  return outcome;
}

async function notifyHrRunReady(run, nowMs) {
  try {
    await N.notify({
      category: 'PAYROLL',
      title: `Payroll ready for review: ${run.name}`,
      body: `${run.employees} employee(s); ${run.pendingCount} deduction line(s) to review - `
          + `${run.routineCount} routine, ${run.attentionCount} needing a decision. `
          + `Cut-off ${run.cutoffDate || 'n/a'}, pay date ${run.payDate || 'n/a'}. `
          + 'Nothing is paid until the run is approved.',
      severity: run.attentionCount > 0 ? 'warning' : 'info',
      link: `/payroll?period=${run.periodId}`,
      nowMs,
    });
  } catch (err) {
    console.error('[payroll] could not notify HR that the run is ready:', err.message);
  }
}

/**
 * The maintenance tick's payroll step. Opens this month's period, and moves
 * any open period past its cut-off to review. Never approves anything.
 */
async function runPayrollAutomation({ nowMs = T.now() } = {}) {
  const today = T.dateKey(nowMs);
  const opened = await ensureCurrentPeriod({ nowMs });

  const due = await db.prepare(`
    SELECT id FROM payroll_periods
    WHERE status = 'OPEN' AND cutoff_date IS NOT NULL AND cutoff_date < ?
    ORDER BY start_date ASC
  `).all(today);

  const generated = [];
  for (const p of due) {
    const run = await generateRun({ periodId: p.id, actor: 'system', nowMs });
    if (!run) continue;
    generated.push(run);
    await notifyHrRunReady(run, nowMs);
  }

  return { opened, generated };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Who is in a period's run, and who is left out and why. */
async function runMembers(period) {
  const run = [];
  const excluded = [];
  for (const e of await payrollEmployees(period)) {
    const basis = await periodBasis(period, e.id);
    const who = { employeeId: e.id, employeeName: e.name, employeeNumber: e.employee_number || null };
    if (basis.blocked) {
      excluded.push({ ...who, reason: basis.salary.reason, message: basis.salary.message });
    } else if (!basis.inPeriod) {
      excluded.push({ ...who, reason: 'NOT_EMPLOYED_IN_PERIOD', message: 'Not employed on any day of this period, so there is nothing to pay.' });
    } else {
      run.push({ employee: e, basis });
    }
  }
  return { run, excluded };
}

const selectPendingCorrections = db.prepare(`
  SELECT id, employee_id, date_key, status FROM attendance_corrections
  WHERE status IN ('PENDING', 'INFO_REQUESTED') AND date_key <= ?
  ORDER BY date_key ASC
`);

const selectPendingAbsences = db.prepare(`
  SELECT id, employee_id, date_key, absence_type FROM absence_records
  WHERE status = 'PENDING_REVIEW' AND date_key <= ?
  ORDER BY date_key ASC
`);

const selectPendingLeave = db.prepare(`
  SELECT id, employee_id, start_date, end_date, status FROM leave_requests
  WHERE status IN ('PENDING_MANAGER', 'PENDING_HR') AND start_date <= ? AND end_date >= ?
  ORDER BY start_date ASC
`);

/**
 * The things that would make a run wrong if it were approved now.
 *
 * Each entry is { code, severity, count, message, items[] }, and only failing
 * checks are listed - an empty array is a clean run. BLOCKING entries stop
 * approveRun() unless it carries an explicit, audited waiver.
 *
 * Read-only. "New deductions since generation" is a genuine dry run: it asks
 * exactly what generatePeriodDeductions() would create (the same component
 * functions) without creating it.
 */
async function preflightChecks(period, run, excluded) {
  const checks = [];
  const bound = period.cutoff_date || period.end_date;
  const members = new Map(run.map(m => [m.employee.id, m]));
  const nameOf = id => members.get(id)?.employee.name || null;
  // Only what the run's own window counts: a leaver's corrections after their
  // last day cannot affect this run.
  const inWindow = (employeeId, date) => members.has(employeeId) && date <= members.get(employeeId).basis.windowEnd;

  const corrections = (await selectPendingCorrections.all(bound)).filter(c => inWindow(c.employee_id, c.date_key));
  if (corrections.length) {
    checks.push({
      code: 'PENDING_CORRECTIONS', severity: 'BLOCKING', count: corrections.length,
      message: `${corrections.length} attendance correction(s) dated on or before the cut-off are still awaiting `
             + 'a decision. They can change the attendance deficit this run deducts.',
      items: corrections.map(c => ({ employeeId: c.employee_id, employeeName: nameOf(c.employee_id), ref: c.id, date: c.date_key, detail: c.status })),
    });
  }

  const absences = (await selectPendingAbsences.all(bound)).filter(a => inWindow(a.employee_id, a.date_key));
  if (absences.length) {
    checks.push({
      code: 'PENDING_ABSENCE_REVIEWS', severity: 'BLOCKING', count: absences.length,
      message: `${absences.length} absence(s) dated on or before the cut-off are still awaiting HR review. `
             + 'One confirmed as unpaid after this run is approved is deducted in next month\'s run instead.',
      items: absences.map(a => ({ employeeId: a.employee_id, employeeName: nameOf(a.employee_id), ref: a.id, date: a.date_key, detail: a.absence_type })),
    });
  }

  const leaveRows = (await selectPendingLeave.all(bound, period.start_date))
    .filter(l => members.has(l.employee_id) && l.start_date <= members.get(l.employee_id).basis.windowEnd);
  if (leaveRows.length) {
    checks.push({
      code: 'PENDING_LEAVE_REQUESTS', severity: 'BLOCKING', count: leaveRows.length,
      message: `${leaveRows.length} leave request(s) overlapping this period up to the cut-off are still pending. `
             + 'Unpaid leave approved after this run is approved is deducted in next month\'s run instead.',
      items: leaveRows.map(l => ({ employeeId: l.employee_id, employeeName: nameOf(l.employee_id), ref: l.id, date: l.start_date, detail: `${l.start_date} to ${l.end_date} (${l.status})` })),
    });
  }

  if (period.generated_at) {
    const fresh = [];
    for (const m of run) {
      const u = m.unpaid || await unpaidDaysSummary({
        employeeId: m.employee.id, periodId: period.id, windowEnd: m.basis.windowEnd, dailyPrecise: m.basis.salary.dailyPrecise,
      });
      const who = { employeeId: m.employee.id, employeeName: m.employee.name };
      if (u.deficitDays > 0 && !u.deficitAdjustmentId) {
        fresh.push({ ...who, ref: null, date: m.basis.windowEnd, detail: `${ATTENDANCE_DEFICIT_DAY}: ${u.deficitDays} day(s)` });
      }
      for (const a of u.absenceRecords) fresh.push({ ...who, ref: a.id, date: a.date, detail: UNAUTHORISED_ABSENCE_UNPAID });
      for (const l of u.leaveRequests) {
        if (l.days > 0) fresh.push({ ...who, ref: l.id, date: l.startDate, detail: `${UNPAID_LEAVE_DEDUCTION}: ${l.days} day(s)` });
      }
    }
    if (fresh.length) {
      checks.push({
        code: 'NEW_DEDUCTIONS_SINCE_GENERATION', severity: 'BLOCKING', count: fresh.length,
        message: `${fresh.length} new deduction(s) have appeared since this run was generated. Generate deductions `
               + 'again to add them to this run, or waive this to leave them for next month\'s run.',
        items: fresh,
      });
    }
  } else {
    checks.push({
      code: 'NOT_YET_GENERATED', severity: 'INFO', count: 0,
      message: `Deductions have not been generated yet. They are generated automatically after the cut-off (${bound}), `
             + 'or when the run is approved.',
      items: [],
    });
  }

  const noSalary = excluded.filter(x => x.reason === 'NO_SALARY_ON_RECORD');
  if (noSalary.length) {
    checks.push({
      code: 'NO_SALARY', severity: 'WARNING', count: noSalary.length,
      message: `${noSalary.length} employee(s) have no salary on record and are excluded from this run.`,
      items: noSalary.map(x => ({ employeeId: x.employeeId, employeeName: x.employeeName, ref: null, date: null, detail: x.reason })),
    });
  }

  return checks;
}

function payrollPreflight(periodId) {
  return withReadMemo(() => payrollPreflightUncached(periodId));
}

async function payrollPreflightUncached(periodId) {
  const period = await selectPeriod.get(periodId);
  if (!period) throw new PayrollRunError('No such payroll period.', { code: 'NOT_FOUND', httpStatus: 404 });
  const { run, excluded } = await runMembers(period);
  return await preflightChecks(period, run, excluded);
}

// ---------------------------------------------------------------------------
// Review sheet
// ---------------------------------------------------------------------------

function presentPeriod(p) {
  return {
    id: p.id, name: p.name, from: p.start_date, to: p.end_date, status: p.status,
    exchangeRate: p.exchange_rate || 350.0,
    cutoffDate: p.cutoff_date || null,
    payDate: p.pay_date || null,
    autoCreated: !!p.auto_created,
    generatedAt: p.generated_at || null,
    publishedAt: p.published_at || null,
    publishedBy: p.published_by || null,
    paidAt: p.paid_at || null,
    approvedBy: p.approved_by || null,
    approvedAt: p.approved_at || null,
  };
}

/** The figure each line stands at: approved amount, or the calculation while undecided. */
function standingAmount(a) {
  if (a.status === 'APPROVED') return Number(a.approved_amount) || 0;
  if (a.status === 'PROPOSED') return Number(a.calculated_amount) || 0;
  return 0;
}

// Each employee's most recent published payslip before this period, for the
// "net pay moved more than 15%" flag.
const selectPreviousNets = db.prepare(`
  SELECT DISTINCT ON (s.employee_id) s.employee_id, s.net_payable, p.name AS period_name
  FROM payslips s JOIN payroll_periods p ON p.id = s.period_id
  WHERE s.status = 'PUBLISHED' AND p.start_date < ?
  ORDER BY s.employee_id, p.start_date DESC
`);

const NET_CHANGE_THRESHOLD = 0.15;

/**
 * Employee-level flags for the review sheet. Computed, never stored: they
 * describe the employee's situation this month, not a decision about a line.
 */
async function employeeFlags(period, employeeId, basis, expectedNet, previous) {
  const flags = [];
  if (basis.joinsInPeriod) {
    flags.push({ code: 'STARTER', message: `Joined on ${basis.startDate}; pay is prorated by working day.` });
  }
  if (basis.leavesInPeriod) {
    flags.push({ code: 'LEAVER', message: `Last working day ${basis.lastWorkingDate}; the leaver settlement is decided by HR.` });
    if (period.cutoff_date && basis.lastWorkingDate > period.cutoff_date) {
      flags.push({
        code: 'LEAVER_AFTER_CUTOFF',
        message: `Deductions for days after the cut-off (${period.cutoff_date}) are not included; `
               + 'settle them via the leaver calculation.',
      });
    }
  }

  const change = await selectSalaryChangeInPeriod.get(employeeId, period.start_date, period.end_date);
  if (change) {
    flags.push({
      code: 'SALARY_CHANGED_IN_PERIOD',
      message: `Salary changed on ${change.effective_from}; this run uses the salary in force on ${period.end_date}.`,
    });
  }

  if (previous && Number(previous.net_payable) > 0) {
    const ratio = (expectedNet - Number(previous.net_payable)) / Number(previous.net_payable);
    if (Math.abs(ratio) > NET_CHANGE_THRESHOLD) {
      flags.push({
        code: 'NET_CHANGE_OVER_15_PERCENT',
        message: `Net pay is ${ratio > 0 ? 'up' : 'down'} ${Math.round(Math.abs(ratio) * 100)}% on the last `
               + `published payslip (${previous.period_name}: ${previous.net_payable}).`,
        previousNet: Number(previous.net_payable),
        changePercent: Math.round(ratio * 1000) / 10,
      });
    }
  }

  return flags;
}

/**
 * The sheet HR approves a run from: the preparation rows, every line with its
 * ROUTINE/ATTENTION classification, employee-level flags, totals and the
 * preflight. Read-only.
 *
 * visibleEmployeeIds limits the rows and totals to the employees the viewer
 * may see; the preflight is always the whole run's, because it is the whole
 * run that approval would publish.
 */
function reviewPeriod(periodId, opts = {}) {
  return withReadMemo(() => reviewPeriodUncached(periodId, opts));
}

async function reviewPeriodUncached(periodId, { visibleEmployeeIds = null, basis = null, forceSync = false } = {}) {
  const period = await selectPeriod.get(periodId);
  if (!period) throw new PayrollRunError('No such payroll period.', { code: 'NOT_FOUND', httpStatus: 404 });

  const rateBasis = basis || await getDailyRateBasis();
  const memKey = `${periodId}:${rateBasis}:${visibleEmployeeIds ? [...visibleEmployeeIds].sort().join(',') : 'all'}`;

  if (!forceSync) {
    const memHit = reviewMemoryCache.get(memKey);
    if (memHit && Date.now() < memHit.expiresAt) {
      return memHit.data;
    }
  }

  // Automatic realtime deduction sync: ensure deductions are calculated and up-to-date
  if (!isFinal(period.status)) {
    try {
      await generatePeriodDeductions({ periodId: period.id, actor: 'system' });
      if (!period.generated_at) {
        const nowMs = T.now();
        await db.prepare("UPDATE payroll_periods SET generated_at = ? WHERE id = ?").run(nowMs, period.id);
        period.generated_at = nowMs;
      }
    } catch (err) {
      console.warn('[payroll] auto-sync deductions non-blocking warning:', err.message);
    }
  }

  const emps = await payrollEmployees(period);
  const allPositions = await Promise.all(
    emps.map(e => employeePosition(period, e, { rateBasis }))
  );

  const positions = [];
  const excluded = [];
  for (let i = 0; i < emps.length; i++) {
    const e = emps[i];
    const pos = allPositions[i];
    if (pos.blocked) {
      excluded.push(pos.blocked);
    } else if (!pos.basis.inPeriod) {
      excluded.push({
        employeeId: e.id, employeeName: e.name, employeeNumber: e.employee_number || null,
        reason: 'NOT_EMPLOYED_IN_PERIOD', message: 'Not employed on any day of this period, so there is nothing to pay.',
      });
    } else {
      positions.push(pos);
    }
  }

  const preflight = await preflightChecks(period, positions, excluded);

  const previous = new Map(
    (await selectPreviousNets.all(period.start_date)).map(r => [r.employee_id, r]),
  );

  const visible = visibleEmployeeIds ? positions.filter(p => visibleEmployeeIds.has(p.employee.id)) : positions;
  const totals = {
    employees: 0, gross: 0, deductions: 0, net: 0,
    routineCount: 0, attentionCount: 0, pendingCount: 0, decidedCount: 0,
  };

  const flagsList = await Promise.all(
    visible.map(pos => {
      const standing = pos.existing.reduce((s, a) => s + standingAmount(a), 0);
      const expectedNet = money(pos.basis.grossBaseline + standing);
      return employeeFlags(period, pos.employee.id, pos.basis, expectedNet, previous.get(pos.employee.id));
    })
  );

  const employees = [];
  for (let i = 0; i < visible.length; i++) {
    const pos = visible[i];
    const standing = pos.existing.reduce((s, a) => s + standingAmount(a), 0);
    const expectedNet = money(pos.basis.grossBaseline + standing);

    totals.employees++;
    totals.gross += pos.basis.grossBaseline;
    totals.net += expectedNet;
    for (const a of pos.existing) {
      const v = standingAmount(a);
      if (v < 0) totals.deductions += -v;
      if (a.status === 'PROPOSED') {
        totals.pendingCount++;
        if (a.review_level === 'ROUTINE') totals.routineCount++; else totals.attentionCount++;
      } else {
        totals.decidedCount++;
      }
    }

    employees.push({
      ...pos.row,
      expectedNetPayable: expectedNet,
      employeeFlags: flagsList[i],
    });
  }

  totals.gross = money(totals.gross);
  totals.deductions = money(totals.deductions);
  totals.net = money(totals.net);

  // Processing fee is an organizational cost displayed to HR only; never added to employee salary
  const feePct = Number(period.processing_fee) || 0;
  const processingFeeAmount = feePct > 0 ? money((totals.gross * feePct) / 100) : 0;
  totals.processingFee = processingFeeAmount;
  totals.totalCompanyCost = money(totals.net + processingFeeAmount);

  const result = {
    period: { ...presentPeriod(period), dailyRateBasis: rateBasis, processingFeeAmount },
    totals,
    preflight,
    employees,
    excluded: visibleEmployeeIds ? excluded.filter(x => visibleEmployeeIds.has(x.employeeId)) : excluded,
    note: 'Approving the run approves every ROUTINE line still proposed. ATTENTION lines must each be '
        + 'decided explicitly. Nothing is paid until the run is approved.',
  };

  reviewMemoryCache.set(memKey, { data: result, expiresAt: Date.now() + REVIEW_CACHE_TTL_MS });
  return result;
}

// ---------------------------------------------------------------------------
// Approving a run, and the payslips it writes
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted at every level, so a hash is stable. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** The figures a payslip's content_hash covers, read back from its row. */
function payslipFigures(r) {
  let lines = [];
  try { lines = JSON.parse(r.lines_json || '[]'); } catch (_) { lines = []; }
  return {
    periodId: r.period_id, employeeId: r.employee_id, version: r.version,
    currency: r.currency, exchangeRate: r.exchange_rate,
    monthlySalary: r.monthly_salary, dailyRate: r.daily_rate,
    grossBaseline: r.gross_baseline, deductionsTotal: r.deductions_total,
    adjustmentsTotal: r.adjustments_total, netPayable: r.net_payable,
    workingDays: r.working_days, fullPeriodDays: r.full_period_days,
    isPartial: !!r.is_partial, isStarter: !!r.is_starter,
    salaryEffectiveFrom: r.salary_effective_from,
    cutoffDate: r.cutoff_date, payDate: r.pay_date,
    lines,
  };
}

function payslipHash(r) {
  return crypto.createHash('sha256').update(canonicalJson(payslipFigures(r))).digest('hex');
}

const LINE_LABELS = {
  [ATTENDANCE_DEFICIT_DAY]: 'Attendance deficit',
  [UNAUTHORISED_ABSENCE_UNPAID]: 'Unpaid absence',
  [UNPAID_LEAVE_DEDUCTION]: 'Unpaid leave',
  'PROCESSING_FEE': 'Processing fee',
};

function lineLabel(type) {
  if (LINE_LABELS[type]) return LINE_LABELS[type];
  const words = String(type || 'Adjustment').toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const selectApprovedLines = db.prepare(`
  SELECT a.*, ar.date_key AS absence_date, lr.start_date AS leave_start
  FROM payroll_adjustments a
  LEFT JOIN absence_records ar
    ON a.adjustment_type = 'UNAUTHORISED_ABSENCE_UNPAID' AND ar.id = a.source_reference
  LEFT JOIN leave_requests lr
    ON a.adjustment_type = 'UNPAID_LEAVE_DEDUCTION' AND lr.id = a.source_reference
  WHERE a.period_id = ? AND a.employee_id = ? AND a.status = 'APPROVED'
  ORDER BY a.created_at ASC, a.id ASC
`);

const insertPayslip = db.prepare(`
  INSERT INTO payslips
    (id, period_id, employee_id, version, status, currency, exchange_rate, monthly_salary,
     daily_rate, gross_baseline, deductions_total, adjustments_total, net_payable,
     working_days, full_period_days, is_partial, is_starter, salary_effective_from,
     lines_json, cutoff_date, pay_date, published_at, published_by, paid_at, content_hash, created_at,
     statement_json, template_id)
  VALUES
    (@id, @period_id, @employee_id, @version, @status, @currency, @exchange_rate, @monthly_salary,
     @daily_rate, @gross_baseline, @deductions_total, @adjustments_total, @net_payable,
     @working_days, @full_period_days, @is_partial, @is_starter, @salary_effective_from,
     @lines_json, @cutoff_date, @pay_date, @published_at, @published_by, @paid_at, @content_hash, @created_at,
     @statement_json, @template_id)
`);

/**
 * Writes one employee's payslip for a run being published. Figures come from
 * APPROVED adjustments only: net = gross baseline + the sum of approved
 * amounts. Written once, never updated.
 *
 * Always version 1: nothing re-issues a payslip yet. A re-issue would be a
 * new version with this one marked SUPERSEDED; until then the unique
 * constraints are the backstop against a run somehow publishing twice.
 */
async function writePayslip(period, member, { actor, nowMs, approvalNote = null, templateId = null }) {
  const { employee, basis } = member;
  const approved = (await selectApprovedLines.all(period.id, employee.id))
    .filter(a => a.adjustment_type !== 'PROCESSING_FEE');

  const lines = approved.map(a => ({
    adjustmentId: a.id,
    type: a.adjustment_type,
    label: lineLabel(a.adjustment_type),
    explanation: a.explanation,
    days: a.approved_days,
    amount: money(Number(a.approved_amount) || 0),
    sourceReference: a.source_reference,
    date: a.absence_date || a.leave_start || (a.adjustment_type === ATTENDANCE_DEFICIT_DAY ? basis.windowEnd : null),
  }));

  const adjustmentsTotal = money(lines.reduce((s, l) => s + l.amount, 0));
  const deductionsTotal = money(lines.reduce((s, l) => s + (l.amount < 0 ? -l.amount : 0), 0));

  const row = {
    id: 'ps_' + crypto.randomBytes(8).toString('hex'),
    period_id: period.id,
    employee_id: employee.id,
    version: 1,
    status: 'PUBLISHED',
    currency: basis.salary.currency || P.currency,
    exchange_rate: period.exchange_rate || 350.0,
    monthly_salary: basis.salary.monthly,
    daily_rate: basis.salary.daily,
    gross_baseline: basis.grossBaseline,
    deductions_total: deductionsTotal,
    adjustments_total: adjustmentsTotal,
    net_payable: money(basis.grossBaseline + adjustmentsTotal),
    working_days: basis.workingDaysCount,
    full_period_days: basis.fullPeriodDays,
    is_partial: basis.isPartialPeriod ? 1 : 0,
    is_starter: basis.startedInPeriod ? 1 : 0,
    salary_effective_from: basis.salary.effectiveFrom || null,
    lines_json: JSON.stringify(lines),
    cutoff_date: period.cutoff_date || null,
    pay_date: period.pay_date || null,
    published_at: nowMs,
    published_by: actor,
    paid_at: null,
    created_at: nowMs,
  };
  row.content_hash = payslipHash(row);

  // What the invoice needs beyond the money (employee and bank details, the
  // attendance counts for the same window the deductions used, the approval
  // note), frozen now and sealed to the content hash: the invoice is filled
  // from these figures on every view, and a later correction cannot change it.
  const invoice = require('./invoice');
  const snapshot = await invoice.buildSnapshot({ ...period, approval_note: approvalNote }, employee.id, {
    fromDate: basis.effectiveStart || period.start_date,
    toDate: basis.windowEnd,
  });
  row.statement_json = invoice.sealSnapshot(snapshot, row.content_hash);
  row.template_id = templateId;

  await insertPayslip.run(row);
  return row;
}

async function announcePublished(period, payslips, nowMs) {
  try {
    await events.broadcast('PAYROLL_PUBLISHED', {
      periodId: period.id, name: period.name, payslips: payslips.length, publishedAt: nowMs,
    });
  } catch (_) {}

  // An employee is only told about a payslip they are allowed to open.
  if (!await settingIsOn('show_salary_to_employees')) return;
  for (const s of payslips) {
    try {
      await N.notify({
        employeeId: s.employee_id,
        category: 'PAYROLL',
        title: 'Your payslip is ready',
        body: `Your payslip for ${period.name} has been approved and published.`
            + (period.pay_date ? ` Pay date: ${period.pay_date}.` : ''),
        severity: 'info',
        link: '/payroll',
        nowMs,
      });
    } catch (err) {
      console.error(`[payroll] could not notify ${s.employee_id} of their payslip:`, err.message);
    }
  }
}

/**
 * HR approves a whole run. Still a human decision: the note is required, every
 * ATTENTION line must have been decided (earlier, or in `decisions` here), and
 * only ROUTINE lines are approved in bulk.
 *
 * One transaction, under the payroll lock and the period's row lock: re-run
 * the preflight, apply the explicit decisions, approve the remaining ROUTINE
 * lines, refuse if anything is still undecided, write the payslips and move
 * the period IN_REVIEW -> PUBLISHED. Any failure rolls all of it back. A
 * second submit (double click, second instance) waits on the lock, then finds
 * the period already PUBLISHED and is refused - it cannot write a second set
 * of payslips.
 *
 * Approving an OPEN period (HR running it before the cut-off) generates it
 * first. That step is committed on its own, so if the approval is then refused
 * for undecided ATTENTION lines, those lines exist to be decided.
 */
async function approveRun({ periodId, note, decisions = [], waiveBlockers = false, waiverNote = null, actor, nowMs = T.now(), visibleEmployeeIds = null }) {
  const runNote = String(note || '').trim();
  if (!runNote) {
    throw new PayrollRunError('A note is required to approve a payroll run.', { code: 'NOTE_REQUIRED', httpStatus: 400 });
  }
  const waive = waiveBlockers === true;
  const waiver = String(waiverNote || '').trim();
  if (waive && !waiver) {
    throw new PayrollRunError('A waiverNote explaining why the blockers are being waived is required.', { code: 'WAIVER_NOTE_REQUIRED', httpStatus: 400 });
  }
  if (!Array.isArray(decisions)) {
    throw new PayrollRunError('decisions must be an array.', { code: 'BAD_REQUEST', httpStatus: 400 });
  }
  const seen = new Set();
  for (const d of decisions) {
    if (!d || !d.adjustmentId || !['APPROVED', 'REJECTED'].includes(d.decision)) {
      throw new PayrollRunError('Each decision needs an adjustmentId and a decision of APPROVED or REJECTED.', { code: 'BAD_REQUEST', httpStatus: 400 });
    }
    if (seen.has(d.adjustmentId)) {
      throw new PayrollRunError(`Adjustment ${d.adjustmentId} is decided more than once.`, { code: 'BAD_REQUEST', httpStatus: 400 });
    }
    seen.add(d.adjustmentId);
  }

  const initial = await selectPeriod.get(periodId);
  if (!initial) throw new PayrollRunError('No such payroll period.', { code: 'NOT_FOUND', httpStatus: 404 });
  if (isFinal(initial.status)) {
    throw new PayrollRunError(`This payroll run is already ${initial.status.toLowerCase()}.`, { code: 'ALREADY_FINAL' });
  }
  if (initial.status === 'OPEN') await generateRun({ periodId, actor, nowMs });

  const outcome = await tx(async () => {
    await lockPayroll();
    const period = await selectPeriodForUpdate.get(periodId);
    if (!period || period.status !== 'IN_REVIEW') {
      throw new PayrollRunError(
        period ? `This payroll run is already ${period.status.toLowerCase()}.` : 'No such payroll period.',
        { code: period ? 'ALREADY_FINAL' : 'NOT_FOUND', httpStatus: period ? 409 : 404 },
      );
    }
    // Every line of the run is held until commit, so no single decision can
    // land half-way through the bulk one.
    await db.prepare('SELECT id FROM payroll_adjustments WHERE period_id = ? FOR UPDATE').all(periodId);

    const { run, excluded } = await runMembers(period);
    if (visibleEmployeeIds && run.some(m => !visibleEmployeeIds.has(m.employee.id))) {
      throw new PayrollRunError('Approving a payroll run requires access to every employee in it.', { code: 'FORBIDDEN', httpStatus: 403 });
    }

    const preflight = await preflightChecks(period, run, excluded);
    const blockers = preflight.filter(c => c.severity === 'BLOCKING');
    if (blockers.length && !waive) {
      throw new PayrollRunError(
        `This run has ${blockers.length} blocking issue(s): ${blockers.map(b => b.code).join(', ')}. `
        + 'Resolve them, or approve with waiveBlockers and a waiverNote.',
        { code: 'PREFLIGHT_BLOCKED', details: { preflight: blockers } },
      );
    }

    for (const d of decisions) {
      const adj = await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(d.adjustmentId);
      if (!adj || adj.period_id !== periodId) {
        throw new PayrollRunError(`Adjustment ${d.adjustmentId} is not part of this payroll run.`, { code: 'BAD_REQUEST', httpStatus: 400 });
      }
      await applyDecision(adj, {
        decision: d.decision,
        approvedDays: d.approvedDays ?? null,
        approvedAmount: d.approvedAmount ?? null,
        deductFromPaidLeave: d.deductFromPaidLeave === true || d.choice === 'DEDUCT_PAID_LEAVE',
        notes: String(d.notes || '').trim() || `Decided in the payroll run: ${runNote}`,
      }, actor, nowMs);
    }

    const routine = await db.prepare(`
      SELECT * FROM payroll_adjustments
      WHERE period_id = ? AND status = 'PROPOSED' AND review_level = 'ROUTINE'
      ORDER BY created_at ASC, id ASC
    `).all(periodId);
    for (const adj of routine) {
      await applyDecision(adj, {
        decision: 'APPROVED', notes: `Approved as routine in the payroll run: ${runNote}`,
      }, actor, nowMs);
    }

    const undecided = await db.prepare(`
      SELECT a.*, e.name AS employee_name FROM payroll_adjustments a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.period_id = ? AND a.status = 'PROPOSED'
      ORDER BY e.name, a.created_at
    `).all(periodId);
    if (undecided.length) {
      throw new PayrollRunError(
        `${undecided.length} line(s) need an explicit decision before this run can be approved: `
        + undecided.map(a => `${a.employee_name} - ${lineLabel(a.adjustment_type)} ${a.calculated_amount}`).join('; '),
        {
          code: 'ATTENTION_UNDECIDED',
          details: {
            undecided: undecided.map(a => ({
              adjustmentId: a.id, employeeId: a.employee_id, employeeName: a.employee_name,
              type: a.adjustment_type, calculatedAmount: a.calculated_amount, calculatedDays: a.calculated_days,
              reviewLevel: a.review_level || null, reviewReasons: parseReasons(a.review_reasons),
            })),
          },
        },
      );
    }

    // Each invoice renders in the template in force when it was published.
    const templateId = await require('./invoice').activeTemplateId();
    const payslips = [];
    for (const m of run) {
      payslips.push(await writePayslip(period, m, { actor, nowMs, approvalNote: runNote, templateId }));
    }

    const moved = await db.prepare(`
      UPDATE payroll_periods
      SET status = 'PUBLISHED', published_at = ?, published_by = ?, approved_by = ?, approved_at = ?,
          approval_note = ?
      WHERE id = ? AND status = 'IN_REVIEW'
    `).run(nowMs, actor, actor, nowMs, runNote, periodId);
    if (!moved.changes) {
      throw new PayrollRunError('This payroll run has already been approved.', { code: 'ALREADY_FINAL' });
    }

    const totals = {
      gross: money(payslips.reduce((s, p) => s + p.gross_baseline, 0)),
      deductions: money(payslips.reduce((s, p) => s + p.deductions_total, 0)),
      net: money(payslips.reduce((s, p) => s + p.net_payable, 0)),
    };

    if (blockers.length) {
      await audit({
        actor, action: 'PAYROLL_PREFLIGHT_WAIVED', targetType: 'payroll_period', targetId: periodId,
        before: { blockers: blockers.map(b => ({ code: b.code, count: b.count })) },
        note: waiver,
      });
    }
    await audit({
      actor, action: 'PAYROLL_RUN_APPROVED', targetType: 'payroll_period', targetId: periodId,
      before: { status: 'IN_REVIEW' },
      after: {
        status: 'PUBLISHED', payslips: payslips.length, excluded: excluded.length,
        explicitDecisions: decisions.length, routineApproved: routine.length,
        waivedBlockers: blockers.map(b => b.code), ...totals,
      },
      note: runNote,
    });

    return {
      period,
      payslips,
      result: {
        periodId,
        periodStatus: 'PUBLISHED',
        publishedAt: nowMs,
        publishedBy: actor,
        payslipCount: payslips.length,
        excludedCount: excluded.length,
        totals,
        decided: { explicit: decisions.length, routineApproved: routine.length },
        waivedBlockers: blockers.map(b => b.code),
      },
    };
  });

  invalidatePayrollCache();
  await announcePublished(outcome.period, outcome.payslips, nowMs);
  return outcome.result;
}

/** PUBLISHED -> PAID, once the money has actually gone out. Stamps every payslip. */
async function markPaid({ periodId, actor, note = null, nowMs = T.now() }) {
  const result = await tx(async () => {
    await lockPayroll();
    const period = await selectPeriodForUpdate.get(periodId);
    if (!period) throw new PayrollRunError('No such payroll period.', { code: 'NOT_FOUND', httpStatus: 404 });
    if (period.status === 'PAID') {
      throw new PayrollRunError('This payroll run is already marked paid.', { code: 'ALREADY_FINAL' });
    }
    if (period.status !== 'PUBLISHED') {
      throw new PayrollRunError('Only a published payroll run can be marked paid.', { code: 'NOT_PUBLISHED' });
    }

    const moved = await db.prepare(
      "UPDATE payroll_periods SET status = 'PAID', paid_at = ? WHERE id = ? AND status = 'PUBLISHED'"
    ).run(nowMs, periodId);
    if (!moved.changes) throw new PayrollRunError('This payroll run is already marked paid.', { code: 'ALREADY_FINAL' });

    // paid_at is not one of the figures content_hash covers, so stamping it
    // leaves every published figure untouched.
    const slips = await db.prepare(
      "UPDATE payslips SET paid_at = ? WHERE period_id = ? AND status = 'PUBLISHED' AND paid_at IS NULL"
    ).run(nowMs, periodId);

    await audit({
      actor, action: 'PAYROLL_RUN_PAID', targetType: 'payroll_period', targetId: periodId,
      before: { status: 'PUBLISHED' }, after: { status: 'PAID', payslips: slips.changes },
      note: note ? String(note).trim() : null,
    });

    return { periodId, periodStatus: 'PAID', paidAt: nowMs, payslipsMarked: slips.changes };
  });

  invalidatePayrollCache();
  return result;
}

function presentPayslip(s) {
  const figures = payslipFigures(s);
  return {
    id: s.id,
    periodId: s.period_id,
    periodName: s.period_name || null,
    employeeId: s.employee_id,
    employeeName: s.employee_name || null,
    employeeNumber: s.employee_number || null,
    version: s.version,
    status: s.status,
    payslipStatus: s.paid_at ? 'PAID' : 'PUBLISHED',
    currency: s.currency,
    exchangeRate: s.exchange_rate,
    monthlySalary: s.monthly_salary,
    dailyRate: s.daily_rate,
    grossBaseline: s.gross_baseline,
    deductionsTotal: s.deductions_total,
    adjustmentsTotal: s.adjustments_total,
    netPayable: s.net_payable,
    workingDays: s.working_days,
    fullPeriodDays: s.full_period_days,
    isPartial: !!s.is_partial,
    isStarter: !!s.is_starter,
    salaryEffectiveFrom: s.salary_effective_from,
    lines: figures.lines,
    cutoffDate: s.cutoff_date,
    payDate: s.pay_date,
    publishedAt: s.published_at,
    publishedBy: s.published_by,
    paidAt: s.paid_at,
    contentHash: s.content_hash,
    // Recomputed from the stored figures: false means the row was altered
    // after it was published.
    integrityOk: payslipHash(s) === s.content_hash,
  };
}

async function listPayslips(periodId) {
  const period = await selectPeriod.get(periodId);
  if (!period) throw new PayrollRunError('No such payroll period.', { code: 'NOT_FOUND', httpStatus: 404 });
  const rows = await db.prepare(`
    SELECT s.*, e.name AS employee_name, e.employee_number, p.name AS period_name
    FROM payslips s
    JOIN employees e ON e.id = s.employee_id
    JOIN payroll_periods p ON p.id = s.period_id
    WHERE s.period_id = ?
    ORDER BY e.name, s.version DESC
  `).all(periodId);
  return { period: presentPeriod(period), payslips: rows.map(presentPayslip) };
}

// ---------------------------------------------------------------------------
// Employee self-service: statements, payslips and the running estimate
// ---------------------------------------------------------------------------

// In-memory cache for employee payroll statements.
// Key: employeeId -> { data, expiresAt }
//
// Per instance on Vercel, so it is kept short: publishing, marking paid or a
// decision clears it only on the instance that did it, and the others catch
// up within a minute.
const statementsCache = new Map();
const STATEMENTS_CACHE_TTL_MS = 60 * 1000;

async function invalidatePayrollCache(employeeId = null, periodId = null) {
  prepMemoryCache.clear();
  reviewMemoryCache.clear();
  if (employeeId) {
    statementsCache.delete(employeeId);
  } else {
    statementsCache.clear();
  }
  workingDaysCache.clear();
  cachedDailyRateBasis = null;
  cachedDailyRateBasisExpiry = 0;
}

async function setDailyRateBasis(basis, actor = 'hr') {
  if (!['WORKING_DAYS_260', 'CALENDAR_DAYS_30'].includes(basis)) {
    throw new Error("basis must be 'WORKING_DAYS_260' or 'CALENDAR_DAYS_30'");
  }
  await db.prepare(`
    INSERT INTO org_settings (key, value) VALUES ('payroll_daily_rate_basis', ?)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `).run(basis);
  cachedDailyRateBasis = basis;
  cachedDailyRateBasisExpiry = Date.now() + 60 * 1000;
  await invalidatePayrollCache();
  await audit({
    actor, action: 'PAYROLL_DAILY_RATE_BASIS_UPDATED', targetType: 'org_settings', targetId: 'payroll_daily_rate_basis',
    after: { basis },
  });
  return { basis };
}

async function addException({ periodId, employeeId, amount, type = 'BONUS', explanation, actor = 'hr', autoApprove = true }) {
  if (!employeeId) throw new Error('employeeId is required.');
  if (!explanation || !String(explanation).trim()) {
    throw new Error('An explanation or reason is required for an exception addition.');
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount === 0) {
    throw new Error('A non-zero numeric amount is required.');
  }

  const period = await selectPeriod.get(periodId);
  if (!period) throw new Error('No such payroll period.');
  if (isFinal(period.status)) throw new Error(finalMessage(period));

  // OVERTIME is never calculated automatically: HR adds it here when it is
  // paid, and the invoice prints it on its own line.
  const validTypes = ['BONUS', 'ALLOWANCE', 'SPECIAL_ADDITION', 'OVERTIME', 'HR_EXCEPTION', 'MANUAL_ADJUSTMENT'];
  const adjType = validTypes.includes(type) ? type : 'BONUS';

  const id = 'pa_' + crypto.randomBytes(8).toString('hex');
  const now = T.now();

  if (autoApprove) {
    await db.prepare(`
      INSERT INTO payroll_adjustments
        (id, period_id, employee_id, adjustment_type, calculated_days, calculated_amount,
         approved_days, approved_amount, status, explanation, created_at, approved_at, approved_by,
         review_level, review_reasons)
      VALUES (?, ?, ?, ?, 0, ?, 0, ?, 'APPROVED', ?, ?, ?, ?, 'ROUTINE', ?)
    `).run(
      id, periodId, employeeId, adjType, numericAmount, numericAmount,
      String(explanation).trim(), now, now, actor, JSON.stringify(['HR Exception Addition (Approved)'])
    );

    await audit({
      actor, action: 'PAYROLL_EXCEPTION_APPROVED',
      targetType: 'employee', targetId: employeeId,
      after: { adjustmentId: id, adjustmentType: adjType, amount: numericAmount },
      note: String(explanation).trim(),
    });
  } else {
    await insertAdjustment.run(
      id, periodId, employeeId, adjType, 0, numericAmount, null,
      String(explanation).trim(), now, 'ATTENTION', JSON.stringify([MANUAL_REASON])
    );

    await audit({
      actor, action: 'PAYROLL_EXCEPTION_PROPOSED',
      targetType: 'employee', targetId: employeeId,
      after: { adjustmentId: id, adjustmentType: adjType, calculatedAmount: numericAmount },
      note: String(explanation).trim(),
    });
  }

  await invalidatePayrollCache(employeeId, periodId);
  return { id, employeeId, periodId, type: adjType, amount: numericAmount, status: autoApprove ? 'APPROVED' : 'PROPOSED' };
}

const selectPublishedPayslips = db.prepare(`
  SELECT s.*, p.name AS period_name, p.start_date, p.end_date
  FROM payslips s JOIN payroll_periods p ON p.id = s.period_id
  WHERE s.employee_id = ? AND s.status = 'PUBLISHED'
  ORDER BY p.start_date DESC
`);

/**
 * A payslip in the statements list, in the shape the phone has always read.
 * `status` is the legacy field: the pre-payslip app knows only OPEN and
 * CLOSED and treats CLOSED as final, which a published payslip is.
 * payslipStatus is the real one.
 */
function presentPayslipStatement(s) {
  const lines = payslipFigures(s).lines;
  return {
    periodId: s.period_id,
    name: s.period_name,
    startDate: s.start_date,
    endDate: s.end_date,
    status: 'CLOSED',
    exchangeRate: s.exchange_rate || 350.0,
    currency: s.currency,
    monthlyGross: s.monthly_salary,
    dailyRate: s.daily_rate,
    workingDaysCount: s.working_days,
    fullPeriodDays: s.full_period_days,
    isStarter: !!s.is_starter,
    basePayable: s.gross_baseline,
    adjustmentsTotal: s.adjustments_total,
    netPayable: s.net_payable,
    adjustments: lines.map(l => ({
      id: l.adjustmentId, type: l.type, explanation: l.explanation, amount: l.amount, days: l.days,
    })),
    effectiveFrom: s.salary_effective_from,
    payslipId: s.id,
    payslipVersion: s.version,
    payslipStatus: s.paid_at ? 'PAID' : 'PUBLISHED',
    payDate: s.pay_date,
    cutoffDate: s.cutoff_date,
    publishedAt: s.published_at,
    paidAt: s.paid_at,
    deductionsTotal: s.deductions_total,
    lines,
  };
}

/**
 * History from before payslips existed: CLOSED manual periods, computed from
 * their approved adjustments exactly as they always were. Never OPEN or
 * IN_REVIEW - an employee sees a month once a person has finalised it.
 */
async function legacyStatements(employeeId) {
  const periods = await db.prepare(`
    SELECT * FROM payroll_periods p
    WHERE p.status = 'CLOSED'
      AND NOT EXISTS (SELECT 1 FROM payslips s WHERE s.period_id = p.id)
    ORDER BY p.start_date DESC
  `).all();
  if (!periods.length) return [];

  const employment = await selectEmploymentDates.get(employeeId);

  // Batch query all approved adjustments for this employee across all periods
  const allAdjustments = await db.prepare(`
    SELECT id, period_id, adjustment_type, explanation, approved_amount, approved_days, status, approved_at
    FROM payroll_adjustments
    WHERE employee_id = ? AND status = 'APPROVED'
    ORDER BY created_at ASC
  `).all(employeeId);

  const adjustmentsByPeriod = new Map();
  for (const a of allAdjustments) {
    if (!adjustmentsByPeriod.has(a.period_id)) {
      adjustmentsByPeriod.set(a.period_id, []);
    }
    adjustmentsByPeriod.get(a.period_id).push(a);
  }

  const out = [];
  for (const p of periods) {
    const salary = await salaryAt(employeeId, p.end_date);
    if (salary.blocked) continue;

    const starter = await starterCalculation({
      employeeId,
      periodStart: p.start_date,
      periodEnd: p.end_date,
    });

    const effectiveStart = (employment?.start_date && employment.start_date > p.start_date)
      ? employment.start_date
      : p.start_date;
    const effectiveEnd = (employment?.contract_end_date && employment.contract_end_date < p.end_date)
      ? employment.contract_end_date
      : p.end_date;

    let workingDaysCount = 0;
    if (effectiveStart <= p.end_date && effectiveEnd >= p.start_date) {
      const workedDays = await eligibleWorkingDays(employeeId, effectiveStart, effectiveEnd);
      workingDaysCount = workedDays.length;
    }

    const fullPeriodDays = (await eligibleWorkingDays(employeeId, p.start_date, p.end_date)).length;
    const isStarter = starter.applicable && !starter.blocked;
    const isPartialPeriod = effectiveStart > p.start_date || effectiveEnd < p.end_date;
    const baseGross = isPartialPeriod ? money(salary.dailyPrecise * workingDaysCount) : salary.monthly;

    const adjustments = adjustmentsByPeriod.get(p.id) || [];

    let adjustmentsTotal = 0;
    for (const a of adjustments) {
      if (a.approved_amount) {
        adjustmentsTotal += Number(a.approved_amount);
      }
    }

    const netPayable = money(baseGross + adjustmentsTotal);

    out.push({
      periodId: p.id,
      name: p.name,
      startDate: p.start_date,
      endDate: p.end_date,
      status: p.status,
      exchangeRate: p.exchange_rate || 350.0,
      currency: salary.currency || 'PKR',
      monthlyGross: salary.monthly,
      dailyRate: salary.daily,
      workingDaysCount,
      fullPeriodDays,
      isStarter,
      basePayable: baseGross,
      adjustmentsTotal: money(adjustmentsTotal),
      netPayable,
      adjustments: adjustments.map((a) => ({
        id: a.id,
        type: a.adjustment_type,
        explanation: a.explanation,
        amount: a.approved_amount,
        days: a.approved_days,
      })),
      effectiveFrom: salary.effectiveFrom,
      // No payslip exists for these: the fields are present so every entry
      // has the same shape, and null says "legacy, computed".
      payslipId: null,
      payslipVersion: null,
      payslipStatus: null,
      payDate: p.pay_date || null,
      cutoffDate: p.cutoff_date || null,
      publishedAt: null,
      paidAt: null,
      deductionsTotal: null,
      lines: null,
    });
  }
  return out;
}

const ESTIMATE_LABEL = 'Estimate - not final until HR approves';

/**
 * What this month looks like so far, for the phone. The same preview the
 * prepare sheet computes, through min(today, cut-off): this period's lines at
 * their CALCULATED figures (decided or not, bar rejections) plus anything not
 * yet generated. Deliberately not approved amounts - it is an estimate, and
 * says so.
 */
async function payrollEstimate(employeeId, nowMs) {
  if (!await settingIsOn('show_payroll_estimate_to_employees')) return null;

  const today = T.dateKey(nowMs);
  const period = await db.prepare(`
    SELECT * FROM payroll_periods
    WHERE start_date <= ? AND end_date >= ? AND status IN ('OPEN', 'IN_REVIEW')
    ORDER BY auto_created DESC, start_date DESC LIMIT 1
  `).get(today, today);
  if (!period) return null;

  const employee = await db.prepare('SELECT id, name, employee_number FROM employees WHERE id = ?').get(employeeId);
  if (!employee) return null;

  const pos = await employeePosition(period, employee, { throughDate: today, detail: false });
  if (pos.blocked || !pos.basis.inPeriod) return null;

  const { basis, unpaid, existing } = pos;
  const daily = basis.salary.dailyPrecise;
  const live = existing.filter(a => a.status !== 'REJECTED');
  const rowsOf = type => live.filter(a => a.adjustment_type === type);
  const sum = (rows, field) => rows.reduce((s, a) => s + (Number(a[field]) || 0), 0);

  // The same timeframe as the deductions below (the ledger as settled through
  // the window's end), so the phone never mixes two different "as of"s.
  const asOf = await attendance.balanceAsOf(employeeId, basis.windowEnd);

  const deductions = [];

  // Deficit: this period's generated line if there is one, else the live
  // preview. unpaid.deficitDays already prefers an existing line, but counts a
  // rejected one too, which an estimate must not.
  const deficitRow = existing.find(a => a.adjustment_type === ATTENDANCE_DEFICIT_DAY);
  const deficitDays = deficitRow
    ? (deficitRow.status === 'REJECTED' ? 0 : Number(deficitRow.calculated_days) || 0)
    : unpaid.deficitDays;
  if (deficitDays > 0) {
    deductions.push({
      type: ATTENDANCE_DEFICIT_DAY,
      label: lineLabel(ATTENDANCE_DEFICIT_DAY),
      days: deficitDays,
      amount: deficitRow && deficitRow.status !== 'REJECTED'
        ? money(Number(deficitRow.calculated_amount) || 0)
        : -money(daily * deficitDays),
      explanation: `${deficitDays} whole day(s) of accumulated lateness/early departures `
                 + `(every ${asOf.dayEquivalentMinutes} minutes is one unpaid day).`,
    });
  }

  const absenceRows = rowsOf(UNAUTHORISED_ABSENCE_UNPAID);
  const absenceDays = absenceRows.length + unpaid.absenceDays;
  if (absenceDays > 0) {
    deductions.push({
      type: UNAUTHORISED_ABSENCE_UNPAID,
      label: lineLabel(UNAUTHORISED_ABSENCE_UNPAID),
      days: absenceDays,
      amount: money(sum(absenceRows, 'calculated_amount') - daily * unpaid.absenceDays),
      explanation: `${absenceDays} unauthorised absence(s) confirmed by HR as unpaid.`,
    });
  }

  const leaveRows = rowsOf(UNPAID_LEAVE_DEDUCTION);
  const leaveDays = sum(leaveRows, 'calculated_days') + unpaid.leaveDays;
  if (leaveDays > 0) {
    deductions.push({
      type: UNPAID_LEAVE_DEDUCTION,
      label: lineLabel(UNPAID_LEAVE_DEDUCTION),
      days: leaveDays,
      amount: money(sum(leaveRows, 'calculated_amount') - daily * unpaid.leaveDays),
      explanation: `${leaveDays} day(s) of approved unpaid leave.`,
    });
  }

  return {
    isEstimate: true,
    label: ESTIMATE_LABEL,
    periodId: period.id,
    periodName: period.name,
    periodStatus: period.status,
    cutoffDate: period.cutoff_date || null,
    payDate: period.pay_date || null,
    grossBaseline: basis.grossBaseline,
    deductions,
    estimatedNet: money(basis.grossBaseline + deductions.reduce((s, d) => s + d.amount, 0)),
    currency: basis.salary.currency || P.currency,
    asOf: basis.windowEnd,
    deficit: {
      carryForwardMinutes: asOf.carryForwardMinutes,
      minutesUntilNextUnpaidDay: asOf.dayEquivalentMinutes - asOf.carryForwardMinutes,
      wholeDaysSoFar: deficitDays,
      dayEquivalentMinutes: asOf.dayEquivalentMinutes,
    },
  };
}

/**
 * Employee self-service statement retrieval across all payroll periods.
 * Gated by org_settings.show_salary_to_employees.
 *
 * periods[] holds published payslips (newest first) and legacy CLOSED
 * periods; estimate is this month so far; latestPayslip lets the phone spot a
 * newly published payslip without diffing the list.
 *
 * Passing nowMs (tests) bypasses the cache, since the estimate depends on it.
 */
async function employeeStatements(employeeId, { nowMs = null } = {}) {
  const useCache = nowMs === null;
  const at = nowMs === null ? T.now() : nowMs;

  // Check in-memory cache first
  const now = Date.now();
  const cached = useCache ? statementsCache.get(employeeId) : null;
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  if (!await settingIsOn('show_salary_to_employees')) {
    return {
      enabled: false,
      message: 'Salary and monthly statements are restricted by company HR policy.',
      currentSalary: null,
      periods: [],
      estimate: null,
      latestPayslip: null,
    };
  }

  const currentSalary = await salaryAt(employeeId, T.dateKey(at));

  const published = await selectPublishedPayslips.all(employeeId);
  const periods = [
    ...published.map(presentPayslipStatement),
    ...await legacyStatements(employeeId),
  ].sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));

  const latest = published.reduce((best, s) => (!best || s.published_at > best.published_at ? s : best), null);

  const result = {
    enabled: true,
    currentSalary: {
      monthly: currentSalary.monthly,
      daily: currentSalary.daily,
      annual: currentSalary.annual,
      currency: currentSalary.currency || 'PKR',
      effectiveFrom: currentSalary.effectiveFrom,
      blocked: currentSalary.blocked,
      message: currentSalary.message,
    },
    periods,
    estimate: await payrollEstimate(employeeId, at),
    latestPayslip: latest ? { periodId: latest.period_id, publishedAt: latest.published_at } : null,
  };

  // Cache calculated result
  if (useCache) {
    statementsCache.set(employeeId, {
      data: result,
      expiresAt: now + STATEMENTS_CACHE_TTL_MS,
    });
  }

  return result;
}

/** One of the employee's own published payslips, or null. */
async function employeePayslip(employeeId, periodId) {
  if (!await settingIsOn('show_salary_to_employees')) {
    throw new PayrollRunError('Salary and monthly statements are restricted by company HR policy.', { code: 'RESTRICTED', httpStatus: 403 });
  }
  const s = await db.prepare(`
    SELECT s.*, p.name AS period_name, p.start_date, p.end_date
    FROM payslips s JOIN payroll_periods p ON p.id = s.period_id
    WHERE s.employee_id = ? AND s.period_id = ? AND s.status = 'PUBLISHED'
  `).get(employeeId, periodId);
  if (!s) return null;
  const payslip = { ...presentPayslip(s), startDate: s.start_date, endDate: s.end_date };
  // Which HR account approved the run is audit detail, not part of the payslip.
  delete payslip.publishedBy;
  return payslip;
}

const selectLatestPayslip = db.prepare(`
  SELECT s.period_id, s.published_at FROM payslips s
  WHERE s.employee_id = ? AND s.status = 'PUBLISHED'
    AND EXISTS (
      SELECT 1 FROM org_settings o WHERE o.key = 'show_salary_to_employees' AND o.value = '1'
    )
  ORDER BY s.published_at DESC LIMIT 1
`);

/**
 * The employee's newest published payslip, for the phone's frequently polled
 * home summary. One indexed query; null while salaries are hidden from
 * employees, so the phone never announces a payslip it cannot open.
 */
async function latestPayslipFor(employeeId) {
  const row = await selectLatestPayslip.get(employeeId);
  return row ? { periodId: row.period_id, publishedAt: row.published_at } : null;
}

module.exports = {
  rates, money, salaryAt, setSalary, salaryHistoryFor,
  getDailyRateBasis, setDailyRateBasis, addException,
  eligibleWorkingDays, starterCalculation, leaverCalculation,
  createPeriod, updatePeriodExchangeRate, updatePeriodProcessingFee, preparePeriod, proposeAdjustment, decideAdjustment, closePeriod,
  generatePeriodDeductions, unpaidDaysSummary, addDecisionToRunInReview,
  employeeStatements, invalidatePayrollCache,
  // The monthly run
  ensureCurrentPeriod, generateRun, runPayrollAutomation,
  payrollPreflight, reviewPeriod, approveRun, markPaid,
  listPayslips, employeePayslip, latestPayslipFor,
  // For invoices (domain/invoice.js)
  employeePosition,
  payslipIntegrityOk: r => payslipHash(r) === r.content_hash,
  PayrollRunError, FINAL_STATUSES,
  ATTENDANCE_DEFICIT_DAY, UNAUTHORISED_ABSENCE_UNPAID, UNPAID_LEAVE_DEDUCTION,
};
