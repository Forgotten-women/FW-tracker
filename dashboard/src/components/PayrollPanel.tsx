'use client';

/**
 * PayrollPanel — Spec section 2.13
 *
 * Every figure here is a CALCULATION. Nothing changes anyone's pay until a
 * person approves it: an adjustment one at a time, or the month's run as a
 * whole ("Approve & publish", in ./payroll). The backend enforces this; this
 * UI makes it obvious.
 */

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type {
  AdminEmployee,
  LeaverCalculation,
  PayrollAdjustment,
  PayrollPeriod,
  StarterCalculation,
} from '@/lib/types';
import { Badge, Button, Empty } from './primitives';
import {
  AlertTriangleIcon,
  BriefcaseIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CurrencyExchangeIcon,
  EyeIcon,
  HandIcon,
  InfoIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  RocketIcon,
  SettingsIcon,
} from './icons';
import {
  type Currency,
  DEFAULT_PKR_RATE,
  LINE_STATUS_META,
  PERIOD_STATUS_META,
  formatActor,
  formatDate,
  formatMoney,
  formatTimestamp,
  isFinalStatus,
} from './payroll/format';
import { PayrollRunView } from './payroll/PayrollRunView';

// Shared by every modal here: scrolls on a short screen instead of clipping.
const MODAL_BACKDROP = 'fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:items-center';
const MODAL_SHELL = 'glass-panel-elevated w-full rounded-3xl p-6';

// ---------------------------------------------------------------------------
// Exchange Rate Modal
// ---------------------------------------------------------------------------

function ExchangeRateModal({
  currentRate,
  onClose,
  onSave,
}: {
  currentRate: number;
  onClose: () => void;
  onSave: (rate: number) => void;
}) {
  const [rateInput, setRateInput] = useState(currentRate.toString());
  const [error, setError] = useState('');

  const handleSave = () => {
    const parsed = parseFloat(rateInput);
    if (isNaN(parsed) || parsed <= 0) {
      setError('Please enter a positive numeric exchange rate.');
      return;
    }
    onSave(parsed);
    onClose();
  };

  return (
    <div className={MODAL_BACKDROP}>
      <div className={`${MODAL_SHELL} max-w-sm`}>
        <div className="flex items-center gap-2 mb-2">
          <CurrencyExchangeIcon className="h-5 w-5 shrink-0" />
          <h2 className="text-base font-bold text-white">GBP / PKR Conversion Rate</h2>
        </div>
        <p className="mb-4 text-xs text-slate-400">
          Configure the exchange rate used for all salary conversions in the preparation sheet.
        </p>
        {error && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {error}
          </div>
        )}
        <div className="mb-4">
          <label className="mb-1 block text-xs font-semibold text-slate-400">1 GBP = PKR (₨)</label>
          <div className="relative">
            <span className="absolute left-3 top-2.5 text-xs text-slate-500 font-mono">₨</span>
            <input
              type="number"
              step="0.01"
              value={rateInput}
              onChange={(e) => setRateInput(e.target.value)}
              placeholder="e.g. 350.00"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 pl-8 pr-3 py-2 text-sm font-mono text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            Example: If £1 = ₨365.50, enter 365.50.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleSave}
            className="flex-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-semibold text-on-accent shadow-lg shadow-indigo-600/30 transition"
          >
            Apply Rate
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prepare-sheet employee row shape (from backend)
// ---------------------------------------------------------------------------

interface PrepareEmployee {
  employeeId: string;
  employeeName: string;
  employeeNumber?: string | null;
  salary: { monthly: number; daily: number; annual: number; currency?: string };
  workingDaysCount?: number;
  fullPeriodDays?: number;
  calculatedPeriodGross?: number;
  isStarter: boolean;
  starter: { startDate: string; eligibleWorkingDays: number; calculatedGross: number } | null;
  attendanceDeficit: {
    wholeDayEquivalents: number;
    carryForwardMinutes: number;
    valueIfDeducted: number;
    needsHrDecision: boolean;
  };
  leave: { blocked: boolean; reason?: string; available?: number; isNegative?: boolean };
  adjustments: Array<{
    id: string;
    type: string;
    status: string;
    calculatedAmount: number;
    approvedAmount: number | null;
    explanation: string;
  }>;
}

interface PrepareBlocked {
  employeeId: string;
  employeeName: string;
  employeeNumber?: string | null;
  reason: string;
  message: string;
}

interface PrepareSheet {
  period: { id: string; name: string; from: string; to: string; status: string; exchangeRate?: number };
  employees: PrepareEmployee[];
  blocked: PrepareBlocked[];
  note: string;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const meta = PERIOD_STATUS_META[status as keyof typeof PERIOD_STATUS_META] ?? LINE_STATUS_META[status];
  return (
    <Badge tone={meta?.tone ?? 'muted'} size="sm" dot={status === 'IN_REVIEW'}>
      {meta?.label ?? status}
    </Badge>
  );
}

function SectionCard({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass-panel min-w-0 overflow-hidden rounded-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
        <h3 className="text-sm font-bold text-white">{title}</h3>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Create Period Modal
// ---------------------------------------------------------------------------

function CreatePeriodModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (
    name: string,
    from: string,
    to: string,
    exchangeRate: number,
    dates: { cutoffDate: string | null; payDate: string | null },
  ) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cutoff, setCutoff] = useState('');
  const [payDate, setPayDate] = useState('');
  const [exchangeRate, setExchangeRate] = useState('350.00');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!name.trim() || !from || !to) { setError('All fields are required.'); return; }
    if (to < from) { setError('End date must be on or after start date.'); return; }
    if (cutoff && (cutoff < from || cutoff > to)) { setError('The cut-off must fall inside the period.'); return; }
    const parsedRate = parseFloat(exchangeRate);
    if (isNaN(parsedRate) || parsedRate <= 0) { setError('Please enter a valid positive conversion rate.'); return; }
    setLoading(true);
    setError('');
    try {
      await onCreate(name.trim(), from, to, parsedRate, { cutoffDate: cutoff || null, payDate: payDate || null });
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create period.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={MODAL_BACKDROP}>
      <div className={`${MODAL_SHELL} max-w-md`}>
        <h2 className="mb-1 text-base font-bold text-white">Create Payroll Period</h2>
        <p className="mb-5 text-xs text-slate-400">
          Each calendar month&apos;s period is opened automatically, with its cut-off on the 25th. Create one by hand only
          for an off-cycle run; it must not overlap a month that already has a period.
        </p>
        {error && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{error}</div>
        )}
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Period Name</label>
            <input
              type="text"
              placeholder="e.g. August 2026 Payroll"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">Start Date</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">End Date</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">Cut-off (optional)</label>
              <input
                type="date"
                value={cutoff}
                min={from || undefined}
                max={to || undefined}
                onChange={(e) => setCutoff(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">Pay Date (optional)</label>
              <input
                type="date"
                value={payDate}
                onChange={(e) => setPayDate(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <p className="col-span-2 -mt-1 text-[11px] text-slate-500">
              Without a cut-off, deductions run to the end date. With one, anything dated after it rolls into the next run.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Exchange Rate (1 GBP = PKR ₨)</label>
            <input
              type="number"
              step="0.01"
              value={exchangeRate}
              onChange={(e) => setExchangeRate(e.target.value)}
              placeholder="e.g. 350.00"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-mono text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-slate-500">Rate applied to this specific payroll run. Can be adjusted until the run is published.</p>
          </div>
        </div>
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading}
            className="flex-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-on-accent transition"
          >
            {loading ? 'Creating…' : 'Create Period'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Set Salary Modal
// ---------------------------------------------------------------------------

export function SetSalaryModal({
  employees,
  prefilledEmployeeId,
  defaultEffectiveFrom,
  onClose,
  onSuccess,
}: {
  employees: AdminEmployee[];
  prefilledEmployeeId?: string;
  defaultEffectiveFrom?: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [employeeId, setEmployeeId] = useState(prefilledEmployeeId ?? '');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('GBP');
  const [payFrequency, setPayFrequency] = useState('Monthly');
  const [effectiveFrom, setEffectiveFrom] = useState(
    defaultEffectiveFrom || new Date().toISOString().slice(0, 10),
  );
  const [reason, setReason] = useState('Initial compensation record');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!employeeId) { setError('Please select an employee.'); return; }
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount < 0) { setError('A valid salary amount is required.'); return; }
    if (!effectiveFrom) { setError('Effective from date is required.'); return; }
    if (!reason.trim()) { setError('A reason is required to explain this pay record.'); return; }

    setLoading(true);
    setError('');
    try {
      await api.setEmployeeSalary(employeeId, {
        amount: parsedAmount,
        effectiveFrom,
        reason: reason.trim(),
        currency,
        payFrequency,
      });
      onSuccess();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to record salary.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={MODAL_BACKDROP}>
      <div className={`${MODAL_SHELL} max-w-md`}>
        <h2 className="mb-1 text-base font-bold text-white">Record Employee Salary</h2>
        <p className="mb-4 text-xs text-slate-400">
          Salaries are append-only. Historical payroll will preserve previous rates.
        </p>
        {error && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{error}</div>
        )}
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Employee</label>
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              <option value="">Select employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name} {e.role ? `(${e.role})` : ''}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">Monthly Salary</label>
              <input
                type="number"
                step="0.01"
                placeholder="e.g. 2500"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">Currency</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
              >
                <option value="GBP">GBP (£)</option>
                <option value="PKR">PKR (₨)</option>
                <option value="USD">USD ($)</option>
                <option value="EUR">EUR (€)</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">Pay Frequency</label>
              <select
                value={payFrequency}
                onChange={(e) => setPayFrequency(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
              >
                <option value="Monthly">Monthly</option>
                <option value="Weekly">Weekly</option>
                <option value="Hourly">Hourly</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">Effective From</label>
              <input
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Reason / Note (required)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Initial compensation record"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading}
            className="flex-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-on-accent transition shadow-lg shadow-indigo-600/30"
          >
            {loading ? 'Saving…' : 'Save Salary Record'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Propose Adjustment Modal
// ---------------------------------------------------------------------------

const ADJ_TYPES = [
  { value: 'ATTENDANCE_DEDUCTION', label: 'Attendance Deduction' },
  { value: 'LEAVE_SETTLEMENT', label: 'Leave Settlement' },
  { value: 'STARTER', label: 'Starter (Pro-rata)' },
  { value: 'LEAVER', label: 'Leaver Settlement' },
  { value: 'BONUS', label: 'Bonus' },
  { value: 'OTHER', label: 'Other' },
];

function ProposeAdjModal({
  periodId,
  employees,
  prefilledEmployeeId,
  prefilledAmount,
  prefilledType,
  prefilledExplanation,
  onClose,
  onProposed,
}: {
  periodId: string;
  employees: AdminEmployee[];
  prefilledEmployeeId?: string;
  prefilledAmount?: number;
  prefilledType?: string;
  prefilledExplanation?: string;
  onClose: () => void;
  onProposed: () => void;
}) {
  const [employeeId, setEmployeeId] = useState(prefilledEmployeeId ?? '');
  const [adjType, setAdjType] = useState(prefilledType ?? 'OTHER');
  const [amount, setAmount] = useState(prefilledAmount?.toString() ?? '');
  const [explanation, setExplanation] = useState(prefilledExplanation ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!employeeId || !amount || !explanation.trim()) {
      setError('Employee, amount, and explanation are required.');
      return;
    }
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount)) { setError('Amount must be a number.'); return; }
    setLoading(true);
    setError('');
    try {
      await api.proposePayrollAdjustment(periodId, employeeId, adjType, null, parsedAmount, explanation.trim());
      onProposed();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to propose adjustment.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={MODAL_BACKDROP}>
      <div className={`${MODAL_SHELL} max-w-md`}>
        <h2 className="mb-5 text-base font-bold text-white">Propose Payroll Adjustment</h2>
        {error && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{error}</div>
        )}
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Employee</label>
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              <option value="">Select employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Adjustment Type</label>
            <select
              value={adjType}
              onChange={(e) => setAdjType(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              {ADJ_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Amount (in the employee&apos;s salary currency; negative deducts)</label>
            <input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Explanation (required)</label>
            <textarea
              rows={3}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              placeholder="Why is this adjustment being proposed?"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none resize-none"
            />
          </div>
        </div>
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading}
            className="flex-1 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-on-accent transition"
          >
            {loading ? 'Proposing…' : 'Propose Adjustment'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition"
          >
            Cancel
          </button>
        </div>
        <p className="mt-3 text-[11px] text-slate-500">
          <InfoIcon className="inline-block h-3.5 w-3.5" /> Proposed adjustments affect nothing until approved by an authorised HR user. A line entered by hand always needs its own decision in the monthly run.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Decide Adjustment Modal
// ---------------------------------------------------------------------------

function DecideAdjModal({
  adj,
  formatAmount,
  onClose,
  onDecided,
}: {
  adj: PayrollAdjustment;
  /** In the employee's own salary currency, as the rest of the sheet shows it. */
  formatAmount: (amount: number | null) => string;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED'>('APPROVED');
  const [notes, setNotes] = useState('');
  const [overrideAmount, setOverrideAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!notes.trim()) { setError('A decision note is required.'); return; }
    setLoading(true);
    setError('');
    try {
      const approved = overrideAmount !== '' ? parseFloat(overrideAmount) : null;
      await api.decidePayrollAdjustment(adj.id, decision, notes.trim(), null, approved);
      onDecided();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to record decision.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={MODAL_BACKDROP}>
      <div className={`${MODAL_SHELL} max-w-md`}>
        <h2 className="mb-1 text-base font-bold text-white">Review Adjustment</h2>
        <p className="mb-4 text-xs text-slate-400">
          {adj.employeeName} {adj.employeeNumber && <span className="font-mono text-indigo-400 font-bold">({adj.employeeNumber})</span>} · {adj.type}
        </p>
        {error && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{error}</div>
        )}
        <div className="mb-4 rounded-xl border border-slate-700 bg-slate-900/60 p-4 text-xs space-y-1">
          <div className="flex justify-between"><span className="text-slate-400">Calculated amount</span><span className="font-mono text-white">{formatAmount(adj.calculated.amount)}</span></div>
          {adj.explanation && <p className="text-slate-400 pt-1">&ldquo;{adj.explanation}&rdquo;</p>}
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex gap-2">
            {(['APPROVED', 'REJECTED'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDecision(d)}
                className={`flex-1 rounded-lg border py-2 text-xs font-bold transition ${
                  decision === d
                    ? d === 'APPROVED' ? 'bg-emerald-600/30 border-emerald-500 text-emerald-300' : 'bg-rose-600/30 border-rose-500 text-rose-300'
                    : 'border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          {decision === 'APPROVED' && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">Override Amount (negative deducts; leave blank to use calculated)</label>
              <input
                type="number"
                step="0.01"
                placeholder={`${adj.calculated.amount?.toFixed(2)}`}
                value={overrideAmount}
                onChange={(e) => setOverrideAmount(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Decision Note (required)</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Brief reason for your decision…"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none resize-none"
            />
          </div>
        </div>
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading}
            className={`flex-1 rounded-lg disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white transition ${
              decision === 'APPROVED' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-rose-600 hover:bg-rose-500'
            }`}
          >
            {loading ? 'Saving…' : `Confirm ${decision}`}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Starter/Leaver Preview sub-section
// ---------------------------------------------------------------------------

function StarterLeaverPreview({
  employees,
  currency,
  canPropose,
  onPropose,
}: {
  employees: AdminEmployee[];
  /** False once the period is final: nothing can be proposed into it. */
  canPropose: boolean;
  currency: Currency;
  onPropose: (employeeId: string, amount: number, type: string, explanation: string) => void;
}) {
  const [mode, setMode] = useState<'STARTER' | 'LEAVER'>('STARTER');
  const [employeeId, setEmployeeId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lastDate, setLastDate] = useState('');
  const [result, setResult] = useState<StarterCalculation | LeaverCalculation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    if (!employeeId) { setError('Select an employee.'); return; }
    setLoading(true);
    setError('');
    setResult(null);
    try {
      if (mode === 'STARTER') {
        if (!from || !to) { setError('Both dates are required.'); setLoading(false); return; }
        const res = await api.starterPreview(employeeId, from, to);
        setResult(res.calculation);
      } else {
        if (!lastDate) { setError('Last working date is required.'); setLoading(false); return; }
        const res = await api.leaverPreview(employeeId, lastDate);
        setResult(res.calculation);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Preview failed.');
    } finally {
      setLoading(false);
    }
  };

  const starterCalc = result as StarterCalculation | null;
  const leaverCalc = result as LeaverCalculation | null;

  const handlePropose = () => {
    if (!result || !employeeId) return;
    if (mode === 'STARTER' && starterCalc?.calculatedGross) {
      onPropose(employeeId, starterCalc.calculatedGross, 'STARTER',
        `Starter pro-rata: ${starterCalc.eligibleWorkingDays} days × £${starterCalc.dailyRate?.toFixed(2)}/day (started ${starterCalc.startDate})`);
    } else if (mode === 'LEAVER' && leaverCalc?.grossPay) {
      onPropose(employeeId, leaverCalc.grossPay, 'LEAVER',
        `Leaver settlement: ${leaverCalc.workedDays} worked days`);
    }
  };

  return (
    <SectionCard title="Starter / Leaver Pay Preview">
      <div className="flex gap-2 mb-4">
        {(['STARTER', 'LEAVER'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setResult(null); setError(''); }}
            className={`rounded-lg border px-4 py-1.5 text-xs font-bold transition ${
              mode === m
                ? 'bg-indigo-600/30 border-indigo-500 text-indigo-300'
                : 'border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800'
            }`}
          >
            {m === 'STARTER' ? <><RocketIcon className="inline-block h-3.5 w-3.5" /> New Starter</> : <><HandIcon className="inline-block h-3.5 w-3.5" /> Leaver</>}
          </button>
        ))}
      </div>

      {error && <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-400">Employee</label>
          <select
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
          >
            <option value="">Select…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        {mode === 'STARTER' ? (
          <>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">Period Start</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-400">Period End</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none" />
            </div>
          </>
        ) : (
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-400">Last Working Date</label>
            <input type="date" value={lastDate} onChange={(e) => setLastDate(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none" />
          </div>
        )}
        <div className="flex items-end">
          <button
            type="button"
            onClick={run}
            disabled={loading}
            className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-on-accent transition"
          >
            {loading ? 'Calculating…' : 'Preview'}
          </button>
        </div>
      </div>

      {result && (
        <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/60 p-4">
          {mode === 'STARTER' && starterCalc && (
            <>
              {starterCalc.applicable === false && (
                <p className="text-sm text-slate-400">This employee did not start during the selected period.</p>
              )}
              {starterCalc.applicable && starterCalc.blocked && (
                <p className="text-sm text-rose-400"><AlertTriangleIcon className="inline-block h-4 w-4" /> {starterCalc.reason}</p>
              )}
              {starterCalc.applicable && !starterCalc.blocked && (
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-slate-400">Start date</span><span className="text-white">{starterCalc.startDate}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Eligible working days</span><span className="font-mono text-white">{starterCalc.eligibleWorkingDays}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Daily rate</span><span className="font-mono text-white">{formatMoney(starterCalc.dailyRate ?? null, currency)}</span></div>
                  <div className="flex justify-between text-sm font-bold"><span className="text-slate-300">Calculated gross</span><span className="text-emerald-400">{formatMoney(starterCalc.calculatedGross ?? null, currency)}</span></div>
                  <p className="pt-1 text-[11px] text-slate-500">{starterCalc.formula}</p>
                  {canPropose && (
                    <button
                      type="button"
                      onClick={handlePropose}
                      className="mt-3 rounded-lg bg-amber-600/20 border border-amber-500/30 hover:bg-amber-600/30 px-3 py-1.5 text-xs font-semibold text-amber-300 transition"
                    >
                      + Propose as Adjustment
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {mode === 'LEAVER' && leaverCalc && (
            <>
              {leaverCalc.blocked && (
                <p className="text-sm text-rose-400"><AlertTriangleIcon className="inline-block h-4 w-4" /> {leaverCalc.message ?? leaverCalc.reason}</p>
              )}
              {!leaverCalc.blocked && (
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-slate-400">Last working date</span><span className="text-white">{leaverCalc.lastWorkingDate}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Worked days in period</span><span className="font-mono text-white">{leaverCalc.workedDays}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Gross pay</span><span className="font-mono text-white">{formatMoney(leaverCalc.grossPay ?? null, currency)}</span></div>
                  {leaverCalc.leave && !leaverCalc.leave.blocked && (
                    <>
                      <div className="flex justify-between"><span className="text-slate-400">Untaken leave days</span><span className="font-mono text-white">{leaverCalc.leave.untakenDays ?? '—'}</span></div>
                      {leaverCalc.leave.untakenValue != null && leaverCalc.leave.untakenValue > 0 && (
                        <div className="flex justify-between"><span className="text-slate-400">Untaken leave value</span><span className="font-mono text-emerald-400">+{formatMoney(leaverCalc.leave.untakenValue, currency)}</span></div>
                      )}
                      {leaverCalc.leave.excessTakenDays != null && leaverCalc.leave.excessTakenDays > 0 && (
                        <div className="flex justify-between"><span className="text-slate-400">Excess leave taken</span><span className="font-mono text-rose-400">−{formatMoney(leaverCalc.leave.excessDeduction ?? 0, currency)}</span></div>
                      )}
                    </>
                  )}
                  <p className="pt-1 text-[11px] text-amber-400/80"><AlertTriangleIcon className="inline-block h-3.5 w-3.5" /> These are calculations only. No changes made until HR approves.</p>
                  {canPropose && (
                    <button
                      type="button"
                      onClick={handlePropose}
                      className="mt-2 rounded-lg bg-amber-600/20 border border-amber-500/30 hover:bg-amber-600/30 px-3 py-1.5 text-xs font-semibold text-amber-300 transition"
                    >
                      + Propose as Adjustment
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Period Detail View
// ---------------------------------------------------------------------------

type DetailTab = 'run' | 'prep' | 'tools';

function PeriodDetailView({
  period,
  employees,
  currency,
  onCurrencyChange,
  onBack,
  onRefresh,
}: {
  period: PayrollPeriod;
  employees: AdminEmployee[];
  currency: Currency;
  onCurrencyChange: (c: Currency) => void;
  onBack: () => void;
  onRefresh: () => void;
}) {
  // A legacy CLOSED period never went through the run, so it has no review.
  const hasRun = period.status !== 'CLOSED';
  const isFinal = isFinalStatus(period.status);
  // Closing publishes no payslips, so it is only offered where it always was:
  // a period created by hand and still open. The monthly run ends in PAID.
  const canCloseLegacy = !period.autoCreated && period.status === 'OPEN';

  const [tab, setTab] = useState<DetailTab>(hasRun ? 'run' : 'prep');
  const [prepVisited, setPrepVisited] = useState(!hasRun);
  const [sheet, setSheet] = useState<PrepareSheet | null>(null);
  const [adjustments, setAdjustments] = useState<PayrollAdjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // dataKey: something changed on the server (the run view reloads too).
  // liveKey: the live stream ticked (only the preparation sheet follows it).
  const [dataKey, setDataKey] = useState(0);
  const [liveKey, setLiveKey] = useState(0);
  const [showProposeModal, setShowProposeModal] = useState(false);
  const [showSetSalary, setShowSetSalary] = useState(false);
  const [showRateModal, setShowRateModal] = useState(false);
  const [periodRate, setPeriodRate] = useState<number>(period.exchangeRate || 350.0);
  const [setSalaryEmployeeId, setSetSalaryEmployeeId] = useState<string | null>(null);
  const [decideAdj, setDecideAdj] = useState<PayrollAdjustment | null>(null);
  const [prefill, setPrefill] = useState<{ employeeId: string; amount: number; type: string; explanation: string } | null>(null);
  const [closingConfirm, setClosingConfirm] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState('');

  const changed = useCallback(() => {
    setDataKey((k) => k + 1);
    onRefresh();
  }, [onRefresh]);

  const openTab = (t: DetailTab) => {
    setTab(t);
    if (t === 'prep') setPrepVisited(true);
  };

  // Every tab needs the adjustments: the run view uses them to find lines of
  // employees left out of the run.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.payrollAdjustments(period.id);
        if (cancelled) return;
        setAdjustments(res.adjustments ?? []);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load adjustments.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period.id, dataKey, liveKey]);

  // The preparation sheet is loaded the first time its tab is opened.
  useEffect(() => {
    if (!prepVisited) return;
    let cancelled = false;
    (async () => {
      try {
        const prepRes = await api.payrollPrepare(period.id);
        if (cancelled) return;
        const prepSheet = prepRes as unknown as PrepareSheet;
        setSheet(prepSheet);
        if (prepSheet.period?.exchangeRate) setPeriodRate(prepSheet.period.exchangeRate);
        setError('');
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load period data.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period.id, prepVisited, dataKey, liveKey]);

  // As before, the preparation sheet follows the live stream while it is on
  // screen (attendance deficits move with every clock event).
  useEffect(() => {
    if (tab !== 'prep') return;
    const handleSse = () => setLiveKey((k) => k + 1);
    window.addEventListener('office-tracker-sse', handleSse);
    return () => window.removeEventListener('office-tracker-sse', handleSse);
  }, [tab]);

  const handleSavePeriodRate = async (newRate: number) => {
    try {
      await api.updatePeriodExchangeRate(period.id, newRate);
      setPeriodRate(newRate);
      changed();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to update period rate.');
    }
  };

  const handleClose = async () => {
    setClosing(true);
    setCloseError('');
    try {
      await api.closePayrollPeriod(period.id);
      onBack();
      onRefresh();
    } catch (e: unknown) {
      setCloseError(e instanceof Error ? e.message : 'Failed to close period.');
    } finally {
      setClosing(false);
      setClosingConfirm(false);
    }
  };

  const pendingAdjCount = adjustments.filter((a) => a.status === 'PROPOSED').length;
  const currencyOf = (employeeId: string) => {
    const e = sheet?.employees.find((x) => x.employeeId === employeeId);
    return e?.salary.currency;
  };

  const tabs: { id: DetailTab; label: string }[] = [
    ...(hasRun ? [{ id: 'run' as const, label: 'Payroll run' }] : []),
    { id: 'prep', label: 'Preparation sheet' },
    { id: 'tools', label: 'Starter / leaver' },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="secondary" size="sm" onClick={onBack} icon={<ChevronLeftIcon className="h-3.5 w-3.5" />}>
              Periods
            </Button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-base font-bold text-white">{period.name}</h2>
                <StatusBadge status={period.status} />
                {period.autoCreated && <Badge tone="accent" size="sm">Auto</Badge>}
              </div>
              <p className="text-xs text-slate-400">{formatDate(period.from)} to {formatDate(period.to)}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Currency switcher & Period Rate pill */}
            <div className="flex rounded-lg border border-slate-700 bg-slate-900 p-0.5">
              {(['GBP', 'PKR'] as Currency[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onCurrencyChange(c)}
                  className={`rounded-md px-2.5 py-1 text-xs font-bold transition ${
                    currency === c
                      ? 'bg-indigo-600 text-on-accent shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {c === 'GBP' ? '£ GBP' : '₨ PKR'}
                </button>
              ))}
            </div>
            {!isFinal ? (
              <button
                type="button"
                onClick={() => setShowRateModal(true)}
                title="Click to edit conversion rate for this month"
                className="flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-950/40 hover:bg-indigo-900/50 px-2.5 py-1.5 text-xs font-mono text-indigo-300 transition"
              >
                <span>£1 = ₨{periodRate.toFixed(2)}</span>
                <PencilIcon className="h-3 w-3 shrink-0 text-indigo-400" />
              </button>
            ) : (
              <span className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-mono text-slate-400">
                <LockIcon className="h-3.5 w-3.5 shrink-0" />
                <span>£1 = ₨{periodRate.toFixed(2)}</span>
              </span>
            )}
            {!isFinal && (
              <>
                <Button size="sm" variant="secondary" icon={<PlusIcon className="h-3.5 w-3.5" />} onClick={() => { setSetSalaryEmployeeId(null); setShowSetSalary(true); }}>
                  Record salary
                </Button>
                <Button size="sm" variant="secondary" icon={<PlusIcon className="h-3.5 w-3.5" />} onClick={() => setShowProposeModal(true)}>
                  Propose adjustment
                </Button>
              </>
            )}
            {canCloseLegacy && (
              <Button size="sm" variant="ghost" onClick={() => setClosingConfirm(true)}>
                Close period (legacy)
              </Button>
            )}
          </div>
        </div>

        <div role="tablist" aria-label="Period views" className="flex w-full flex-wrap gap-1 rounded-2xl border border-white/10 bg-white/5 p-1 sm:w-fit">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => openTab(t.id)}
              className={`flex-1 whitespace-nowrap rounded-xl px-3.5 py-1.5 text-xs font-bold transition cursor-pointer sm:flex-none ${
                tab === t.id
                  ? 'bg-accent-gradient text-on-accent shadow-accent'
                  : 'text-slate-400 hover:bg-white/5 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300"><AlertTriangleIcon className="inline-block h-3.5 w-3.5" /> {error}</div>
      )}

      {/* Kept mounted while another tab is shown, so decisions in progress survive. */}
      {hasRun && (
        <div className={tab === 'run' ? '' : 'hidden'}>
          <PayrollRunView
            period={period}
            adjustments={adjustments}
            currency={currency}
            rate={periodRate}
            refreshKey={dataKey}
            onChanged={changed}
            onRecordSalary={(employeeId) => {
              setSetSalaryEmployeeId(employeeId);
              setShowSetSalary(true);
            }}
          />
        </div>
      )}

      {tab === 'prep' && (loading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        </div>
      ) : sheet && (
        <>
          {/* Prepare Sheet */}
          <SectionCard title={`Preparation Sheet — ${sheet.period?.name ?? period.name}`}>
            <div className="mb-3 rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-4 py-2 text-xs text-indigo-300">
              <InfoIcon className="inline-block h-3.5 w-3.5" /> {sheet.note}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="pb-2 text-left font-semibold">Employee</th>
                    <th className="pb-2 text-right font-semibold">Calculated Period Pay</th>
                    <th className="pb-2 text-right font-semibold">Daily Rate</th>
                    <th className="pb-2 text-right font-semibold">Contract Monthly</th>
                    <th className="pb-2 text-right font-semibold">Leave Available</th>
                    <th className="pb-2 text-right font-semibold">Deficit Equiv.</th>
                    <th className="pb-2 text-right font-semibold">Adjustments</th>
                    <th className="pb-2 text-left font-semibold pl-3">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {sheet.employees.map((emp) => {
                    const approvedAdjs = emp.adjustments.filter((a) => a.status === 'APPROVED');
                    const adjTotal = approvedAdjs.reduce((s, a) => s + (a.approvedAmount ?? a.calculatedAmount), 0);
                    const gross = emp.calculatedPeriodGross ?? (emp.isStarter && emp.starter ? emp.starter.calculatedGross : emp.salary.monthly);
                    return (
                      <tr key={emp.employeeId} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-2.5 font-medium text-white">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span>{emp.employeeName}</span>
                            {emp.employeeNumber && (
                              <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                                {emp.employeeNumber}
                              </span>
                            )}
                            {emp.salary.currency && (
                              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 border border-slate-700">
                                {emp.salary.currency}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 text-right font-mono text-slate-200">
                          <div>
                            <div className="text-emerald-400 font-bold">
                              {formatMoney(gross, currency, emp.salary.currency, periodRate)}
                            </div>
                            <div className="text-[10px] text-slate-400 font-sans">
                              {emp.workingDaysCount !== undefined ? `${emp.workingDaysCount} working days` : `${formatMoney(emp.salary.daily, currency, emp.salary.currency, periodRate)}/d`}
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 text-right font-mono text-slate-300">
                          {formatMoney(emp.salary.daily, currency, emp.salary.currency, periodRate)}
                        </td>
                        <td className="py-2.5 text-right font-mono text-slate-400">
                          {formatMoney(emp.salary.monthly, currency, emp.salary.currency, periodRate)}
                        </td>
                        <td className="py-2.5 text-right font-mono">
                          {emp.leave.blocked ? (
                            <span className="text-amber-400 text-xs"><AlertTriangleIcon className="inline-block h-3.5 w-3.5" /> {emp.leave.reason || 'Blocked'}</span>
                          ) : (
                            <span className={emp.leave.isNegative ? 'text-rose-400 font-bold' : 'text-slate-300'}>
                              {emp.leave.available ?? '—'}d
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 text-right font-mono">
                          {emp.attendanceDeficit.needsHrDecision ? (
                            <div>
                              <span className="text-rose-400 font-bold">
                                {emp.attendanceDeficit.wholeDayEquivalents}d
                              </span>
                              <div className="text-[10px] text-slate-400 font-sans">
                                Val: {formatMoney(emp.attendanceDeficit.valueIfDeducted, currency, emp.salary.currency, periodRate)}
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right font-mono">
                          {emp.adjustments.length === 0 ? (
                            <span className="text-slate-500">—</span>
                          ) : (
                            <div>
                              <span className={adjTotal < 0 ? 'text-rose-400 font-bold' : adjTotal > 0 ? 'text-emerald-400 font-bold' : 'text-slate-300'}>
                                {adjTotal !== 0 ? formatMoney(adjTotal, currency, emp.salary.currency, periodRate) : '—'}
                              </span>
                              <div className="text-[10px] text-slate-400 font-sans">
                                {approvedAdjs.length}/{emp.adjustments.length} approved
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 pl-3 text-slate-400">
                          <div className="flex flex-col gap-0.5">
                            {emp.isStarter && (
                              <span className="text-sky-400 font-medium text-[11px]">
                                <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 align-middle" /> Starter ({emp.starter?.eligibleWorkingDays}/{emp.fullPeriodDays} days)
                              </span>
                            )}
                            {emp.attendanceDeficit.needsHrDecision && (
                              <span className="text-amber-400 text-[11px]">
                                <AlertTriangleIcon className="inline-block h-3.5 w-3.5" /> Deficit ({emp.attendanceDeficit.wholeDayEquivalents}d) — pending decision
                              </span>
                            )}
                            {emp.leave.isNegative && (
                              <span className="text-rose-400 text-[11px]">
                                <span className="inline-block h-2 w-2 rounded-full bg-rose-400 align-middle" /> Negative leave balance
                              </span>
                            )}
                            {!emp.isStarter && !emp.attendanceDeficit.needsHrDecision && !emp.leave.isNegative && (
                              <span className="text-slate-500">—</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {sheet.employees.length === 0 && (
                <p className="py-8 text-center text-sm text-slate-500">No active employees with salary records.</p>
              )}
            </div>
          </SectionCard>

          {/* Blocked employees */}
          {sheet.blocked.length > 0 && (
            <SectionCard title={`Blocked — Missing Salary Records (${sheet.blocked.length})`}>
              <p className="mb-3 text-xs text-amber-400">These employees cannot be included until a salary is recorded for them.</p>
              <div className="space-y-2">
                {sheet.blocked.map((b) => (
                  <div key={b.employeeId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm text-amber-300 font-bold">{b.employeeName}</span>
                        {b.employeeNumber && (
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-mono font-bold text-amber-300 border border-amber-500/30">
                            {b.employeeNumber}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-amber-400/80">{b.message}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSetSalaryEmployeeId(b.employeeId);
                        setShowSetSalary(true);
                      }}
                      className="rounded-lg bg-amber-500 hover:bg-amber-400 px-3.5 py-1.5 text-xs font-bold text-on-bright shadow-md transition flex items-center gap-1.5"
                    >
                      <span>+ Record Salary</span>
                    </button>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {/* Adjustments Panel */}
          {(() => {
            // adj.calculated/approved.amount carries no currency of its own
            // -- it was computed in the employee's own base salary currency,
            // same as every other figure on this sheet. Without this lookup,
            // formatMoney silently defaulted every row here to GBP-sourced
            // conversion regardless of the employee's actual currency, and
            // used the hardcoded DEFAULT_PKR_RATE instead of this period's
            // own exchangeRate (periodRate) -- so in PKR view these two
            // columns could show a different rate/currency than the rest of
            // the sheet an HR reviewer is looking at for the same period.
            const employeeCurrencyById = new Map(
              sheet.employees.map((e) => [e.employeeId, 'currency' in e.salary ? e.salary.currency : undefined]),
            );
            return (
          <SectionCard title={`Payroll Adjustments${pendingAdjCount > 0 ? ` (${pendingAdjCount} pending)` : ''}`}>
            {adjustments.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-500">No adjustments proposed yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="pb-2 text-left font-semibold">Employee</th>
                      <th className="pb-2 text-left font-semibold">Type</th>
                      <th className="pb-2 text-right font-semibold">Calculated</th>
                      <th className="pb-2 text-right font-semibold">Approved</th>
                      <th className="pb-2 text-left font-semibold pl-3">Status</th>
                      {!isFinal && <th className="pb-2 text-right font-semibold">Action</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {adjustments.map((adj) => (
                      <tr key={adj.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-2.5 font-medium text-white">
                          <div className="flex items-center gap-1.5">
                            <span>{adj.employeeName}</span>
                            {adj.employeeNumber && (
                              <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                                {adj.employeeNumber}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 text-slate-300">{adj.type.replace(/_/g, ' ')}</td>
                        <td className="py-2.5 text-right font-mono text-slate-300">{formatMoney(adj.calculated.amount, currency, employeeCurrencyById.get(adj.employeeId), periodRate)}</td>
                        <td className="py-2.5 text-right font-mono text-emerald-400">
                          {adj.approved ? formatMoney(adj.approved.amount, currency, employeeCurrencyById.get(adj.employeeId), periodRate) : '—'}
                        </td>
                        <td className="py-2.5 pl-3"><StatusBadge status={adj.status} /></td>
                        {!isFinal && (
                          <td className="py-2.5 text-right">
                            {adj.status === 'PROPOSED' && (
                              <button
                                type="button"
                                onClick={() => setDecideAdj(adj)}
                                className="rounded-lg bg-indigo-600/20 border border-indigo-500/30 hover:bg-indigo-600/30 px-3 py-1 text-xs font-semibold text-indigo-300 transition"
                              >
                                Review
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
            );
          })()}
        </>
      ))}

      {tab === 'tools' && (
        <StarterLeaverPreview
          employees={employees}
          currency={currency}
          canPropose={!isFinal}
          onPropose={(eid, amount, type, explanation) => {
            setPrefill({ employeeId: eid, amount, type, explanation });
            setShowProposeModal(true);
          }}
        />
      )}

      {/* Close Period Confirmation */}
      {closingConfirm && (
        <div className={MODAL_BACKDROP}>
          <div className={`${MODAL_SHELL} max-w-sm border-rose-500/40`}>
            <h2 className="mb-2 text-base font-bold text-white">Close Payroll Period?</h2>
            <p className="mb-4 text-xs text-slate-400">
              This is irreversible. All proposed adjustments must be decided first. Once closed, no new adjustments can be added.
              Closing is the legacy way to finish a manual period: it publishes <strong>no payslips</strong>. To publish
              payslips, approve the run on the Payroll run tab instead.
            </p>
            {closeError && <div className="mb-3 text-xs text-rose-400">{closeError}</div>}
            {pendingAdjCount > 0 && (
              <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                <AlertTriangleIcon className="inline-block h-3.5 w-3.5" /> There are {pendingAdjCount} pending adjustment(s). The backend will reject the close request until all are decided.
              </div>
            )}
            <div className="flex gap-3">
              <button type="button" onClick={handleClose} disabled={closing}
                className="flex-1 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-on-accent transition">
                {closing ? 'Closing…' : 'Yes, Close Period'}
              </button>
              <button type="button" onClick={() => setClosingConfirm(false)}
                className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Propose Adjustment Modal */}
      {showProposeModal && (
        <ProposeAdjModal
          periodId={period.id}
          employees={employees}
          prefilledEmployeeId={prefill?.employeeId}
          prefilledAmount={prefill?.amount}
          prefilledType={prefill?.type}
          prefilledExplanation={prefill?.explanation}
          onClose={() => { setShowProposeModal(false); setPrefill(null); }}
          onProposed={changed}
        />
      )}

      {/* Set Salary Modal */}
      {showSetSalary && (
        <SetSalaryModal
          employees={employees}
          prefilledEmployeeId={setSalaryEmployeeId ?? undefined}
          defaultEffectiveFrom={period.from}
          onClose={() => { setShowSetSalary(false); setSetSalaryEmployeeId(null); }}
          onSuccess={changed}
        />
      )}

      {/* Exchange Rate Modal */}
      {showRateModal && (
        <ExchangeRateModal
          currentRate={periodRate}
          onClose={() => setShowRateModal(false)}
          onSave={handleSavePeriodRate}
        />
      )}

      {/* Decide Adjustment Modal */}
      {decideAdj && (
        <DecideAdjModal
          adj={decideAdj}
          formatAmount={(amount) => formatMoney(amount, currency, currencyOf(decideAdj.employeeId), periodRate)}
          onClose={() => setDecideAdj(null)}
          onDecided={changed}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Period list
// ---------------------------------------------------------------------------

const RATE_STORAGE_KEY = 'office_tracker_pkr_rate';

function readSavedRate(): number {
  try {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(RATE_STORAGE_KEY) : null;
    const parsed = saved ? parseFloat(saved) : NaN;
    return !isNaN(parsed) && parsed > 0 ? parsed : DEFAULT_PKR_RATE;
  } catch {
    return DEFAULT_PKR_RATE;
  }
}

const OPEN_ACTION: Record<PayrollPeriod['status'], string> = {
  OPEN: 'Open',
  IN_REVIEW: 'Review & approve',
  PUBLISHED: 'Payslips',
  PAID: 'View',
  CLOSED: 'View',
};

function PeriodRow({ period: p, onOpen }: { period: PayrollPeriod; onOpen: () => void }) {
  const needsReview = p.status === 'IN_REVIEW';
  return (
    <li
      className={`flex flex-col gap-3 rounded-2xl border p-4 transition-colors sm:flex-row sm:items-center sm:justify-between ${
        needsReview ? 'border-amber-500/30 bg-amber-500/5' : 'border-white/10 bg-white/3 hover:bg-white/5'
      }`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-white">{p.name}</span>
          <StatusBadge status={p.status} />
          <Badge tone={p.autoCreated ? 'accent' : 'muted'} size="sm">
            {p.autoCreated ? 'Auto-created' : 'Manual'}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-slate-400">{formatDate(p.from)} to {formatDate(p.to)}</p>
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
          <div>
            <dt className="inline">Cut-off </dt>
            <dd className="inline text-slate-300">{p.cutoffDate ? formatDate(p.cutoffDate) : 'none'}</dd>
          </div>
          <div>
            <dt className="inline">Pay date </dt>
            <dd className="inline text-slate-300">{formatDate(p.payDate)}</dd>
          </div>
          <div>
            <dt className="inline">Rate </dt>
            <dd className="inline font-mono text-slate-300">£1 = ₨{(p.exchangeRate || 350.0).toFixed(2)}</dd>
          </div>
          {p.publishedAt != null && (
            <div>
              <dt className="inline">Published </dt>
              <dd className="inline text-slate-300">{formatTimestamp(p.publishedAt)}</dd>
            </div>
          )}
          {p.paidAt != null && (
            <div>
              <dt className="inline">Paid </dt>
              <dd className="inline text-slate-300">{formatTimestamp(p.paidAt)}</dd>
            </div>
          )}
          {p.status === 'CLOSED' && p.approvedBy && (
            <div>
              <dt className="inline">Closed by </dt>
              <dd className="inline text-slate-300">{formatActor(p.approvedBy)}</dd>
            </div>
          )}
        </dl>
      </div>
      <Button variant={needsReview ? 'accent' : 'secondary'} size="sm" className="shrink-0 self-start sm:self-center" onClick={onOpen}>
        {OPEN_ACTION[p.status] ?? 'View'}
        <ChevronRightIcon className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main PayrollPanel
// ---------------------------------------------------------------------------

export function PayrollPanel() {
  const [periods, setPeriods] = useState<PayrollPeriod[]>([]);
  const [employees, setEmployees] = useState<AdminEmployee[]>([]);
  const [showSalaryToEmployees, setShowSalaryToEmployees] = useState(false);
  const [togglingVisibility, setTogglingVisibility] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showSetSalary, setShowSetSalary] = useState(false);
  const [showRateModal, setShowRateModal] = useState(false);
  // By id, so the open period follows the list as it reloads (its status
  // moves on when the run is approved or paid).
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
  const [currency, setCurrency] = useState<Currency>('GBP');
  const [pkrRate, setPkrRate] = useState<number>(readSavedRate);
  const [reloadKey, setReloadKey] = useState(0);

  const loadPeriods = useCallback(() => setReloadKey((k) => k + 1), []);

  const handleSaveRate = (newRate: number) => {
    setPkrRate(newRate);
    try {
      window.localStorage.setItem(RATE_STORAGE_KEY, newRate.toString());
    } catch {
      // Storage blocked: the rate still applies for this visit.
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pRes, eRes, sRes] = await Promise.all([
          api.payrollPeriods(),
          api.employees(),
          api.getSettings().catch(() => ({ settings: {} as Record<string, string> })),
        ]);
        if (cancelled) return;
        setPeriods(pRes.periods ?? []);
        setEmployees(eRes.employees ?? []);
        if (sRes?.settings) {
          setShowSalaryToEmployees(sRes.settings.show_salary_to_employees === '1' || sRes.settings.show_salary_to_employees === 'true');
        }
        setError('');
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load payroll data.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    window.addEventListener('office-tracker-sse', loadPeriods);
    const iv = setInterval(loadPeriods, 30_000);
    return () => {
      window.removeEventListener('office-tracker-sse', loadPeriods);
      clearInterval(iv);
    };
  }, [loadPeriods]);

  const handleToggleSalaryVisibility = async () => {
    const nextVal = !showSalaryToEmployees;
    setTogglingVisibility(true);
    try {
      await api.updateSetting('show_salary_to_employees', nextVal ? '1' : '0');
      setShowSalaryToEmployees(nextVal);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update salary visibility setting.');
    } finally {
      setTogglingVisibility(false);
    }
  };

  const handleCreate = async (
    name: string,
    startDate: string,
    endDate: string,
    exchangeRate: number,
    dates: { cutoffDate: string | null; payDate: string | null },
  ) => {
    await api.createPayrollPeriod(name, startDate, endDate, exchangeRate, dates);
    loadPeriods();
  };

  // Period detail drill-down
  const selectedPeriod = selectedPeriodId ? periods.find((p) => p.id === selectedPeriodId) ?? null : null;
  if (selectedPeriod) {
    return (
      <PeriodDetailView
        key={selectedPeriod.id}
        period={selectedPeriod}
        employees={employees}
        currency={currency}
        onCurrencyChange={setCurrency}
        onBack={() => setSelectedPeriodId(null)}
        onRefresh={loadPeriods}
      />
    );
  }

  const currentPeriods = periods.filter((p) => p.status === 'OPEN' || p.status === 'IN_REVIEW' || p.status === 'PUBLISHED');
  const pastPeriods = periods.filter((p) => p.status === 'PAID' || p.status === 'CLOSED');
  const inReview = periods.filter((p) => p.status === 'IN_REVIEW');

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Payroll</h2>
          <p className="text-sm text-slate-400">
            Each month opens automatically; deductions are generated at the cut-off. Nothing is paid until HR approves the run.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Currency switcher & Rate pill */}
          <div className="flex rounded-lg border border-slate-700 bg-slate-900 p-0.5">
            {(['GBP', 'PKR'] as Currency[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCurrency(c)}
                className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${
                  currency === c
                    ? 'bg-indigo-600 text-on-accent shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {c === 'GBP' ? '£ GBP' : '₨ PKR'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowRateModal(true)}
            title="Click to change exchange rate"
            className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/80 hover:bg-slate-800 px-3 py-1.5 text-xs font-mono text-indigo-300 transition"
          >
            <span>£1 = ₨{pkrRate.toFixed(2)}</span>
            <SettingsIcon className="h-3 w-3 shrink-0 text-slate-500" />
          </button>
          <Button variant="secondary" icon={<PlusIcon className="h-3.5 w-3.5" />} onClick={() => setShowSetSalary(true)}>
            Set salary
          </Button>
          <Button variant="secondary" icon={<PlusIcon className="h-3.5 w-3.5" />} onClick={() => setShowCreate(true)}>
            New period
          </Button>
        </div>
      </div>

      {/* Employee Mobile Salary Visibility Setting Banner */}
      <div className="glass-panel flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3">
        <div className="flex items-center gap-3">
          <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${showSalaryToEmployees ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
            {showSalaryToEmployees ? <EyeIcon className="h-5 w-5" /> : <LockIcon className="h-5 w-5" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-white">Employee Mobile Salary Visibility</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${showSalaryToEmployees ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-400 border border-slate-700'}`}>
                {showSalaryToEmployees ? 'Visible on Mobile' : 'Hidden on Mobile'}
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              {showSalaryToEmployees
                ? 'Staff can view their pay and published payslips in the mobile app, and are told when a payslip is published.'
                : 'Personal salaries and payslips are hidden from the mobile app and stripped from employee API responses.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleToggleSalaryVisibility}
          disabled={togglingVisibility}
          className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition flex items-center gap-1.5 ${
            showSalaryToEmployees
              ? 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30'
              : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
          }`}
        >
          {togglingVisibility ? 'Updating…' : (showSalaryToEmployees ? <><LockIcon className="h-3.5 w-3.5 shrink-0" /> Hide From Staff</> : <><EyeIcon className="h-3.5 w-3.5 shrink-0" /> Enable Staff View</>)}
        </button>
      </div>

      {currency === 'PKR' && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-300">
          <span><CurrencyExchangeIcon className="inline-block h-3.5 w-3.5" /> PKR conversions use the current exchange rate <strong>£1.00 = ₨{pkrRate.toFixed(2)}</strong>. Inside a period, that period&apos;s own rate is used.</span>
          <button
            type="button"
            onClick={() => setShowRateModal(true)}
            className="rounded-lg border border-amber-500/40 bg-amber-500/20 hover:bg-amber-500/30 px-3 py-1 text-xs font-bold text-amber-200 transition"
          >
            Edit Rate
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300"><AlertTriangleIcon className="inline-block h-3.5 w-3.5" /> {error}</div>
      )}

      {inReview.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400">
              <AlertTriangleIcon className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-bold text-amber-300">
                {inReview.length === 1 ? `${inReview[0].name} is ready for review` : `${inReview.length} payroll runs are ready for review`}
              </div>
              <div className="text-xs text-amber-400/80">Deductions are generated. Nothing is paid until the run is approved.</div>
            </div>
          </div>
          <Button variant="accent" size="sm" onClick={() => setSelectedPeriodId(inReview[0].id)}>
            Review {inReview.length === 1 ? 'now' : inReview[0].name}
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        </div>
      ) : periods.length === 0 ? (
        <Empty
          icon={<BriefcaseIcon className="h-6 w-6" />}
          title="No payroll periods yet"
          description="This month's period opens automatically on the next maintenance run. For an off-cycle run, create one by hand."
          action={
            <Button variant="secondary" icon={<PlusIcon className="h-3.5 w-3.5" />} onClick={() => setShowCreate(true)}>
              Create a period
            </Button>
          }
        />
      ) : (
        <>
          <SectionCard title={`Current runs (${currentPeriods.length})`}>
            {currentPeriods.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-500">
                No run in progress. This month&apos;s period opens automatically.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {currentPeriods.map((p) => (
                  <PeriodRow key={p.id} period={p} onOpen={() => setSelectedPeriodId(p.id)} />
                ))}
              </ul>
            )}
          </SectionCard>

          {pastPeriods.length > 0 && (
            <SectionCard title={`Paid and closed (${pastPeriods.length})`}>
              <ul className="flex flex-col gap-2">
                {pastPeriods.map((p) => (
                  <PeriodRow key={p.id} period={p} onOpen={() => setSelectedPeriodId(p.id)} />
                ))}
              </ul>
            </SectionCard>
          )}
        </>
      )}

      {showCreate && (
        <CreatePeriodModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}

      {showSetSalary && (
        <SetSalaryModal
          employees={employees}
          onClose={() => setShowSetSalary(false)}
          onSuccess={loadPeriods}
        />
      )}

      {showRateModal && (
        <ExchangeRateModal
          currentRate={pkrRate}
          onClose={() => setShowRateModal(false)}
          onSave={handleSaveRate}
        />
      )}
    </div>
  );
}
