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
// Precision follows the principle spec section 14 states for leave: full
// precision internally, rounded only at the edge. That gives 369.23 for four
// days at 2000/month where the spec's own worked example shows 369.24 - the
// difference is rounding the daily rate before multiplying, and it is flagged
// on every calculation rather than hidden.

const crypto = require('crypto');
const { db, tx, audit } = require('../db');
const { config } = require('../config');
const schedule = require('./schedule');
const leave = require('./leave');
const attendance = require('./attendance');
const T = require('../util/time');

const P = config.payroll;

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** Rounds to whole pence, at the edge only. */
function money(n) {
  return Math.round(n * 100) / 100;
}

/**
 * The rate chain from spec section 17, kept as separate steps so each one can
 * be shown to whoever is checking the figure.
 */
function rates(monthlyAmount) {
  const monthly = Number(monthlyAmount) || 0;
  const annual = monthly * P.monthsPerYear;
  const weekly = annual / P.weeksPerYear;
  const daily = weekly / P.workingDaysPerWeek;

  return {
    monthly: money(monthly),
    annual: money(annual),
    weekly: money(weekly),
    daily: money(daily),
    // Unrounded, because multiplying a rounded daily rate by a day count is
    // what produces the penny difference against the spec's worked example.
    dailyPrecise: daily,
    formula: `monthly x ${P.monthsPerYear} / ${P.weeksPerYear} / ${P.workingDaysPerWeek}`,
    workingDaysPerYear: P.weeksPerYear * P.workingDaysPerWeek,
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
async function salaryAt(employeeId, dateKey = T.dateKey()) {
  const row = await selectSalaryAt.get(employeeId, dateKey, dateKey);
  if (!row) {
    return {
      blocked: true,
      reason: 'NO_SALARY_ON_RECORD',
      message: 'No salary is recorded for this employee on that date, so pay cannot be calculated.',
    };
  }
  return {
    blocked: false,
    salaryId: row.id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    currency: row.currency,
    payFrequency: row.pay_frequency,
    ...rates(row.amount),
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

/** Scheduled working days for an employee in a range, honouring the calendar. */
async function eligibleWorkingDays(employeeId, fromDate, toDate) {
  return await schedule.workingDaysBetween(employeeId, fromDate, toDate);
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
 * currently open when this is next run.
 */
async function unclaimedUnpaidAbsences({ employeeId, throughDate }) {
  return await selectUnclaimedAbsences.all(employeeId, throughDate, UNAUTHORISED_ABSENCE_UNPAID);
}

const selectUnclaimedUnpaidLeave = db.prepare(`
  SELECT lr.id, lr.start_date, lr.end_date, lr.total_days, lt.name AS leave_type_name
  FROM leave_requests lr
  JOIN leave_types lt ON lt.id = lr.leave_type_id
  WHERE lr.employee_id = ?
    AND lr.status = 'APPROVED'
    AND lt.is_paid = 0
    AND lr.start_date <= ?
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
  return await selectUnclaimedUnpaidLeave.all(employeeId, throughDate, UNPAID_LEAVE_DEDUCTION);
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
 */
async function starterCalculation({ employeeId, periodStart, periodEnd, periodId = null }) {
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
    employeeId, periodId, windowEnd: periodEnd, dailyPrecise: salary.dailyPrecise,
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
  const balance = await leave.balanceFor(employeeId, lastWorkingDate);
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
// Periods and adjustments
// ---------------------------------------------------------------------------

async function createPeriod({ name, startDate, endDate, exchangeRate = 350.0, actor }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('startDate and endDate must be YYYY-MM-DD.');
  }
  if (endDate < startDate) throw new Error('endDate must be on or after startDate.');

  const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 350.0;
  const id = 'pp_' + crypto.randomBytes(6).toString('hex');
  await db.prepare(`
    INSERT INTO payroll_periods (id, name, start_date, end_date, exchange_rate, status, created_at)
    VALUES (?,?,?,?,?, 'OPEN', ?)
  `).run(id, name || `${startDate} to ${endDate}`, startDate, endDate, rate, T.now());

  await audit({ actor, action: 'PAYROLL_PERIOD_CREATED', targetType: 'payroll_period', targetId: id,
          after: { startDate, endDate, exchangeRate: rate } });
  return { id, name: name || `${startDate} to ${endDate}`, startDate, endDate, exchangeRate: rate, status: 'OPEN' };
}

async function updatePeriodExchangeRate({ periodId, exchangeRate, actor }) {
  const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(periodId);
  if (!period) throw new Error('No such payroll period.');
  if (period.status === 'CLOSED') throw new Error('Cannot change exchange rate of a closed payroll period.');

  const rate = Number(exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('A positive numeric exchange rate is required.');
  }

  await db.prepare('UPDATE payroll_periods SET exchange_rate = ? WHERE id = ?').run(rate, periodId);
  await audit({
    actor, action: 'PAYROLL_PERIOD_EXCHANGE_RATE_UPDATED', targetType: 'payroll_period', targetId: periodId,
    before: { exchangeRate: period.exchange_rate }, after: { exchangeRate: rate },
  });

  return { periodId, exchangeRate: rate, message: 'Exchange rate updated for this period.' };
}

/**
 * Builds the preparation sheet for a period.
 *
 * Read-only by design: it computes what each employee's position looks like and
 * writes nothing. Adjustments are created only when a person chooses to.
 */
async function preparePeriod(periodId) {
  const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(periodId);
  if (!period) throw new Error('No such payroll period.');

  const employees = await db.prepare('SELECT id, name, employee_number FROM employees WHERE active = 1').all();
  const rows = [];
  const blocked = [];

  for (const e of employees) {
    const salary = await salaryAt(e.id, period.end_date);
    if (salary.blocked) {
      blocked.push({ employeeId: e.id, employeeName: e.name, employeeNumber: e.employee_number || null, reason: salary.reason, message: salary.message });
      continue;
    }

    const starter = await starterCalculation({
      employeeId: e.id, periodStart: period.start_date, periodEnd: period.end_date, periodId,
    });

    const employment = await selectEmploymentDates.get(e.id);
    const effectiveStart = (employment?.start_date && employment.start_date > period.start_date)
      ? employment.start_date
      : period.start_date;
    const effectiveEnd = (employment?.contract_end_date && employment.contract_end_date < period.end_date)
      ? employment.contract_end_date
      : period.end_date;

    let workingDaysCount = 0;
    if (effectiveStart <= period.end_date && effectiveEnd >= period.start_date) {
      const workedDays = await eligibleWorkingDays(e.id, effectiveStart, effectiveEnd);
      workingDaysCount = workedDays.length;
    }

    const fullPeriodDays = await (await eligibleWorkingDays(e.id, period.start_date, period.end_date)).length;

    // A partial period (starter, leaver, or both) keeps the day-rate basis --
    // you can't apply "full month minus unpaid days" to someone who only had
    // a handful of scheduled days in the period to begin with. A full period
    // starts from the whole monthly salary instead of re-deriving it from a
    // day count, per the new formula.
    const isPartialPeriod = effectiveStart > period.start_date || effectiveEnd < period.end_date;
    const windowEnd = effectiveEnd < period.end_date ? effectiveEnd : period.end_date;

    const unpaid = await unpaidDaysSummary({
      employeeId: e.id, periodId, windowEnd, dailyPrecise: salary.dailyPrecise,
    });

    const grossBaseline = isPartialPeriod ? money(salary.dailyPrecise * workingDaysCount) : salary.monthly;
    const calculatedPeriodGross = isPartialPeriod
      ? money(salary.dailyPrecise * Math.max(0, workingDaysCount - unpaid.totalDays))
      : money(salary.monthly - salary.dailyPrecise * unpaid.totalDays);

    // Lifetime informational view, kept for continuity -- unpaid.deficitDays
    // above (NEW whole-days not yet claimed by a prior adjustment) is what
    // actually drives the deduction now.
    const deficit = await attendance.balanceFor(e.id);
    const balance = await leave.balanceFor(e.id, period.end_date);

    const existing = await db.prepare(
      'SELECT * FROM payroll_adjustments WHERE period_id = ? AND employee_id = ?'
    ).all(periodId, e.id);

    const approvedTotal = existing
      .filter(a => a.status === 'APPROVED')
      .reduce((s, a) => s + Number(a.approved_amount || 0), 0);
    const hasPending = existing.some(a => a.status === 'PROPOSED');
    // PROVISIONAL: nothing has been proposed for this employee/period yet --
    // netPayable is just the undeducted baseline. PARTIALLY_DECIDED: some
    // adjustments are still awaiting a decision. DECIDED: every adjustment
    // that exists has been approved or rejected.
    const netBasis = existing.length === 0 ? 'PROVISIONAL' : (hasPending ? 'PARTIALLY_DECIDED' : 'DECIDED');

    rows.push({
      employeeId: e.id,
      employeeName: e.name,
      employeeNumber: e.employee_number || null,
      salary: { monthly: salary.monthly, daily: salary.daily, annual: salary.annual, currency: salary.currency || 'GBP' },
      isPartialPeriod,
      workingDaysCount,
      fullPeriodDays,
      grossBaseline,
      calculatedPeriodGross,
      isStarter: starter.applicable && !starter.blocked,
      starter: starter.applicable && !starter.blocked ? {
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
      attendanceDeficit: {
        wholeDayEquivalents: deficit.wholeDayEquivalents,
        carryForwardMinutes: deficit.carryForwardMinutes,
        // Shown as a VALUE, never as a deduction, on this lifetime view.
        // unpaidDays.deficitAmount above is the actual per-period deduction.
        valueIfDeducted: money(salary.dailyPrecise * deficit.wholeDayEquivalents),
        needsHrDecision: deficit.wholeDayEquivalents > 0,
      },
      leave: balance.blocked
        ? { blocked: true, reason: balance.reason }
        : { available: balance.availableDays, isNegative: balance.isNegative },
      adjustments: existing.map(a => ({
        id: a.id, type: a.adjustment_type, status: a.status,
        calculatedAmount: a.calculated_amount,
        approvedAmount: a.approved_amount,
        explanation: a.explanation,
      })),
    });
  }

  return {
    period: {
      id: period.id, name: period.name,
      from: period.start_date, to: period.end_date,
      exchangeRate: period.exchange_rate || 350.0,
      status: period.status,
    },
    employees: rows,
    // Named rather than skipped, so a missing salary is visible instead of the
    // employee simply not appearing on the sheet.
    blocked,
    note: 'Nothing here affects pay until an adjustment is created and approved. '
        + 'calculatedPeriodGross and unpaidDays are a preview of what generate-deductions would '
        + 'propose; netPayable reflects only what has actually been approved.',
  };
}

/** Creates a PROPOSED adjustment. Never approved at the same time. */
async function proposeAdjustment({ periodId, employeeId, adjustmentType, calculatedDays = 0, calculatedAmount = 0, explanation, sourceReference = null, actor }) {
  if (!explanation || !String(explanation).trim()) {
    throw new Error('An explanation is required for any payroll adjustment.');
  }
  const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(periodId);
  if (!period) throw new Error('No such payroll period.');
  if (period.status === 'CLOSED') throw new Error('This payroll period is closed.');

  const id = 'pa_' + crypto.randomBytes(8).toString('hex');
  await db.prepare(`
    INSERT INTO payroll_adjustments
      (id, period_id, employee_id, adjustment_type, calculated_days, calculated_amount,
       source_reference, explanation, status, created_at)
    VALUES (?,?,?,?,?,?,?,?, 'PROPOSED', ?)
  `).run(id, periodId, employeeId, adjustmentType, Number(calculatedDays) || 0,
         Number(calculatedAmount) || 0, sourceReference, String(explanation).trim(), T.now());

  await audit({
    actor, action: 'PAYROLL_ADJUSTMENT_PROPOSED',
    targetType: 'employee', targetId: employeeId,
    after: { adjustmentId: id, adjustmentType, calculatedAmount },
    note: String(explanation).trim(),
  });

  return { id, status: 'PROPOSED' };
}

/**
 * A person approves or rejects. The approved amount is recorded SEPARATELY from
 * the calculated one, so a figure that was overridden stays visible as an
 * override rather than replacing the calculation.
 */
async function decideAdjustment({ adjustmentId, decision, approvedDays = null, approvedAmount = null, notes, actor }) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw new Error('decision must be APPROVED or REJECTED.');
  }
  if (!notes || !String(notes).trim()) throw new Error('A note explaining the decision is required.');

  const adj = await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(adjustmentId);
  if (!adj) throw new Error('No such adjustment.');
  if (adj.status !== 'PROPOSED') throw new Error(`This adjustment is already ${adj.status.toLowerCase()}.`);

  const nowMs = T.now();
  const finalAmount = decision === 'APPROVED'
    ? (approvedAmount === null ? adj.calculated_amount : Number(approvedAmount))
    : null;
  const finalDays = decision === 'APPROVED'
    ? (approvedDays === null ? adj.calculated_days : Number(approvedDays))
    : null;

  await tx(async () => {
    await db.prepare(`
      UPDATE payroll_adjustments
      SET status = ?, approved_days = ?, approved_amount = ?, approved_by = ?, approved_at = ?
      WHERE id = ?
    `).run(decision, finalDays, finalAmount, actor, nowMs, adjustmentId);

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
      after: { status: decision, approvedAmount: finalAmount },
      note: String(notes).trim()
        + (finalAmount !== null && finalAmount !== adj.calculated_amount
            ? ` (overridden from the calculated ${adj.calculated_amount})`
            : ''),
    });
  });

  invalidatePayrollCache(adj.employee_id);

  return { decision, approvedAmount: finalAmount, approvedDays: finalDays };
}

/** Closes a period. Only approved adjustments are final. */
async function closePeriod({ periodId, actor }) {
  const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(periodId);
  if (!period) throw new Error('No such payroll period.');

  const pending = (await db.prepare(
    "SELECT COUNT(*) c FROM payroll_adjustments WHERE period_id = ? AND status = 'PROPOSED'"
  ).get(periodId)).c;
  if (pending > 0) {
    throw new Error(`${pending} adjustment(s) are still awaiting a decision. Decide them before closing.`);
  }

  await db.prepare("UPDATE payroll_periods SET status = 'CLOSED', approved_by = ?, approved_at = ? WHERE id = ?")
    .run(actor, T.now(), periodId);

  await audit({ actor, action: 'PAYROLL_PERIOD_CLOSED', targetType: 'payroll_period', targetId: periodId });
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
 * not something a GET request should ever trigger. Safe to call more than
 * once for the same period -- every source's "already claimed" check means
 * a second run creates nothing new.
 */
async function generatePeriodDeductions({ periodId, actor }) {
  const period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(periodId);
  if (!period) throw new Error('No such payroll period.');
  if (period.status === 'CLOSED') throw new Error('This payroll period is closed.');

  const employees = await db.prepare('SELECT id FROM employees WHERE active = 1').all();
  const created = [];

  for (const e of employees) {
    const salary = await salaryAt(e.id, period.end_date);
    if (salary.blocked) continue;

    const employment = await selectEmploymentDates.get(e.id);
    const effectiveStart = (employment?.start_date && employment.start_date > period.start_date)
      ? employment.start_date
      : period.start_date;
    const effectiveEnd = (employment?.contract_end_date && employment.contract_end_date < period.end_date)
      ? employment.contract_end_date
      : period.end_date;
    if (effectiveStart > period.end_date || effectiveEnd < period.start_date) continue;

    const windowEnd = effectiveEnd < period.end_date ? effectiveEnd : period.end_date;

    // Attendance deficit: one row per employee per period.
    const deficit = await deficitComponent({ employeeId: e.id, periodId, windowEnd });
    if (!deficit.existingAdjustmentId && deficit.days > 0) {
      const adj = await proposeAdjustment({
        periodId, employeeId: e.id, adjustmentType: ATTENDANCE_DEFICIT_DAY,
        calculatedDays: deficit.days,
        calculatedAmount: -money(salary.dailyPrecise * deficit.days),
        explanation: `Attendance deficit: ${deficit.days} whole day(s) crossed (480+ accumulated `
                   + `minutes) as of ${windowEnd}. Auto-calculated.`,
        sourceReference: null, actor,
      });
      created.push({ employeeId: e.id, adjustmentType: ATTENDANCE_DEFICIT_DAY, ...adj });
    }

    // Unauthorised absences: one row per unclaimed confirmed+unpaid record.
    const absences = await unclaimedUnpaidAbsences({ employeeId: e.id, throughDate: windowEnd });
    for (const abs of absences) {
      const adj = await proposeAdjustment({
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
      const adj = await proposeAdjustment({
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

  await audit({
    actor, action: 'PAYROLL_DEDUCTIONS_GENERATED', targetType: 'payroll_period', targetId: periodId,
    after: { createdCount: created.length },
  });

  return { periodId, createdCount: created.length, created };
}

/**
 * Employee self-service statement retrieval across all payroll periods.
 * Gated by org_settings.show_salary_to_employees.
 */
// In-memory cache for employee payroll statements.
// Key: employeeId -> { data, expiresAt }
const statementsCache = new Map();
const STATEMENTS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function invalidatePayrollCache(employeeId = null) {
  if (employeeId) {
    statementsCache.delete(employeeId);
  } else {
    statementsCache.clear();
  }
}

async function employeeStatements(employeeId) {
  // Check in-memory cache first
  const now = Date.now();
  const cached = statementsCache.get(employeeId);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const setting = await db.prepare("SELECT value FROM org_settings WHERE key = 'show_salary_to_employees'").get();
  const enabled = setting ? String(setting.value).trim() === '1' : false;
  if (!enabled) {
    return {
      enabled: false,
      message: 'Salary and monthly statements are restricted by company HR policy.',
      currentSalary: null,
      periods: [],
    };
  }

  const currentSalary = await salaryAt(employeeId, T.dateKey());

  const periods = await db.prepare('SELECT * FROM payroll_periods ORDER BY start_date DESC').all();
  const periodStatements = [];

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

  // Pre-fetch working pattern once
  const wp = await (employment?.working_pattern_id
    ? db.prepare('SELECT * FROM working_patterns WHERE id = ?').get(employment.working_pattern_id)
    : db.prepare('SELECT * FROM working_patterns ORDER BY created_at ASC LIMIT 1').get());

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

    periodStatements.push({
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
    });
  }

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
    periods: periodStatements,
  };

  // Cache calculated result
  statementsCache.set(employeeId, {
    data: result,
    expiresAt: now + STATEMENTS_CACHE_TTL_MS,
  });

  return result;
}

module.exports = {
  rates, money, salaryAt, setSalary, salaryHistoryFor,
  eligibleWorkingDays, starterCalculation, leaverCalculation,
  createPeriod, updatePeriodExchangeRate, preparePeriod, proposeAdjustment, decideAdjustment, closePeriod,
  generatePeriodDeductions, unpaidDaysSummary,
  employeeStatements, invalidatePayrollCache,
  ATTENDANCE_DEFICIT_DAY, UNAUTHORISED_ABSENCE_UNPAID, UNPAID_LEAVE_DEDUCTION,
};

