'use client';

// Unauthorised absence review (HR requirements 2026-11-12, sections 2-7, 18, 36).
//
// HR records the notice given and whether there were emergency / exceptional
// circumstances. An emergency is reclassified as the right leave category
// (no penalty). Otherwise HR chooses the treatment - Option 1 unpaid, or
// Option 2 paid using accrued annual leave - and the fixed one-day penalty
// (once per incident). Everything goes through Review & Confirm, showing the
// absence treatment, the annual leave impact and the payroll impact apart.

import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import type { AbsenceRecord, AbsenceReviewPreview, LeaveTypeItem } from '@/lib/types';
import { Button } from '@/components/primitives';
import { AlertTriangleIcon, SirenIcon, XIcon } from '@/components/icons';
import { ReviewConfirm, type ReviewRow } from '@/components/ReviewConfirm';

export type AbsenceAction = 'CONFIRMED' | 'DISMISSED' | 'RECLASSIFIED';

const RECLASSIFY_IDS = ['emergency', 'sick', 'sick_unpaid', 'compassionate', 'authorised', 'other', 'annual', 'unpaid', 'maternity', 'maternity_unpaid', 'paternity', 'parental', 'study', 'toil'];
const NOTICE_LABEL: Record<string, string> = { NO_NOTICE: 'No notice', SHORT_NOTICE: 'Short notice', NORMAL_NOTICE: 'Normal notice' };

function errorInfo(err: unknown): { message: string; code: string | null; details: Record<string, unknown> | null } {
  if (err instanceof ApiError) {
    const body = (err.body ?? {}) as { code?: string; details?: Record<string, unknown> };
    return { message: err.message, code: body.code ?? err.code ?? null, details: body.details ?? null };
  }
  return { message: err instanceof Error ? err.message : 'Something went wrong.', code: null, details: null };
}

export function AbsenceReviewModal({
  absence, action, leaveTypes, onClose, onDone,
}: {
  absence: AbsenceRecord;
  action: AbsenceAction;
  leaveTypes: LeaveTypeItem[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [step, setStep] = useState<'FORM' | 'REVIEW'>('FORM');
  const [mode, setMode] = useState<AbsenceAction>(action);
  const [notice, setNotice] = useState<'NO_NOTICE' | 'SHORT_NOTICE' | 'NORMAL_NOTICE' | ''>('');
  const [emergency, setEmergency] = useState<'YES' | 'NO' | ''>('');
  const [treatment, setTreatment] = useState<'UNPAID' | 'PAID_ANNUAL_LEAVE' | ''>('');
  const [applyPenalty, setApplyPenalty] = useState(true);
  const [warningTrigger, setWarningTrigger] = useState(false);
  const [approvedBy, setApprovedBy] = useState('');
  const [notes, setNotes] = useState(action === 'DISMISSED' ? 'Excused with management approval.' : '');
  const [leaveTypeId, setLeaveTypeId] = useState('emergency');
  const [preview, setPreview] = useState<AbsenceReviewPreview | null>(null);
  const [allowOutstanding, setAllowOutstanding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Any existing penalty on the incident is shown before HR decides.
  useEffect(() => {
    let alive = true;
    api.absenceReviewPreview(absence.id, { treatment: null, applyPenalty: null })
      .then((r) => { if (!alive) return; setPreview(r.preview); if (r.preview.incident.existingPenalty) setApplyPenalty(false); })
      .catch(() => {});
    return () => { alive = false; };
  }, [absence.id]);

  const reclassTypes = leaveTypes.filter((t) => RECLASSIFY_IDS.includes(t.id));
  const existingPenalty = preview?.incident.existingPenalty ?? null;

  const goReview = async () => {
    setError(null);
    if (!notes.trim()) { setError('A review note explaining the decision is required.'); return; }
    if (mode === 'CONFIRMED') {
      if (!notice) { setError('Notification status is required.'); return; }
      if (!emergency) { setError('Say whether there were emergency / exceptional circumstances.'); return; }
      if (!treatment) { setError('Choose Option 1 (unpaid) or Option 2 (paid using accrued annual leave).'); return; }
      if (!approvedBy.trim()) { setError('Approved by is required.'); return; }
      setBusy(true);
      try {
        const r = await api.absenceReviewPreview(absence.id, { treatment, applyPenalty: existingPenalty ? false : applyPenalty });
        setPreview(r.preview);
        setStep('REVIEW');
      } catch (err) { setError(errorInfo(err).message); } finally { setBusy(false); }
      return;
    }
    if (mode === 'RECLASSIFIED' && !leaveTypeId) { setError('Choose the leave category.'); return; }
    setStep('REVIEW');
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.reviewAbsence(absence.id, mode === 'CONFIRMED' ? {
        status: 'CONFIRMED', notes: notes.trim(), notificationStatus: notice || null, emergencyException: false,
        treatment: treatment || null, applyPenalty: existingPenalty ? false : applyPenalty, approvedBy: approvedBy.trim(),
        createWarningTrigger: warningTrigger, allowOutstanding,
      } : mode === 'RECLASSIFIED' ? {
        status: 'RECLASSIFIED', notes: notes.trim(), notificationStatus: notice || null, emergencyException: emergency === 'YES',
        leaveTypeId, approvedBy: approvedBy.trim() || null,
      } : {
        status: 'DISMISSED', notes: notes.trim(), notificationStatus: notice || null, emergencyException: emergency ? emergency === 'YES' : null,
        deductAnnualLeave: false, treatAsUnpaid: false, createWarningTrigger: false,
      });
      onDone(r.message);
    } catch (err) {
      const e = errorInfo(err);
      setError(e.code === 'INSUFFICIENT_BALANCE' ? `Insufficient accrued annual leave balance: ${e.message}` : e.message);
    } finally { setBusy(false); }
  };

  const bal = preview?.annualLeave.balance ?? null;
  const insufficient = mode === 'CONFIRMED' && bal && !bal.sufficient;
  const rows: ReviewRow[] = mode === 'CONFIRMED' && preview ? [
    { label: 'Absence', value: `${absence.employeeName} · ${absence.date}${preview.incident.otherDates.length ? ` (incident of ${preview.incident.days} days)` : ''}` },
    { label: 'Notification status', value: NOTICE_LABEL[notice] ?? notice },
    { label: 'Emergency / exceptional circumstances', value: 'No' },
    { label: 'Absence treatment', value: treatment === 'UNPAID' ? 'Option 1 — Unpaid: 1 unpaid day' : 'Option 2 — Paid: 1 accrued annual leave day covers the absence', tone: 'warn' },
    { label: 'Annual leave impact', value: preview.annualLeave.totalDays > 0
        ? `${preview.annualLeave.totalDays} day(s) total: ${preview.annualLeave.coverDays} to cover the absence + ${preview.annualLeave.penaltyDays} penalty${bal ? ` · available ${bal.availableDays} → ${bal.balanceAfter}` : ''}${bal && bal.outstandingDays > 0 ? ` · ${bal.outstandingDays} day(s) cannot be covered` : ''}`
        : 'None', tone: insufficient ? 'danger' : preview.annualLeave.totalDays > 0 ? 'warn' : undefined },
    { label: 'Payroll impact', value: preview.payroll.deduction ? '1 day pay deduction, proposed to the payroll run' : 'No payroll deduction', tone: preview.payroll.deduction ? 'warn' : undefined },
    { label: 'Penalty', value: existingPenalty ? `Already applied on ${existingPenalty.onDate} (${existingPenalty.approvedBy ?? 'HR'})` : applyPenalty ? '1 annual leave day (once per incident)' : 'No penalty for this day' },
    { label: 'Effective date', value: absence.date },
    { label: 'Reason / HR comments', value: notes.trim() },
    { label: 'Approved by', value: approvedBy.trim() },
  ] : mode === 'RECLASSIFIED' ? [
    { label: 'Absence', value: `${absence.employeeName} · ${absence.date}` },
    { label: 'Notification status', value: notice ? NOTICE_LABEL[notice] : '—' },
    { label: 'Emergency / exceptional circumstances', value: emergency === 'YES' ? 'Yes' : 'No' },
    { label: 'Proposed change', value: `Record as ${reclassTypes.find((t) => t.id === leaveTypeId)?.name ?? leaveTypeId}`, tone: 'ok' },
    { label: 'Annual leave impact', value: leaveTypeId === 'annual' ? '1 day of annual leave booked' : 'None' },
    { label: 'Payroll impact', value: reclassTypes.find((t) => t.id === leaveTypeId)?.isPaid === false ? '1 unpaid day (unpaid leave type)' : 'None (paid leave)' },
    { label: 'Unauthorised absence penalty', value: 'None', tone: 'ok' },
    { label: 'Reason', value: notes.trim() },
    ...(approvedBy.trim() ? [{ label: 'Approved by', value: approvedBy.trim() }] : []),
  ] : [
    { label: 'Absence', value: `${absence.employeeName} · ${absence.date}` },
    { label: 'Proposed change', value: 'Dismiss / excuse — no consequence', tone: 'ok' },
    { label: 'Reason', value: notes.trim() },
  ];

  const field = 'mt-1 w-full rounded-lg border border-line bg-raised px-3 py-2 text-xs text-text';
  const radio = (checked: boolean) => `flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer text-xs ${checked ? 'border-brand bg-brand/10' : 'border-line bg-surface hover:border-brand/50'}`;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 overflow-y-auto">
      <div className="w-full max-w-xl rounded-2xl border border-line bg-surface p-6 my-auto max-h-[92vh] overflow-y-auto space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-text flex items-center gap-2">
              <SirenIcon className="h-4 w-4 text-rose-400" />
              {mode === 'CONFIRMED' ? 'Unauthorised absence review' : mode === 'RECLASSIFIED' ? 'Record absence as leave' : 'Dismiss / excuse absence'}: {absence.employeeName}
            </h2>
            <p className="mt-0.5 text-xs text-muted">Date: {absence.date} · Type: {absence.absenceType}{absence.reason ? ` · Reported reason: ${absence.reason}` : ''}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="p-1.5 rounded-lg text-muted hover:text-text hover:bg-raised" aria-label="Close"><XIcon className="h-4 w-4" /></button>
        </div>

        {step === 'FORM' && (
          <div className="space-y-4 text-xs">
            {mode !== 'DISMISSED' && (
              <>
                <div>
                  <div className="font-semibold text-text mb-1">Notification status</div>
                  <div className="grid grid-cols-3 gap-2">
                    {(['NO_NOTICE', 'SHORT_NOTICE', 'NORMAL_NOTICE'] as const).map((n) => (
                      <label key={n} className={radio(notice === n)}><input type="radio" name="notice" checked={notice === n} onChange={() => setNotice(n)} /> {NOTICE_LABEL[n]}</label>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted mt-1">Short notice is not automatically unauthorised: HR reviews the circumstances and decides.</p>
                </div>
                <div>
                  <div className="font-semibold text-text mb-1">Emergency / exceptional circumstances</div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className={radio(emergency === 'YES')}><input type="radio" name="emergency" checked={emergency === 'YES'} onChange={() => { setEmergency('YES'); if (mode === 'CONFIRMED') setMode('RECLASSIFIED'); }} /> Yes — choose the appropriate leave category (no penalty)</label>
                    <label className={radio(emergency === 'NO')}><input type="radio" name="emergency" checked={emergency === 'NO'} onChange={() => { setEmergency('NO'); if (mode === 'RECLASSIFIED' && action === 'CONFIRMED') setMode('CONFIRMED'); }} /> No — review as unauthorised absence</label>
                  </div>
                </div>
              </>
            )}

            {mode === 'RECLASSIFIED' && (
              <div>
                <div className="font-semibold text-text mb-1">Leave category</div>
                <select value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} className={field}>
                  {reclassTypes.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isPaid === false ? ' (unpaid)' : ''}</option>)}
                </select>
                <p className="text-[11px] text-muted mt-1">An approved leave request is created for {absence.date}; the absence is closed without an unauthorised absence penalty.</p>
              </div>
            )}

            {mode === 'CONFIRMED' && (
              <>
                <div>
                  <div className="font-semibold text-text mb-1">Treatment</div>
                  <div className="space-y-2">
                    <label className={radio(treatment === 'UNPAID')}>
                      <input type="radio" name="treatment" checked={treatment === 'UNPAID'} onChange={() => setTreatment('UNPAID')} className="mt-0.5" />
                      <div><div className="font-semibold text-text">Option 1 — Unpaid</div><div className="text-muted">1 unpaid day (payroll) + 1 annual leave day penalty.</div></div>
                    </label>
                    <label className={radio(treatment === 'PAID_ANNUAL_LEAVE')}>
                      <input type="radio" name="treatment" checked={treatment === 'PAID_ANNUAL_LEAVE'} onChange={() => setTreatment('PAID_ANNUAL_LEAVE')} className="mt-0.5" />
                      <div><div className="font-semibold text-text">Option 2 — Paid using accrued annual leave</div><div className="text-muted">1 annual leave day covers the absence + 1 annual leave day penalty = 2 days in total (never 3). No payroll deduction.</div></div>
                    </label>
                  </div>
                </div>
                <div className="rounded-xl border border-line bg-raised/50 p-3 space-y-2">
                  {existingPenalty ? (
                    <div className="flex items-start gap-2 text-rose-200"><AlertTriangleIcon className="h-4 w-4 shrink-0 mt-0.5" /><span><strong>Penalty already applied</strong> for this incident · 1 annual leave day · {existingPenalty.onDate}{existingPenalty.dateApplied ? ` · ${existingPenalty.dateApplied}` : ''}{existingPenalty.approvedBy ? ` · approved by ${existingPenalty.approvedBy}` : ''}. No second penalty is applied.</span></div>
                  ) : (
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input type="checkbox" checked={applyPenalty} onChange={(e) => setApplyPenalty(e.target.checked)} className="mt-0.5 h-4 w-4" />
                      <div><div className="font-semibold text-text">Apply the annual leave penalty (1 day)</div><div className="text-muted">Fixed per incident: consecutive absence days share one penalty; it never multiplies by the number of days.</div></div>
                    </label>
                  )}
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={warningTrigger} onChange={(e) => setWarningTrigger(e.target.checked)} className="mt-0.5 h-4 w-4" />
                    <div><div className="font-semibold text-text">Forward to the Warning Board</div><div className="text-muted">Creates a disciplinary trigger for formal review.</div></div>
                  </label>
                </div>
              </>
            )}

            <label className="block"><span className="font-semibold text-text">{mode === 'CONFIRMED' ? 'Reason / HR comments (required)' : 'Review note (required)'}</span>
              <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className={field} placeholder="Explain the HR review rationale…" /></label>
            {mode !== 'DISMISSED' && (
              <label className="block"><span className="font-semibold text-text">Approved by{mode === 'CONFIRMED' ? ' (required)' : ''}</span>
                <input type="text" value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} className={field} placeholder="Name of the HR / management approver" /></label>
            )}
            {error && <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">{error}</div>}
            <div className="flex justify-end gap-2 pt-2 border-t border-line">
              <Button onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="primary" onClick={goReview} disabled={busy}>{busy ? 'Checking…' : 'Review…'}</Button>
            </div>
          </div>
        )}

        {step === 'REVIEW' && (
          <ReviewConfirm
            title={mode === 'CONFIRMED' ? 'unauthorised absence' : mode === 'RECLASSIFIED' ? 'record as leave' : 'dismiss absence'}
            rows={rows}
            warnings={[
              ...(mode === 'CONFIRMED' && preview?.payroll.deduction ? ['This action will create a payroll deduction.'] : []),
              ...(mode === 'CONFIRMED' && (preview?.annualLeave.totalDays ?? 0) > 0 ? ["This action will reduce the employee's annual leave balance."] : []),
            ]}
            busy={busy}
            disabled={Boolean(insufficient) && !allowOutstanding}
            error={error}
            confirmLabel={mode === 'DISMISSED' ? 'Confirm dismissal' : 'Confirm & Apply'}
            onConfirm={confirm}
            onBack={() => { setStep('FORM'); setError(null); }}
          >
            {insufficient && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs space-y-2">
                <div className="font-bold text-rose-200 flex items-center gap-2"><AlertTriangleIcon className="h-4 w-4" /> Insufficient accrued annual leave balance</div>
                <p className="text-rose-200/80">Required {bal?.requiredDays} day(s), available {bal?.availableDays}. Review the treatment (Option 1 unpaid uses less annual leave), or hold the shortfall as an Outstanding Annual Leave Adjustment.</p>
                <label className="flex items-center gap-2 cursor-pointer text-text">
                  <input type="checkbox" checked={allowOutstanding} onChange={(e) => setAllowOutstanding(e.target.checked)} className="h-4 w-4" />
                  Hold the shortfall as an Outstanding Annual Leave Adjustment
                </label>
              </div>
            )}
          </ReviewConfirm>
        )}
      </div>
    </div>
  );
}
