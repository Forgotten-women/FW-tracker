'use client';

import { type ReactNode, useState } from 'react';
import type { PayrollPeriodStatus, PayrollPreflightCheck } from '@/lib/types';
import { Badge, Button, Panel } from '@/components/primitives';
import { AlertTriangleIcon, CheckCircleIcon, CheckIcon, LockIcon, XIcon } from '@/components/icons';
import { type RunErrorView, formatDate, lineLabel, preflightLabel } from './format';

export interface PendingProblem {
  lineId: string;
  employeeName: string;
  type: string;
  problem: string;
}

const textareaClass =
  'w-full resize-y rounded-xl border border-white/10 bg-slate-900/70 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500/70 focus:bg-slate-900 focus:outline-none focus:ring-4 focus:ring-indigo-500/15 transition-all';

function Requirement({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
          ok ? 'bg-emerald-500 text-on-bright' : 'border border-white/20 text-slate-500'
        }`}
      >
        {ok ? <CheckIcon className="h-2.5 w-2.5" /> : <XIcon className="h-2.5 w-2.5" />}
      </span>
      <span className={ok ? 'text-slate-300' : 'text-slate-400'}>{children}</span>
    </li>
  );
}

/**
 * The one primary action of a run. Approving is a person's decision about
 * every line: ROUTINE lines go through in bulk under the note, each ATTENTION
 * line carries its own decision, and blockers need an explicit waiver.
 */
export function ApprovePanel({
  status,
  cutoffDate,
  today,
  employeeCount,
  routinePending,
  attentionTotal,
  problems,
  blockers,
  note,
  onNoteChange,
  waive,
  onWaiveChange,
  waiverNote,
  onWaiverNoteChange,
  submitting,
  error,
  formatUndecidedAmount,
  isOnPage,
  onJumpToLine,
  onSubmit,
}: {
  status: PayrollPeriodStatus;
  cutoffDate: string | null;
  today: string;
  employeeCount: number;
  routinePending: number;
  attentionTotal: number;
  problems: PendingProblem[];
  blockers: PayrollPreflightCheck[];
  note: string;
  onNoteChange: (v: string) => void;
  waive: boolean;
  onWaiveChange: (v: boolean) => void;
  waiverNote: string;
  onWaiverNoteChange: (v: string) => void;
  submitting: boolean;
  error: RunErrorView | null;
  formatUndecidedAmount: (lineId: string, amount: number) => string;
  isOnPage: (lineId: string) => boolean;
  onJumpToLine: (lineId: string) => void;
  onSubmit: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const decidedCount = attentionTotal - problems.length;
  const linesReady = problems.length === 0;
  const noteReady = note.trim().length > 0;
  const hasBlockers = blockers.length > 0;
  const waiverReady = !hasBlockers || (waive && waiverNote.trim().length > 0);
  const canApprove = (status === 'OPEN' || status === 'IN_REVIEW') && linesReady && noteReady && waiverReady && !submitting;
  const beforeCutoff = status === 'OPEN' && !!cutoffDate && today <= cutoffDate;

  return (
    <Panel
      title="Approve & publish payroll"
      subtitle="Writes every payslip. Published payslips are final and appear on employees' phones."
      icon={<LockIcon className="h-5 w-5" />}
    >
      <div id="payroll-approve" className="flex scroll-mt-24 flex-col gap-4">
        {status === 'OPEN' && (
          <div className="flex items-start gap-2.5 rounded-xl border border-sky-500/25 bg-sky-500/5 px-3.5 py-2.5 text-xs text-slate-300">
            <AlertTriangleIcon className="mt-px h-4 w-4 shrink-0 text-sky-400" />
            <span>
              Deductions have not been generated for this period yet. Approving generates them first
              {beforeCutoff ? `, before the ${formatDate(cutoffDate)} cut-off; anything recorded after that goes into next month's run` : ''}.
              If any of them need a decision, nothing is published and they are shown here to decide.
            </span>
          </div>
        )}

        <ul className="flex flex-col gap-1.5">
          <Requirement ok={linesReady}>
            {attentionTotal === 0
              ? 'No line needs an individual decision.'
              : `Lines needing attention decided: ${decidedCount} of ${attentionTotal}.`}
          </Requirement>
          <Requirement ok={noteReady}>An approval note, kept in the audit log with the run.</Requirement>
          {hasBlockers && (
            <Requirement ok={waiverReady}>
              {blockers.length} blocking issue{blockers.length === 1 ? '' : 's'} waived, with a note saying why.
            </Requirement>
          )}
          <li className="flex items-start gap-2 text-xs text-slate-400">
            <CheckCircleIcon className="mt-px h-4 w-4 shrink-0 text-emerald-400" />
            {routinePending} routine line{routinePending === 1 ? '' : 's'} will be approved with the run, under your note.
          </li>
        </ul>

        {problems.length > 0 && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-amber-400">Still to decide</p>
            <ul className="mt-2 flex flex-col gap-1">
              {problems.slice(0, 8).map((p) => (
                <li key={p.lineId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 text-slate-300">
                    <span className="font-semibold text-white">{p.employeeName}</span> · {lineLabel(p.type)}
                    <span className="text-slate-500"> · {p.problem}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onJumpToLine(p.lineId)}
                    className="text-[11px] font-semibold text-indigo-300 hover:text-indigo-200 cursor-pointer"
                  >
                    Go to line
                  </button>
                </li>
              ))}
              {problems.length > 8 && <li className="text-[11px] text-slate-500">and {problems.length - 8} more.</li>}
            </ul>
          </div>
        )}

        {hasBlockers && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3.5">
            <p className="flex items-center gap-2 text-xs font-bold text-rose-300">
              <AlertTriangleIcon className="h-4 w-4 shrink-0" />
              The preflight found {blockers.length} blocking issue{blockers.length === 1 ? '' : 's'}:
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {blockers.map((b) => (
                <li key={b.code}>
                  <Badge tone="danger" size="sm">{preflightLabel(b.code)} ({b.count})</Badge>
                </li>
              ))}
            </ul>
            <label className="mt-3 flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={waive}
                onChange={(ev) => onWaiveChange(ev.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-rose-500"
              />
              <span>
                <span className="font-semibold">Approve anyway.</span> I have checked these issues and the run should be
                published without resolving them. The waiver is recorded in the audit log.
              </span>
            </label>
            {waive && (
              <label className="mt-3 flex flex-col gap-1">
                <span className="text-[11px] font-semibold text-slate-400">Waiver note (required)</span>
                <textarea
                  rows={2}
                  value={waiverNote}
                  onChange={(ev) => onWaiverNoteChange(ev.target.value)}
                  placeholder="Why is it right to publish with these issues open?"
                  className={textareaClass}
                  maxLength={1000}
                />
              </label>
            )}
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-slate-400">Approval note (required)</span>
          <textarea
            rows={2}
            value={note}
            onChange={(ev) => onNoteChange(ev.target.value)}
            placeholder="e.g. September payroll, checked against the attendance report"
            className={textareaClass}
            maxLength={1000}
          />
        </label>

        {error && (
          <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs">
            <p className="flex items-center gap-2 font-bold text-rose-300">
              <AlertTriangleIcon className="h-4 w-4 shrink-0" />
              {error.title}
            </p>
            <p className="mt-1 text-rose-200/90">{error.message}</p>
            {error.undecided.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {error.undecided.map((u) => (
                  <li key={u.adjustmentId} className="flex flex-wrap items-center justify-between gap-2 text-slate-300">
                    <span className="min-w-0">
                      <span className="font-semibold text-white">{u.employeeName}</span> · {lineLabel(u.type)}{' '}
                      <span className="font-mono tnum">{formatUndecidedAmount(u.adjustmentId, u.calculatedAmount)}</span>
                      {u.reviewReasons.length > 0 && <span className="text-slate-500"> · {u.reviewReasons.join('; ')}</span>}
                    </span>
                    {isOnPage(u.adjustmentId) && (
                      <button
                        type="button"
                        onClick={() => onJumpToLine(u.adjustmentId)}
                        className="text-[11px] font-semibold text-indigo-300 hover:text-indigo-200 cursor-pointer"
                      >
                        Go to line
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {error.blockers.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1.5">
                {error.blockers.map((b) => (
                  <li key={b.code} className="text-slate-300">
                    <span className="font-semibold text-white">{preflightLabel(b.code)} ({b.count})</span>
                    <span className="text-slate-400"> · {b.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {confirming ? (
          <div className="flex flex-col gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-slate-300">
              Publish payslips for {employeeCount} employee{employeeCount === 1 ? '' : 's'} now? They cannot be edited
              afterwards.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="secondary" onClick={() => setConfirming(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button
                variant="accent"
                disabled={!canApprove}
                onClick={() => {
                  setConfirming(false);
                  onSubmit();
                }}
                icon={<CheckIcon className="h-4 w-4" />}
              >
                Publish now
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="accent"
            size="lg"
            className="w-full sm:w-auto sm:self-end"
            disabled={!canApprove}
            onClick={() => setConfirming(true)}
            icon={
              submitting ? (
                <span className="block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <LockIcon className="h-4 w-4" />
              )
            }
          >
            {submitting ? 'Publishing…' : 'Approve & publish payroll'}
          </Button>
        )}
      </div>
    </Panel>
  );
}
