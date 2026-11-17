'use client';

// Change Employment Status (HR update 2026-11-17): move an employee to
// Former Employee with their confirmed final employment date, or rehire a
// former employee under the same permanent Employee ID. Both go through
// Review & Confirm and need a reason; nothing is deleted.

import { useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/primitives';
import { XIcon } from '@/components/icons';
import { ReviewConfirm } from '@/components/ReviewConfirm';

export type EmploymentStatusMode = 'FORMER' | 'REHIRE';

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function EmploymentStatusModal({
  employeeId, employeeName, employeeNumber, mode, defaultFinalDate, startDate, onClose, onDone,
}: {
  employeeId: string;
  employeeName: string;
  employeeNumber?: string | null;
  mode: EmploymentStatusMode;
  /** e.g. the contract end date when opened from Advanced HR. */
  defaultFinalDate?: string | null;
  startDate?: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [step, setStep] = useState<'FORM' | 'REVIEW'>('FORM');
  const [finalDate, setFinalDate] = useState(defaultFinalDate || todayKey());
  const [rehireStatus, setRehireStatus] = useState<'Active' | 'Probation'>('Active');
  const [reason, setReason] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scheduled = mode === 'FORMER' && finalDate >= todayKey();

  const review = () => {
    setError(null);
    if (mode === 'FORMER' && !/^\d{4}-\d{2}-\d{2}$/.test(finalDate)) { setError('Enter the final employment date.'); return; }
    if (mode === 'FORMER' && startDate && finalDate < startDate) { setError(`The final employment date cannot be before the start date (${startDate}).`); return; }
    if (!reason.trim()) { setError('A reason is required.'); return; }
    if (!approvedBy.trim()) { setError('Approved by is required.'); return; }
    setStep('REVIEW');
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.setEmployeeStatus(employeeId, mode === 'FORMER'
        ? { status: 'Former employee', finalEmploymentDate: finalDate, reason: reason.trim(), approvedBy: approvedBy.trim() }
        : { status: rehireStatus, reason: reason.trim(), approvedBy: approvedBy.trim() });
      onDone(r.message || 'Employment status updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the employment status.');
    } finally { setBusy(false); }
  };

  const field = 'mt-1 w-full rounded-lg border border-line bg-raised px-3 py-2 text-xs text-text';

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/75 p-4 overflow-y-auto">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 my-auto space-y-4">
        {step === 'FORM' && (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-text">
                  {mode === 'FORMER' ? 'Change employment status → Former Employee' : 'Rehire former employee'}
                </h2>
                <p className="text-xs text-muted mt-0.5">{employeeName}{employeeNumber ? ` · ${employeeNumber}` : ''}{startDate ? ` · employed from ${startDate}` : ''}</p>
              </div>
              <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-muted hover:text-text hover:bg-raised" aria-label="Close"><XIcon className="h-4 w-4" /></button>
            </div>

            <div className="rounded-xl border border-line bg-raised/50 p-3 text-xs text-muted">
              {mode === 'FORMER'
                ? 'They stop appearing in the live workforce (In office, WFH, Remote, On break, On leave, Away / out, Not arrived, Late / deficit), no attendance is expected and no deficit is generated. Their full history stays available, and their Employee ID stays theirs permanently.'
                : `They return to the live workforce with the same Employee ID${employeeNumber ? ` (${employeeNumber})` : ''}. Their earlier employment history stays. Pair their app and laptop again to resume tracking.`}
            </div>

            {mode === 'FORMER' ? (
              <label className="block text-xs"><span className="font-semibold text-text">Final employment date</span>
                <input type="date" value={finalDate} min={startDate || undefined} onChange={(e) => setFinalDate(e.target.value)} className={field} />
                {scheduled && <span className="block mt-1 text-[11px] text-amber-300">This date is today or later: they stay in the live workforce until then and move to Former Employees the day after.</span>}
              </label>
            ) : (
              <label className="block text-xs"><span className="font-semibold text-text">Status on return</span>
                <select value={rehireStatus} onChange={(e) => setRehireStatus(e.target.value as 'Active' | 'Probation')} className={field}>
                  <option value="Active">Active</option>
                  <option value="Probation">Probation</option>
                </select>
              </label>
            )}
            <label className="block text-xs"><span className="font-semibold text-text">Reason (required)</span>
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={field} placeholder={mode === 'FORMER' ? 'e.g. Resigned; contract ended; employment ended during probation' : 'e.g. Rehired for the new project'} /></label>
            <label className="block text-xs"><span className="font-semibold text-text">Approved by (required)</span>
              <input type="text" value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} className={field} placeholder="Name of the HR / management approver" /></label>
            {error && <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>}
            <div className="flex justify-end gap-2 pt-2 border-t border-line">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" onClick={review}>Review…</Button>
            </div>
          </>
        )}

        {step === 'REVIEW' && (
          <ReviewConfirm
            title={mode === 'FORMER' ? 'former employee' : 'rehire'}
            subtitle={`${employeeName}${employeeNumber ? ` · ${employeeNumber}` : ''}`}
            rows={mode === 'FORMER' ? [
              { label: 'Current value', value: 'Active employee' },
              { label: 'Proposed change', value: 'Employment Status: Former Employee', tone: 'warn' },
              { label: 'Employment start date', value: startDate || '—' },
              { label: 'Final employment date', value: finalDate },
              { label: 'Takes effect', value: scheduled ? `The day after ${finalDate}` : 'Now' },
              { label: 'Employee ID', value: `${employeeNumber || '—'} (kept permanently, never reissued)` },
              { label: 'Records', value: 'All history kept: profile, contracts, attendance, leave, deficit, payroll, warnings, documents, notes, notifications, audit' },
              { label: 'Reason', value: reason.trim() },
              { label: 'Approved by', value: approvedBy.trim() },
            ] : [
              { label: 'Current value', value: 'Former employee' },
              { label: 'Proposed change', value: `Rehire as ${rehireStatus}`, tone: 'ok' },
              { label: 'Employee ID', value: `${employeeNumber || '—'} (unchanged)` },
              { label: 'Earlier employment', value: 'Kept in the history' },
              { label: 'Reason', value: reason.trim() },
              { label: 'Approved by', value: approvedBy.trim() },
            ]}
            busy={busy}
            error={error}
            confirmLabel={mode === 'FORMER' ? 'Confirm: move to Former Employees' : 'Confirm rehire'}
            onConfirm={confirm}
            onBack={() => { setStep('FORM'); setError(null); }}
          />
        )}
      </div>
    </div>
  );
}
