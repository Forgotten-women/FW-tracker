// Shared payroll display helpers: currency, dates, labels and the payroll
// run's error codes. Pure functions only; no React.

import { ApiError } from '@/lib/api';
import type {
  PayrollEmployeeFlag,
  PayrollPeriodStatus,
  PayrollPreflightCheck,
  PayrollPreflightCode,
  PayrollReviewLine,
  PayrollRunErrorBody,
  PayrollRunErrorCode,
  PayrollUndecidedLine,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

/** What the panel can display figures in. The period's rate is 1 GBP = N PKR. */
export type Currency = 'GBP' | 'PKR';

export const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  PKR: '₨',
  USD: '$',
  EUR: '€',
};

export const DEFAULT_PKR_RATE = 350;

/** Rounds to whole pence, as the backend's money() does. */
export function money(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * An amount recorded in `recordedCurrency`, in the display currency where the
 * period's rate allows it. The only rate a period carries is GBP/PKR, so a
 * USD or EUR salary is shown in its own currency rather than relabelled.
 */
export function convertAmount(
  amount: number,
  displayCurrency: Currency,
  recordedCurrency: string | null | undefined,
  pkrRate: number = DEFAULT_PKR_RATE,
): { value: number; currency: string } {
  const src = (recordedCurrency || 'GBP').toUpperCase();
  const tgt = (displayCurrency || 'GBP').toUpperCase();
  if (src === 'GBP' && tgt === 'PKR') return { value: amount * pkrRate, currency: 'PKR' };
  if (src === 'PKR' && tgt === 'GBP') return { value: amount / (pkrRate || 1), currency: 'GBP' };
  return { value: amount, currency: src };
}

function formatIn(value: number, currency: string, signed = false): string {
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const abs = Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Rounds to zero at two places: no "-£0.00".
  const isZero = Math.abs(value) < 0.005;
  const sign = isZero ? '' : value < 0 ? '−' : signed ? '+' : '';
  return `${sign}${sym}${abs}`;
}

export function formatMoney(
  amount: number | null | undefined,
  displayCurrency: Currency,
  recordedCurrency?: string | null,
  pkrRate: number = DEFAULT_PKR_RATE,
): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const { value, currency } = convertAmount(amount, displayCurrency, recordedCurrency, pkrRate);
  return formatIn(value, currency);
}

/** A figure whose currency is not known (an employee with no salary on record). */
export function formatPlainAmount(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const abs = Math.abs(amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${amount <= -0.005 ? '−' : ''}${abs}`;
}

/** As formatMoney, with an explicit + on a positive amount (a line that adds pay). */
export function formatSignedMoney(
  amount: number | null | undefined,
  displayCurrency: Currency,
  recordedCurrency?: string | null,
  pkrRate: number = DEFAULT_PKR_RATE,
): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const { value, currency } = convertAmount(amount, displayCurrency, recordedCurrency, pkrRate);
  return formatIn(value, currency, true);
}

/**
 * Sums amounts recorded in different currencies. Everything the rate can
 * convert is added up in the display currency; anything it cannot (USD, EUR)
 * is kept as its own figure, so "£1,200.00 + $300.00" rather than a number
 * that adds pounds to dollars.
 */
export function sumAcrossCurrencies(
  parts: { amount: number; currency: string | null | undefined }[],
  displayCurrency: Currency,
  pkrRate: number,
): { value: number; currency: string }[] {
  const totals = new Map<string, number>();
  for (const p of parts) {
    const { value, currency } = convertAmount(p.amount, displayCurrency, p.currency, pkrRate);
    totals.set(currency, (totals.get(currency) ?? 0) + value);
  }
  if (totals.size === 0) totals.set(displayCurrency, 0);
  return [...totals.entries()]
    .sort(([a], [b]) => (a === displayCurrency ? -1 : b === displayCurrency ? 1 : a.localeCompare(b)))
    .map(([currency, value]) => ({ value, currency }));
}

export function formatSum(sums: { value: number; currency: string }[]): string {
  return sums.map((s) => formatIn(s.value, s.currency)).join(' + ');
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2025-05-25" -> "25 May 2025". Parsed by hand: no timezone can move the day. */
export function formatDate(key: string | null | undefined): string {
  if (!key) return '—';
  const m = DATE_KEY.exec(key);
  if (!m) return key;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** "2025-05-25" -> "25 May". */
export function formatDayMonth(key: string | null | undefined): string {
  if (!key) return '—';
  const m = DATE_KEY.exec(key);
  if (!m) return key;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
}

/** Epoch ms -> "28 May 2025, 14:05" in the viewer's timezone. */
export function formatTimestamp(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Today's YYYY-MM-DD in the viewer's timezone. */
export function localDateKey(d: Date = new Date()): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** An audit actor ("user:abc", "admin", "system") as a person reads it. */
export function formatActor(actor: string | null | undefined): string {
  if (!actor) return '—';
  if (actor === 'system') return 'System (automatic)';
  if (actor === 'admin') return 'Admin key';
  return actor.startsWith('user:') ? actor.slice(5) : actor;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function sentenceCase(code: string): string {
  const words = code.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Mirrors LINE_LABELS / lineLabel() in backend/src/domain/payroll.js, so a
// line reads the same here as on the payslip the employee is shown.
const LINE_LABELS: Record<string, string> = {
  ATTENDANCE_DEFICIT_DAY: 'Attendance deficit',
  UNAUTHORISED_ABSENCE_UNPAID: 'Unpaid absence',
  UNPAID_LEAVE_DEDUCTION: 'Unpaid leave',
};

export function lineLabel(type: string | null | undefined): string {
  if (!type) return 'Adjustment';
  return LINE_LABELS[type] ?? sentenceCase(type);
}

/**
 * A preflight item's free-text detail ("UNPAID_LEAVE_DEDUCTION: 2 day(s)",
 * "2025-07-01 to 2025-07-03 (PENDING_HR)", "NO_SHOW") for a person to read.
 */
export function humanizeDetail(detail: string | null | undefined): string {
  if (!detail) return '';
  return detail
    .replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (d) => formatDate(d))
    .replace(/\b[A-Z][A-Z_]*[A-Z]\b/g, (code) => LINE_LABELS[code] ?? sentenceCase(code));
}

export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'info' | 'muted' | 'dim';

export const PERIOD_STATUS_META: Record<PayrollPeriodStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'Open', tone: 'info' },
  IN_REVIEW: { label: 'In review', tone: 'warn' },
  PUBLISHED: { label: 'Published', tone: 'accent' },
  PAID: { label: 'Paid', tone: 'ok' },
  CLOSED: { label: 'Closed', tone: 'dim' },
};

export const LINE_STATUS_META: Record<string, { label: string; tone: Tone }> = {
  PROPOSED: { label: 'Proposed', tone: 'warn' },
  APPROVED: { label: 'Approved', tone: 'ok' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
};

/** PUBLISHED, PAID and CLOSED: nothing in the period can change any more. */
export function isFinalStatus(status: string): boolean {
  return status === 'PUBLISHED' || status === 'PAID' || status === 'CLOSED';
}

export const PREFLIGHT_LABELS: Record<PayrollPreflightCode, string> = {
  PENDING_CORRECTIONS: 'Attendance corrections awaiting a decision',
  PENDING_ABSENCE_REVIEWS: 'Absences awaiting HR review',
  PENDING_LEAVE_REQUESTS: 'Leave requests still pending',
  NEW_DEDUCTIONS_SINCE_GENERATION: 'New deductions since the run was generated',
  NOT_YET_GENERATED: 'Deductions not generated yet',
  NO_SALARY: 'Employees with no salary on record',
};

export function preflightLabel(code: string): string {
  return PREFLIGHT_LABELS[code as PayrollPreflightCode] ?? sentenceCase(code);
}

/** Employee-level flags as short badge labels; the full sentence is the flag's message. */
export function flagMeta(flag: PayrollEmployeeFlag): { label: string; tone: Tone } {
  switch (flag.code) {
    case 'STARTER':
      return { label: 'Starter', tone: 'info' };
    case 'LEAVER':
      return { label: 'Leaver', tone: 'warn' };
    case 'LEAVER_AFTER_CUTOFF':
      return { label: 'Leaves after cut-off', tone: 'danger' };
    case 'SALARY_CHANGED_IN_PERIOD':
      return { label: 'Salary changed', tone: 'accent' };
    case 'NET_CHANGE_OVER_15_PERCENT': {
      const pct = flag.changePercent;
      if (typeof pct === 'number' && Number.isFinite(pct)) {
        return { label: `Net ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% vs last payslip`, tone: 'warn' };
      }
      return { label: 'Big change vs last payslip', tone: 'warn' };
    }
    default:
      return { label: sentenceCase(String(flag.code)), tone: 'muted' };
  }
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/**
 * Whether a PROPOSED line needs a person's explicit decision. approve-run
 * approves only ROUTINE lines in bulk; anything else still proposed, including
 * a legacy line with no level at all, refuses the run until decided.
 */
export function needsDecision(line: PayrollReviewLine): boolean {
  return line.status === 'PROPOSED' && line.reviewLevel !== 'ROUTINE';
}

export function isRoutinePending(line: PayrollReviewLine): boolean {
  return line.status === 'PROPOSED' && line.reviewLevel === 'ROUTINE';
}

/** The figure a line stands at: approved amount, the calculation while undecided, nothing if rejected. */
export function standingAmount(line: PayrollReviewLine): number {
  if (line.status === 'APPROVED') return Number(line.approvedAmount) || 0;
  if (line.status === 'PROPOSED') return Number(line.calculatedAmount) || 0;
  return 0;
}

// ---------------------------------------------------------------------------
// Run errors
// ---------------------------------------------------------------------------

export interface RunErrorView {
  code: PayrollRunErrorCode | string | null;
  title: string;
  message: string;
  undecided: PayrollUndecidedLine[];
  blockers: PayrollPreflightCheck[];
}

/**
 * Turns a refused approve-run / mark-paid into something HR can act on. The
 * server's own message is kept as the detail: it names the lines and codes.
 */
export function describeRunError(err: unknown, action: 'approve' | 'pay' | 'generate'): RunErrorView {
  const fallback = action === 'approve'
    ? 'The run was not approved.'
    : action === 'pay'
      ? 'The run was not marked as paid.'
      : 'Deductions were not generated.';

  if (!(err instanceof ApiError)) {
    return {
      code: null,
      title: fallback,
      message: err instanceof Error && err.message ? err.message : 'Could not reach the server.',
      undecided: [],
      blockers: [],
    };
  }

  const body = (err.body ?? {}) as Partial<PayrollRunErrorBody>;
  const undecided = Array.isArray(body.undecided) ? body.undecided : [];
  const blockers = Array.isArray(body.preflight) ? body.preflight : [];
  const base = { code: err.code, undecided, blockers };

  switch (err.code) {
    case 'NOTE_REQUIRED':
      return { ...base, title: 'An approval note is required.', message: 'Every payroll approval is recorded with a note. Add one and try again.' };
    case 'WAIVER_NOTE_REQUIRED':
      return { ...base, title: 'Explain the waiver.', message: 'Approving past blocking issues needs a waiver note saying why. It is kept in the audit log.' };
    case 'ATTENTION_UNDECIDED':
      return {
        ...base,
        title: `${undecided.length || 'Some'} line(s) still need an explicit decision.`,
        message: 'Nothing was published. Decide each line listed below, then approve again.',
      };
    case 'PREFLIGHT_BLOCKED':
      return {
        ...base,
        title: 'This run has blocking issues.',
        message: 'Nothing was published. Resolve the issues below, or tick "Approve anyway" and explain why in a waiver note.',
      };
    case 'ALREADY_FINAL':
      return {
        ...base,
        title: action === 'pay' ? 'This run is already marked as paid.' : 'This run has already been approved.',
        message: `${err.message} Someone else may have acted on it; the latest state is shown now. Nothing was changed by this request.`,
      };
    case 'NOT_PUBLISHED':
      return { ...base, title: 'Only a published run can be marked as paid.', message: err.message };
    case 'NOT_FOUND':
      return { ...base, title: 'This payroll period no longer exists.', message: err.message };
    case 'FORBIDDEN': {
      const missing = Array.isArray(body.missing) && body.missing.length ? ` Missing permission: ${body.missing.join(', ')}.` : '';
      return { ...base, title: 'You are not allowed to do this.', message: `${err.message}${missing}` };
    }
    default:
      return { ...base, title: fallback, message: err.message };
  }
}
