'use client';

/**
 * The monthly payroll run for one period: where it is, what would make
 * approving it wrong, every employee's lines, and the one action that turns
 * it into payslips. After publishing: mark as paid, and the payslips.
 *
 * Decisions made here are held in the browser until "Approve & publish"
 * sends them all at once with POST /periods/:id/approve-run. A refused
 * approval changes nothing on the server, so they are kept for another try.
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type {
  PayrollAdjustment,
  PayrollApproveRunResult,
  PayrollPeriod,
  PayrollReviewSheet,
  PayrollUndecidedLine,
} from '@/lib/types';
import { Badge, Button, Panel } from '@/components/primitives';
import { AlertTriangleIcon, CheckCircleIcon, RefreshIcon, UsersIcon } from '@/components/icons';
import {
  type Currency,
  type RunErrorView,
  describeRunError,
  formatMoney,
  formatPlainAmount,
  formatSignedMoney,
  formatTimestamp,
  isFinalStatus,
  isRoutinePending,
  localDateKey,
  needsDecision,
  preflightLabel,
} from './format';
import { type DecidableLine, type DecisionMap, type LineDecision, decisionProblem, toRunDecision } from './decisions';
import { RunHeader } from './RunHeader';
import { PreflightPanel } from './PreflightPanel';
import { type ReviewFilter, ReviewList, lineDomId, toDecidable } from './ReviewList';
import { ApprovePanel, type PendingProblem } from './ApprovePanel';
import { PayslipsPanel } from './PayslipsPanel';

interface SseDetail {
  type?: string;
  data?: { periodId?: string; category?: string; employeeId?: string | null } | null;
}

export function PayrollRunView({
  period,
  adjustments,
  currency,
  rate,
  refreshKey,
  onChanged,
  onRecordSalary,
}: {
  period: PayrollPeriod;
  /** GET /periods/:id/adjustments, which also lists lines of employees left out of the run. */
  adjustments: PayrollAdjustment[];
  currency: Currency;
  rate: number;
  refreshKey: number;
  /** Something changed on the server: the parent reloads the period list and adjustments. */
  onChanged: () => void;
  onRecordSalary: (employeeId: string) => void;
}) {
  const [today] = useState(() => localDateKey());
  const [sheet, setSheet] = useState<PayrollReviewSheet | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  const [decisions, setDecisions] = useState<DecisionMap>({});
  const [note, setNote] = useState('');
  const [waive, setWaive] = useState(false);
  const [waiverNote, setWaiverNote] = useState('');
  const [filter, setFilter] = useState<ReviewFilter>('ALL');
  const [search, setSearch] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [runError, setRunError] = useState<RunErrorView | null>(null);
  const [extraUndecided, setExtraUndecided] = useState<PayrollUndecidedLine[]>([]);
  const [result, setResult] = useState<PayrollApproveRunResult | null>(null);

  const [regenerating, setRegenerating] = useState(false);
  const [regenNotice, setRegenNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  const reload = () => setReloadTick((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.payrollReview(period.id);
        if (cancelled) return;
        setSheet(res);
        setLoadError('');
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : 'Could not load the payroll run.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period.id, refreshKey, reloadTick]);

  // The review sheet is a heavy read, so it follows payroll events only, not
  // every presence update on the stream: this run being published, and HR's
  // own payroll notifications ("ready for review"). Each employee's "your
  // payslip is ready" is broadcast too, one per payslip, and is ignored.
  useEffect(() => {
    const onSse = (ev: Event) => {
      const detail = (ev as CustomEvent<SseDetail>).detail;
      if (!detail) return;
      if (
        (detail.type === 'PAYROLL_PUBLISHED' && detail.data?.periodId === period.id)
        || (detail.type === 'NOTIFICATION' && detail.data?.category === 'PAYROLL' && !detail.data?.employeeId)
      ) {
        setReloadTick((t) => t + 1);
      }
    };
    window.addEventListener('office-tracker-sse', onSse);
    return () => window.removeEventListener('office-tracker-sse', onSse);
  }, [period.id]);

  if (!sheet) {
    return loadError ? (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
        <span><AlertTriangleIcon className="inline-block h-3.5 w-3.5" /> {loadError}</span>
        <Button size="sm" variant="secondary" onClick={reload} icon={<RefreshIcon className="h-3.5 w-3.5" />}>Try again</Button>
      </div>
    ) : (
      <div className="flex h-48 items-center justify-center">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
      </div>
    );
  }

  const status = sheet.period.status;
  const final = isFinalStatus(status);

  // Every line on the sheet that approve-run would refuse without a decision.
  const sheetLines: DecidableLine[] = sheet.employees.flatMap((e) =>
    e.adjustments.filter(needsDecision).map((l) => toDecidable(e, l)),
  );
  const onSheet = new Set(sheet.employees.flatMap((e) => e.adjustments.map((l) => l.id)));
  const sheetEmployees = new Set(sheet.employees.map((e) => e.employeeId));

  // Lines of employees left out of the run (no salary on record) are not on
  // the review sheet, yet approve-run still refuses while they are proposed.
  // They come from the adjustments list, and from a refusal's own list.
  const outside = new Map<string, DecidableLine>();
  for (const a of adjustments) {
    if (a.status !== 'PROPOSED' || onSheet.has(a.id) || sheetEmployees.has(a.employeeId)) continue;
    outside.set(a.id, {
      id: a.id,
      employeeId: a.employeeId,
      employeeName: a.employeeName,
      type: a.type,
      calculatedAmount: Number(a.calculated.amount) || 0,
      calculatedDays: Number(a.calculated.days) || 0,
      explanation: a.explanation,
      reviewReasons: [],
      currency: null,
    });
  }
  for (const u of extraUndecided) {
    // A line of someone on the sheet shows up there once the sheet reloads.
    if (onSheet.has(u.adjustmentId) || sheetEmployees.has(u.employeeId)) continue;
    outside.set(u.adjustmentId, {
      id: u.adjustmentId,
      employeeId: u.employeeId,
      employeeName: u.employeeName,
      type: u.type,
      calculatedAmount: u.calculatedAmount,
      calculatedDays: u.calculatedDays,
      explanation: outside.get(u.adjustmentId)?.explanation ?? null,
      reviewReasons: u.reviewReasons,
      currency: null,
    });
  }
  const outsideLines = final ? [] : [...outside.values()];
  const toDecide = [...sheetLines, ...outsideLines];

  const problems: PendingProblem[] = [];
  for (const l of toDecide) {
    const p = decisionProblem(l.calculatedAmount, decisions[l.id]);
    if (p) problems.push({ lineId: l.id, employeeName: l.employeeName, type: l.type, problem: p });
  }
  const routinePending = sheet.employees.reduce((s, e) => s + e.adjustments.filter(isRoutinePending).length, 0);
  const blockers = final ? [] : sheet.preflight.filter((c) => c.severity === 'BLOCKING');
  const highlightIds = new Set(runError?.undecided.map((u) => u.adjustmentId) ?? []);

  const currencyOfLine = new Map<string, string>();
  for (const e of sheet.employees) for (const l of e.adjustments) currencyOfLine.set(l.id, e.salary.currency || 'GBP');

  const setDecision = (lineId: string, d: LineDecision) => setDecisions((prev) => ({ ...prev, [lineId]: d }));

  const jumpToLine = (lineId: string) => {
    setFilter('ALL');
    setSearch('');
    // After the filter change has rendered the line.
    window.setTimeout(() => {
      document.getElementById(lineDomId(lineId))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  };

  const approve = async () => {
    setSubmitting(true);
    setRunError(null);
    setResult(null);
    try {
      const res = await api.approvePayrollRun(sheet.period.id, {
        note: note.trim(),
        // Only lines still waiting for one: a line decided elsewhere since
        // is refused by the server rather than decided twice.
        decisions: toDecide.filter((l) => decisions[l.id]?.choice).map((l) => toRunDecision(l, decisions[l.id])),
        ...(blockers.length > 0 && waive ? { waiveBlockers: true, waiverNote: waiverNote.trim() } : {}),
      });
      setResult(res);
      setDecisions({});
      setNote('');
      setWaive(false);
      setWaiverNote('');
      setExtraUndecided([]);
      reload();
      onChanged();
    } catch (e) {
      const view = describeRunError(e, 'approve');
      setRunError(view);
      if (view.code === 'ATTENTION_UNDECIDED') setExtraUndecided(view.undecided);
      // Anything but a missing note may mean the run moved on (it was
      // generated by this very call, a blocker appeared, someone approved or
      // decided a line first): show the latest state. Decisions are kept.
      if (view.code !== 'NOTE_REQUIRED' && view.code !== 'WAIVER_NOTE_REQUIRED') {
        reload();
        onChanged();
      }
      window.setTimeout(() => {
        document.getElementById('payroll-approve')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
    } finally {
      setSubmitting(false);
    }
  };

  const regenerate = async () => {
    setRegenerating(true);
    setRegenNotice(null);
    try {
      const r = await api.generatePayrollDeductions(sheet.period.id);
      setRegenNotice({
        tone: 'ok',
        text: r.createdCount > 0
          ? `${r.createdCount} new line${r.createdCount === 1 ? '' : 's'} added to this run: ${r.classification.routine} routine, ${r.classification.attention} needing attention in total.`
          : 'Nothing new to add: every deduction is already in this run.',
      });
      reload();
      onChanged();
    } catch (e) {
      const view = describeRunError(e, 'generate');
      setRegenNotice({ tone: 'danger', text: `${view.title} ${view.message}` });
    } finally {
      setRegenerating(false);
    }
  };

  const formatUndecidedAmount = (lineId: string, amount: number) => {
    const cur = currencyOfLine.get(lineId);
    return cur ? formatSignedMoney(amount, currency, cur, rate) : formatPlainAmount(amount);
  };

  const resultCurrency = (() => {
    const set = new Set(sheet.employees.map((e) => (e.salary.currency || 'GBP').toUpperCase()));
    return set.size === 1 ? [...set][0] : null;
  })();

  return (
    <div className="flex flex-col gap-6">
      <RunHeader
        period={sheet.period}
        totals={sheet.totals}
        employees={sheet.employees}
        currency={currency}
        rate={rate}
        today={today}
      />

      {loadError && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-300">
          <AlertTriangleIcon className="inline-block h-3.5 w-3.5" /> Could not refresh: {loadError}. Showing the last loaded state.
        </div>
      )}

      {result && (
        <div role="status" className="flex items-start gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          <CheckCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
          <div className="min-w-0 text-xs text-emerald-200/90">
            <p className="text-sm font-bold text-emerald-300">
              Payroll published: {result.payslipCount} payslip{result.payslipCount === 1 ? '' : 's'} written.
            </p>
            <p className="mt-0.5">
              {result.decided.explicit} line{result.decided.explicit === 1 ? '' : 's'} decided by you,{' '}
              {result.decided.routineApproved} routine line{result.decided.routineApproved === 1 ? '' : 's'} approved with the run
              {result.excludedCount > 0 ? `, ${result.excludedCount} employee${result.excludedCount === 1 ? '' : 's'} left out` : ''}.
              {' '}Published {formatTimestamp(result.publishedAt)}.
              {resultCurrency && (
                <> Net {formatMoney(result.totals.net, currency, resultCurrency, rate)} after {formatMoney(result.totals.deductions, currency, resultCurrency, rate)} of deductions.</>
              )}
            </p>
            {result.waivedBlockers.length > 0 && (
              <p className="mt-0.5">Waived: {result.waivedBlockers.map(preflightLabel).join(', ')}.</p>
            )}
          </div>
        </div>
      )}

      {!final && (
        <PreflightPanel
          checks={sheet.preflight}
          onRegenerate={status === 'IN_REVIEW' ? regenerate : undefined}
          regenerating={regenerating}
          notice={regenNotice}
        />
      )}

      {!final && (
        <Panel
          title="Employee review"
          subtitle="Lines that need attention are open for a decision; routine lines are approved with the run"
          icon={<UsersIcon className="h-5 w-5" />}
          actions={
            <>
              <Badge tone={problems.length > 0 ? 'warn' : 'ok'} size="sm">
                {toDecide.length - problems.length} of {toDecide.length} decided
              </Badge>
              <Button size="sm" variant="ghost" onClick={reload} icon={<RefreshIcon className="h-3.5 w-3.5" />}>
                Refresh
              </Button>
            </>
          }
        >
          <p className="mb-4 text-xs text-slate-400">{sheet.note}</p>
          <ReviewList
            employees={sheet.employees}
            excluded={sheet.excluded}
            outsideLines={outsideLines}
            decisions={decisions}
            onDecisionChange={setDecision}
            currency={currency}
            rate={rate}
            filter={filter}
            onFilterChange={setFilter}
            search={search}
            onSearchChange={setSearch}
            highlightIds={highlightIds}
            onRecordSalary={onRecordSalary}
          />
        </Panel>
      )}

      {!final && (
        <ApprovePanel
          status={status}
          cutoffDate={sheet.period.cutoffDate}
          today={today}
          employeeCount={sheet.totals.employees}
          routinePending={routinePending}
          attentionTotal={toDecide.length}
          problems={problems}
          blockers={blockers}
          note={note}
          onNoteChange={setNote}
          waive={waive}
          onWaiveChange={setWaive}
          waiverNote={waiverNote}
          onWaiverNoteChange={setWaiverNote}
          submitting={submitting}
          error={runError}
          formatUndecidedAmount={formatUndecidedAmount}
          isOnPage={(id) => onSheet.has(id) || outside.has(id)}
          onJumpToLine={jumpToLine}
          onSubmit={approve}
        />
      )}

      {(status === 'PUBLISHED' || status === 'PAID') && (
        <PayslipsPanel
          periodId={sheet.period.id}
          status={status}
          payDate={sheet.period.payDate}
          refreshKey={refreshKey + reloadTick}
          currency={currency}
          onChanged={() => {
            reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}
