'use client';

import { type ReactNode, useState } from 'react';
import type { PayrollExcludedEmployee, PayrollReviewEmployee, PayrollReviewLine } from '@/lib/types';
import { Badge, Button, Empty, Input } from '@/components/primitives';
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  UsersIcon,
  XIcon,
} from '@/components/icons';
import {
  CURRENCY_SYMBOLS,
  type Currency,
  LINE_STATUS_META,
  flagMeta,
  formatDate,
  formatMoney,
  formatPlainAmount,
  formatSignedMoney,
  isRoutinePending,
  lineLabel,
  money,
  needsDecision,
  standingAmount,
} from './format';
import {
  type DecidableLine,
  type DecisionMap,
  EMPTY_DECISION,
  type LineChoice,
  type LineDecision,
  amountSign,
  decisionProblem,
  parseChangedAmount,
  projectedAmount,
} from './decisions';

export type ReviewFilter = 'ALL' | 'ATTENTION' | 'DEDUCTIONS';

export function lineDomId(lineId: string): string {
  return `payroll-line-${lineId}`;
}

export function toDecidable(e: PayrollReviewEmployee, l: PayrollReviewLine): DecidableLine {
  return {
    id: l.id,
    employeeId: e.employeeId,
    employeeName: e.employeeName,
    type: l.type,
    calculatedAmount: l.calculatedAmount,
    calculatedDays: l.calculatedDays,
    explanation: l.explanation,
    reviewReasons: l.reviewReasons,
    currency: e.salary.currency || 'GBP',
  };
}

function employeeNeedsAttention(e: PayrollReviewEmployee): boolean {
  return e.employeeFlags.length > 0 || e.adjustments.some(needsDecision);
}

function employeeHasDeductions(e: PayrollReviewEmployee): boolean {
  return e.adjustments.some((l) => standingAmount(l) < 0);
}

// ---------------------------------------------------------------------------
// One line that needs a decision
// ---------------------------------------------------------------------------

const CHOICES: { choice: LineChoice; label: string; icon: ReactNode; active: string }[] = [
  { choice: 'APPROVED', label: 'Approve', icon: <CheckIcon className="h-3.5 w-3.5" />, active: 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300' },
  { choice: 'REJECTED', label: 'Reject', icon: <XIcon className="h-3.5 w-3.5" />, active: 'border-rose-500/60 bg-rose-500/15 text-rose-300' },
  { choice: 'CHANGED', label: 'Different amount', icon: <PencilIcon className="h-3.5 w-3.5" />, active: 'border-indigo-500/60 bg-indigo-500/15 text-indigo-300' },
];

export function LineDecisionCard({
  line,
  decision,
  onChange,
  currency,
  rate,
  highlighted,
}: {
  line: DecidableLine;
  decision: LineDecision | undefined;
  onChange: (d: LineDecision) => void;
  currency: Currency;
  rate: number;
  highlighted: boolean;
}) {
  const d = decision ?? EMPTY_DECISION;
  const fmt = (n: number) => (line.currency ? formatSignedMoney(n, currency, line.currency, rate) : formatPlainAmount(n));
  const problem = decisionProblem(line.calculatedAmount, d);
  const sign = amountSign(line.calculatedAmount);
  const changed = d.choice === 'CHANGED' ? parseChangedAmount(line.calculatedAmount, d.amount) : null;
  const recordedCurrency = line.currency ?? '';
  const symbol = line.currency ? (CURRENCY_SYMBOLS[line.currency] ?? line.currency) : '';

  const choose = (choice: LineChoice) => {
    if (d.choice === choice) return;
    const amount = choice === 'CHANGED' && !d.amount
      ? (sign === 0 ? '0.00' : Math.abs(line.calculatedAmount).toFixed(2))
      : d.amount;
    onChange({ ...d, choice, amount });
  };

  let outcome: ReactNode;
  if (!d.choice) {
    outcome = <span className="text-amber-400">Awaiting your decision</span>;
  } else if (d.choice === 'REJECTED') {
    outcome = <span className="text-rose-400">Rejected: nothing {sign < 0 ? 'deducted' : 'paid'}</span>;
  } else if (d.choice === 'CHANGED') {
    outcome = changed === null
      ? <span className="text-amber-400">Enter an amount</span>
      : <span className="text-indigo-300">{fmt(changed)} <span className="text-[10px] font-sans text-slate-500">changed</span></span>;
  } else {
    outcome = <span className="text-emerald-400">{fmt(line.calculatedAmount)}</span>;
  }

  const box = highlighted && problem
    ? 'border-rose-500/50 bg-rose-500/5'
    : problem
      ? 'border-amber-500/30 bg-amber-500/5'
      : 'border-emerald-500/25 bg-emerald-500/5';

  return (
    <div id={lineDomId(line.id)} className={`scroll-mt-24 rounded-xl border p-3.5 transition-colors ${box}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={problem ? 'warn' : 'ok'} size="sm">
              {problem ? <AlertTriangleIcon className="h-3 w-3" /> : <CheckIcon className="h-3 w-3" />}
              {problem ? 'Needs a decision' : 'Decided'}
            </Badge>
            <span className="text-sm font-semibold text-white">{lineLabel(line.type)}</span>
            {line.calculatedDays > 0 && (
              <span className="text-xs text-slate-400 tnum">{line.calculatedDays} day{line.calculatedDays === 1 ? '' : 's'}</span>
            )}
          </div>
          {line.explanation && <p className="mt-1 text-xs leading-relaxed text-slate-300">{line.explanation}</p>}
        </div>
        <dl className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:text-right">
          <dt className="text-slate-500 sm:order-1">Calculated</dt>
          <dd className="font-mono text-slate-200 tnum sm:order-3">{fmt(line.calculatedAmount)}</dd>
          <dt className="text-slate-500 sm:order-2">Approved</dt>
          <dd className="font-mono tnum sm:order-4">{outcome}</dd>
        </dl>
      </div>

      <ul className="mt-2.5 flex flex-col gap-1">
        {line.reviewReasons.length === 0 ? (
          <li className="flex items-start gap-1.5 text-[11px] text-slate-400">
            <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-slate-500" />
            Not classified by the system; approving the run needs an explicit decision on it.
          </li>
        ) : (
          line.reviewReasons.map((r) => (
            <li key={r} className="flex items-start gap-1.5 text-[11px] text-slate-400">
              <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-amber-400/80" />
              {r}
            </li>
          ))
        )}
      </ul>

      <div className="mt-3 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`Decision for ${lineLabel(line.type)}, ${line.employeeName}`}>
          {CHOICES.map((c) => (
            <button
              key={c.choice}
              type="button"
              aria-pressed={d.choice === c.choice}
              onClick={() => choose(c.choice)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition cursor-pointer ${
                d.choice === c.choice ? c.active : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              {c.icon}
              {c.label}
            </button>
          ))}
          {d.choice && (
            <button
              type="button"
              onClick={() => onChange({ ...EMPTY_DECISION })}
              className="rounded-lg px-2 py-1.5 text-[11px] font-semibold text-slate-500 hover:text-slate-200 cursor-pointer"
            >
              Clear
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
          {d.choice === 'CHANGED' && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-slate-400">
                {sign < 0 ? 'Deduct instead' : sign > 0 ? 'Pay instead' : 'Amount (negative deducts)'}
                {recordedCurrency ? ` (${recordedCurrency})` : ''}
              </span>
              <Input
                inputMode="decimal"
                value={d.amount}
                onChange={(ev) => onChange({ ...d, amount: ev.target.value })}
                icon={symbol ? <span className="font-mono text-xs">{symbol}</span> : undefined}
                className="py-2 font-mono"
                aria-invalid={changed === null}
              />
              {changed !== null && line.currency && line.currency.toUpperCase() !== currency && (
                <span className="text-[10px] text-slate-500">= {formatSignedMoney(changed, currency, line.currency, rate)}</span>
              )}
            </label>
          )}
          <label className={`flex flex-col gap-1 ${d.choice === 'CHANGED' ? '' : 'sm:col-span-2'}`}>
            <span className="text-[11px] font-semibold text-slate-400">
              Note{' '}
              {d.choice === 'REJECTED' || d.choice === 'CHANGED' ? '(required)' : '(optional; the run note is used if blank)'}
            </span>
            <Input
              value={d.note}
              onChange={(ev) => onChange({ ...d, note: ev.target.value })}
              placeholder={d.choice === 'REJECTED' ? 'Why is this line rejected?' : d.choice === 'CHANGED' ? 'Why a different amount?' : 'Anything the audit log should say'}
              className="py-2"
              maxLength={500}
            />
          </label>
        </div>
        {problem && d.choice && <p className="text-[11px] font-semibold text-amber-400">{problem}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Routine and already-decided lines
// ---------------------------------------------------------------------------

function RoutineGroup({ lines, fmt }: { lines: PayrollReviewLine[]; fmt: (n: number) => string }) {
  const [open, setOpen] = useState(false);
  const total = money(lines.reduce((s, l) => s + l.calculatedAmount, 0));
  return (
    <div className="rounded-xl border border-white/8 bg-white/3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left cursor-pointer"
      >
        <span className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          <CheckCircleIcon className="h-4 w-4 shrink-0 text-emerald-400" />
          {lines.length} routine line{lines.length === 1 ? '' : 's'}, pre-approved
          <span className="hidden font-normal text-slate-500 sm:inline">· approved with the run</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-xs text-slate-300 tnum">
          {fmt(total)}
          <ChevronDownIcon className={`h-4 w-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-white/5 border-t border-white/8">
          {lines.map((l) => (
            <li key={l.id} className="flex flex-col gap-1 px-3.5 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-200">
                  {lineLabel(l.type)}
                  {l.calculatedDays > 0 && <span className="ml-1.5 font-normal text-slate-500">{l.calculatedDays} day{l.calculatedDays === 1 ? '' : 's'}</span>}
                </div>
                <p className="text-[11px] text-slate-500">{l.explanation}</p>
                {l.reviewReasons.length > 0 && <p className="text-[11px] text-emerald-400/80">{l.reviewReasons.join(' · ')}</p>}
              </div>
              <span className="shrink-0 font-mono text-xs text-slate-200 tnum">{fmt(l.calculatedAmount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DecidedGroup({ lines, fmt }: { lines: PayrollReviewLine[]; fmt: (n: number) => string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-white/8 bg-white/3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left cursor-pointer"
      >
        <span className="text-xs font-semibold text-slate-300">
          {lines.length} line{lines.length === 1 ? '' : 's'} already decided
        </span>
        <ChevronDownIcon className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul className="divide-y divide-white/5 border-t border-white/8">
          {lines.map((l) => {
            const meta = LINE_STATUS_META[l.status] ?? LINE_STATUS_META.PROPOSED;
            const overridden = l.status === 'APPROVED' && l.approvedAmount !== null && l.approvedAmount !== l.calculatedAmount;
            return (
              <li key={l.id} className="flex flex-col gap-1 px-3.5 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={meta.tone} size="sm">{meta.label}</Badge>
                    <span className="text-xs font-semibold text-slate-200">{lineLabel(l.type)}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500">{l.explanation}</p>
                </div>
                <div className="shrink-0 font-mono text-xs tnum sm:text-right">
                  {l.status === 'APPROVED' ? (
                    <span className="text-slate-200">{fmt(Number(l.approvedAmount) || 0)}</span>
                  ) : (
                    <span className="text-slate-500">Not applied</span>
                  )}
                  {(overridden || l.status === 'REJECTED') && (
                    <div className="text-[10px] font-sans text-slate-500">calculated {fmt(l.calculatedAmount)}</div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One employee
// ---------------------------------------------------------------------------

function Figure({ label, value, tone = 'text-slate-200', sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={`break-words font-mono text-sm font-bold tnum ${tone}`}>{value}</dd>
      {sub && <dd className="text-[10px] text-slate-500">{sub}</dd>}
    </div>
  );
}

function EmployeeReviewCard({
  employee: e,
  decisions,
  onDecisionChange,
  currency,
  rate,
  highlightIds,
}: {
  employee: PayrollReviewEmployee;
  decisions: DecisionMap;
  onDecisionChange: (lineId: string, d: LineDecision) => void;
  currency: Currency;
  rate: number;
  highlightIds: Set<string>;
}) {
  const recorded = e.salary.currency || 'GBP';
  const fmt = (n: number) => formatSignedMoney(n, currency, recorded, rate);
  const attention = e.adjustments.filter(needsDecision);
  const routine = e.adjustments.filter(isRoutinePending);
  const decided = e.adjustments.filter((l) => l.status !== 'PROPOSED');

  const projected = e.adjustments.map((l) => projectedAmount(l, decisions[l.id]));
  const deductions = projected.reduce((s, v) => (v < 0 ? s - v : s), 0);
  const additions = projected.reduce((s, v) => (v > 0 ? s + v : s), 0);
  const net = money(e.grossBaseline + projected.reduce((s, v) => s + v, 0));
  const netChanged = Math.abs(net - e.expectedNetPayable) >= 0.005;

  return (
    <article className="rounded-2xl border border-white/10 bg-white/3 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="text-sm font-bold text-white">{e.employeeName}</h4>
            {e.employeeNumber && (
              <span className="rounded-md border border-indigo-500/30 bg-indigo-500/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-indigo-300">
                {e.employeeNumber}
              </span>
            )}
            <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{recorded}</span>
            {e.employeeFlags.map((f) => {
              const m = flagMeta(f);
              return (
                <Badge key={f.code} tone={m.tone} size="sm" className="cursor-help">
                  <span title={f.message}>{m.label}</span>
                </Badge>
              );
            })}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            {e.isPartialPeriod
              ? `Partial period: ${e.workingDaysCount} of ${e.fullPeriodDays} working days`
              : `Full period, ${e.fullPeriodDays} working days`}
            {' · '}deductions counted to {formatDate(e.deductionsThrough)}
          </p>
        </div>
        <dl className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-4 lg:min-w-[440px]">
          <Figure label="Baseline" value={formatMoney(e.grossBaseline, currency, recorded, rate)} />
          <Figure label="Deductions" value={deductions > 0 ? formatMoney(-deductions, currency, recorded, rate) : '—'} tone={deductions > 0 ? 'text-rose-400' : 'text-slate-500'} />
          <Figure label="Additions" value={additions > 0 ? formatSignedMoney(additions, currency, recorded, rate) : '—'} tone={additions > 0 ? 'text-emerald-400' : 'text-slate-500'} />
          <Figure
            label={netChanged ? 'Net, as decided' : 'Expected net'}
            value={formatMoney(net, currency, recorded, rate)}
            tone="text-white"
            sub={netChanged ? `calculated ${formatMoney(e.expectedNetPayable, currency, recorded, rate)}` : undefined}
          />
        </dl>
      </div>

      {e.employeeFlags.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {e.employeeFlags.map((f) => (
            <li key={f.code} className="flex items-start gap-1.5 text-[11px] text-slate-400">
              <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-sky-400/80" />
              {f.message}
            </li>
          ))}
        </ul>
      )}

      {(attention.length > 0 || routine.length > 0 || decided.length > 0) && (
        <div className="mt-3 flex flex-col gap-2">
          {attention.map((l) => (
            <LineDecisionCard
              key={l.id}
              line={toDecidable(e, l)}
              decision={decisions[l.id]}
              onChange={(d) => onDecisionChange(l.id, d)}
              currency={currency}
              rate={rate}
              highlighted={highlightIds.has(l.id)}
            />
          ))}
          {routine.length > 0 && <RoutineGroup lines={routine} fmt={fmt} />}
          {decided.length > 0 && <DecidedGroup lines={decided} fmt={fmt} />}
        </div>
      )}
      {e.adjustments.length === 0 && (
        <p className="mt-3 text-[11px] text-slate-500">No deductions or adjustments: paid the baseline.</p>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// People left out of the run
// ---------------------------------------------------------------------------

function OutsideRun({
  excluded,
  lines,
  decisions,
  onDecisionChange,
  currency,
  rate,
  highlightIds,
  onRecordSalary,
}: {
  excluded: PayrollExcludedEmployee[];
  lines: DecidableLine[];
  decisions: DecisionMap;
  onDecisionChange: (lineId: string, d: LineDecision) => void;
  currency: Currency;
  rate: number;
  highlightIds: Set<string>;
  onRecordSalary?: (employeeId: string) => void;
}) {
  const ids = [...new Set([...excluded.map((x) => x.employeeId), ...lines.map((l) => l.employeeId)])];
  if (ids.length === 0) return null;

  return (
    <section className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4">
      <h4 className="flex items-center gap-2 text-sm font-bold text-amber-300">
        <AlertTriangleIcon className="h-4 w-4 shrink-0" /> Not in this run ({ids.length})
      </h4>
      <p className="mt-1 text-xs text-slate-400">
        These employees get no payslip from this run. A line still proposed for one of them has to be decided before the
        run can be approved, but approving it pays or deducts nothing, because there is no payslip for it to appear on.
        Record a salary to bring them into the run, or reject the line.
      </p>
      <ul className="mt-3 flex flex-col gap-3">
        {ids.map((id) => {
          const x = excluded.find((ex) => ex.employeeId === id);
          const own = lines.filter((l) => l.employeeId === id);
          const name = x?.employeeName ?? own[0]?.employeeName ?? id;
          return (
            <li key={id} className="rounded-xl border border-white/8 bg-slate-950/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold text-white">{name}</span>
                    {x?.employeeNumber && (
                      <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{x.employeeNumber}</span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">{x?.message ?? 'Not part of this run.'}</p>
                </div>
                {onRecordSalary && (!x || x.reason === 'NO_SALARY_ON_RECORD') && (
                  <Button size="sm" variant="secondary" icon={<PlusIcon className="h-3.5 w-3.5" />} onClick={() => onRecordSalary(id)}>
                    Record salary
                  </Button>
                )}
              </div>
              {own.length > 0 && (
                <div className="mt-2 flex flex-col gap-2">
                  {own.map((l) => (
                    <LineDecisionCard
                      key={l.id}
                      line={l}
                      decision={decisions[l.id]}
                      onChange={(d) => onDecisionChange(l.id, d)}
                      currency={currency}
                      rate={rate}
                      highlighted={highlightIds.has(l.id)}
                    />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function ReviewList({
  employees,
  excluded,
  outsideLines,
  decisions,
  onDecisionChange,
  currency,
  rate,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  highlightIds,
  onRecordSalary,
}: {
  employees: PayrollReviewEmployee[];
  excluded: PayrollExcludedEmployee[];
  outsideLines: DecidableLine[];
  decisions: DecisionMap;
  onDecisionChange: (lineId: string, d: LineDecision) => void;
  currency: Currency;
  rate: number;
  filter: ReviewFilter;
  onFilterChange: (f: ReviewFilter) => void;
  search: string;
  onSearchChange: (s: string) => void;
  highlightIds: Set<string>;
  onRecordSalary?: (employeeId: string) => void;
}) {
  const counts: Record<ReviewFilter, number> = {
    ALL: employees.length,
    ATTENTION: employees.filter(employeeNeedsAttention).length,
    DEDUCTIONS: employees.filter(employeeHasDeductions).length,
  };
  const q = search.trim().toLowerCase();
  const shown = employees.filter((e) => {
    if (filter === 'ATTENTION' && !employeeNeedsAttention(e)) return false;
    if (filter === 'DEDUCTIONS' && !employeeHasDeductions(e)) return false;
    if (q && !e.employeeName.toLowerCase().includes(q) && !(e.employeeNumber ?? '').toLowerCase().includes(q)) return false;
    return true;
  });

  const chips: { id: ReviewFilter; label: string }[] = [
    { id: 'ALL', label: 'All' },
    { id: 'ATTENTION', label: 'Needs attention' },
    { id: 'DEDUCTIONS', label: 'Has deductions' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter employees">
          {chips.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={filter === c.id}
              onClick={() => onFilterChange(c.id)}
              className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                filter === c.id
                  ? 'border-indigo-500/60 bg-indigo-500/10 text-white shadow-accent'
                  : 'border-white/10 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200'
              }`}
            >
              {c.label}
              <span className="rounded-md bg-white/10 px-1.5 font-mono text-[10px] tnum">{counts[c.id]}</span>
            </button>
          ))}
        </div>
        <div className="w-full sm:w-64">
          <Input
            value={search}
            onChange={(ev) => onSearchChange(ev.target.value)}
            placeholder="Find an employee"
            icon={<SearchIcon className="h-4 w-4" />}
            className="py-2"
            aria-label="Find an employee"
          />
        </div>
      </div>

      {employees.length === 0 ? (
        <Empty
          icon={<UsersIcon className="h-6 w-6" />}
          title="Nobody is in this run yet"
          description="Employees appear here once they have a salary and are employed on at least one day of the period."
        />
      ) : shown.length === 0 ? (
        <Empty title="No employees match" description="Try another filter or clear the search." />
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((e) => (
            <EmployeeReviewCard
              key={e.employeeId}
              employee={e}
              decisions={decisions}
              onDecisionChange={onDecisionChange}
              currency={currency}
              rate={rate}
              highlightIds={highlightIds}
            />
          ))}
        </div>
      )}

      <OutsideRun
        excluded={excluded}
        lines={outsideLines}
        decisions={decisions}
        onDecisionChange={onDecisionChange}
        currency={currency}
        rate={rate}
        highlightIds={highlightIds}
        onRecordSalary={onRecordSalary}
      />
    </div>
  );
}
