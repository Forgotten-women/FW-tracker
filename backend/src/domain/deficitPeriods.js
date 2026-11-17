// Monthly deficit settlement and the separate deficit penalty.
// "Office App - Update Requirements" (HR, 2026-11-12), sections 9-16, 19 and 36.
//
// The lifetime ledger (attendance_deficit_ledger) stays the source of truth
// for how much deficit exists. This module reads it per calendar month and
// adds two HR decisions on top, both recorded once and never derived:
//
//   settlement  how many of the period's completed 8-hour deficit days are
//               covered by paid annual leave, treated as unpaid (whole days,
//               plus hours/minutes if HR wishes) or carried forward. Posted to
//               the ledger as a SETTLEMENT entry so the lifetime balance
//               agrees with the card.
//   penalty     none / option 1 (1 annual leave day + 1 day's pay) /
//               option 2 (2 annual leave days, no pay). One per period, never
//               multiplied by the number of deficit days.
//
// Period arithmetic, in the order HR reads it:
//   previous period deficit  what the last period carried forward
//   + new deficit this period (daily postings, less HR credits)
//   = total deficit
//   = completed 8-hour deficit days + remaining hours/minutes (never rounded up)
//   - settled this period
//   = carried forward to the next period
//
// Period views start from PERIODS_FROM (November 2026): each employee's ledger
// balance at the end of October 2026 is the opening "previous period" figure.
// Nothing is stored for a period until HR settles it; every figure is
// recomputed from the ledger and the settlement rows, so a later correction to
// an earlier day shows up honestly in the totals rather than being hidden.

const crypto = require('crypto');
const { db, tx, audit } = require('../db');
const T = require('../util/time');
const A = require('./attendance');

const DAY = A.DEFICIT_DAY_MINUTES;
const PERIODS_FROM = process.env.DEFICIT_PERIODS_FROM || '2026-11';
const PENALTY_OPTIONS = {
  NONE: { alDays: 0, payDays: 0, label: 'No penalty' },
  OPTION_1: { alDays: 1, payDays: 1, label: '1 annual leave day + 1 day pay deduction' },
  OPTION_2: { alDays: 2, payDays: 0, label: '2 annual leave days, no pay deduction' },
};

class DeficitError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Period keys
// ---------------------------------------------------------------------------

function isPeriodKey(k) { return /^\d{4}-\d{2}$/.test(String(k || '')); }
function periodOf(dateKey) { return String(dateKey).slice(0, 7); }
function periodBounds(key) {
  const [y, m] = key.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${key}-01`, end: `${key}-${String(last).padStart(2, '0')}` };
}
function nextPeriod(key) {
  const [y, m] = key.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
function prevPeriod(key) {
  const [y, m] = key.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
function periodLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function split(minutes) {
  const m = Math.max(0, Math.round(minutes));
  return { minutes: m, days: Math.floor(m / DAY), remainingMinutes: m % DAY, formatted: T.formatMinutes(m) };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const selectEntriesSince = db.prepare(`
  SELECT id, date_key, entry_type, minutes_delta, description, created_at, created_by
  FROM attendance_deficit_ledger
  WHERE employee_id = ? AND created_at > ?
    AND entry_type NOT IN ('SETTLEMENT', 'HR_OPENING_BALANCE')
  ORDER BY created_at ASC, id ASC
`);
const selectSettlements = db.prepare(`
  SELECT * FROM attendance_deficit_settlements WHERE employee_id = ? ORDER BY created_at ASC
`);
const selectPenalties = db.prepare(`
  SELECT * FROM attendance_deficit_penalties WHERE employee_id = ? ORDER BY period_key ASC
`);

function presentSettlement(r) {
  return {
    id: r.id,
    periodKey: r.period_key,
    alDays: Number(r.al_days) || 0,
    unpaidDays: Number(r.unpaid_days) || 0,
    unpaidMinutes: Number(r.unpaid_minutes) || 0,
    settledMinutes: Number(r.settled_minutes) || 0,
    settledFormatted: T.formatMinutes(Number(r.settled_minutes) || 0),
    reason: r.reason,
    enteredBy: r.entered_by,
    approvedBy: r.approved_by,
    createdAt: Number(r.created_at),
    at: T.displayTime(Number(r.created_at)),
    outstandingAdjustmentId: r.outstanding_adjustment_id || null,
    snapshot: safeJson(r.snapshot_json),
  };
}
function presentPenalty(r) {
  if (!r) return null;
  return {
    id: r.id,
    periodKey: r.period_key,
    option: r.penalty_option,
    label: PENALTY_OPTIONS[r.penalty_option]?.label || r.penalty_option,
    alDays: Number(r.al_days) || 0,
    payDays: Number(r.pay_days) || 0,
    reason: r.reason,
    enteredBy: r.entered_by,
    approvedBy: r.approved_by,
    createdAt: Number(r.created_at),
    at: T.displayTime(Number(r.created_at)),
    outstandingAdjustmentId: r.outstanding_adjustment_id || null,
  };
}
function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } }

/**
 * Every period from PERIODS_FROM to `through`, oldest first, each with the
 * full arithmetic. One ledger read, one settlements read, one penalties read.
 */
async function periodChain(employeeId, through, nowMs = T.now()) {
  const base = PERIODS_FROM;
  const cutoffMs = T.endOfDay(periodBounds(prevPeriod(base)).end);
  const opening = (await A.balanceAsOf(employeeId, periodBounds(prevPeriod(base)).end)).balanceMinutes;

  const entries = await selectEntriesSince.all(employeeId, cutoffMs);
  const settlements = (await selectSettlements.all(employeeId)).map(presentSettlement);
  const penalties = (await selectPenalties.all(employeeId)).map(presentPenalty);

  const byPeriod = new Map();
  for (const e of entries) {
    // A late correction to a day before the baseline belongs to the first period.
    const key = periodOf(e.date_key) < base ? base : periodOf(e.date_key);
    if (!byPeriod.has(key)) byPeriod.set(key, []);
    byPeriod.get(key).push(e);
  }

  const chain = [];
  let carried = Math.max(0, opening);
  for (let key = base; key <= through; key = nextPeriod(key)) {
    const rows = byPeriod.get(key) || [];
    const gross = rows.filter(r => Number(r.minutes_delta) > 0).reduce((s, r) => s + Number(r.minutes_delta), 0);
    const credits = rows.filter(r => Number(r.minutes_delta) < 0).reduce((s, r) => s + -Number(r.minutes_delta), 0);
    const net = gross - credits;
    const total = Math.max(0, carried + net);
    const periodSettlements = settlements.filter(s => s.periodKey === key);
    const settledMinutes = periodSettlements.reduce((s, r) => s + r.settledMinutes, 0);
    const settledAl = periodSettlements.reduce((s, r) => s + r.alDays, 0);
    const settledUnpaidDays = periodSettlements.reduce((s, r) => s + r.unpaidDays, 0);
    const settledUnpaidMinutes = periodSettlements.reduce((s, r) => s + r.unpaidMinutes, 0);
    const carry = Math.max(0, total - settledMinutes);
    const bounds = periodBounds(key);
    chain.push({
      periodKey: key,
      label: periodLabel(key),
      start: bounds.start,
      end: bounds.end,
      isCurrent: key === periodOf(T.dateKey(nowMs)),
      previous: split(carried),
      newGross: split(gross),
      credits: split(credits),
      current: { ...split(Math.max(0, net)), netMinutes: net, formatted: (net < 0 ? '-' : '') + T.formatMinutes(Math.abs(net)) },
      total: split(total),
      convertedDays: Math.floor(total / DAY),
      remaining: split(total % DAY),
      settled: {
        minutes: settledMinutes,
        formatted: T.formatMinutes(settledMinutes),
        alDays: settledAl,
        unpaidDays: settledUnpaidDays,
        unpaidMinutes: settledUnpaidMinutes,
        unpaidFormatted: T.formatMinutes(settledUnpaidDays * DAY + settledUnpaidMinutes),
      },
      // Still open after settlements: what could still be settled this period.
      available: split(carry),
      carriedForward: { ...split(carry), days: Math.floor(carry / DAY), remainingMinutes: carry % DAY },
      settlements: periodSettlements,
      penalty: penalties.find(p => p.periodKey === key) || null,
      entries: rows.map(r => ({
        id: r.id, date: r.date_key, type: r.entry_type, minutes: Number(r.minutes_delta),
        description: r.description, at: T.displayTime(Number(r.created_at)), by: r.created_by,
      })),
    });
    carried = carry;
  }
  return { baseline: { periodKey: base, openingMinutes: opening, openingFormatted: T.formatMinutes(opening) }, chain };
}

/** The deficit card for one period, with the earlier periods as history. */
async function periodView(employeeId, periodKey = null, nowMs = T.now()) {
  const current = periodOf(T.dateKey(nowMs));
  const key = periodKey && isPeriodKey(periodKey) ? periodKey : current;
  if (key < PERIODS_FROM) {
    throw new DeficitError(`Deficit periods start from ${periodLabel(PERIODS_FROM)}.`, 'BEFORE_BASELINE');
  }
  if (key > current) throw new DeficitError('That period has not started yet.', 'FUTURE_PERIOD');
  const { baseline, chain } = await periodChain(employeeId, key, nowMs);
  const view = chain[chain.length - 1];
  return {
    employeeId,
    dayMinutes: DAY,
    baseline,
    period: view,
    history: chain.slice(0, -1).reverse(),
    nextPeriodOpening: view.carriedForward,
    penaltyOptions: Object.entries(PENALTY_OPTIONS).map(([option, o]) => ({ option, ...o })),
    leaveBalance: await leaveSummary(employeeId),
  };
}

async function leaveSummary(employeeId) {
  try {
    const L = require('./leave');
    const b = await L.balanceFor(employeeId, T.dateKey(), { summaryOnly: true });
    if (b.blocked) return { blocked: true };
    return {
      blocked: false,
      availableDays: b.availableDays,
      outstandingAdjustmentDays: await L.outstandingDays(employeeId),
    };
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

function validateSettlementInput({ alDays, unpaidDays, unpaidMinutes }) {
  const al = Number(alDays) || 0;
  const un = Number(unpaidDays) || 0;
  const um = Number(unpaidMinutes) || 0;
  if (!Number.isInteger(al) || al < 0) throw new DeficitError('Paid annual leave must be a whole number of days.', 'INVALID');
  if (!Number.isInteger(un) || un < 0) throw new DeficitError('Unpaid days must be a whole number.', 'INVALID');
  if (!Number.isInteger(um) || um < 0 || um >= DAY) throw new DeficitError('Unpaid hours/minutes must be less than one deficit day.', 'INVALID');
  return { al, un, um };
}

/**
 * The settlement as it would be applied, for the Review & Confirm screen.
 * Also the validation every real settlement goes through.
 */
async function settlementPreview({ employeeId, periodKey, alDays = 0, unpaidDays = 0, unpaidMinutes = 0 }, nowMs = T.now()) {
  const { al, un, um } = validateSettlementInput({ alDays, unpaidDays, unpaidMinutes });
  const view = await periodView(employeeId, periodKey, nowMs);
  const p = view.period;
  const settledMinutes = (al + un) * DAY + um;
  if (settledMinutes <= 0) throw new DeficitError('Nothing to settle: choose at least one day, or some hours.', 'INVALID');

  // 36.6: the amount settled must not exceed the available deficit.
  if (settledMinutes > p.available.minutes) {
    throw new DeficitError('Settlement exceeds available deficit. Please review.', 'EXCEEDS_AVAILABLE', {
      requestedMinutes: settledMinutes, availableMinutes: p.available.minutes,
    });
  }
  // Whole days settled cannot exceed the completed deficit days still open.
  if ((al + un) > p.available.days) {
    throw new DeficitError(
      `Only ${p.available.days} completed deficit day(s) can be settled; the remaining ${T.formatMinutes(p.available.remainingMinutes)} is less than a day.`,
      'EXCEEDS_AVAILABLE', { requestedDays: al + un, availableDays: p.available.days },
    );
  }

  const carryAfter = p.available.minutes - settledMinutes;
  const L = require('./leave');
  const leave = al > 0 ? await L.chargePreview(employeeId, al) : null;

  return {
    period: {
      periodKey: p.periodKey, label: p.label,
      previous: p.previous, current: p.current, total: p.total,
      convertedDays: p.convertedDays, remaining: p.remaining,
      alreadySettled: p.settled, available: p.available,
    },
    settlement: {
      alDays: al, unpaidDays: un, unpaidMinutes: um,
      settledMinutes, settledFormatted: T.formatMinutes(settledMinutes),
      unpaidTotalMinutes: un * DAY + um,
      unpaidTotalFormatted: T.formatMinutes(un * DAY + um),
      // Pay is deducted per 8-hour day, hours pro rata.
      unpaidDayEquivalents: Math.round(((un * DAY + um) / DAY) * 10000) / 10000,
    },
    // 36.7: carry forward is calculated, never typed in.
    carryForward: { ...split(carryAfter), days: Math.floor(carryAfter / DAY), remainingMinutes: carryAfter % DAY },
    annualLeave: leave,
    payroll: (un * DAY + um) > 0
      ? { deduction: true, dayEquivalents: Math.round(((un * DAY + um) / DAY) * 10000) / 10000, note: 'Proposed to the payroll run for this period; HR approves it there.' }
      : { deduction: false },
  };
}

async function settle({
  employeeId, periodKey, alDays = 0, unpaidDays = 0, unpaidMinutes = 0,
  reason, actor, approvedBy, allowOutstanding = false, nowMs = T.now(),
}) {
  if (!reason || !String(reason).trim()) throw new DeficitError('A reason is required.', 'INVALID');
  if (!approvedBy || !String(approvedBy).trim()) throw new DeficitError('Approved by is required.', 'INVALID');
  const preview = await settlementPreview({ employeeId, periodKey, alDays, unpaidDays, unpaidMinutes }, nowMs);
  const key = preview.period.periodKey;
  const { al, un, um } = { al: preview.settlement.alDays, un: preview.settlement.unpaidDays, um: preview.settlement.unpaidMinutes };
  const settledMinutes = preview.settlement.settledMinutes;
  const L = require('./leave');

  // The balance check happens before anything is written (36.3).
  if (al > 0 && preview.annualLeave && !preview.annualLeave.sufficient && !allowOutstanding) {
    throw new L.InsufficientBalanceError({
      requiredDays: al, availableDays: preview.annualLeave.availableDays, shortfallDays: preview.annualLeave.outstandingDays,
    });
  }

  const id = 'dst_' + crypto.randomBytes(8).toString('hex');
  const dateKey = preview.period.periodKey === periodOf(T.dateKey(nowMs)) ? T.dateKey(nowMs) : periodBounds(key).end;
  const parts = [];
  if (al) parts.push(`${al} day(s) paid annual leave`);
  if (un) parts.push(`${un} day(s) unpaid`);
  if (um) parts.push(`${T.formatMinutes(um)} unpaid`);
  const description = `Deficit settlement ${periodLabel(key)}: ${parts.join(', ')} (${T.formatMinutes(settledMinutes)}). ${String(reason).trim()}`;

  const out = await tx(async () => {
    // Ledger: the lifetime balance comes down by what was settled.
    const current = await A.balanceFor(employeeId, nowMs, false);
    const balanceAfter = Math.max(0, current.balanceMinutes - settledMinutes);
    const ledgerId = 'def_' + crypto.randomBytes(8).toString('hex');
    await A.insertLedger.run({
      id: ledgerId,
      employee_id: employeeId,
      date_key: dateKey,
      entry_type: 'SETTLEMENT',
      minutes_delta: -settledMinutes,
      balance_after: balanceAfter,
      whole_days_after: Math.floor(balanceAfter / DAY),
      carry_forward_after: balanceAfter % DAY,
      description,
      created_at: nowMs,
      created_by: actor,
    });

    let leaveLedgerId = null;
    let outstandingId = null;
    if (al > 0) {
      const charge = await L.chargeAnnualLeave({
        employeeId, days: al, entryType: 'DEFICIT_COVER',
        reason: `Deficit ${periodLabel(key)}: ${al} day(s) covered by paid annual leave. ${String(reason).trim()}`,
        actor, approvedBy, allowOutstanding, sourceType: 'DEFICIT_SETTLEMENT', sourceId: id, nowMs,
      });
      leaveLedgerId = charge.ledgerId;
      outstandingId = charge.outstandingId;
    }

    await db.prepare(`
      INSERT INTO attendance_deficit_settlements
        (id, employee_id, period_key, al_days, unpaid_days, unpaid_minutes, settled_minutes, snapshot_json,
         reason, entered_by, approved_by, created_at, ledger_entry_id, leave_ledger_id, outstanding_adjustment_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, employeeId, key, al, un, um, settledMinutes, JSON.stringify(preview),
      String(reason).trim(), actor, String(approvedBy).trim(), nowMs, ledgerId, leaveLedgerId, outstandingId);

    await audit({
      actor, action: 'DEFICIT_SETTLED', targetType: 'employee', targetId: employeeId,
      before: { periodKey: key, totalMinutes: preview.period.total.minutes, availableMinutes: preview.period.available.minutes },
      after: { settlementId: id, alDays: al, unpaidDays: un, unpaidMinutes: um, settledMinutes, carryForwardMinutes: preview.carryForward.minutes, approvedBy: String(approvedBy).trim(), outstandingAdjustmentId: outstandingId },
      note: String(reason).trim(),
    });
    return { id, ledgerId, leaveLedgerId, outstandingId };
  });

  try { require('./payroll').invalidatePayrollCache(employeeId); } catch (_) {}
  // Unpaid time joins a payroll run already in review, as a proposed line.
  let addedToRun = null;
  if (un * DAY + um > 0) {
    try {
      addedToRun = await require('./payroll').addDecisionToRunInReview({ employeeId, dateKey, actor });
    } catch (_) {}
  }
  return { ...out, periodKey: key, addedToRun, view: await periodView(employeeId, key, nowMs) };
}

// ---------------------------------------------------------------------------
// Penalty (separate from settlement; fixed; once per period)
// ---------------------------------------------------------------------------

async function penaltyPreview({ employeeId, periodKey, option, nowMs = T.now() }) {
  const o = PENALTY_OPTIONS[option];
  if (!o) throw new DeficitError('Choose No penalty, Option 1 or Option 2.', 'INVALID');
  const view = await periodView(employeeId, periodKey, nowMs);
  const existing = view.period.penalty;
  if (existing && existing.option !== 'NONE') {
    throw new DeficitError('Penalty already applied for this period.', 'PENALTY_ALREADY_APPLIED', {
      penaltyType: existing.label, dateApplied: existing.at, approvedBy: existing.approvedBy, option: existing.option,
    });
  }
  const L = require('./leave');
  return {
    period: { periodKey: view.period.periodKey, label: view.period.label, total: view.period.total, convertedDays: view.period.convertedDays, settled: view.period.settled },
    option, label: o.label, alDays: o.alDays, payDays: o.payDays,
    annualLeave: o.alDays > 0 ? await L.chargePreview(employeeId, o.alDays) : null,
    payroll: o.payDays > 0
      ? { deduction: true, days: o.payDays, note: 'Proposed to the payroll run for this period; HR approves it there.' }
      : { deduction: false },
    replacesNoPenalty: Boolean(existing && existing.option === 'NONE'),
  };
}

async function applyPenalty({ employeeId, periodKey, option, reason, actor, approvedBy, allowOutstanding = false, nowMs = T.now() }) {
  if (!reason || !String(reason).trim()) throw new DeficitError('A reason is required.', 'INVALID');
  if (!approvedBy || !String(approvedBy).trim()) throw new DeficitError('Approved by is required.', 'INVALID');
  const preview = await penaltyPreview({ employeeId, periodKey, option, nowMs });
  const key = preview.period.periodKey;
  const L = require('./leave');
  if (preview.annualLeave && !preview.annualLeave.sufficient && !allowOutstanding) {
    throw new L.InsufficientBalanceError({
      requiredDays: preview.alDays, availableDays: preview.annualLeave.availableDays, shortfallDays: preview.annualLeave.outstandingDays,
    });
  }

  const id = 'dpn_' + crypto.randomBytes(8).toString('hex');
  const out = await tx(async () => {
    let leaveLedgerId = null;
    let outstandingId = null;
    if (preview.alDays > 0) {
      const charge = await L.chargeAnnualLeave({
        employeeId, days: preview.alDays, entryType: 'PENALTY',
        reason: `Attendance deficit penalty ${periodLabel(key)} (${preview.label}). ${String(reason).trim()}`,
        actor, approvedBy, allowOutstanding, sourceType: 'DEFICIT_PENALTY', sourceId: id, nowMs,
      });
      leaveLedgerId = charge.ledgerId;
      outstandingId = charge.outstandingId;
    }
    if (preview.replacesNoPenalty) {
      await db.prepare('DELETE FROM attendance_deficit_penalties WHERE employee_id = ? AND period_key = ?').run(employeeId, key);
    }
    await db.prepare(`
      INSERT INTO attendance_deficit_penalties
        (id, employee_id, period_key, penalty_option, al_days, pay_days, reason, entered_by, approved_by, created_at, leave_ledger_id, outstanding_adjustment_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, employeeId, key, option, preview.alDays, preview.payDays, String(reason).trim(), actor, String(approvedBy).trim(), nowMs, leaveLedgerId, outstandingId);

    await audit({
      actor, action: 'DEFICIT_PENALTY_APPLIED', targetType: 'employee', targetId: employeeId,
      before: { periodKey: key, convertedDays: preview.period.convertedDays, previousDecision: preview.replacesNoPenalty ? 'NONE' : null },
      after: { penaltyId: id, option, alDays: preview.alDays, payDays: preview.payDays, approvedBy: String(approvedBy).trim(), outstandingAdjustmentId: outstandingId },
      note: String(reason).trim(),
    });
    return { id, leaveLedgerId, outstandingId };
  });

  try { require('./payroll').invalidatePayrollCache(employeeId); } catch (_) {}
  let addedToRun = null;
  if (preview.payDays > 0) {
    try {
      addedToRun = await require('./payroll').addDecisionToRunInReview({ employeeId, dateKey: T.dateKey(nowMs), actor });
    } catch (_) {}
  }
  return { ...out, periodKey: key, addedToRun, view: await periodView(employeeId, key, nowMs) };
}

// ---------------------------------------------------------------------------
// For payroll: unpaid time and penalty pay not yet proposed to a run
// ---------------------------------------------------------------------------

const selectUnclaimedSettlements = db.prepare(`
  SELECT s.* FROM attendance_deficit_settlements s
  WHERE s.employee_id = ? AND (s.unpaid_days > 0 OR s.unpaid_minutes > 0)
    AND s.created_at <= ?
    AND NOT EXISTS (
      SELECT 1 FROM payroll_adjustments pa WHERE pa.adjustment_type = ? AND pa.source_reference = s.id
    )
  ORDER BY s.created_at ASC
`);
const selectUnclaimedPenalties = db.prepare(`
  SELECT p.* FROM attendance_deficit_penalties p
  WHERE p.employee_id = ? AND p.pay_days > 0 AND p.created_at <= ?
    AND NOT EXISTS (
      SELECT 1 FROM payroll_adjustments pa WHERE pa.adjustment_type = ? AND pa.source_reference = p.id
    )
  ORDER BY p.created_at ASC
`);

async function unclaimedUnpaidSettlements({ employeeId, throughDate, adjustmentType }) {
  const rows = await selectUnclaimedSettlements.all(employeeId, T.endOfDay(throughDate), adjustmentType);
  return rows.map(r => ({
    id: r.id,
    periodKey: r.period_key,
    unpaidDays: Number(r.unpaid_days) || 0,
    unpaidMinutes: Number(r.unpaid_minutes) || 0,
    dayEquivalents: Math.round((((Number(r.unpaid_days) || 0) * DAY + (Number(r.unpaid_minutes) || 0)) / DAY) * 10000) / 10000,
  }));
}
async function unclaimedPenaltyPay({ employeeId, throughDate, adjustmentType }) {
  const rows = await selectUnclaimedPenalties.all(employeeId, T.endOfDay(throughDate), adjustmentType);
  return rows.map(r => ({ id: r.id, periodKey: r.period_key, payDays: Number(r.pay_days) || 0, option: r.penalty_option }));
}

/** Month figures for reports: the period plus leave charges made in it. */
async function monthlyFigures(employeeId, periodKey, nowMs = T.now()) {
  if (!isPeriodKey(periodKey) || periodKey < PERIODS_FROM || periodKey > periodOf(T.dateKey(nowMs))) return null;
  const view = await periodView(employeeId, periodKey, nowMs);
  const p = view.period;
  const b = periodBounds(periodKey);
  const charges = await db.prepare(`
    SELECT entry_type, COALESCE(SUM(-days_delta), 0) AS days
    FROM leave_accrual_ledger
    WHERE employee_id = ? AND entry_type IN ('PENALTY', 'UA_COVER', 'DEFICIT_COVER')
      AND effective_date >= ? AND effective_date <= ?
    GROUP BY entry_type
  `).all(employeeId, b.start, b.end);
  const by = Object.fromEntries(charges.map(c => [c.entry_type, Number(c.days) || 0]));
  const unpaidDayEq = p.settled.unpaidDays + p.settled.unpaidMinutes / DAY;
  return {
    periodKey,
    previousDeficitMinutes: p.previous.minutes,
    currentDeficitMinutes: p.current.netMinutes,
    totalDeficitMinutes: p.total.minutes,
    deficitDays: p.convertedDays,
    remainingDeficitMinutes: p.remaining.minutes,
    settledAlDays: p.settled.alDays,
    settledUnpaidDays: p.settled.unpaidDays,
    settledUnpaidMinutes: p.settled.unpaidMinutes,
    carriedForwardMinutes: p.carriedForward.minutes,
    annualLeaveCoverDeficitDays: by.DEFICIT_COVER || 0,
    annualLeaveCoverAbsenceDays: by.UA_COVER || 0,
    annualLeavePenaltyDays: by.PENALTY || 0,
    penalty: p.penalty,
    payrollDeductionDayEquivalents: Math.round((unpaidDayEq + (p.penalty?.payDays || 0)) * 10000) / 10000,
    // What is still owed after this period's decisions.
    finalNetDeficitMinutes: p.carriedForward.minutes,
  };
}

module.exports = {
  DAY, PERIODS_FROM, PENALTY_OPTIONS, DeficitError,
  periodOf, periodBounds, nextPeriod, prevPeriod, periodLabel, isPeriodKey, split,
  periodView, periodChain, settlementPreview, settle, penaltyPreview, applyPenalty,
  unclaimedUnpaidSettlements, unclaimedPenaltyPay, monthlyFigures,
};
