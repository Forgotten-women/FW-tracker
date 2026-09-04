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

  return {
    blocked: false,
    startDate,
    yearsOfService,
    // A stable key for the ledger, e.g. "2026-03-15/1" for the second year.
    leaveYear: `${yearStart}/${yearsOfService}`,
    yearStart,
    yearEnd,
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
async function closeHolidayYear(employeeId, leaveYear, unusedDays, onDate, { actor = 'system' } = {}) {
  if (unusedDays <= 0.005) return { forfeited: 0 };
  if (config.leave.carryOverDays > 0) {
    const carried = Math.min(unusedDays, config.leave.carryOverDays);
    // Not reachable under the confirmed policy, but the branch exists so
    // turning carry-over on later is a config change rather than a rewrite.
    return { carried, forfeited: unusedDays - carried };
  }

  await insertLedger.run({
    id: 'lal_' + crypto.randomBytes(8).toString('hex'),
    employee_id: employeeId,
    leave_year: leaveYear,
    entry_type: 'FORFEIT',
    days_delta: -unusedDays,
    balance_after: 0,
    effective_date: onDate,
    leave_request_id: null,
    description: `${unusedDays.toFixed(2)} day(s) unused at the end of the holiday year. Nothing carries over.`,
    created_at: T.now(),
    created_by: actor,
  });

  await audit({
    actor, action: 'LEAVE_FORFEITED',
    targetType: 'employee', targetId: employeeId,
    after: { leaveYear, forfeitedDays: unusedDays },
  });

  return { forfeited: unusedDays };
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
//
// Scoping matters: without the year bounds, leave approved in a previous year
// would keep being subtracted from the current year's balance, and under an
// anniversary-based year every employee has different bounds.
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
  // BOOKED and CANCELLED ledger entries are the audit trail of approvals; the
  // authoritative figure comes from the requests themselves, so counting both
  // would deduct every booking twice.
  const credited = (totals.ACCRUAL || 0) + (totals.ADJUSTMENT || 0) + (totals.FORFEIT || 0);

  let taken = 0;
  let booked = 0;
  for (const r of await selectYearRequests.all(employeeId, year.yearStart, year.yearEnd, excludeRequestId)) {
    // Already used versus still to come. Both reduce what is available; the
    // split only exists because spec 14 asks the dashboard to show them apart.
    if (r.status === 'APPROVED' && r.end_date < onDate) taken += r.total_days;
    else booked += r.total_days;
  }

  return {
    accruedDays: credited,
    takenDays: taken,
    bookedDays: booked,
    availableDays: credited - taken - booked,
  };
}

/**
 * The employee leave dashboard figures from spec 14.
 *
 * Full precision is kept internally and rounded only for display, so twelve
 * monthly accruals sum to exactly 20.00 rather than 19.99.
 */
async function balanceFor(employeeId, onDate = T.dateKey(), excludeRequestId = null) {
  const year = await holidayYearFor(employeeId, onDate);
  if (year.blocked) return { blocked: true, ...year };

  // Always ensure accruals are current for completed months of service before calculating balance
  try {
    await accrue(employeeId, onDate);
  } catch (err) {
    console.error('Auto-accrual error in balanceFor:', err);
  }

  const raw = await balanceRaw(employeeId, year, onDate, excludeRequestId);
  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    blocked: false,
    leaveYear: year.leaveYear,
    yearStart: year.yearStart,
    yearEnd: year.yearEnd,
    monthsCompleted: year.monthsCompleted,
    nextAccrualDate: year.nextAccrualDate,

    annualEntitlementDays: ENTITLEMENT,
    accruedDays: round2(raw.accruedDays),
    takenDays: round2(raw.takenDays),
    bookedDays: round2(raw.bookedDays),
    availableDays: round2(raw.availableDays),

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

module.exports = {
  holidayYearFor, addMonths, daysBetween,
  accrue, accrueAll, finaliseYear, closeHolidayYear,
  balanceFor, countLeaveDays,
  previewRequest, submitRequest, decideRequest, cancelRequest, adjustBalance,
  ENTITLEMENT,
};
