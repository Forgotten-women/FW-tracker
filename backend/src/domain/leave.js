// Leave accrual, balances and requests. Spec sections 13, 14, 15 and 16.
//
// Policy confirmed by Forgotten Women on 2026-08-27:
//   - 20 days a year, accruing monthly
//   - the holiday year runs from each EMPLOYMENT ANNIVERSARY, not January
//   - nothing carries over: unused days are lost at the anniversary
//   - an employee may go beyond their entitlement, but only where HR approves
//   - HR approves leave requests; there is no manager step
//
// Two consequences of the anniversary basis are worth stating plainly:
//
//   1. Accrual is impossible without a start date. Rather than assume one, the
//      engine reports the employee as blocked and says what is missing.
//   2. Every employee has a different year boundary, so "the leave year" is
//      never a single global period.

const crypto = require('crypto');
const { db, tx, audit } = require('../db');
const { config } = require('../config');
const schedule = require('./schedule');
const N = require('./notifications');
const T = require('../util/time');

const ENTITLEMENT = config.leave.annualEntitlementDays;

// ---------------------------------------------------------------------------
// Holiday year
// ---------------------------------------------------------------------------

const selectStartDate = db.prepare(`
  SELECT start_date FROM employment_records
  WHERE employee_id = ? ORDER BY effective_from ASC LIMIT 1
`);

function addMonths(dateKey, months) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth() + 1;
  // Clamp so a start date of the 31st does not roll into the next month.
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${String(tm).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/**
 * The employee's current holiday year, running from their start anniversary.
 *
 * Returns { blocked: true } when no start date is recorded. Guessing one would
 * silently decide how much leave somebody has.
 */
async function holidayYearFor(employeeId, onDate = T.dateKey()) {
  const row = await selectStartDate.get(employeeId);
  if (!row || !row.start_date) {
    return {
      blocked: true,
      reason: 'NO_START_DATE',
      message: 'This employee has no employment start date, so their holiday year '
             + 'cannot be worked out. Add an employment record with a start date.',
    };
  }

  const startDate = row.start_date;
  if (onDate < startDate) {
    return { blocked: true, reason: 'NOT_STARTED', message: 'Employment has not started yet.', startDate };
  }

  // How many whole years of service have elapsed.
  let yearsOfService = 0;
  while (addMonths(startDate, (yearsOfService + 1) * 12) <= onDate) yearsOfService++;

  const yearStart = addMonths(startDate, yearsOfService * 12);
  const yearEnd = addMonths(startDate, (yearsOfService + 1) * 12);

  // Months of service COMPLETED within this holiday year. The month accrues
  // once it has been worked - that is what makes 12 accruals reach exactly
  // 20.00 at month 12, as the spec section 14 table shows.
  let monthsCompleted = 0;
  while (monthsCompleted < 12 && addMonths(yearStart, monthsCompleted + 1) <= onDate) {
    monthsCompleted++;
  }

  const cycleStartDate = yearStart;
  const cycleEndDate = T.dateKey(T.startOfDay(yearEnd) - 1);
  const nextRenewalDate = yearEnd;

  return {
    blocked: false,
    startDate,
    yearsOfService,
    // A stable key for the ledger, e.g. "2026-03-15/1" for the second year.
    leaveYear: `${yearStart}/${yearsOfService}`,
    yearStart,
    yearEnd,
    cycleStartDate,
    cycleEndDate,
    nextRenewalDate,
    monthsCompleted,
    nextAccrualDate: monthsCompleted < 12 ? addMonths(yearStart, monthsCompleted + 1) : yearEnd,
  };
}

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

const selectAccrued = db.prepare(`
  SELECT COALESCE(SUM(days_delta), 0) AS days
  FROM leave_accrual_ledger
  WHERE employee_id = ? AND leave_year = ? AND entry_type = 'ACCRUAL'
`);

const insertLedger = db.prepare(`
  INSERT INTO leave_accrual_ledger
    (id, employee_id, leave_year, entry_type, days_delta, balance_after,
     effective_date, leave_request_id, description, created_at, created_by)
  VALUES (@id, @employee_id, @leave_year, @entry_type, @days_delta, @balance_after,
          @effective_date, @leave_request_id, @description, @created_at, @created_by)
  ON CONFLICT DO NOTHING
`);

/**
 * Credits any months of service completed but not yet accrued.
 *
 * The target is computed CUMULATIVELY - entitlement * months / 12 - and the
 * difference posted. Adding 20/12 twelve times in floating point overshoots
 * 20; computing the cumulative target means month 12 lands on exactly 20.00.
 */
/**
 * Credits a completed holiday year with its full entitlement.
 *
 * The 12th month completes exactly ON the anniversary, which is also the moment
 * the year rolls over. Without this step nobody would ever reach 20 days: the
 * outgoing year would stop at 11 months and the 12th would fall into a new year
 * that starts from zero. So when a year has been fully served, it is topped up
 * to the full entitlement before the new one begins.
 */
async function finaliseYear(employeeId, yearsOfService, startDate, { actor = 'system' } = {}) {
  if (yearsOfService < 0) return { finalised: false };

  const yearStart = addMonths(startDate, yearsOfService * 12);
  const yearEnd = addMonths(startDate, (yearsOfService + 1) * 12);
  const leaveYear = `${yearStart}/${yearsOfService}`;

  const already = (await selectAccrued.get(employeeId, leaveYear)).days;
  const delta = ENTITLEMENT - already;
  if (delta < 0.005) return { finalised: false, upToDate: true };

  await insertLedger.run({
    id: 'lal_' + crypto.randomBytes(8).toString('hex'),
    employee_id: employeeId,
    leave_year: leaveYear,
    entry_type: 'ACCRUAL',
    days_delta: delta,
    balance_after: 0,
    // Dated the last day of the year it belongs to, not the anniversary, so it
    // cannot be mistaken for the new year's first accrual.
    effective_date: T.dateKey(T.startOfDay(yearEnd) - 1),
    leave_request_id: null,
    description: 'Final month of the holiday year, completing the full entitlement',
    created_at: T.now(),
    created_by: actor,
  });

  return { finalised: true, leaveYear, addedDays: delta };
}

async function accrue(employeeId, onDate = T.dateKey(), { actor = 'system' } = {}) {
  const year = await holidayYearFor(employeeId, onDate);
  if (year.blocked) return { accrued: false, ...year };

  // Close off any fully-served year before crediting the current one.
  if (year.yearsOfService > 0) {
    await finaliseYear(employeeId, year.yearsOfService - 1, year.startDate, { actor });
  }

  const already = (await selectAccrued.get(employeeId, year.leaveYear)).days;
  const target = (ENTITLEMENT * year.monthsCompleted) / 12;
  const delta = target - already;

  // Rounded to a hundredth of a day before comparing, so floating-point dust
  // does not post meaningless entries.
  if (Math.abs(delta) < 0.005) {
    return { accrued: false, upToDate: true, leaveYear: year.leaveYear, accruedDays: already };
  }

  const balance = await balanceRaw(employeeId, year);
  await insertLedger.run({
    id: 'lal_' + crypto.randomBytes(8).toString('hex'),
    employee_id: employeeId,
    leave_year: year.leaveYear,
    entry_type: 'ACCRUAL',
    days_delta: delta,
    balance_after: balance.availableDays + delta,
    effective_date: addMonths(year.yearStart, year.monthsCompleted),
    leave_request_id: null,
    description: `Accrual for ${year.monthsCompleted} month(s) of service in this holiday year`,
    created_at: T.now(),
    created_by: actor,
  });

  return {
    accrued: true, leaveYear: year.leaveYear,
    accruedDays: target, addedDays: delta,
    monthsCompleted: year.monthsCompleted,
  };
}

/** Runs accrual for every active employee. Called daily by the maintenance tick. */
async function accrueAll(onDate = T.dateKey()) {
  const employees = await db.prepare('SELECT id FROM employees WHERE active = 1').all();
  const results = { accrued: 0, upToDate: 0, blocked: [] };
  for (const e of employees) {
    const r = await accrue(e.id, onDate);
    if (r.accrued) results.accrued++;
    else if (r.upToDate) results.upToDate++;
    else results.blocked.push({ employeeId: e.id, reason: r.reason });
  }
  return results;
}

/**
 * Closes a holiday year, forfeiting anything unused.
 *
 * Confirmed: nothing carries over. The forfeit is posted as a ledger entry
 * rather than by resetting a number, so an employee can always see what was
 * lost and when.
 */
const selectCarryForwardRecord = db.prepare(`
  SELECT * FROM leave_carry_forward_records
  WHERE employee_id = ? AND from_leave_year = ?
`);

const upsertCarryForwardRecord = db.prepare(`
  INSERT INTO leave_carry_forward_records
    (id, employee_id, from_leave_year, to_leave_year, unused_days_at_close, approved_days,
     lapsed_days, decision, approved_by, approved_at, notes, applied_at, created_at)
  VALUES (@id, @employee_id, @from_leave_year, @to_leave_year, @unused_days_at_close, @approved_days,
          @lapsed_days, @decision, @approved_by, @approved_at, @notes, @applied_at, @created_at)
  ON CONFLICT (employee_id, from_leave_year) DO UPDATE SET
    approved_days = EXCLUDED.approved_days,
    lapsed_days = EXCLUDED.lapsed_days,
    decision = EXCLUDED.decision,
    approved_by = EXCLUDED.approved_by,
    approved_at = EXCLUDED.approved_at,
    notes = EXCLUDED.notes
`);

/**
 * Closes a holiday year, carrying forward approved days (max 5) and forfeiting remainder.
 */
async function closeHolidayYear(employeeId, leaveYear, unusedDays, onDate, { actor = 'system' } = {}) {
  if (unusedDays <= 0.005) return { forfeited: 0, carried: 0 };

  const cf = await selectCarryForwardRecord.get(employeeId, leaveYear);
  const approved = (cf && cf.decision === 'APPROVED')
    ? Math.min(cf.approved_days, Math.min(5, unusedDays))
    : (config.leave.carryOverDays > 0 ? Math.min(unusedDays, config.leave.carryOverDays) : 0);
  const lapsed = Math.max(0, unusedDays - approved);

  if (lapsed > 0.005) {
    await insertLedger.run({
      id: 'lal_' + crypto.randomBytes(8).toString('hex'),
      employee_id: employeeId,
      leave_year: leaveYear,
      entry_type: 'FORFEIT',
      days_delta: -lapsed,
      balance_after: approved,
      effective_date: onDate,
      leave_request_id: null,
      description: `${lapsed.toFixed(2)} day(s) unused at the end of the holiday year lapsed. ${approved > 0 ? `${approved.toFixed(2)} day(s) approved for carry forward.` : 'No carry-forward approved.'}`,
      created_at: T.now(),
      created_by: actor,
    });
  }

  await audit({
    actor, action: 'LEAVE_FORFEITED',
    targetType: 'employee', targetId: employeeId,
    after: { leaveYear, forfeitedDays: lapsed, approvedDays: approved },
  });

  return { forfeited: lapsed, carried: approved };
}

// ---------------------------------------------------------------------------
// Balances (spec 14)
// ---------------------------------------------------------------------------

const selectLedgerTotals = db.prepare(`
  SELECT entry_type, COALESCE(SUM(days_delta), 0) AS days
  FROM leave_accrual_ledger
  WHERE employee_id = ? AND leave_year = ?
  GROUP BY entry_type
`);

// Requests that consume entitlement, scoped to ONE holiday year.
const selectYearRequests = db.prepare(`
  SELECT r.id, r.start_date, r.end_date, r.total_days, r.status
  FROM leave_requests r
  JOIN leave_types t ON t.id = r.leave_type_id
  WHERE r.employee_id = ? AND t.reduces_entitlement = 1
    AND r.cancelled_at IS NULL
    AND r.status IN ('PENDING_MANAGER', 'PENDING_HR', 'APPROVED')
    AND r.start_date >= ? AND r.start_date < ?
    AND r.id != COALESCE(?, '')
`);

async function balanceRaw(employeeId, year, onDate = T.dateKey(), excludeRequestId = null) {
  const totals = {};
  for (const row of await selectLedgerTotals.all(employeeId, year.leaveYear)) {
    totals[row.entry_type] = row.days;
  }
  const carryOver = totals.CARRY_OVER || 0;
  const accrued = totals.ACCRUAL || 0;
  const adjustments = totals.ADJUSTMENT || 0;
  const forfeit = totals.FORFEIT || 0;
  // BOOKED and CANCELLED ledger entries are the audit trail of approvals; the
  // authoritative figure comes from the requests themselves, so counting both
  // would deduct every booking twice.
  const credited = accrued + carryOver + adjustments + forfeit;

  let taken = 0;
  let booked = 0;
  for (const r of await selectYearRequests.all(employeeId, year.yearStart, year.yearEnd, excludeRequestId)) {
    if (r.status === 'APPROVED' && r.end_date < onDate) taken += r.total_days;
    else booked += r.total_days;
  }

  // FIFO draw: leave is drawn against carry-forward first, then current cycle accrual
  const totalUsed = taken + booked;
  const carryOverUsed = Math.min(carryOver, totalUsed);
  const remainingCarryForward = Math.max(0, carryOver - totalUsed);
  const currentAccrualUsed = Math.max(0, totalUsed - carryOver);
  const remainingCurrentCycle = Math.max(0, (accrued + adjustments + forfeit) - currentAccrualUsed);

  return {
    accruedDays: accrued,
    carryOverDays: carryOver,
    adjustmentDays: adjustments,
    forfeitDays: forfeit,
    creditedDays: credited,
    takenDays: taken,
    bookedDays: booked,
    carryOverUsed,
    remainingCarryForwardDays: remainingCarryForward,
    remainingCurrentCycleDays: remainingCurrentCycle,
    availableDays: credited - taken - booked,
  };
}

/**
 * The employee leave dashboard figures with full 8-metric report.
 */
async function balanceFor(employeeId, onDate = T.dateKey(), excludeRequestId = null) {
  const year = await holidayYearFor(employeeId, onDate);
  if (year.blocked) return { blocked: true, ...year };

  // Always ensure accruals and rollovers are current
  try {
    if (year.yearsOfService > 0) {
      await rolloverHolidayYear(employeeId, onDate);
    }
    await accrue(employeeId, onDate);
  } catch (err) {
    console.error('Auto-accrual/rollover error in balanceFor:', err);
  }

  const raw = await balanceRaw(employeeId, year, onDate, excludeRequestId);
  const round2 = (n) => Math.round(n * 100) / 100;

  // Check carry-forward approval for this closing cycle
  const cf = await selectCarryForwardRecord.get(employeeId, year.leaveYear);
  const approvedCarryForwardForCycle = (cf && cf.decision === 'APPROVED') ? cf.approved_days : 0;

  // Leave due to expire: unused available leave minus any approved carry-forward (max 5)
  const leaveDueToExpire = round2(Math.max(0, raw.availableDays - approvedCarryForwardForCycle));

  // Historical lapsed/forfeited leave across all cycles for this employee
  const lapsedRow = await db.prepare(`
    SELECT COALESCE(SUM(ABS(days_delta)), 0) AS days
    FROM leave_accrual_ledger
    WHERE employee_id = ? AND entry_type = 'FORFEIT'
  `).get(employeeId);
  const leaveAlreadyLapsed = round2(lapsedRow?.days || 0);

  return {
    blocked: false,
    leaveYear: year.leaveYear,
    yearStart: year.yearStart,
    yearEnd: year.yearEnd,
    cycleStartDate: year.cycleStartDate,
    cycleEndDate: year.cycleEndDate,
    nextRenewalDate: year.nextRenewalDate,
    officialJoiningDate: year.startDate,
    monthsCompleted: year.monthsCompleted,
    nextAccrualDate: year.nextAccrualDate,

    // The 8 distinct metrics required by policy:
    annualEntitlementDays: ENTITLEMENT,
    accruedDays: round2(raw.accruedDays),
    takenDays: round2(raw.takenDays),
    approvedCarryForwardDays: round2(raw.carryOverDays),
    remainingCurrentCycleDays: round2(raw.remainingCurrentCycleDays),
    leaveDueToExpire,
    leaveAlreadyLapsed,

    // Additional convenient figures
    bookedDays: round2(raw.bookedDays),
    availableDays: round2(raw.availableDays),
    carryForwardDecision: cf ? {
      decision: cf.decision,
      approvedDays: cf.approved_days,
      lapsedDays: cf.lapsed_days,
      approvedBy: cf.approved_by,
      approvedAt: cf.approved_at,
      notes: cf.notes,
    } : null,

    // Kept unrounded for arithmetic that must not drift.
    precise: raw,
    isNegative: raw.availableDays < -0.005,
  };
}

// ---------------------------------------------------------------------------
// Counting leave days (spec 16)
// ---------------------------------------------------------------------------

/**
 * How many days a request actually costs.
 *
 * Rest days and paid office closures are skipped. Spec 16 is explicit that an
 * employee must not lose annual leave for a day the office is shut.
 */
async function countLeaveDays(employeeId, startDate, endDate, dayPortion = 'FULL_DAY') {
  const days = [];
  const skipped = [];
  let cursor = startDate;
  let guard = 0;

  while (cursor <= endDate && guard++ < 400) {
    const s = await schedule.resolve(employeeId, cursor);
    if (s.isWorkingDay) days.push(cursor);
    else skipped.push({ date: cursor, reason: s.nonWorkingReason });
    cursor = T.dateKey(T.endOfDay(cursor));
  }

  // A half day only makes sense for a single date.
  const multiplier = (dayPortion !== 'FULL_DAY' && days.length === 1) ? 0.5 : 1;

  return {
    totalDays: days.length * multiplier,
    workingDates: days,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Requests (spec 15)
// ---------------------------------------------------------------------------

const selectLeaveType = db.prepare('SELECT * FROM leave_types WHERE id = ? AND active = 1');

/**
 * The figures spec 15 says to show BEFORE submitting, so nobody discovers a
 * shortfall only after the request is in.
 */
async function previewRequest({
  employeeId, leaveTypeId, startDate, endDate, dayPortion = 'FULL_DAY',
  // Set when re-previewing a request that has already been submitted, so it is
  // not counted against its own balance.
  excludeRequestId = null,
}) {
  const type = await selectLeaveType.get(leaveTypeId);
  if (!type) return { ok: false, error: 'Unknown leave type.' };
  if (!startDate || !endDate || endDate < startDate) {
    return { ok: false, error: 'The end date must be on or after the start date.' };
  }

  const count = await countLeaveDays(employeeId, startDate, endDate, dayPortion);
  if (count.totalDays === 0) {
    return {
      ok: false,
      error: 'That range contains no working days.',
      skipped: count.skipped,
    };
  }

  const balance = await balanceFor(employeeId, startDate, excludeRequestId);
  if (balance.blocked) return { ok: false, error: balance.message, blocked: true };

  // Only types that reduce entitlement touch the balance. Sick and maternity
  // leave do not come out of someone's holiday.
  const affectsBalance = !!type.reduces_entitlement;
  const projected = affectsBalance
    ? balance.precise.availableDays - count.totalDays
    : balance.precise.availableDays;

  const shortfall = affectsBalance && projected < 0 ? Math.abs(projected) : 0;

  return {
    ok: true,
    leaveType: { id: type.id, name: type.name, reducesEntitlement: affectsBalance, requiresEvidence: !!type.requires_evidence },
    requestedDays: count.totalDays,
    workingDates: count.workingDates,
    skipped: count.skipped,
    balance,
    projectedAvailableDays: Math.round(projected * 100) / 100,
    // Confirmed policy: allowed, but HR has to knowingly approve it.
    exceedsBalance: shortfall > 0,
    shortfallDays: Math.round(shortfall * 100) / 100,
    requiresOverdraftApproval: shortfall > 0,
    warning: shortfall > 0
      ? `This request is ${shortfall.toFixed(2)} day(s) more than has been accrued. `
        + 'It can still be submitted, but HR must approve going beyond the entitlement.'
      : null,
  };
}

async function submitRequest({ employeeId, leaveTypeId, startDate, endDate, dayPortion = 'FULL_DAY', reason = null, evidenceDocumentId = null }) {
  const preview = await previewRequest({ employeeId, leaveTypeId, startDate, endDate, dayPortion });
  if (!preview.ok) throw new Error(preview.error);

  if (preview.leaveType.requiresEvidence && !evidenceDocumentId && !reason) {
    throw new Error(`${preview.leaveType.name} needs supporting evidence or an explanation.`);
  }

  const overlapping = await db.prepare(`
    SELECT id, start_date, end_date FROM leave_requests
    WHERE employee_id = ? AND cancelled_at IS NULL
      AND status IN ('PENDING_MANAGER','PENDING_HR','APPROVED')
      AND start_date <= ? AND end_date >= ?
  `).get(employeeId, endDate, startDate);
  if (overlapping) {
    throw new Error(`This overlaps an existing request for ${overlapping.start_date} to ${overlapping.end_date}.`);
  }

  const id = 'lr_' + crypto.randomBytes(8).toString('hex');
  const nowMs = T.now();

  await tx(async () => {
    await db.prepare(`
      INSERT INTO leave_requests
        (id, employee_id, leave_type_id, start_date, end_date, day_portion,
         total_days, reason, evidence_document_id, status, submitted_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?, 'PENDING_HR', ?, ?)
    `).run(id, employeeId, leaveTypeId, startDate, endDate, dayPortion,
           preview.requestedDays, reason, evidenceDocumentId, nowMs, nowMs);

    // Confirmed route: HR only, so there is exactly one step and a request is
    // never stuck waiting on a manager who is not set up as a user.
    await db.prepare(`
      INSERT INTO leave_approvals (id, request_id, step, approver_role, created_at)
      VALUES (?,?,1,'hr',?)
    `).run('la_' + crypto.randomBytes(8).toString('hex'), id, nowMs);

    await audit({
      actor: `employee:${employeeId}`, action: 'LEAVE_REQUESTED',
      targetType: 'leave_request', targetId: id,
      after: {
        type: leaveTypeId, startDate, endDate, days: preview.requestedDays,
        exceedsBalance: preview.exceedsBalance,
      },
    });
  });

  try {
    const emp = await db.prepare('SELECT name FROM employees WHERE id = ?').get(employeeId);
    const empName = emp?.name || employeeId;
    await N.notify({
      category: 'LEAVE',
      title: `Leave Request: ${empName}`,
      body: `${preview.requestedDays} day(s) requested for ${startDate} to ${endDate} (${preview.leaveType.name}).`,
      severity: preview.exceedsBalance ? 'warning' : 'info',
      link: `/leave?request=${id}`,
      nowMs,
    });
  } catch (_) {}

  return { id, ...preview, status: 'PENDING_HR' };
}

async function decideRequest({ requestId, decision, notes, actor, overdraftReason = null, nowMs = T.now() }) {
  if (!['APPROVED', 'REJECTED', 'INFO_REQUESTED'].includes(decision)) {
    throw new Error('decision must be APPROVED, REJECTED or INFO_REQUESTED.');
  }
  if (!notes || !String(notes).trim()) throw new Error('A note explaining the decision is required.');

  const req = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(requestId);
  if (!req) throw new Error('No such leave request.');
  if (req.status === 'APPROVED' || req.status === 'REJECTED') {
    throw new Error(`This request has already been ${req.status.toLowerCase()}.`);
  }
  if (req.cancelled_at) throw new Error('This request was cancelled.');

  const preview = await previewRequest({
    employeeId: req.employee_id, leaveTypeId: req.leave_type_id,
    startDate: req.start_date, endDate: req.end_date, dayPortion: req.day_portion,
    excludeRequestId: requestId,
  });

  if (decision === 'APPROVED' && preview.ok && preview.requiresOverdraftApproval) {
    // Confirmed: going beyond entitlement is allowed, but only knowingly. A
    // silent approval would let someone accrue a debt nobody agreed to.
    if (!overdraftReason || !String(overdraftReason).trim()) {
      throw new Error(
        `This request exceeds the accrued balance by ${preview.shortfallDays} day(s). ` +
        'Approving it requires an explicit reason for allowing the overdraft.',
      );
    }
  }

  await tx(async () => {
    await db.prepare(`
      UPDATE leave_requests SET status = ?, decided_at = ? WHERE id = ?
    `).run(decision === 'INFO_REQUESTED' ? 'PENDING_HR' : decision, nowMs, requestId);

    // approver_user_id is a foreign key into users. The actor string may be a
    // system or CLI identity with no user row, so it is stored only when it
    // genuinely resolves - the audit log records the actor either way.
    const actorUserId = String(actor || '').replace(/^user:/, '');
    const resolvedUser = actorUserId
      ? await db.prepare('SELECT id FROM users WHERE id = ?').get(actorUserId)
      : null;

    await db.prepare(`
      UPDATE leave_approvals SET decision = ?, decided_at = ?, notes = ?, approver_user_id = ?
      WHERE request_id = ? AND step = 1
    `).run(decision, nowMs, String(notes).trim(), resolvedUser ? resolvedUser.id : null, requestId);

    if (decision === 'APPROVED') {
      const year = await holidayYearFor(req.employee_id, req.start_date);
      const type = await selectLeaveType.get(req.leave_type_id);

      if (!year.blocked && type.reduces_entitlement) {
        const balance = await balanceRaw(req.employee_id, year);
        await insertLedger.run({
          id: 'lal_' + crypto.randomBytes(8).toString('hex'),
          employee_id: req.employee_id,
          leave_year: year.leaveYear,
          entry_type: 'BOOKED',
          days_delta: -req.total_days,
          balance_after: balance.availableDays - req.total_days,
          effective_date: req.start_date,
          leave_request_id: requestId,
          description: `${type.name}: ${req.start_date} to ${req.end_date}`,
          created_at: nowMs,
          created_by: actor,
        });
      }

      if (preview.ok && preview.requiresOverdraftApproval) {
        await db.prepare(`
          INSERT INTO leave_overdraft_approvals
            (id, request_id, employee_id, shortfall_days, approved_by, approved_at, reason)
          VALUES (?,?,?,?,?,?,?)
        `).run('lov_' + crypto.randomBytes(8).toString('hex'), requestId, req.employee_id,
               preview.shortfallDays, actor, nowMs, String(overdraftReason).trim());
      }
    }

    await audit({
      actor, action: 'LEAVE_DECIDED',
      targetType: 'leave_request', targetId: requestId,
      before: { status: req.status },
      after: { status: decision, overdraftApproved: !!overdraftReason },
      note: String(notes).trim(),
    });
  });

  try {
    const type = await selectLeaveType.get(req.leave_type_id);
    const typeName = type?.name || 'Leave';
    if (decision === 'APPROVED') {
      await N.notify({
        employeeId: req.employee_id,
        category: 'LEAVE',
        title: 'Leave Request Approved',
        body: `Your ${req.total_days} day(s) ${typeName} request from ${req.start_date} to ${req.end_date} has been approved.`,
        severity: 'info',
        link: '/leave',
        nowMs,
      });
    } else if (decision === 'REJECTED') {
      await N.notify({
        employeeId: req.employee_id,
        category: 'LEAVE',
        title: 'Leave Request Rejected',
        body: `Your ${typeName} request from ${req.start_date} to ${req.end_date} was rejected. Note: ${notes}`,
        severity: 'warning',
        link: '/leave',
        nowMs,
      });
    }
  } catch (_) {}

  return { decision, requestId };
}

async function cancelRequest({ requestId, actor, reason = null, nowMs = T.now() }) {
  const req = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(requestId);
  if (!req) throw new Error('No such leave request.');
  if (req.cancelled_at) return { alreadyCancelled: true };

  await tx(async () => {
    await db.prepare("UPDATE leave_requests SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?")
      .run(nowMs, requestId);

    // Spec 34: cancelled leave restores the balance. Posted as a reversal
    // rather than by deleting the booking, so the history stays intact.
    if (req.status === 'APPROVED') {
      const year = await holidayYearFor(req.employee_id, req.start_date);
      const type = await selectLeaveType.get(req.leave_type_id);
      if (!year.blocked && type.reduces_entitlement) {
        const balance = await balanceRaw(req.employee_id, year);
        await insertLedger.run({
          id: 'lal_' + crypto.randomBytes(8).toString('hex'),
          employee_id: req.employee_id,
          leave_year: year.leaveYear,
          entry_type: 'CANCELLED',
          days_delta: req.total_days,
          balance_after: balance.availableDays + req.total_days,
          effective_date: T.dateKey(nowMs),
          leave_request_id: requestId,
          description: `Cancelled: ${req.start_date} to ${req.end_date}`,
          created_at: nowMs,
          created_by: actor,
        });
      }
    }

    await audit({
      actor, action: 'LEAVE_CANCELLED',
      targetType: 'leave_request', targetId: requestId,
      before: { status: req.status }, note: reason,
    });
  });

  try {
    const emp = await db.prepare('SELECT name FROM employees WHERE id = ?').get(req.employee_id);
    const empName = emp?.name || req.employee_id;
    await N.notify({
      category: 'LEAVE',
      title: `Leave Request Cancelled: ${empName}`,
      body: `${empName} cancelled leave request for ${req.start_date} to ${req.end_date}.`,
      severity: 'info',
      link: '/leave',
      nowMs,
    });
  } catch (_) {}

  return { cancelled: true };
}

/** An explicit HR adjustment to someone's entitlement. Always attributed. */
async function adjustBalance({ employeeId, days, reason, actor, onDate = T.dateKey() }) {
  if (!reason || !String(reason).trim()) throw new Error('An adjustment needs a reason.');
  const year = await holidayYearFor(employeeId, onDate);
  if (year.blocked) throw new Error(year.message);

  const balance = await balanceRaw(employeeId, year);
  await insertLedger.run({
    id: 'lal_' + crypto.randomBytes(8).toString('hex'),
    employee_id: employeeId,
    leave_year: year.leaveYear,
    entry_type: 'ADJUSTMENT',
    days_delta: days,
    balance_after: balance.availableDays + days,
    effective_date: onDate,
    leave_request_id: null,
    description: String(reason).trim(),
    created_at: T.now(),
    created_by: actor,
  });

  await audit({
    actor, action: 'LEAVE_ADJUSTED',
    targetType: 'employee', targetId: employeeId,
    after: { days }, note: String(reason).trim(),
  });

  return await balanceFor(employeeId, onDate);
}

// ---------------------------------------------------------------------------
// Carry Forward & Anniversary Rollover Management
// ---------------------------------------------------------------------------

/**
 * HR/Management records an approval or rejection for carrying forward up to 5 days
 * of unused annual leave into the next leave cycle.
 */
async function recordCarryForwardApproval({ employeeId, approvedDays, notes = '', actor, onDate, today }) {
  const effectiveDate = today || onDate || T.dateKey();
  const numDays = Number(approvedDays);
  if (isNaN(numDays) || numDays < 0) {
    throw new Error('Approved carry-forward days must be a non-negative number.');
  }
  if (numDays > 5) {
    throw new Error('Maximum allowable carry-forward is 5 days.');
  }

  const year = await holidayYearFor(employeeId, effectiveDate);
  if (year.blocked) throw new Error(year.message);

  const raw = await balanceRaw(employeeId, year, effectiveDate);
  const available = Math.max(0, raw.availableDays);
  if (numDays > available) {
    throw new Error(`Cannot approve ${numDays} days: employee only has ${available.toFixed(2)} days available.`);
  }

  const fromLeaveYear = year.leaveYear;
  const nextServiceYear = year.yearsOfService + 1;
  const toLeaveYear = `${year.yearEnd}/${nextServiceYear}`;
  const lapsed = Math.max(0, available - numDays);
  const decision = numDays > 0 ? 'APPROVED' : 'REJECTED';
  const nowMs = T.now();

  const recordId = 'lcf_' + crypto.randomBytes(8).toString('hex');

  await upsertCarryForwardRecord.run({
    id: recordId,
    employee_id: employeeId,
    from_leave_year: fromLeaveYear,
    to_leave_year: toLeaveYear,
    unused_days_at_close: available,
    approved_days: numDays,
    lapsed_days: lapsed,
    decision,
    approved_by: actor,
    approved_at: nowMs,
    notes: String(notes || '').trim(),
    applied_at: null,
    created_at: nowMs,
  });

  await audit({
    actor,
    action: 'LEAVE_CARRY_FORWARD_DECIDED',
    targetType: 'employee',
    targetId: employeeId,
    after: { fromLeaveYear, toLeaveYear, approvedDays: numDays, decision, notes },
  });

  return await selectCarryForwardRecord.get(employeeId, fromLeaveYear);
}

/**
 * Executes work anniversary rollover for an employee:
 * - Credits full 20 days final accrual for the outgoing year.
 * - Applies approved carry-forward (max 5 days) as CARRY_OVER in the new cycle ledger.
 * - Forfeits any remaining unused days with a FORFEIT entry in the outgoing cycle ledger.
 * - If no approval was recorded, all remaining unused days forfeit per policy.
 */
async function rolloverHolidayYear(employeeId, onDate = T.dateKey(), { actor = 'system' } = {}) {
  const row = await selectStartDate.get(employeeId);
  if (!row || !row.start_date) return { rolledOver: false, reason: 'NO_START_DATE' };

  const startDate = row.start_date;
  if (onDate < startDate) return { rolledOver: false, reason: 'NOT_STARTED' };

  let yearsOfService = 0;
  while (addMonths(startDate, (yearsOfService + 1) * 12) <= onDate) yearsOfService++;

  if (yearsOfService <= 0) return { rolledOver: false, upToDate: true };

  const results = [];

  for (let y = 0; y < yearsOfService; y++) {
    const yearStart = addMonths(startDate, y * 12);
    const yearEnd = addMonths(startDate, (y + 1) * 12);
    const leaveYear = `${yearStart}/${y}`;
    const nextLeaveYear = `${yearEnd}/${y + 1}`;

    // 1. Ensure full 20 days final accrual for this fully-served outgoing year
    await finaliseYear(employeeId, y, startDate, { actor });

    // 2. Check if this cycle has already been rolled over
    const alreadyForfeit = await db.prepare(
      "SELECT 1 FROM leave_accrual_ledger WHERE employee_id = ? AND leave_year = ? AND entry_type = 'FORFEIT'"
    ).get(employeeId, leaveYear);
    const alreadyCarried = await db.prepare(
      "SELECT 1 FROM leave_accrual_ledger WHERE employee_id = ? AND leave_year = ? AND entry_type = 'CARRY_OVER'"
    ).get(employeeId, nextLeaveYear);

    if (alreadyForfeit || alreadyCarried) {
      continue;
    }

    // 3. Compute unused days in this outgoing cycle
    const totals = {};
    for (const r of await selectLedgerTotals.all(employeeId, leaveYear)) {
      totals[r.entry_type] = r.days;
    }
    const credited = (totals.ACCRUAL || 0) + (totals.CARRY_OVER || 0) + (totals.ADJUSTMENT || 0) + (totals.FORFEIT || 0);

    let taken = 0;
    for (const req of await selectYearRequests.all(employeeId, yearStart, yearEnd, null)) {
      if (req.status === 'APPROVED') taken += req.total_days;
    }

    const unusedDays = Math.max(0, credited - taken);

    // 4. Look up carry-forward approval for this cycle
    const cf = await selectCarryForwardRecord.get(employeeId, leaveYear);
    let approvedDays = 0;
    if (cf && cf.decision === 'APPROVED') {
      approvedDays = Math.min(cf.approved_days, Math.min(5, unusedDays));
    }
    const lapsedDays = Math.max(0, unusedDays - approvedDays);
    const nowMs = T.now();

    // 5. Post FORFEIT for lapsed days in outgoing year
    if (lapsedDays > 0.005) {
      await insertLedger.run({
        id: 'lal_' + crypto.randomBytes(8).toString('hex'),
        employee_id: employeeId,
        leave_year: leaveYear,
        entry_type: 'FORFEIT',
        days_delta: -lapsedDays,
        balance_after: approvedDays,
        effective_date: T.dateKey(T.startOfDay(yearEnd) - 1),
        leave_request_id: null,
        description: `${lapsedDays.toFixed(2)} day(s) unused at end of cycle lapsed. ${approvedDays > 0 ? `${approvedDays.toFixed(2)} day(s) carried forward.` : 'No carry-forward approved.'}`,
        created_at: nowMs,
        created_by: actor,
      });
    }

    // 6. Post CARRY_OVER for approved days in new year
    if (approvedDays > 0.005) {
      await insertLedger.run({
        id: 'lal_' + crypto.randomBytes(8).toString('hex'),
        employee_id: employeeId,
        leave_year: nextLeaveYear,
        entry_type: 'CARRY_OVER',
        days_delta: approvedDays,
        balance_after: approvedDays,
        effective_date: yearEnd,
        leave_request_id: null,
        description: `Approved carry forward from cycle ${leaveYear}. Approved by ${cf?.approved_by || actor}.`,
        created_at: nowMs,
        created_by: actor,
      });
    }

    // 7. Update carry-forward record
    if (cf) {
      await db.prepare(`
        UPDATE leave_carry_forward_records
        SET applied_at = ?, unused_days_at_close = ?, approved_days = ?, lapsed_days = ?
        WHERE id = ?
      `).run(nowMs, unusedDays, approvedDays, lapsedDays, cf.id);
    } else {
      await upsertCarryForwardRecord.run({
        id: 'lcf_' + crypto.randomBytes(8).toString('hex'),
        employee_id: employeeId,
        from_leave_year: leaveYear,
        to_leave_year: nextLeaveYear,
        unused_days_at_close: unusedDays,
        approved_days: 0,
        lapsed_days: lapsedDays,
        decision: 'NO_REQUEST_LAPSED',
        approved_by: 'system',
        approved_at: nowMs,
        notes: 'No carry-forward approved before cycle end; unused leave lapsed in accordance with policy.',
        applied_at: nowMs,
        created_at: nowMs,
      });
    }

    await audit({
      actor,
      action: 'LEAVE_CYCLE_ROLLED_OVER',
      targetType: 'employee',
      targetId: employeeId,
      after: { fromLeaveYear: leaveYear, toLeaveYear: nextLeaveYear, approvedDays, lapsedDays },
    });

    results.push({ leaveYear, nextLeaveYear, approvedDays, lapsedDays });
  }

  const carriedOverDays = results.reduce((acc, c) => acc + c.approvedDays, 0);
  const forfeitedDays = results.reduce((acc, c) => acc + c.lapsedDays, 0);

  return { rolledOver: true, carriedOverDays, forfeitedDays, cycles: results };
}

/** Runs anniversary rollover and 14-day cycle end notifications for all active employees. */
async function checkAndRolloverAll(onDate = T.dateKey()) {
  const employees = await db.prepare('SELECT id, name FROM employees WHERE active = 1').all();
  let rolledOverCount = 0;
  let notifiedCount = 0;
  const nowMs = T.now();

  for (const e of employees) {
    try {
      const r = await rolloverHolidayYear(e.id, onDate);
      if (r.rolledOver && r.cycles && r.cycles.length > 0) rolledOverCount++;
    } catch (err) {
      console.error(`[leave] Rollover error for ${e.id}:`, err.message);
    }

    // 14-day pre-anniversary advisory notification
    try {
      const year = await holidayYearFor(e.id, onDate);
      if (!year.blocked) {
        const daysLeft = daysBetween(onDate, year.nextRenewalDate);
        if (daysLeft === 14) {
          const notifKey = `leave_renew_14d_${e.id}_${year.nextRenewalDate}`;
          const already = await db.prepare(`
            SELECT id FROM notifications
            WHERE employee_id = ? AND link = ?
          `).get(e.id, notifKey);

          if (!already) {
            const bal = await balanceFor(e.id, onDate);
            const cf = await selectCarryForwardRecord.get(e.id, year.leaveYear);
            const carryInfo = (cf && cf.decision === 'APPROVED')
              ? `${cf.approved_days} day(s) approved by management to carry forward.`
              : 'No carry-forward has been approved yet (up to 5 days permitted, subject to Management approval).';

            await N.notify({
              employeeId: e.id,
              category: 'LEAVE',
              title: 'Annual Leave Cycle Ending Soon',
              body: `Your leave cycle renews on ${year.nextRenewalDate} (in 14 days). You have ${bal.availableDays.toFixed(1)} day(s) remaining. ${carryInfo} Any unapproved leave will lapse on your work anniversary.`,
              severity: 'info',
              link: notifKey,
              nowMs,
            });
            notifiedCount++;
          }
        }
      }
    } catch (err) {
      console.error(`[leave] Notification error for ${e.id}:`, err.message);
    }
  }

  return { rolledOverCount, notifiedCount };
}

/**
 * Returns previous completed leave cycles and current cycle for an employee.
 * Essential for HR / audit purposes.
 */
async function historicalCyclesFor(employeeId, asOfDate = T.dateKey()) {
  const row = await selectStartDate.get(employeeId);
  if (!row || !row.start_date) return [];

  const startDate = row.start_date;
  const onDate = asOfDate;

  let yearsOfService = 0;
  while (addMonths(startDate, (yearsOfService + 1) * 12) <= onDate) yearsOfService++;

  const cycles = [];
  for (let y = 0; y <= yearsOfService; y++) {
    const yearStart = addMonths(startDate, y * 12);
    const yearEnd = addMonths(startDate, (y + 1) * 12);
    const cycleEndDate = T.dateKey(T.startOfDay(yearEnd) - 1);
    const leaveYear = `${yearStart}/${y}`;
    const isCurrent = (y === yearsOfService);
    const status = isCurrent ? 'ACTIVE' : 'COMPLETED';

    const totals = {};
    for (const r of await selectLedgerTotals.all(employeeId, leaveYear)) {
      totals[r.entry_type] = r.days;
    }

    let taken = 0;
    for (const req of await selectYearRequests.all(employeeId, yearStart, yearEnd, null)) {
      if (req.status === 'APPROVED') taken += req.total_days;
    }

    const carryForwardRec = await selectCarryForwardRecord.get(employeeId, leaveYear);
    const cfData = carryForwardRec ? {
      decision: carryForwardRec.decision,
      approvedDays: carryForwardRec.approved_days,
      lapsedDays: carryForwardRec.lapsed_days,
      approvedBy: carryForwardRec.approved_by,
      approvedAt: carryForwardRec.approved_at ? T.displayTime(carryForwardRec.approved_at) : null,
      notes: carryForwardRec.notes,
      applied: !!carryForwardRec.applied_at,
    } : null;

    cycles.push({
      leaveYear,
      cycleNumber: y + 1,
      isCurrent,
      status,
      cycleStartDate: yearStart,
      cycleEndDate,
      nextRenewalDate: yearEnd,
      annualEntitlement: ENTITLEMENT,
      accrued: Math.round((totals.ACCRUAL || 0) * 100) / 100,
      carriedForwardIn: Math.round((totals.CARRY_OVER || 0) * 100) / 100,
      adjustments: Math.round((totals.ADJUSTMENT || 0) * 100) / 100,
      taken: Math.round(taken * 100) / 100,
      lapsed: Math.round(Math.abs(totals.FORFEIT || 0) * 100) / 100,
      available: isCurrent ? (await balanceFor(employeeId, onDate)).availableDays : 0,
      carryForwardDecision: cfData,
      carryForwardRecord: cfData,
    });
  }

  return cycles.reverse();
}

/** Lists active employees within 30 days of cycle end with unused leave. */
async function employeesApproachingAnniversary(today = T.dateKey()) {
  const employees = await db.prepare('SELECT id, name, role, employee_number FROM employees WHERE active = 1').all();
  const list = [];
  for (const e of employees) {
    const year = await holidayYearFor(e.id, today);
    if (year.blocked) continue;
    const daysLeft = daysBetween(today, year.nextRenewalDate);
    if (daysLeft >= 0 && daysLeft <= 30) {
      const bal = await balanceFor(e.id, today);
      const cf = await selectCarryForwardRecord.get(e.id, year.leaveYear);
      list.push({
        employeeId: e.id,
        employeeName: e.name,
        employeeNumber: e.employee_number || null,
        role: e.role,
        cycleStartDate: year.cycleStartDate,
        cycleEndDate: year.cycleEndDate,
        nextRenewalDate: year.nextRenewalDate,
        daysUntilRenewal: daysLeft,
        availableDays: bal.availableDays,
        accruedDays: bal.accruedDays,
        takenDays: bal.takenDays,
        carryForwardRecord: cf ? {
          approvedDays: cf.approved_days,
          decision: cf.decision,
          approvedBy: cf.approved_by,
          approvedAt: cf.approved_at ? T.displayTime(cf.approved_at) : null,
          notes: cf.notes,
        } : null,
      });
    }
  }
  list.sort((a, b) => a.daysUntilRenewal - b.daysUntilRenewal);
  return list;
}

/**
 * Generates an employee's Monthly Leave Entitlement Statement/Report.
 * Includes:
 * 1. Total annual leave entitlement
 * 2. Leave already taken (cycle total)
 * 3. Paid leave used (cycle total and statement month breakdown)
 * 4. Unpaid leave taken (cycle total and statement month breakdown)
 * 5. Remaining leave balance (annual)
 * 6. Leave accrued/earned up to that month
 * 7. How much paid leave the employee is currently entitled to take
 * 8. Whether the employee has sufficient accrued entitlement for any requested leave
 * 9. Any leave adjustments made during that month
 * Plus plain-English explanation banner and available months in current cycle.
 */
async function monthlyReportFor(employeeId, { monthKey = null, asOfDate = T.dateKey() } = {}) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // 1. Get holiday anniversary cycle
  const year = await holidayYearFor(employeeId, asOfDate);
  if (year.blocked) {
    return { blocked: true, reason: year.reason, message: year.message };
  }

  // Ensure accruals and rollovers are up to date
  try {
    if (year.yearsOfService > 0) await rolloverHolidayYear(employeeId, asOfDate);
    await accrue(employeeId, asOfDate);
  } catch (_) {}

  // 2. Determine target statement month
  const currentMonthKey = asOfDate.slice(0, 7); // e.g. "2026-09"
  const targetMonthKey = (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) ? monthKey : currentMonthKey;
  const [yearNum, monthNum] = targetMonthKey.split('-').map(Number);

  const monthStart = `${targetMonthKey}-01`;
  const lastDay = new Date(Date.UTC(yearNum, monthNum, 0)).getUTCDate();
  const monthEnd = `${targetMonthKey}-${String(lastDay).padStart(2, '0')}`;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const monthName = `${monthNames[monthNum - 1]} ${yearNum}`;

  // 3. Build available months list in this cycle
  const availableMonths = [];
  const cycleStartMonth = year.cycleStartDate.slice(0, 7);
  let curY = Number(cycleStartMonth.slice(0, 4));
  let curM = Number(cycleStartMonth.slice(5, 7));
  const endY = Number(currentMonthKey.slice(0, 4));
  const endM = Number(currentMonthKey.slice(5, 7));

  while (curY < endY || (curY === endY && curM <= endM)) {
    const mKey = `${curY}-${String(curM).padStart(2, '0')}`;
    availableMonths.push({
      monthKey: mKey,
      label: `${monthNames[curM - 1]} ${curY}`,
      isCurrent: mKey === currentMonthKey,
      isSelected: mKey === targetMonthKey,
    });
    curM++;
    if (curM > 12) {
      curM = 1;
      curY++;
    }
  }
  availableMonths.reverse(); // Most recent first

  // 4. Ledger totals for current cycle
  const totals = {};
  for (const r of await selectLedgerTotals.all(employeeId, year.leaveYear)) {
    totals[r.entry_type] = r.days;
  }
  const accrued = totals.ACCRUAL || 0;
  const carryOver = totals.CARRY_OVER || 0;
  const adjustments = totals.ADJUSTMENT || 0;
  const forfeit = totals.FORFEIT || 0;

  // 5. Query all requests in cycle
  const requests = await db.prepare(`
    SELECT r.id, r.leave_type_id, r.start_date, r.end_date, r.total_days, r.status,
           t.name AS type_name, t.is_paid, t.reduces_entitlement
    FROM leave_requests r
    JOIN leave_types t ON t.id = r.leave_type_id
    WHERE r.employee_id = ?
      AND r.cancelled_at IS NULL
      AND r.start_date >= ? AND r.start_date < ?
    ORDER BY r.start_date ASC
  `).all(employeeId, year.yearStart, year.yearEnd);

  let annualLeaveTaken = 0;
  let annualLeaveBooked = 0;
  let cyclePaidLeaveUsed = 0;
  let cycleUnpaidLeaveTaken = 0;
  let monthPaidLeaveUsed = 0;
  let monthUnpaidLeaveTaken = 0;

  for (const req of requests) {
    if (req.status !== 'APPROVED') continue;
    const isPast = req.end_date < asOfDate;
    const days = Number(req.total_days) || 0;

    // Annual leave tracking
    if (req.reduces_entitlement) {
      if (isPast) annualLeaveTaken += days;
      else annualLeaveBooked += days;
    }

    // Paid vs Unpaid breakdown for the cycle
    if (req.is_paid) {
      if (isPast) cyclePaidLeaveUsed += days;
    } else {
      if (isPast) cycleUnpaidLeaveTaken += days;
    }

    // Overlap with statement month
    if (req.end_date >= monthStart && req.start_date <= monthEnd) {
      // Calculate overlapping fraction
      const s = req.start_date > monthStart ? req.start_date : monthStart;
      const e = req.end_date < monthEnd ? req.end_date : monthEnd;
      const totalSpan = Math.max(1, (new Date(req.end_date) - new Date(req.start_date)) / 86400000 + 1);
      const overlapSpan = Math.max(1, (new Date(e) - new Date(s)) / 86400000 + 1);
      const monthDays = round2(days * (overlapSpan / totalSpan));

      if (req.is_paid) monthPaidLeaveUsed += monthDays;
      else monthUnpaidLeaveTaken += monthDays;
    }
  }

  // 6. Entitlements & Balances
  // Remaining annual balance: annual entitlement + carry forward + adjustments - annual taken - annual booked
  const remainingAnnual = round2(ENTITLEMENT + carryOver + adjustments + forfeit - annualLeaveTaken - annualLeaveBooked);
  // Currently entitled to take right now without overdraft: accrued to date + carry forward + adjustments - annual taken - annual booked
  const currentlyEntitled = round2(Math.max(0, accrued + carryOver + adjustments + forfeit - annualLeaveTaken - annualLeaveBooked));

  // 7. Adjustments made during the statement month
  const monthAdjustmentsRows = await db.prepare(`
    SELECT id, effective_date, days_delta, description, created_at, created_by
    FROM leave_accrual_ledger
    WHERE employee_id = ? AND entry_type = 'ADJUSTMENT'
      AND effective_date >= ? AND effective_date <= ?
    ORDER BY effective_date DESC, created_at DESC
  `).all(employeeId, monthStart, monthEnd);

  const adjustmentsList = monthAdjustmentsRows.map(a => ({
    id: a.id,
    date: a.effective_date,
    days: round2(a.days_delta),
    description: a.description || 'Adjustment',
    createdBy: a.created_by,
  }));
  const totalMonthAdjustments = round2(adjustmentsList.reduce((acc, a) => acc + a.days, 0));

  // 8. Sufficiency of accrued entitlement for pending / requested leave
  const pendingRequests = await db.prepare(`
    SELECT r.id, r.start_date, r.end_date, r.total_days, r.status, t.name AS type_name
    FROM leave_requests r
    JOIN leave_types t ON t.id = r.leave_type_id
    WHERE r.employee_id = ?
      AND r.cancelled_at IS NULL
      AND r.status IN ('PENDING_MANAGER', 'PENDING_HR')
      AND t.reduces_entitlement = 1
    ORDER BY r.start_date ASC
  `).all(employeeId);

  const pendingTotalDays = round2(pendingRequests.reduce((acc, p) => acc + (Number(p.total_days) || 0), 0));
  const hasRequestedLeave = pendingRequests.length > 0;

  let sufficiencyStatus = 'SUFFICIENT';
  let shortfallDays = 0;
  let sufficiencyMessage = '';

  if (!hasRequestedLeave) {
    sufficiencyMessage = `No pending leave requests. You currently have ${currentlyEntitled} day(s) of accrued paid leave available for future requests.`;
  } else if (pendingTotalDays <= currentlyEntitled) {
    sufficiencyStatus = 'SUFFICIENT';
    sufficiencyMessage = `You have sufficient accrued entitlement for your requested leave (${pendingTotalDays} day(s) requested vs ${currentlyEntitled} day(s) accrued and available).`;
  } else {
    shortfallDays = round2(pendingTotalDays - currentlyEntitled);
    sufficiencyStatus = 'INSUFFICIENT';
    sufficiencyMessage = `Requested leave (${pendingTotalDays} day(s)) exceeds your currently accrued leave (${currentlyEntitled} day(s)) by ${shortfallDays} day(s). HR advance/overdraft approval will be required.`;
  }

  // 9. Plain-English statement synthesis
  let summaryExplanation = '';
  if (currentlyEntitled >= remainingAnnual && remainingAnnual > 0) {
    summaryExplanation = `You currently have ${currentlyEntitled} days of paid leave available.`;
  } else if (currentlyEntitled < remainingAnnual && currentlyEntitled > 0) {
    summaryExplanation = `You have ${remainingAnnual} days remaining annually, but only ${currentlyEntitled} days have accrued and are currently available to take.`;
  } else if (currentlyEntitled <= 0 && remainingAnnual > 0) {
    summaryExplanation = `You have ${remainingAnnual} days remaining annually, but have used all leave accrued to date (0 days currently available to take without an advance/overdraft).`;
  } else {
    summaryExplanation = `You currently have 0 days of paid leave available (overdraft balance).`;
  }

  return {
    blocked: false,
    employeeId,
    monthKey: targetMonthKey,
    monthName,
    monthStart,
    monthEnd,
    asOfDate,
    cycleStartDate: year.cycleStartDate,
    cycleEndDate: year.cycleEndDate,
    nextRenewalDate: year.nextRenewalDate,
    officialJoiningDate: year.startDate,
    availableMonths,

    // Plain-English explanation
    summaryExplanation,

    // The Required Metrics
    annualEntitlementDays: ENTITLEMENT,
    leaveAlreadyTaken: round2(annualLeaveTaken),
    paidLeaveUsed: {
      cycleTotal: round2(cyclePaidLeaveUsed),
      thisMonth: round2(monthPaidLeaveUsed),
    },
    unpaidLeaveTaken: {
      cycleTotal: round2(cycleUnpaidLeaveTaken),
      thisMonth: round2(monthUnpaidLeaveTaken),
    },
    remainingAnnualLeave: round2(remainingAnnual),
    accruedUpToMonth: round2(accrued),
    currentlyEntitledPaidLeave: round2(currentlyEntitled),
    approvedCarryForwardDays: round2(carryOver),

    // Requested leave sufficiency analysis
    requestedLeaveSufficiency: {
      hasRequestedLeave,
      pendingDays: pendingTotalDays,
      status: sufficiencyStatus,
      shortfallDays,
      message: sufficiencyMessage,
      pendingRequests: pendingRequests.map(p => ({
        id: p.id,
        startDate: p.start_date,
        endDate: p.end_date,
        days: Number(p.total_days),
        typeName: p.type_name,
      })),
    },

    // Month adjustments
    monthAdjustments: {
      totalDays: totalMonthAdjustments,
      count: adjustmentsList.length,
      items: adjustmentsList,
    },
  };
}

module.exports = {
  holidayYearFor, addMonths, daysBetween,
  accrue, accrueAll, finaliseYear, closeHolidayYear,
  balanceFor, countLeaveDays,
  previewRequest, submitRequest, decideRequest, cancelRequest, adjustBalance,
  recordCarryForwardApproval, rolloverHolidayYear, checkAndRolloverAll,
  historicalCyclesFor, employeesApproachingAnniversary,
  monthlyReportFor,
  ENTITLEMENT,
};

