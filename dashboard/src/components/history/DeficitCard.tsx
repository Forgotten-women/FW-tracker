'use client';

// The Deficit card (HR requirements 2026-11-12, sections 9-16, 19, 36).
//
// A clickable tile on the employee's month: previous period deficit, new
// deficit this period, total, completed 8-hour deficit days, remaining
// hours/minutes. Opened, it lets HR settle completed days (paid annual leave /
// unpaid / carried forward, plus hours as unpaid) and, separately, decide a
// fixed penalty - each through Review & Confirm. Earlier periods stay
// visible as history. Nothing here is automatic.

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import type { DeficitPeriod, DeficitPeriodView, DeficitPenaltyPreview, DeficitSettlementPreview } from '@/lib/types';
import { Badge, Button } from '@/components/primitives';
import { AlertTriangleIcon, ClockIcon, HistoryIcon, XIcon } from '@/components/icons';
import { ReviewConfirm, type ReviewRow } from '@/components/ReviewConfirm';

function fmt(m: number): string {
  const n = Math.max(0, Math.round(m));
  const h = Math.floor(n / 60);
  const r = n % 60;
  if (h === 0) return `${r}m`;
  return r === 0 ? `${h}h` : `${h}h ${String(r).padStart(2, '0')}m`;
}

function errorInfo(err: unknown): { message: string; code: string | null; details: Record<string, unknown> | null } {
  if (err instanceof ApiError) {
    const body = (err.body ?? {}) as { code?: string; details?: Record<string, unknown> };
    return { message: err.message, code: body.code ?? null, details: body.details ?? null };
  }
  return { message: err instanceof Error ? err.message : 'Something went wrong.', code: null, details: null };
}

// ---------------------------------------------------------------------------
// The tile
// ---------------------------------------------------------------------------

export function DeficitTile({ employeeId, month, onOpen }: { employeeId: string; month: string; onOpen: () => void }) {
  const [view, setView] = useState<DeficitPeriodView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Remounted by its key when the month or the card changes, so no reset here.
  useEffect(() => {
    let alive = true;
    api.deficitPeriod(employeeId, month)
      .then((v) => { if (alive) setView(v); })
      .catch((err) => { if (alive) setNote(errorInfo(err).message); });
    return () => { alive = false; };
  }, [employeeId, month]);

  const p = view?.period;
  const total = p?.total.minutes ?? 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left rounded-xl border border-white/8 bg-white/5 px-3 py-2.5 hover:border-rose-400/40 hover:bg-white/8 transition cursor-pointer"
      title="Open the deficit card: settlement, carry forward and penalty"
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center justify-between">
        <span>Deficit</span>
        <span className="text-[9px] normal-case tracking-normal text-rose-300/80">Open card →</span>
      </div>
      <div className={`mt-0.5 font-mono text-lg font-bold leading-tight tnum ${total > 0 ? 'text-rose-400' : 'text-slate-400'}`}>
        {p ? (total > 0 ? `−${fmt(total)}` : '0m') : note ? '—' : '…'}
      </div>
      <div className="text-[10px] text-slate-500 truncate">
        {p
          ? `${p.convertedDays} day${p.convertedDays === 1 ? '' : 's'} + ${fmt(p.remaining.minutes)} · prev ${fmt(p.previous.minutes)}${p.settled.minutes > 0 ? ` · settled ${fmt(p.settled.minutes)}` : ''}`
          : note ?? 'loading'}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function Row({ label, value, tone = '' }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2 text-xs">
      <span className="text-text-secondary font-medium">{label}</span>
      <span className={`font-mono font-semibold ${tone || 'text-text'}`}>{value}</span>
    </div>
  );
}

type Mode = 'VIEW' | 'SETTLE' | 'SETTLE_REVIEW' | 'PENALTY' | 'PENALTY_REVIEW';

export function DeficitCardModal({
  employeeId, employeeName, month, onClose, onChanged,
}: { employeeId: string; employeeName: string; month: string; onClose: () => void; onChanged?: () => void }) {
  const [view, setView] = useState<DeficitPeriodView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('VIEW');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Settlement form
  const [alDays, setAlDays] = useState(0);
  const [unpaidDays, setUnpaidDays] = useState(0);
  const [unpaidHours, setUnpaidHours] = useState(0);
  const [unpaidMins, setUnpaidMins] = useState(0);
  const [reason, setReason] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [allowOutstanding, setAllowOutstanding] = useState(false);
  const [settlePreview, setSettlePreview] = useState<DeficitSettlementPreview | null>(null);

  // Penalty form
  const [option, setOption] = useState<'NONE' | 'OPTION_1' | 'OPTION_2'>('NONE');
  const [penaltyPreview, setPenaltyPreview] = useState<DeficitPenaltyPreview | null>(null);
  const [alreadyApplied, setAlreadyApplied] = useState<{ penaltyType?: string; dateApplied?: string; approvedBy?: string } | null>(null);

  const load = useCallback(() => api.deficitPeriod(employeeId, month)
    .then((v) => { setView(v); setLoadError(null); })
    .catch((err) => { setLoadError(errorInfo(err).message); }), [employeeId, month]);
  useEffect(() => { void load(); }, [load]);

  const p = view?.period ?? null;
  const unpaidMinutes = unpaidHours * 60 + unpaidMins;
  const settledMinutes = (alDays + unpaidDays) * 480 + unpaidMinutes;
  const carryAfter = p ? Math.max(0, p.available.minutes - settledMinutes) : 0;

  const reset = () => { setError(null); setAllowOutstanding(false); setAlreadyApplied(null); };

  const previewSettlement = async () => {
    if (!p) return;
    setError(null);
    if (settledMinutes <= 0) { setError('Choose at least one deficit day, or some hours, to settle.'); return; }
    if (!reason.trim()) { setError('A reason is required.'); return; }
    if (!approvedBy.trim()) { setError('Approved by is required.'); return; }
    setBusy(true);
    try {
      const r = await api.deficitSettlePreview(employeeId, { period: month, alDays, unpaidDays, unpaidMinutes });
      setSettlePreview(r.preview);
      setMode('SETTLE_REVIEW');
    } catch (err) {
      setError(errorInfo(err).message);
    } finally { setBusy(false); }
  };

  const confirmSettlement = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.deficitSettle(employeeId, { period: month, alDays, unpaidDays, unpaidMinutes, reason: reason.trim(), approvedBy: approvedBy.trim(), allowOutstanding });
      setView(r.view);
      setDone(r.message);
      setMode('VIEW');
      setAlDays(0); setUnpaidDays(0); setUnpaidHours(0); setUnpaidMins(0); setReason(''); setAllowOutstanding(false);
      onChanged?.();
    } catch (err) {
      const e = errorInfo(err);
      if (e.code === 'INSUFFICIENT_BALANCE') setError(`Insufficient accrued annual leave balance: ${e.message}`);
      else setError(e.message);
    } finally { setBusy(false); }
  };

  const previewPenalty = async () => {
    setError(null);
    setAlreadyApplied(null);
    if (!reason.trim()) { setError('A reason is required.'); return; }
    if (!approvedBy.trim()) { setError('Approved by is required.'); return; }
    setBusy(true);
    try {
      const r = await api.deficitPenaltyPreview(employeeId, { period: month, option });
      setPenaltyPreview(r.preview);
      setMode('PENALTY_REVIEW');
    } catch (err) {
      const e = errorInfo(err);
      if (e.code === 'PENALTY_ALREADY_APPLIED') setAlreadyApplied((e.details ?? {}) as { penaltyType?: string; dateApplied?: string; approvedBy?: string });
      setError(e.message);
    } finally { setBusy(false); }
  };

  const confirmPenalty = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.deficitPenalty(employeeId, { period: month, option, reason: reason.trim(), approvedBy: approvedBy.trim(), allowOutstanding });
      setView(r.view);
      setDone(r.message);
      setMode('VIEW');
      setReason(''); setAllowOutstanding(false);
      onChanged?.();
    } catch (err) {
      const e = errorInfo(err);
      setError(e.code === 'INSUFFICIENT_BALANCE' ? `Insufficient accrued annual leave balance: ${e.message}` : e.message);
    } finally { setBusy(false); }
  };

  const periodSummary = (x: DeficitPeriod) => (
    <div className="rounded-xl border border-line-strong bg-raised divide-y divide-line">
      <Row label="Previous period deficit (carried forward)" value={fmt(x.previous.minutes)} />
      <Row label={`New deficit this period${x.credits.minutes > 0 ? ` (${fmt(x.newGross.minutes)} − ${fmt(x.credits.minutes)} HR credit)` : ''}`} value={x.current.formatted} />
      <Row label="Total deficit" value={fmt(x.total.minutes)} tone={x.total.minutes > 0 ? 'text-rose-400 font-bold' : ''} />
      <Row label="Completed 8-hour deficit days" value={`${x.convertedDays} day${x.convertedDays === 1 ? '' : 's'}`} tone={x.convertedDays > 0 ? 'text-rose-400 font-bold' : ''} />
      <Row label="Remaining hours/minutes" value={fmt(x.remaining.minutes)} />
      <Row label="Settled this period" value={x.settled.minutes > 0 ? `${fmt(x.settled.minutes)} (AL ${x.settled.alDays}d · unpaid ${x.settled.unpaidDays}d${x.settled.unpaidMinutes ? ` + ${fmt(x.settled.unpaidMinutes)}` : ''})` : 'Nothing yet'} />
      <Row label="Carried forward to next period" value={`${x.carriedForward.days} day${x.carriedForward.days === 1 ? '' : 's'} + ${fmt(x.carriedForward.remainingMinutes)} (${fmt(x.carriedForward.minutes)})`} tone={x.carriedForward.minutes > 0 ? 'text-amber-400 font-bold' : ''} />
      <Row label="Penalty" value={x.penalty ? `${x.penalty.label} · ${x.penalty.approvedBy} · ${x.penalty.at}` : 'No decision recorded'} tone={x.penalty && x.penalty.option !== 'NONE' ? 'text-rose-400 font-bold' : ''} />
    </div>
  );

  const settlementRows: ReviewRow[] = settlePreview ? [
    { label: 'Current value (deficit open this period)', value: `${settlePreview.period.available.days} days + ${fmt(settlePreview.period.available.remainingMinutes)}` },
    { label: 'Proposed change', value: `Settle ${settlePreview.settlement.settledFormatted}: ${alDays} day(s) paid annual leave, ${unpaidDays} day(s) unpaid${unpaidMinutes ? ` + ${fmt(unpaidMinutes)} unpaid` : ''}` },
    { label: 'Annual leave impact', value: settlePreview.annualLeave ? `−${alDays} day(s) · available ${settlePreview.annualLeave.availableDays} → ${settlePreview.annualLeave.balanceAfter}${settlePreview.annualLeave.outstandingDays > 0 ? ` · ${settlePreview.annualLeave.outstandingDays} day(s) cannot be covered` : ''}` : 'None', tone: settlePreview.annualLeave && !settlePreview.annualLeave.sufficient ? 'danger' : alDays > 0 ? 'warn' : undefined },
    { label: 'Payroll impact', value: settlePreview.payroll.deduction ? `${settlePreview.payroll.dayEquivalents} day equivalent(s) unpaid, proposed to the payroll run` : 'No payroll deduction', tone: settlePreview.payroll.deduction ? 'warn' : undefined },
    { label: 'Carried forward after this', value: `${settlePreview.carryForward.days} day(s) + ${fmt(settlePreview.carryForward.remainingMinutes)} (${fmt(settlePreview.carryForward.minutes)})` },
    { label: 'Effective period', value: settlePreview.period.label },
    { label: 'Reason', value: reason.trim() },
    { label: 'Approved by', value: approvedBy.trim() },
  ] : [];

  const penaltyRows: ReviewRow[] = penaltyPreview ? [
    { label: 'Deficit this period', value: `${penaltyPreview.period.convertedDays} completed day(s) (${fmt(penaltyPreview.period.total.minutes)})` },
    { label: 'Proposed penalty', value: penaltyPreview.label, tone: option === 'NONE' ? undefined : 'danger' },
    { label: 'Annual leave impact', value: penaltyPreview.annualLeave ? `−${penaltyPreview.alDays} day(s) · available ${penaltyPreview.annualLeave.availableDays} → ${penaltyPreview.annualLeave.balanceAfter}${penaltyPreview.annualLeave.outstandingDays > 0 ? ` · ${penaltyPreview.annualLeave.outstandingDays} day(s) cannot be covered` : ''}` : 'None', tone: penaltyPreview.annualLeave && !penaltyPreview.annualLeave.sufficient ? 'danger' : penaltyPreview.alDays > 0 ? 'warn' : undefined },
    { label: 'Payroll impact', value: penaltyPreview.payroll.deduction ? `${penaltyPreview.payDays} day('s) pay, proposed to the payroll run` : 'No payroll deduction', tone: penaltyPreview.payroll.deduction ? 'warn' : undefined },
    { label: 'Effective period', value: penaltyPreview.period.label },
    { label: 'Reason', value: reason.trim() },
    { label: 'Approved by', value: approvedBy.trim() },
  ] : [];

  const insufficient = (mode === 'SETTLE_REVIEW' && settlePreview?.annualLeave && !settlePreview.annualLeave.sufficient)
    || (mode === 'PENALTY_REVIEW' && penaltyPreview?.annualLeave && !penaltyPreview.annualLeave.sufficient);

  const outstandingChoice = insufficient ? (
    <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs space-y-2">
      <div className="font-bold text-rose-200 flex items-center gap-2"><AlertTriangleIcon className="h-4 w-4" /> Insufficient accrued annual leave balance</div>
      <p className="text-rose-200/80">The balance cannot cover the whole charge. Review the treatment, or hold the shortfall as an Outstanding Annual Leave Adjustment (applied as leave accrues, and included in the final balance on leaving).</p>
      <label className="flex items-center gap-2 cursor-pointer text-text">
        <input type="checkbox" checked={allowOutstanding} onChange={(e) => setAllowOutstanding(e.target.checked)} className="h-4 w-4" />
        Hold the shortfall as an Outstanding Annual Leave Adjustment
      </label>
    </div>
  ) : null;

  const num = (v: string, max = 99) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  const fieldClass = 'mt-1 w-full rounded-lg border border-line-strong bg-sheet px-3 py-2 text-text placeholder:text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25';

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={`Deficit card · ${employeeName}`}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="glass-panel-elevated relative w-full max-w-2xl rounded-3xl p-6 my-auto max-h-[92vh] overflow-y-auto space-y-4 text-text">
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-line">
          <div>
            <h2 className="text-base font-bold text-text flex items-center gap-2"><ClockIcon className="h-5 w-5 text-rose-400" /> Deficit card · {employeeName}</h2>
            <p className="text-xs text-muted mt-0.5">{p ? p.label : month} · 8 hours = 1 deficit day · settlement and penalty are separate HR decisions</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-xl text-muted hover:text-text hover:bg-raised transition" aria-label="Close"><XIcon className="h-5 w-5" /></button>
        </div>

        {loadError && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{loadError}</div>}
        {done && <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">{done}</div>}

        {p && mode === 'VIEW' && (
          <>
            {periodSummary(p)}
            {view?.leaveBalance && !view.leaveBalance.blocked && (
              <div className="text-xs text-text-secondary">
                Annual leave available: <strong className="text-text">{view.leaveBalance.availableDays} day(s)</strong>
                {view.leaveBalance.outstandingAdjustmentDays > 0 && <> · outstanding adjustment: <strong className="text-rose-300">{view.leaveBalance.outstandingAdjustmentDays} day(s)</strong></>}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="success" disabled={p.available.minutes <= 0} onClick={() => { reset(); setDone(null); setMode('SETTLE'); }}>Settle deficit…</Button>
              <Button variant="danger" onClick={() => { reset(); setDone(null); setOption(p.penalty?.option ?? 'NONE'); setMode('PENALTY'); }}>Penalty decision…</Button>
            </div>

            {p.settlements.length > 0 && (
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-muted mb-1">Settlements this period</div>
                <div className="divide-y divide-line rounded-xl border border-line-strong bg-raised text-xs">
                  {p.settlements.map((s) => (
                    <div key={s.id} className="px-3 py-2">
                      <div className="flex justify-between gap-3"><span className="font-semibold text-text">{s.settledFormatted}</span><span className="text-muted">{s.at}</span></div>
                      <div className="text-text-secondary">AL {s.alDays}d · unpaid {s.unpaidDays}d{s.unpaidMinutes ? ` + ${fmt(s.unpaidMinutes)}` : ''} · {s.reason} · approved by {s.approvedBy}{s.outstandingAdjustmentId ? ' · shortfall held as outstanding adjustment' : ''}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {view && view.history.length > 0 && (
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-muted mb-1 flex items-center gap-1"><HistoryIcon className="h-3.5 w-3.5" /> Previous periods</div>
                <div className="divide-y divide-line rounded-xl border border-line-strong bg-raised text-xs">
                  {view.history.map((h) => (
                    <div key={h.periodKey} className="px-3 py-2 flex flex-wrap justify-between gap-x-4 gap-y-0.5">
                      <span className="font-semibold text-text">{h.label}</span>
                      <span className="text-text-secondary">prev {fmt(h.previous.minutes)} + new {h.current.formatted} = {fmt(h.total.minutes)} · settled {fmt(h.settled.minutes)} · carried {fmt(h.carriedForward.minutes)}{h.penalty ? ` · penalty: ${h.penalty.label}` : ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {p.entries.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer font-medium text-text-secondary hover:text-text transition">Ledger entries this period ({p.entries.length})</summary>
                <div className="mt-1.5 divide-y divide-line rounded-xl border border-line-strong bg-raised">
                  {p.entries.map((e) => (
                    <div key={e.id} className="px-3 py-1.5 flex justify-between gap-3">
                      <span className="text-text-secondary">{e.date} · {e.description}</span>
                      <span className={`font-mono font-semibold ${e.minutes > 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{e.minutes > 0 ? '+' : '−'}{fmt(Math.abs(e.minutes))}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}

        {p && mode === 'SETTLE' && (
          <div className="space-y-3 text-xs">
            <div className="rounded-xl border border-line-strong bg-raised p-3 text-text-secondary">
              Open this period: <strong className="text-text">{p.available.days} completed day(s) + {fmt(p.available.remainingMinutes)}</strong> ({fmt(p.available.minutes)}). Choose how many days are covered by paid annual leave or treated as unpaid; everything else carries forward automatically.
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="text-[11px] font-semibold text-text-secondary">Paid annual leave (days)</span>
                <input type="number" min={0} max={p.available.days} value={alDays} onChange={(e) => setAlDays(num(e.target.value, p.available.days))} className={`${fieldClass} font-mono`} /></label>
              <label className="block"><span className="text-[11px] font-semibold text-text-secondary">Unpaid (days)</span>
                <input type="number" min={0} max={p.available.days} value={unpaidDays} onChange={(e) => setUnpaidDays(num(e.target.value, p.available.days))} className={`${fieldClass} font-mono`} /></label>
              <label className="block"><span className="text-[11px] font-semibold text-text-secondary">Unpaid hours (of the remainder)</span>
                <input type="number" min={0} max={7} value={unpaidHours} onChange={(e) => setUnpaidHours(num(e.target.value, 7))} className={`${fieldClass} font-mono`} /></label>
              <label className="block"><span className="text-[11px] font-semibold text-text-secondary">Unpaid minutes</span>
                <input type="number" min={0} max={59} value={unpaidMins} onChange={(e) => setUnpaidMins(num(e.target.value, 59))} className={`${fieldClass} font-mono`} /></label>
            </div>
            <div className="rounded-xl border border-line-strong bg-raised divide-y divide-line">
              <Row label="Settled" value={fmt(settledMinutes)} />
              <Row label="Carried forward (calculated)" value={`${Math.floor(carryAfter / 480)} day(s) + ${fmt(carryAfter % 480)} (${fmt(carryAfter)})`} tone="text-amber-300" />
            </div>
            {settledMinutes > p.available.minutes && <div className="text-rose-300 font-medium">Settlement exceeds available deficit. Please review.</div>}
            <label className="block"><span className="text-[11px] font-semibold text-text-secondary">Reason (required)</span>
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} placeholder="e.g. Agreed with the employee and their manager on 12 Nov." /></label>
            <label className="block"><span className="text-[11px] font-semibold text-text-secondary">Approved by (required)</span>
              <input type="text" value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} className={fieldClass} placeholder="Name of the HR / management approver" /></label>
            {error && <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">{error}</div>}
            <div className="flex justify-end gap-2 pt-2 border-t border-line">
              <Button onClick={() => { setMode('VIEW'); setError(null); }} disabled={busy}>Cancel</Button>
              <Button variant="success" onClick={previewSettlement} disabled={busy || settledMinutes <= 0 || settledMinutes > p.available.minutes}>{busy ? 'Checking…' : 'Review…'}</Button>
            </div>
          </div>
        )}

        {mode === 'SETTLE_REVIEW' && settlePreview && (
          <ReviewConfirm
            title="deficit settlement"
            subtitle={`${employeeName} · ${settlePreview.period.label}`}
            rows={settlementRows}
            warnings={[
              ...(settlePreview.payroll.deduction ? ['This action will create a payroll deduction.'] : []),
              ...(alDays > 0 ? ["This action will reduce the employee's annual leave balance."] : []),
            ]}
            busy={busy}
            disabled={Boolean(insufficient) && !allowOutstanding}
            error={error}
            onConfirm={confirmSettlement}
            onBack={() => { setMode('SETTLE'); setError(null); }}
          >
            {outstandingChoice}
          </ReviewConfirm>
        )}

        {p && mode === 'PENALTY' && (
          <div className="space-y-3 text-xs">
            <div className="rounded-xl border border-line-strong bg-raised p-3 text-text-secondary">
              The penalty is a separate decision from settling the deficit, and it is fixed: it does not grow with the number of deficit days ({p.convertedDays} day{p.convertedDays === 1 ? '' : 's'} this period). One penalty per period.
            </div>
            {p.penalty && p.penalty.option !== 'NONE' && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-rose-200">
                <strong>Penalty already applied</strong> · {p.penalty.label} · {p.penalty.at} · approved by {p.penalty.approvedBy}
              </div>
            )}
            <div className="space-y-2">
              {(view?.penaltyOptions ?? []).map((o) => (
                <label key={o.option} className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition ${option === o.option ? 'border-brand bg-brand/10' : 'border-line-strong bg-raised hover:border-brand/50'}`}>
                  <input type="radio" name="penalty" checked={option === o.option} onChange={() => setOption(o.option)} className="mt-0.5" />
                  <div>
                    <div className="font-semibold text-text">{o.option === 'NONE' ? 'No penalty' : o.option === 'OPTION_1' ? 'Option 1' : 'Option 2'}</div>
                    <div className="text-text-secondary">{o.label}</div>
                  </div>
                </label>
              ))}
            </div>
            <label className="block"><span className="text-[11px] font-semibold text-text-secondary">Reason (required)</span>
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} /></label>
            <label className="block"><span className="text-[11px] font-semibold text-text-secondary">Approved by (required)</span>
              <input type="text" value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} className={fieldClass} /></label>
            {alreadyApplied && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-200">
                Penalty already applied · {alreadyApplied.penaltyType} · {alreadyApplied.dateApplied} · approved by {alreadyApplied.approvedBy}
              </div>
            )}
            {error && !alreadyApplied && <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">{error}</div>}
            <div className="flex justify-end gap-2 pt-2 border-t border-line">
              <Button onClick={() => { setMode('VIEW'); setError(null); }} disabled={busy}>Cancel</Button>
              <Button variant="success" onClick={previewPenalty} disabled={busy || Boolean(p.penalty && p.penalty.option !== 'NONE')}>{busy ? 'Checking…' : 'Review…'}</Button>
            </div>
          </div>
        )}

        {mode === 'PENALTY_REVIEW' && penaltyPreview && (
          <ReviewConfirm
            title="deficit penalty"
            subtitle={`${employeeName} · ${penaltyPreview.period.label}`}
            rows={penaltyRows}
            warnings={[
              ...(penaltyPreview.payroll.deduction ? ['This action will create a payroll deduction.'] : []),
              ...(penaltyPreview.alDays > 0 ? ["This action will reduce the employee's annual leave balance."] : []),
            ]}
            busy={busy}
            disabled={Boolean(insufficient) && !allowOutstanding}
            error={error}
            confirmLabel={option === 'NONE' ? 'Record: no penalty' : 'Confirm & Apply'}
            onConfirm={confirmPenalty}
            onBack={() => { setMode('PENALTY'); setError(null); }}
          >
            {outstandingChoice}
          </ReviewConfirm>
        )}

        {!p && !loadError && <div className="text-xs text-text-secondary">Loading…</div>}
        {p && mode === 'VIEW' && <div className="text-[11px] text-text-secondary leading-relaxed"><Badge tone="muted" size="sm">Audit</Badge> Every settlement and penalty is recorded with who entered it, who approved it, the reason and the figures at the time. Earlier figures are never overwritten.</div>}
      </div>
    </div>
  );
}
