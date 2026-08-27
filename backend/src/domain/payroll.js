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
function salaryAt(employeeId, dateKey = T.dateKey()) {
  const row = selectSalaryAt.get(employeeId, dateKey, dateKey);
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
function setSalary({ employeeId, amount, effectiveFrom, reason, actor, currency = P.currency, payFrequency = 'Monthly' }) {
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
  const previous = selectSalaryAt.get(employeeId, effectiveFrom, effectiveFrom);

  tx(() => {
    if (previous) {
      // Closed the day before the new one starts, so the two never overlap and
      // salaryAt() can never return two answers for one date.
      const dayBefore = T.dateKey(T.startOfDay(effectiveFrom) - 1);
      db.prepare('UPDATE salary_history SET effective_to = ? WHERE id = ?')
        .run(dayBefore, previous.id);
    }

    db.prepare(`
      INSERT INTO salary_history
        (id, employee_id, amount, currency, pay_frequency, effective_from,
         daily_rate, reason, created_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, employeeId, Number(amount), currency, payFrequency, effectiveFrom,
           rates(amount).dailyPrecise, String(reason).trim(), nowMs, actor);

    audit({
      actor, action: 'SALARY_SET',
      targetType: 'employee', targetId: employeeId,
      before: previous ? { amount: previous.amount, effectiveFrom: previous.effective_from } : null,
      after: { amount: Number(amount), effectiveFrom },
      note: String(reason).trim(),
    });
  })();

  return salaryAt(employeeId, effectiveFrom);
}

function salaryHistoryFor(employeeId) {
  return db.prepare(
    'SELECT * FROM salary_history WHERE employee_id = ? ORDER BY effective_from DESC'
  ).all(employeeId).map(r => ({
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
function eligibleWorkingDays(employeeId, fromDate, toDate) {
  return schedule.workingDaysBetween(employeeId, fromDate, toDate);
}

const selectEmploymentDates = db.prepare(`
  SELECT start_date, contract_end_date FROM employment_records
  WHERE employee_id = ? ORDER BY effective_from ASC LIMIT 1
`);

// ---------------------------------------------------------------------------
// Starters (spec 18)
// ---------------------------------------------------------------------------

/**
 * Pro-rata pay for someone who started part-way through a period.
 *
 * Spec 18: daily salary x eligible working days. A starter who works four days
 * in their first month is paid for four days.
 */
function starterCalculation({ employeeId, periodStart, periodEnd }) {
  const employment = selectEmploymentDates.get(employeeId);
  if (!employment || !employment.start_date) {
    return { applicable: false, blocked: true, reason: 'NO_START_DATE' };
  }

  const startDate = employment.start_date;
  // Only a starter if they began inside this period.
  if (startDate < periodStart || startDate > periodEnd) {
    return { applicable: false };
  }

  const salary = salaryAt(employeeId, startDate);
  if (salary.blocked) return { applicable: true, blocked: true, ...salary };

  const workedDays = eligibleWorkingDays(employeeId, startDate, periodEnd);
  const fullPeriodDays = eligibleWorkingDays(employeeId, periodStart, periodEnd);

  const grossPrecise = salary.dailyPrecise * workedDays.length;

  return {
    applicable: true,
    blocked: false,
    startDate,
    eligibleWorkingDays: workedDays.length,
    fullPeriodWorkingDays: fullPeriodDays.length,
    dailyRate: salary.daily,
    calculatedGross: money(grossPrecise),
    // The alternative rounding, shown rather than argued about. The spec's own
    // example rounds the daily rate first, which differs by pennies.
    calculatedGrossRoundedDaily: money(salary.daily * workedDays.length),
    fullMonthlySalary: salary.monthly,
    formula: `${salary.daily} x ${workedDays.length} working day(s)`,
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
function leaverCalculation({ employeeId, lastWorkingDate, periodStart = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lastWorkingDate || ''))) {
    throw new Error('lastWorkingDate must be YYYY-MM-DD.');
  }

  const salary = salaryAt(employeeId, lastWorkingDate);
  if (salary.blocked) return { blocked: true, ...salary };

  const employment = selectEmploymentDates.get(employeeId);
  const from = periodStart
    || (employment?.start_date && employment.start_date > lastWorkingDate.slice(0, 8) + '01'
        ? employment.start_date
        : lastWorkingDate.slice(0, 8) + '01');

  const workedDays = eligibleWorkingDays(employeeId, from, lastWorkingDate);

  // Leave position at the leaving date.
  const balance = leave.balanceFor(employeeId, lastWorkingDate);
  const leaveBlocked = balance.blocked;

  const untakenDays = leaveBlocked ? null : Math.max(0, balance.availableDays);
  const excessTakenDays = leaveBlocked ? null : Math.max(0, -balance.availableDays);

  // Attendance deficit, as whole-day equivalents. Spec 8.3 says reaching 480
  // minutes creates an HR ACTION - it is not an automatic deduction, so it is
  // reported here and nothing more.
  const deficit = attendance.balanceFor(employeeId);

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
    calculatedPayForPeriod: money(salary.dailyPrecise * workedDays.length),

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

function createPeriod({ name, startDate, endDate, actor }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('startDate and endDate must be YYYY-MM-DD.');
  }
  if (endDate < startDate) throw new Error('endDate must be on or after startDate.');

  const id = 'pp_' + crypto.randomBytes(6).toString('hex');
  db.prepare(`
    INSERT INTO payroll_periods (id, name, start_date, end_date, status, created_at)
    VALUES (?,?,?,?, 'OPEN', ?)
  `).run(id, name || `${startDate} to ${endDate}`, startDate, endDate, T.now());

  audit({ actor, action: 'PAYROLL_PERIOD_CREATED', targetType: 'payroll_period', targetId: id,
          after: { startDate, endDate } });
  return { id, startDate, endDate, status: 'OPEN' };
}

/**
 * Builds the preparation sheet for a period.
 *
 * Read-only by design: it computes what each employee's position looks like and
 * writes nothing. Adjustments are created only when a person chooses to.
 */
function preparePeriod(periodId) {
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(periodId);
  if (!period) throw new Error('No such payroll period.');

  const employees = db.prepare('SELECT id, name FROM employees WHERE active = 1').all();
  const rows = [];
  const blocked = [];

  for (const e of employees) {
    const salary = salaryAt(e.id, period.end_date);
    if (salary.blocked) {
      blocked.push({ employeeId: e.id, employeeName: e.name, reason: salary.reason, message: salary.message });
      continue;
    }

    const starter = starterCalculation({
      employeeId: e.id, periodStart: period.start_date, periodEnd: period.end_date,
    });
    const deficit = attendance.balanceFor(e.id);
    const balance = leave.balanceFor(e.id, period.end_date);

    const existing = db.prepare(
      'SELECT * FROM payroll_adjustments WHERE period_id = ? AND employee_id = ?'
    ).all(periodId, e.id);

    rows.push({
      employeeId: e.id,
      employeeName: e.name,
      salary: { monthly: salary.monthly, daily: salary.daily, annual: salary.annual },
      isStarter: starter.applicable && !starter.blocked,
      starter: starter.applicable && !starter.blocked ? {
        startDate: starter.startDate,
        eligibleWorkingDays: starter.eligibleWorkingDays,
        calculatedGross: starter.calculatedGross,
      } : null,
      attendanceDeficit: {
        wholeDayEquivalents: deficit.wholeDayEquivalents,
        carryForwardMinutes: deficit.carryForwardMinutes,
        // Shown as a VALUE, never as a deduction. Spec 8.3.
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
      status: period.status,
    },
    employees: rows,
    // Named rather than skipped, so a missing salary is visible instead of the
    // employee simply not appearing on the sheet.
    blocked,
    note: 'Preparation figures only. Nothing here affects pay until an adjustment is '
        + 'created and approved.',
  };
}

/** Creates a PROPOSED adjustment. Never approved at the same time. */
function proposeAdjustment({ periodId, employeeId, adjustmentType, calculatedDays = 0, calculatedAmount = 0, explanation, sourceReference = null, actor }) {
  if (!explanation || !String(explanation).trim()) {
    throw new Error('An explanation is required for any payroll adjustment.');
  }
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(periodId);
  if (!period) throw new Error('No such payroll period.');
  if (period.status === 'CLOSED') throw new Error('This payroll period is closed.');

  const id = 'pa_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO payroll_adjustments
      (id, period_id, employee_id, adjustment_type, calculated_days, calculated_amount,
       source_reference, explanation, status, created_at)
    VALUES (?,?,?,?,?,?,?,?, 'PROPOSED', ?)
  `).run(id, periodId, employeeId, adjustmentType, Number(calculatedDays) || 0,
         Number(calculatedAmount) || 0, sourceReference, String(explanation).trim(), T.now());

  audit({
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
function decideAdjustment({ adjustmentId, decision, approvedDays = null, approvedAmount = null, notes, actor }) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw new Error('decision must be APPROVED or REJECTED.');
  }
  if (!notes || !String(notes).trim()) throw new Error('A note explaining the decision is required.');

  const adj = db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(adjustmentId);
  if (!adj) throw new Error('No such adjustment.');
  if (adj.status !== 'PROPOSED') throw new Error(`This adjustment is already ${adj.status.toLowerCase()}.`);

  const nowMs = T.now();
  const finalAmount = decision === 'APPROVED'
    ? (approvedAmount === null ? adj.calculated_amount : Number(approvedAmount))
    : null;
  const finalDays = decision === 'APPROVED'
    ? (approvedDays === null ? adj.calculated_days : Number(approvedDays))
    : null;

  tx(() => {
    db.prepare(`
      UPDATE payroll_adjustments
      SET status = ?, approved_days = ?, approved_amount = ?, approved_by = ?, approved_at = ?
      WHERE id = ?
    `).run(decision, finalDays, finalAmount, actor, nowMs, adjustmentId);

    audit({
      actor, action: 'PAYROLL_ADJUSTMENT_DECIDED',
      targetType: 'employee', targetId: adj.employee_id,
      before: { status: adj.status, calculatedAmount: adj.calculated_amount },
      after: { status: decision, approvedAmount: finalAmount },
      note: String(notes).trim()
        + (finalAmount !== null && finalAmount !== adj.calculated_amount
            ? ` (overridden from the calculated ${adj.calculated_amount})`
            : ''),
    });
  })();

  return { decision, approvedAmount: finalAmount, approvedDays: finalDays };
}

/** Closes a period. Only approved adjustments are final. */
function closePeriod({ periodId, actor }) {
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(periodId);
  if (!period) throw new Error('No such payroll period.');

  const pending = db.prepare(
    "SELECT COUNT(*) c FROM payroll_adjustments WHERE period_id = ? AND status = 'PROPOSED'"
  ).get(periodId).c;
  if (pending > 0) {
    throw new Error(`${pending} adjustment(s) are still awaiting a decision. Decide them before closing.`);
  }

  db.prepare("UPDATE payroll_periods SET status = 'CLOSED', approved_by = ?, approved_at = ? WHERE id = ?")
    .run(actor, T.now(), periodId);

  audit({ actor, action: 'PAYROLL_PERIOD_CLOSED', targetType: 'payroll_period', targetId: periodId });
  return { closed: true };
}

module.exports = {
  rates, money, salaryAt, setSalary, salaryHistoryFor,
  eligibleWorkingDays, starterCalculation, leaverCalculation,
  createPeriod, preparePeriod, proposeAdjustment, decideAdjustment, closePeriod,
};
