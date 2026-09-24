'use client';

import type { ReactNode } from 'react';
import type { PayrollReviewEmployee, PayrollReviewTotals, PayrollRunPeriod } from '@/lib/types';
import { Badge } from '@/components/primitives';
import {
  AlertTriangleIcon,
  BanknoteIcon,
  CalendarIcon,
  CheckCircleIcon,
  CheckIcon,
  HourglassIcon,
  UsersIcon,
} from '@/components/icons';
import {
  type Currency,
  PERIOD_STATUS_META,
  formatActor,
  formatDate,
  formatDayMonth,
  formatMoney,
  formatSum,
  formatTimestamp,
  localDateKey,
  standingAmount,
  sumAcrossCurrencies,
} from './format';

type StepState = 'done' | 'current' | 'todo';

interface Step {
  label: string;
  sub: string;
  state: StepState;
}

function dayOf(ms: number | null): string {
  return ms == null ? '' : formatDayMonth(localDateKey(new Date(ms)));
}

/** Where the run is: OPEN -> cut-off -> IN_REVIEW -> PUBLISHED -> PAID. */
function runSteps(period: PayrollRunPeriod, today: string): Step[] {
  const cutoffPassed = !!period.cutoffDate && today > period.cutoffDate;
  const current =
    period.status === 'OPEN' ? (cutoffPassed ? 1 : 0)
      : period.status === 'IN_REVIEW' ? 2
        : period.status === 'PUBLISHED' ? 3
          : period.status === 'PAID' ? 4
            : -1;

  const state = (i: number): StepState => {
    if (period.status === 'PAID') return 'done';
    return i < current ? 'done' : i === current ? 'current' : 'todo';
  };

  return [
    { label: 'Open', sub: formatDayMonth(period.from), state: state(0) },
    {
      label: 'Cut-off',
      sub: period.cutoffDate ? formatDayMonth(period.cutoffDate) : 'None set',
      state: state(1),
    },
    { label: 'In review', sub: dayOf(period.generatedAt) || '—', state: state(2) },
    { label: 'Published', sub: dayOf(period.publishedAt) || '—', state: state(3) },
    {
      label: 'Paid',
      sub: period.paidAt != null ? dayOf(period.paidAt) : period.payDate ? `Due ${formatDayMonth(period.payDate)}` : '—',
      state: state(4),
    },
  ];
}

function statusSentence(period: PayrollRunPeriod, today: string): string {
  switch (period.status) {
    case 'OPEN':
      if (period.cutoffDate && today > period.cutoffDate) {
        return 'The cut-off has passed. Deductions are generated on the next automatic run, or when you approve.';
      }
      return period.cutoffDate
        ? `Collecting attendance. Deductions dated up to ${formatDate(period.cutoffDate)} are generated automatically after the cut-off; anything later rolls into next month.`
        : `No cut-off on this period, so its deductions run to ${formatDate(period.to)}.`;
    case 'IN_REVIEW':
      return `Deductions were generated on ${formatTimestamp(period.generatedAt)}. Decide the lines that need attention, then approve to publish payslips.`;
    case 'PUBLISHED':
      return `Payslips were published on ${formatTimestamp(period.publishedAt)} by ${formatActor(period.publishedBy)}. They are final. Mark the run as paid once the money has gone out.`;
    case 'PAID':
      return `Paid on ${formatTimestamp(period.paidAt)}. This run is complete.`;
    case 'CLOSED':
      return 'A legacy period, closed by hand. It has no payslips.';
  }
}

function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="grid grid-cols-5 gap-1" aria-label="Payroll run progress">
      {steps.map((s, i) => (
        <li
          key={s.label}
          aria-current={s.state === 'current' ? 'step' : undefined}
          className="relative flex min-w-0 flex-col items-center text-center"
        >
          {i < steps.length - 1 && (
            <span
              aria-hidden="true"
              className={`absolute left-1/2 top-3.5 h-0.5 w-full ${
                s.state === 'done' ? 'bg-emerald-500/60' : 'bg-white/10'
              }`}
            />
          )}
          <span
            className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-bold ${
              s.state === 'done'
                ? 'border-transparent bg-emerald-500 text-on-bright'
                : s.state === 'current'
                  ? 'border-transparent bg-accent-gradient text-on-accent shadow-accent'
                  : 'border-white/15 bg-slate-900 text-slate-500'
            }`}
          >
            {s.state === 'done' ? (
              <CheckIcon className="h-3.5 w-3.5" />
            ) : s.state === 'current' ? (
              <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
            ) : (
              i + 1
            )}
          </span>
          <span
            className={`mt-1.5 text-[11px] font-bold leading-tight ${
              s.state === 'todo' ? 'text-slate-500' : s.state === 'current' ? 'text-white' : 'text-slate-300'
            }`}
          >
            {s.label}
          </span>
          <span className="text-[10px] leading-tight text-slate-500 tnum">{s.sub}</span>
        </li>
      ))}
    </ol>
  );
}

function Fact({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/8 bg-white/3 px-3 py-2">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 truncate text-xs font-semibold text-slate-200 tnum" title={typeof value === 'string' ? value : undefined}>
        {value}
      </dd>
      {hint && <dd className="truncate text-[10px] text-slate-500">{hint}</dd>}
    </div>
  );
}

function Tile({ icon, label, value, tone = 'text-white' }: { icon: ReactNode; label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-white/10 bg-white/5 p-3.5">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
        <span className="shrink-0 text-slate-400">{icon}</span>
        {label}
      </div>
      <div className={`mt-1.5 break-words font-mono text-base font-bold tracking-tight tnum sm:text-lg ${tone}`}>{value}</div>
    </div>
  );
}

export function RunHeader({
  period,
  totals,
  employees,
  currency,
  rate,
  today,
}: {
  period: PayrollRunPeriod;
  totals: PayrollReviewTotals;
  employees: PayrollReviewEmployee[];
  currency: Currency;
  rate: number;
  today: string;
}) {
  const meta = PERIOD_STATUS_META[period.status];

  // The backend's totals add raw numbers across employees whatever their
  // salary currency. That is right when everyone shares one currency; with a
  // mix, the figures are summed here per currency instead.
  const currencies = new Set(employees.map((e) => (e.salary.currency || 'GBP').toUpperCase()));
  const mixed = currencies.size > 1;
  const recorded = currencies.size === 1 ? [...currencies][0] : 'GBP';

  let gross: string;
  let deductions: string;
  let net: string;
  if (!mixed) {
    gross = formatMoney(totals.gross, currency, recorded, rate);
    deductions = formatMoney(totals.deductions, currency, recorded, rate);
    net = formatMoney(totals.net, currency, recorded, rate);
  } else {
    const sum = (pick: (e: PayrollReviewEmployee) => number) =>
      formatSum(sumAcrossCurrencies(employees.map((e) => ({ amount: pick(e), currency: e.salary.currency })), currency, rate));
    gross = sum((e) => e.grossBaseline);
    deductions = sum((e) => e.adjustments.reduce((s, l) => {
      const v = standingAmount(l);
      return v < 0 ? s - v : s;
    }, 0));
    net = sum((e) => e.expectedNetPayable);
  }

  const steps = runSteps(period, today);

  return (
    <section aria-label="Payroll run" className="glass-panel rounded-3xl p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-gradient text-on-accent shadow-accent">
            <BanknoteIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-extrabold tracking-tight text-white">{period.name}</h2>
            <p className="text-xs text-slate-400">
              {formatDate(period.from)} to {formatDate(period.to)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={meta.tone} dot>{meta.label}</Badge>
          <Badge tone={period.autoCreated ? 'accent' : 'muted'} size="sm">
            {period.autoCreated ? 'Opened automatically' : 'Created by hand'}
          </Badge>
        </div>
      </div>

      {period.status !== 'CLOSED' && (
        <div className="mt-5">
          <Stepper steps={steps} />
        </div>
      )}
      <p className="mt-4 text-xs leading-relaxed text-slate-400">{statusSentence(period, today)}</p>

      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Fact
          label="Cut-off"
          value={period.cutoffDate ? formatDate(period.cutoffDate) : 'None'}
          hint={period.cutoffDate ? 'Later days roll into next month' : `Runs to ${formatDate(period.to)}`}
        />
        <Fact label="Pay date" value={formatDate(period.payDate)} />
        <Fact label="Generated" value={formatTimestamp(period.generatedAt)} />
        <Fact
          label="Published"
          value={formatTimestamp(period.publishedAt)}
          hint={period.publishedBy ? `by ${formatActor(period.publishedBy)}` : undefined}
        />
        <Fact label="Paid" value={formatTimestamp(period.paidAt)} />
        <Fact label="Exchange rate" value={`£1 = ₨${rate.toFixed(2)}`} />
      </dl>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile icon={<UsersIcon className="h-3.5 w-3.5" />} label="Employees" value={String(totals.employees)} />
        <Tile icon={<BanknoteIcon className="h-3.5 w-3.5" />} label="Gross" value={gross} />
        <Tile icon={<BanknoteIcon className="h-3.5 w-3.5" />} label="Deductions" value={deductions} tone="text-rose-400" />
        <Tile icon={<BanknoteIcon className="h-3.5 w-3.5" />} label="Net" value={net} tone="text-emerald-400" />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone="ok" size="sm">
          <CheckCircleIcon className="h-3 w-3" /> {totals.routineCount} routine pending
        </Badge>
        <Badge tone={totals.attentionCount > 0 ? 'warn' : 'muted'} size="sm">
          <AlertTriangleIcon className="h-3 w-3" /> {totals.attentionCount} need attention
        </Badge>
        <Badge tone="muted" size="sm">
          <HourglassIcon className="h-3 w-3" /> {totals.pendingCount} pending in total
        </Badge>
        <Badge tone="dim" size="sm">
          <CalendarIcon className="h-3 w-3" /> {totals.decidedCount} already decided
        </Badge>
      </div>

      {mixed && (
        <p className="mt-3 text-[11px] text-slate-500">
          Salaries here are in more than one currency ({[...currencies].join(', ')}). Totals are converted at the
          period rate where it applies; other currencies are shown separately.
        </p>
      )}
    </section>
  );
}
