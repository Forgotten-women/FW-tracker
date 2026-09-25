// Shared vocabulary for the attendance history view: what each day status
// looks like, date-key arithmetic, month totals, the deficit in words and the
// client-side CSV export. Date keys are YYYY-MM-DD strings in the office
// timezone (the server decides the day); they are parsed by hand and handled
// in UTC so no viewer timezone can move a day.

import type { ReactNode } from 'react';
import type { HistoryDayStatus, HistoryDaySummary, HistoryDeficit } from '@/lib/types';
import {
  BriefcaseIcon,
  CheckIcon,
  CircleSlashIcon,
  ClockIcon,
  FlagIcon,
  HourglassIcon,
  MinusIcon,
  PalmTreeIcon,
  TimerIcon,
  TrendingDownIcon,
  XIcon,
} from '@/components/icons';

export type HistoryMode = 'calendar' | 'list';

/** Which month and day the History tab shows. Held by the drawer so it survives tab switches. */
export interface HistoryView {
  month: string; // YYYY-MM
  day: string | null; // YYYY-MM-DD
  mode: HistoryMode;
}

type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'info' | 'muted' | 'dim';

interface StatusMeta {
  label: string;
  tone: Tone;
  /** Calendar cell / legend swatch surface. */
  cell: string;
  /** Glyph colour. */
  glyph: string;
  icon: (className: string) => ReactNode;
}

export const HISTORY_STATUS_META: Record<HistoryDayStatus, StatusMeta> = {
  ON_TIME: {
    label: 'On time',
    tone: 'ok',
    cell: 'bg-emerald-500/10 border-emerald-500/30',
    glyph: 'text-emerald-400',
    icon: (c) => <CheckIcon className={c} />,
  },
  LATE: {
    label: 'Late',
    tone: 'warn',
    cell: 'bg-amber-500/10 border-amber-500/35',
    glyph: 'text-amber-400',
    icon: (c) => <ClockIcon className={c} />,
  },
  SHORT: {
    label: 'Short of hours',
    tone: 'warn',
    cell: 'bg-orange-500/10 border-orange-500/35',
    glyph: 'text-orange-400',
    icon: (c) => <TrendingDownIcon className={c} />,
  },
  ABSENT: {
    label: 'Absent',
    tone: 'danger',
    cell: 'bg-rose-500/10 border-rose-500/35',
    glyph: 'text-rose-400',
    icon: (c) => <XIcon className={c} />,
  },
  ON_LEAVE: {
    label: 'On leave',
    tone: 'info',
    cell: 'bg-sky-500/10 border-sky-500/30',
    glyph: 'text-sky-400',
    icon: (c) => <PalmTreeIcon className={c} />,
  },
  HOLIDAY: {
    label: 'Holiday',
    tone: 'accent',
    cell: 'bg-violet-500/10 border-violet-500/30',
    glyph: 'text-violet-400',
    icon: (c) => <FlagIcon className={c} />,
  },
  REST_DAY: {
    label: 'Rest day',
    tone: 'muted',
    cell: 'bg-white/[0.03] border-white/8',
    glyph: 'text-slate-500',
    icon: (c) => <MinusIcon className={c} />,
  },
  REST_DAY_WORKED: {
    label: 'Rest day (worked)',
    tone: 'info',
    cell: 'bg-teal-500/10 border-teal-500/30',
    glyph: 'text-teal-400',
    icon: (c) => <BriefcaseIcon className={c} />,
  },
  IN_PROGRESS: {
    label: 'Today, in progress',
    tone: 'accent',
    cell: 'bg-indigo-500/10 border-indigo-500/35',
    glyph: 'text-indigo-400',
    icon: (c) => <TimerIcon className={c} />,
  },
  NOT_STARTED: {
    label: 'Today, not arrived yet',
    tone: 'dim',
    cell: 'bg-indigo-500/5 border-dashed border-indigo-500/30',
    glyph: 'text-indigo-300',
    icon: (c) => <HourglassIcon className={c} />,
  },
  NOT_EMPLOYED: {
    label: 'Before employment',
    tone: 'dim',
    cell: 'bg-transparent border-dashed border-white/8',
    glyph: 'text-slate-600',
    icon: (c) => <CircleSlashIcon className={c} />,
  },
};

/** Legend order: outcomes first, then non-working days. */
export const LEGEND_ORDER: HistoryDayStatus[] = [
  'ON_TIME', 'LATE', 'SHORT', 'ABSENT', 'ON_LEAVE', 'HOLIDAY', 'REST_DAY', 'REST_DAY_WORKED', 'IN_PROGRESS', 'NOT_STARTED', 'NOT_EMPLOYED',
];

export function statusMeta(status: string): StatusMeta {
  return HISTORY_STATUS_META[status as HistoryDayStatus] ?? HISTORY_STATUS_META.ABSENT;
}

// ---------------------------------------------------------------------------
// Date keys
// ---------------------------------------------------------------------------

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEK_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function isDateKey(v: string | null | undefined): v is string {
  return !!v && DATE_RE.test(v);
}

function toUtc(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(t: Date): string {
  return t.toISOString().slice(0, 10);
}

export function addDays(dateKey: string, n: number): string {
  const t = toUtc(dateKey);
  t.setUTCDate(t.getUTCDate() + n);
  return fromUtc(t);
}

export function monthOf(dateKey: string): string {
  return dateKey.slice(0, 7);
}

export function addMonths(month: string, n: number): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + n, 1));
  return fromUtc(t).slice(0, 7);
}

/** First and last date of a month. */
export function monthBounds(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  return { from, to: addDays(`${addMonths(month, 1)}-01`, -1) };
}

/** 'September 2026' */
export function monthLabel(month: string): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  return `${MONTHS_LONG[Number(m[2]) - 1]} ${m[1]}`;
}

/** 'Tuesday, 1 September 2026' */
export function longDate(dateKey: string): string {
  const m = DATE_RE.exec(dateKey);
  if (!m) return dateKey;
  return `${WEEKDAYS_LONG[toUtc(dateKey).getUTCDay()]}, ${Number(m[3])} ${MONTHS_LONG[Number(m[2]) - 1]} ${m[1]}`;
}

/** 'Tue 1 Sep' */
export function shortDate(dateKey: string): string {
  const m = DATE_RE.exec(dateKey);
  if (!m) return dateKey;
  return `${WEEKDAYS_SHORT[toUtc(dateKey).getUTCDay()]} ${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1]}`;
}

/** '1 Sep 2026' */
export function mediumDate(dateKey: string): string {
  const m = DATE_RE.exec(dateKey);
  if (!m) return dateKey;
  return `${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1]} ${m[1]}`;
}

/** 0 = Monday ... 6 = Sunday */
export function mondayIndex(dateKey: string): number {
  return (toUtc(dateKey).getUTCDay() + 6) % 7;
}

/** Every month from `from` to `to` inclusive, newest first. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = to; m >= from && out.length < 600; m = addMonths(m, -1)) out.push(m);
  return out;
}

// ---------------------------------------------------------------------------
// Minutes
// ---------------------------------------------------------------------------

/** 450 -> '7h 30m', 45 -> '45m', 0 -> '0m' */
export function fmtMinutes(mins: number | null | undefined): string {
  const v = Math.max(0, Math.round(Number(mins) || 0));
  const h = Math.floor(v / 60);
  const m = v % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Compact form for calendar cells: 450 -> '7h30', 45 -> '45m' */
export function fmtCompact(mins: number): string {
  const v = Math.max(0, Math.round(mins || 0));
  const h = Math.floor(v / 60);
  const m = v % 60;
  if (h === 0) return `${m}m`;
  return `${h}h${String(m).padStart(2, '0')}`;
}

/** Leave counted in days: a half-day portion counts 0.5. */
export function leaveDayValue(day: HistoryDaySummary): number {
  if (day.status !== 'ON_LEAVE') return 0;
  return !day.leave || day.leave.dayPortion === 'FULL' ? 1 : 0.5;
}

export function sentenceCase(code: string | null | undefined): string {
  if (!code) return '';
  const words = code.toLowerCase().replace(/_/g, ' ').replace(/\bhr\b/g, 'HR');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------------------
// Month totals
// ---------------------------------------------------------------------------

export interface MonthTotals {
  present: number;
  onTime: number;
  late: number;
  short: number;
  absent: number;
  leaveDays: number;
  workedMinutes: number;
  deficitMinutes: number;
  pendingCorrections: number;
  workingDays: number;
}

const PRESENT: HistoryDayStatus[] = ['ON_TIME', 'LATE', 'SHORT', 'IN_PROGRESS', 'REST_DAY_WORKED'];

export function monthTotals(days: HistoryDaySummary[]): MonthTotals {
  const t: MonthTotals = {
    present: 0, onTime: 0, late: 0, short: 0, absent: 0, leaveDays: 0,
    workedMinutes: 0, deficitMinutes: 0, pendingCorrections: 0, workingDays: 0,
  };
  for (const d of days) {
    if (d.status === 'NOT_EMPLOYED') continue;
    if (PRESENT.includes(d.status)) t.present += 1;
    if (d.status === 'ON_TIME') t.onTime += 1;
    if (d.status === 'LATE') t.late += 1;
    if (d.status === 'SHORT') t.short += 1;
    if (d.status === 'ABSENT') t.absent += 1;
    if (d.isWorkingDay) t.workingDays += 1;
    t.leaveDays += leaveDayValue(d);
    t.workedMinutes += d.workedMinutes || 0;
    t.deficitMinutes += d.deficit?.totalMinutes || 0;
    t.pendingCorrections += d.corrections?.pending || 0;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Deficit in words
// ---------------------------------------------------------------------------

export function deficitLines(d: HistoryDeficit): { text: string; minutes: number; credit?: boolean }[] {
  const out: { text: string; minutes: number; credit?: boolean }[] = [];
  if (d.lateMinutes > 0) out.push({ text: `Arrived ${fmtMinutes(d.lateMinutes)} late.`, minutes: d.lateMinutes });
  if (d.excessBreakMinutes > 0) {
    out.push({ text: `Took ${fmtMinutes(d.excessBreakMinutes)} more break than permitted.`, minutes: d.excessBreakMinutes });
  }
  if (d.earlyDepartureMinutes > 0) {
    out.push({ text: `Left ${fmtMinutes(d.earlyDepartureMinutes)} before the scheduled end.`, minutes: d.earlyDepartureMinutes });
  }
  if (d.unauthorisedMissingMinutes > 0) {
    out.push({
      text: `${fmtMinutes(d.unauthorisedMissingMinutes)} unaccounted for during working hours.`,
      minutes: d.unauthorisedMissingMinutes,
    });
  }
  if (d.approvedAdjustmentMinutes > 0) {
    out.push({
      text: `${fmtMinutes(d.approvedAdjustmentMinutes)} credited back by approved HR adjustments.`,
      minutes: d.approvedAdjustmentMinutes,
      credit: true,
    });
  }
  return out;
}

/** One line for screen readers and the calendar cell's label. */
export function dayAriaLabel(day: HistoryDaySummary): string {
  const parts = [longDate(day.dateKey)];
  if (day.isToday) parts.push('today');
  parts.push(day.statusLabel || statusMeta(day.status).label);
  if (day.workedMinutes > 0) parts.push(`worked ${fmtMinutes(day.workedMinutes)}`);
  if (day.deficit.totalMinutes > 0) parts.push(`deficit ${fmtMinutes(day.deficit.totalMinutes)}`);
  if (day.corrections.pending > 0) {
    parts.push(`${day.corrections.pending} pending correction${day.corrections.pending === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

/** A correction's requested change, stored as JSON text, as a person reads it. */
export function describeRequestedChange(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [raw];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [String(parsed)];
  const out: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined || value === '') continue;
    if (key === 'adjustmentMinutes' && Number.isFinite(Number(value))) {
      const n = Number(value);
      out.push(`${n >= 0 ? 'Add' : 'Remove'} ${fmtMinutes(Math.abs(n))} of worked time`);
      continue;
    }
    const label = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
    out.push(`${label.charAt(0).toUpperCase()}${label.slice(1)}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSV (built in the browser from the DaySummary rows already fetched)
// ---------------------------------------------------------------------------

const CSV_COLUMNS: [string, (d: HistoryDaySummary) => string | number | boolean | null | undefined][] = [
  ['date', (d) => d.dateKey],
  ['weekday', (d) => d.weekday],
  ['status', (d) => d.status],
  ['status_label', (d) => d.statusLabel],
  ['attendance_status', (d) => d.attendanceStatus],
  ['working_day', (d) => d.isWorkingDay],
  ['day_type', (d) => d.dayType],
  ['non_working_reason', (d) => d.nonWorkingReason],
  ['scheduled_start', (d) => d.scheduledStart],
  ['scheduled_end', (d) => d.scheduledEnd],
  ['first_in', (d) => d.firstIn],
  ['last_out', (d) => d.lastOut],
  ['first_in_at_utc', (d) => (d.firstInAt ? new Date(d.firstInAt).toISOString() : null)],
  ['last_out_at_utc', (d) => (d.lastOutAt ? new Date(d.lastOutAt).toISOString() : null)],
  ['worked_minutes', (d) => d.workedMinutes],
  ['worked', (d) => d.workedFormatted],
  ['break_minutes', (d) => d.breakMinutes],
  ['late_minutes', (d) => d.deficit.lateMinutes],
  ['excess_break_minutes', (d) => d.deficit.excessBreakMinutes],
  ['early_departure_minutes', (d) => d.deficit.earlyDepartureMinutes],
  ['unauthorised_missing_minutes', (d) => d.deficit.unauthorisedMissingMinutes],
  ['approved_adjustment_minutes', (d) => d.deficit.approvedAdjustmentMinutes],
  ['deficit_minutes', (d) => d.deficit.totalMinutes],
  ['adjustment_minutes', (d) => d.adjustment?.minutes],
  ['adjustment_note', (d) => d.adjustment?.note],
  ['leave_type', (d) => d.leave?.type],
  ['leave_status', (d) => d.leave?.status],
  ['leave_portion', (d) => d.leave?.dayPortion],
  ['leave_paid', (d) => d.leave?.isPaid],
  ['absence_status', (d) => d.absence?.status],
  ['absence_type', (d) => d.absence?.type],
  ['absence_unpaid', (d) => d.absence?.treatAsUnpaid],
  ['corrections_pending', (d) => d.corrections.pending],
  ['corrections_total', (d) => d.corrections.total],
  ['laptop_active_minutes', (d) => d.laptop?.activeMinutes],
  ['laptop_idle_minutes', (d) => d.laptop?.idleMinutes],
];

function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return String(v);
  // Free text (notes, labels) must never be read by a spreadsheet as a formula.
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildHistoryCsv(days: HistoryDaySummary[]): string {
  const lines = [CSV_COLUMNS.map(([h]) => h).join(',')];
  for (const d of days) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(d))).join(','));
  return lines.join('\r\n');
}

export function downloadCsv(filename: string, csv: string) {
  // The BOM makes Excel read the file as UTF-8 (names, notes).
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'employee';
}
