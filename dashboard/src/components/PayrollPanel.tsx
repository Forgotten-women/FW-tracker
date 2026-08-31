'use client';

/**
 * PayrollPanel — Spec section 2.13
 *
 * Every figure here is a CALCULATION. Nothing changes anyone's pay until a
 * human approves an adjustment and a payroll period is closed. The backend
 * enforces this; this UI makes it obvious.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type {
  AdminEmployee,
  LeaverCalculation,
  PayrollAdjustment,
  PayrollPeriod,
  StarterCalculation,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Currency helpers
// ---------------------------------------------------------------------------

type Currency = 'GBP' | 'PKR';

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  PKR: '₨',
  USD: '$',
  EUR: '€',
};

const DEFAULT_PKR_RATE = 350;

function formatMoney(
  amount: number | null | undefined,
  displayCurrency: Currency,
  recordedCurrency?: string,
  pkrRate: number = DEFAULT_PKR_RATE,
): string {
  if (amount == null) return '—';
  const src = (recordedCurrency || 'GBP').toUpperCase();
  const tgt = (displayCurrency || 'GBP').toUpperCase();

  let value = amount;
  if (src === 'GBP' && tgt === 'PKR') {
    value = amount * pkrRate;
  } else if (src === 'PKR' && tgt === 'GBP') {
    value = amount / (pkrRate || 1);
  }

  const sym = CURRENCY_SYMBOLS[tgt] ?? `${tgt} `;
  return `${sym}${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-[#0F172A] p-6 shadow-2xl">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xl">💱</span>
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
            className="flex-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-600/30 transition"
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
  salary: { monthly: number; daily: number; annual: number; currency?: string };
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
  const map: Record<string, string> = {
    OPEN: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    DRAFT: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    CLOSED: 'bg-slate-700/50 text-slate-400 border-slate-600/30',
    PROPOSED: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    APPROVED: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
    REJECTED: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  };
  const cls = map[status] ?? 'bg-slate-700/50 text-slate-400 border-slate-600/30';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-[#141E33] shadow-xl overflow-hidden">
      <div className="border-b border-slate-800/80 px-5 py-4">
        <h3 className="text-sm font-bold text-white">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </div>
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
  onCreate: (name: string, from: string, to: string, exchangeRate?: number) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exchangeRate, setExchangeRate] = useState('350.00');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!name.trim() || !from || !to) { setError('All fields are required.'); return; }
    if (to < from) { setError('End date must be on or after start date.'); return; }
    const parsedRate = parseFloat(exchangeRate);
    if (isNaN(parsedRate) || parsedRate <= 0) { setError('Please enter a valid positive conversion rate.'); return; }
    setLoading(true);
    setError('');
    try {
      await onCreate(name.trim(), from, to, parsedRate);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create period.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#0F172A] p-6 shadow-2xl">
        <h2 className="mb-5 text-base font-bold text-white">Create Payroll Period</h2>
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
            <p className="mt-1 text-[11px] text-slate-500">Rate applied to this specific payroll run. Can be adjusted before period closing.</p>
          </div>
        </div>
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading}
            className="flex-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white transition"
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

function SetSalaryModal({
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#0F172A] p-6 shadow-2xl">
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
            className="flex-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white transition shadow-lg shadow-indigo-600/30"
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#0F172A] p-6 shadow-2xl">
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
            <label className="mb-1 block text-xs font-semibold text-slate-400">Amount (GBP)</label>
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
            className="flex-1 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white transition"
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
          ℹ️ Proposed adjustments affect nothing until approved by an authorised HR user.
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
  onClose,
  onDecided,
}: {
  adj: PayrollAdjustment;
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#0F172A] p-6 shadow-2xl">
        <h2 className="mb-1 text-base font-bold text-white">Review Adjustment</h2>
        <p className="mb-4 text-xs text-slate-400">{adj.employeeName} · {adj.type}</p>
        {error && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{error}</div>
        )}
        <div className="mb-4 rounded-xl border border-slate-700 bg-slate-900/60 p-4 text-xs space-y-1">
          <div className="flex justify-between"><span className="text-slate-400">Calculated amount</span><span className="font-mono text-white">£{adj.calculated.amount?.toFixed(2)}</span></div>
          {adj.explanation && <p className="text-slate-400 pt-1">"{adj.explanation}"</p>}
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
              <label className="mb-1 block text-xs font-semibold text-slate-400">Override Amount (leave blank to use calculated)</label>
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
  periodId,
  employees,
  currency,
  onPropose,
}: {
  periodId: string;
  employees: AdminEmployee[];
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
      const emp = employees.find((e) => e.id === employeeId);
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
            {m === 'STARTER' ? '🚀 New Starter' : '👋 Leaver'}
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
            className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white transition"
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
                <p className="text-sm text-rose-400">⚠️ {starterCalc.reason}</p>
              )}
              {starterCalc.applicable && !starterCalc.blocked && (
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-slate-400">Start date</span><span className="text-white">{starterCalc.startDate}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Eligible working days</span><span className="font-mono text-white">{starterCalc.eligibleWorkingDays}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Daily rate</span><span className="font-mono text-white">{formatMoney(starterCalc.dailyRate ?? null, currency)}</span></div>
                  <div className="flex justify-between text-sm font-bold"><span className="text-slate-300">Calculated gross</span><span className="text-emerald-400">{formatMoney(starterCalc.calculatedGross ?? null, currency)}</span></div>
                  <p className="pt-1 text-[11px] text-slate-500">{starterCalc.formula}</p>
                  <button
                    type="button"
                    onClick={handlePropose}
                    className="mt-3 rounded-lg bg-amber-600/20 border border-amber-500/30 hover:bg-amber-600/30 px-3 py-1.5 text-xs font-semibold text-amber-300 transition"
                  >
                    + Propose as Adjustment
                  </button>
                </div>
              )}
            </>
          )}
          {mode === 'LEAVER' && leaverCalc && (
            <>
              {leaverCalc.blocked && (
                <p className="text-sm text-rose-400">⚠️ {leaverCalc.message ?? leaverCalc.reason}</p>
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
                  <p className="pt-1 text-[11px] text-amber-400/80">⚠️ These are calculations only. No changes made until HR approves.</p>
                  <button
                    type="button"
                    onClick={handlePropose}
                    className="mt-2 rounded-lg bg-amber-600/20 border border-amber-500/30 hover:bg-amber-600/30 px-3 py-1.5 text-xs font-semibold text-amber-300 transition"
                  >
                    + Propose as Adjustment
                  </button>
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
  const [sheet, setSheet] = useState<PrepareSheet | null>(null);
  const [adjustments, setAdjustments] = useState<PayrollAdjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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

  const loadData = useCallback(async () => {
    setError('');
    try {
      const [prepRes, adjRes] = await Promise.all([
        api.payrollPrepare(period.id),
        api.payrollAdjustments(period.id),
      ]);
      const prepSheet = prepRes as unknown as PrepareSheet;
      setSheet(prepSheet);
      if (prepSheet.period?.exchangeRate) {
        setPeriodRate(prepSheet.period.exchangeRate);
      }
      setAdjustments(adjRes.adjustments ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load period data.');
    } finally {
      setLoading(false);
    }
  }, [period.id]);

  const handleSavePeriodRate = async (newRate: number) => {
    try {
      await api.updatePeriodExchangeRate(period.id, newRate);
      setPeriodRate(newRate);
      await loadData();
      onRefresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to update period rate.');
    }
  };

  useEffect(() => {
    loadData();

    const handleSse = () => { loadData(); };
    if (typeof window !== 'undefined') window.addEventListener('office-tracker-sse', handleSse);
    return () => { if (typeof window !== 'undefined') window.removeEventListener('office-tracker-sse', handleSse); };
  }, [loadData]);

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

  const pendingAdjCount = adjustments.filter((a) => a.status === 'PENDING').length;
  const isClosed = period.status === 'CLOSED';

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 px-3 py-2 text-xs font-medium text-slate-300 transition flex items-center gap-1.5"
          >
            ← Back to Periods
          </button>
          <div>
            <h2 className="text-base font-bold text-white">{period.name}</h2>
            <p className="text-xs text-slate-400">{period.from} → {period.to}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Currency switcher & Period Rate pill */}
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-slate-700 bg-slate-900 p-0.5">
              {(['GBP', 'PKR'] as Currency[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onCurrencyChange(c)}
                  className={`rounded-md px-2.5 py-1 text-xs font-bold transition ${
                    currency === c
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {c === 'GBP' ? '£ GBP' : '₨ PKR'}
                </button>
              ))}
            </div>
            {!isClosed ? (
              <button
                type="button"
                onClick={() => setShowRateModal(true)}
                title="Click to edit conversion rate for this month"
                className="flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-950/40 hover:bg-indigo-900/50 px-2.5 py-1.5 text-xs font-mono text-indigo-300 transition"
              >
                <span>£1 = ₨{periodRate.toFixed(2)}</span>
                <span className="text-[10px] text-indigo-400">✏️</span>
              </button>
            ) : (
              <span className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-mono text-slate-400">
                <span>🔒 £1 = ₨{periodRate.toFixed(2)}</span>
              </span>
            )}
          </div>
          <StatusBadge status={period.status} />
          {!isClosed && (
            <>
              <button
                type="button"
                onClick={() => { setSetSalaryEmployeeId(null); setShowSetSalary(true); }}
                className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-300 transition"
              >
                + Record Salary
              </button>
              <button
                type="button"
                onClick={() => setShowProposeModal(true)}
                className="rounded-lg bg-amber-600/20 border border-amber-500/30 hover:bg-amber-600/30 px-4 py-2 text-xs font-semibold text-amber-300 transition"
              >
                + Propose Adjustment
              </button>
            </>
          )}
          {!isClosed && (
            <button
              type="button"
              onClick={() => setClosingConfirm(true)}
              className="rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 px-4 py-2 text-xs font-semibold text-slate-300 transition"
            >
              Close Period
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">⚠️ {error}</div>
      )}

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        </div>
      ) : sheet && (
        <>
          {/* Prepare Sheet */}
          <SectionCard title={`Preparation Sheet — ${sheet.period?.name ?? period.name}`}>
            <div className="mb-3 rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-4 py-2 text-xs text-indigo-300">
              ℹ️ {sheet.note}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="pb-2 text-left font-semibold">Employee</th>
                    <th className="pb-2 text-right font-semibold">Monthly Salary</th>
                    <th className="pb-2 text-right font-semibold">Daily Rate</th>
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
                    return (
                      <tr key={emp.employeeId} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-2.5 font-medium text-white">
                          {emp.employeeName}
                          {emp.isStarter && <span className="ml-2 rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] text-sky-400">Starter</span>}
                          {emp.salary.currency && (
                            <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 border border-slate-700">
                              {emp.salary.currency}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 text-right font-mono text-slate-200">
                          {formatMoney(emp.salary.monthly, currency, emp.salary.currency, periodRate)}
                        </td>
                        <td className="py-2.5 text-right font-mono text-slate-300">
                          {formatMoney(emp.salary.daily, currency, emp.salary.currency, periodRate)}
                        </td>
                        <td className={`py-2.5 text-right font-mono ${emp.leave.isNegative ? 'text-rose-400' : 'text-emerald-400'}`}>
                          {emp.leave.blocked ? <span className="text-slate-500">—</span> : `${emp.leave.available?.toFixed(2)} d`}
                        </td>
                        <td className={`py-2.5 text-right font-mono ${emp.attendanceDeficit.needsHrDecision ? 'text-amber-400' : 'text-slate-400'}`}>
                          {emp.attendanceDeficit.wholeDayEquivalents > 0
                            ? <>{emp.attendanceDeficit.wholeDayEquivalents}d <span className="text-[10px]">({formatMoney(emp.attendanceDeficit.valueIfDeducted, currency, emp.salary.currency, periodRate)})</span></>
                            : '—'}
                        </td>
                        <td className="py-2.5 text-right font-mono text-slate-300">
                          {emp.adjustments.length > 0
                            ? <span className={adjTotal < 0 ? 'text-rose-400' : 'text-emerald-400'}>{adjTotal > 0 ? '+' : ''}{formatMoney(adjTotal, currency, emp.salary.currency, periodRate)}</span>
                            : <span className="text-slate-500">—</span>}
                        </td>
                        <td className="py-2.5 pl-3 text-slate-400">
                          {emp.adjustments.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {emp.adjustments.map((a) => (
                                <StatusBadge key={a.id} status={a.status} />
                              ))}
                            </div>
                          )}
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
                      <span className="text-sm text-amber-300 font-bold">{b.employeeName}</span>
                      <span className="text-xs text-amber-400/80">{b.message}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSetSalaryEmployeeId(b.employeeId);
                        setShowSetSalary(true);
                      }}
                      className="rounded-lg bg-amber-500 hover:bg-amber-400 px-3.5 py-1.5 text-xs font-bold text-slate-950 shadow-md transition flex items-center gap-1.5"
                    >
                      <span>+ Record Salary</span>
                    </button>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {/* Adjustments Panel */}
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
                      {!isClosed && <th className="pb-2 text-right font-semibold">Action</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {adjustments.map((adj) => (
                      <tr key={adj.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-2.5 font-medium text-white">{adj.employeeName}</td>
                        <td className="py-2.5 text-slate-300">{adj.type.replace(/_/g, ' ')}</td>
                        <td className="py-2.5 text-right font-mono text-slate-300">{formatMoney(adj.calculated.amount, currency)}</td>
                        <td className="py-2.5 text-right font-mono text-emerald-400">
                          {adj.approved ? formatMoney(adj.approved.amount, currency) : '—'}
                        </td>
                        <td className="py-2.5 pl-3"><StatusBadge status={adj.status} /></td>
                        {!isClosed && (
                          <td className="py-2.5 text-right">
                            {adj.status === 'PENDING' && (
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
        </>
      )}

      {/* Starter/Leaver Preview */}
      <StarterLeaverPreview
        periodId={period.id}
        employees={employees}
        currency={currency}
        onPropose={(eid, amount, type, explanation) => {
          setPrefill({ employeeId: eid, amount, type, explanation });
          setShowProposeModal(true);
        }}
      />

      {/* Close Period Confirmation */}
      {closingConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-rose-700/50 bg-[#0F172A] p-6 shadow-2xl">
            <h2 className="mb-2 text-base font-bold text-white">Close Payroll Period?</h2>
            <p className="mb-4 text-xs text-slate-400">
              This is irreversible. All proposed adjustments must be decided first. Once closed, no new adjustments can be added.
            </p>
            {closeError && <div className="mb-3 text-xs text-rose-400">{closeError}</div>}
            {pendingAdjCount > 0 && (
              <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                ⚠️ There are {pendingAdjCount} pending adjustment(s). The backend will reject the close request until all are decided.
              </div>
            )}
            <div className="flex gap-3">
              <button type="button" onClick={handleClose} disabled={closing}
                className="flex-1 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white transition">
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
          onProposed={loadData}
        />
      )}

      {/* Set Salary Modal */}
      {showSetSalary && (
        <SetSalaryModal
          employees={employees}
          prefilledEmployeeId={setSalaryEmployeeId ?? undefined}
          defaultEffectiveFrom={period.from}
          onClose={() => { setShowSetSalary(false); setSetSalaryEmployeeId(null); }}
          onSuccess={loadData}
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
          onClose={() => setDecideAdj(null)}
          onDecided={loadData}
        />
      )}
    </div>
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
  const [selectedPeriod, setSelectedPeriod] = useState<PayrollPeriod | null>(null);
  const [currency, setCurrency] = useState<Currency>('GBP');
  const [pkrRate, setPkrRate] = useState<number>(DEFAULT_PKR_RATE);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('office_tracker_pkr_rate');
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed > 0) setPkrRate(parsed);
      }
    }
  }, []);

  const handleSaveRate = (newRate: number) => {
    setPkrRate(newRate);
    if (typeof window !== 'undefined') {
      localStorage.setItem('office_tracker_pkr_rate', newRate.toString());
    }
  };

  const loadPeriods = useCallback(async () => {
    setError('');
    try {
      const [pRes, eRes, sRes] = await Promise.all([
        api.payrollPeriods(),
        api.employees(),
        api.getSettings().catch(() => ({ settings: {} as Record<string, string> })),
      ]);
      setPeriods(pRes.periods ?? []);
      setEmployees(eRes.employees ?? []);
      if (sRes?.settings) {
        setShowSalaryToEmployees(sRes.settings.show_salary_to_employees === '1' || sRes.settings.show_salary_to_employees === 'true');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load payroll data.');
    } finally {
      setLoading(false);
    }
  }, []);

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

  useEffect(() => {
    loadPeriods();
    const handleSse = () => { loadPeriods(); };
    if (typeof window !== 'undefined') window.addEventListener('office-tracker-sse', handleSse);
    const iv = setInterval(loadPeriods, 30_000);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('office-tracker-sse', handleSse);
      clearInterval(iv);
    };
  }, [loadPeriods]);

  const handleCreate = async (name: string, startDate: string, endDate: string, exchangeRate?: number) => {
    await api.createPayrollPeriod(name, startDate, endDate, exchangeRate);
    await loadPeriods();
  };

  // Period detail drill-down
  if (selectedPeriod) {
    return (
      <PeriodDetailView
        period={selectedPeriod}
        employees={employees}
        currency={currency}
        onCurrencyChange={setCurrency}
        onBack={() => setSelectedPeriod(null)}
        onRefresh={loadPeriods}
      />
    );
  }

  const openPeriods = periods.filter((p) => p.status === 'OPEN' || p.status === 'DRAFT');
  const closedPeriods = periods.filter((p) => p.status === 'CLOSED');

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Payroll Preparation</h2>
          <p className="text-sm text-slate-400">All figures are calculations requiring HR approval before any pay is affected.</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Currency switcher & Rate pill */}
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-slate-700 bg-slate-900 p-0.5">
              {(['GBP', 'PKR'] as Currency[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCurrency(c)}
                  className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${
                    currency === c
                      ? 'bg-indigo-600 text-white shadow'
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
              <span className="text-[10px] text-slate-500">⚙️</span>
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowSetSalary(true)}
            className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 px-3.5 py-2 text-sm font-semibold text-slate-300 transition"
          >
            + Set Salary
          </button>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 transition"
          >
            + New Period
          </button>
        </div>
      </div>

      {/* Employee Mobile Salary Visibility Setting Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-[#0F172A] px-4 py-3 shadow-md">
        <div className="flex items-center gap-3">
          <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${showSalaryToEmployees ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
            {showSalaryToEmployees ? '👁️' : '🔒'}
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
                ? 'Staff can view their monthly gross pay, daily rate and currency on the mobile app Profile screen in real-time.'
                : 'Personal salaries are hidden from mobile app and stripped from employee API responses.'}
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
          {togglingVisibility ? 'Updating…' : (showSalaryToEmployees ? '🔒 Hide From Staff' : '👁️ Enable Staff View')}
        </button>
      </div>

      {currency === 'PKR' && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-300">
          <span>💱 PKR conversions use the current exchange rate <strong>£1.00 = ₨{pkrRate.toFixed(2)}</strong>.</span>
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
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">⚠️ {error}</div>
      )}

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        </div>
      ) : (
        <>
          {/* Open Periods */}
          <SectionCard title={`Open Periods (${openPeriods.length})`}>
            {openPeriods.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-10">
                <div className="text-4xl">💼</div>
                <p className="text-sm text-slate-400">No open payroll periods. Create one to start preparation.</p>
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition"
                >
                  + Create First Period
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs text-slate-400">
                      <th className="pb-2 text-left font-semibold">Period Name</th>
                      <th className="pb-2 text-left font-semibold">Date Range</th>
                      <th className="pb-2 text-left font-semibold">Conversion Rate</th>
                      <th className="pb-2 text-left font-semibold">Status</th>
                      <th className="pb-2 text-right font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {openPeriods.map((p) => (
                      <tr key={p.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-3 font-medium text-white">{p.name}</td>
                        <td className="py-3 text-slate-400">{p.from} → {p.to}</td>
                        <td className="py-3 font-mono text-xs text-indigo-300">
                          1 GBP = ₨{(p.exchangeRate || 350.0).toFixed(2)}
                        </td>
                        <td className="py-3"><StatusBadge status={p.status} /></td>
                        <td className="py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedPeriod(p)}
                            className="rounded-lg bg-indigo-600/20 border border-indigo-500/30 hover:bg-indigo-600/30 px-3 py-1.5 text-xs font-semibold text-indigo-300 transition"
                          >
                            View →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          {/* Closed Periods */}
          {closedPeriods.length > 0 && (
            <SectionCard title={`Closed Periods (${closedPeriods.length})`}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs text-slate-400">
                      <th className="pb-2 text-left font-semibold">Period Name</th>
                      <th className="pb-2 text-left font-semibold">Date Range</th>
                      <th className="pb-2 text-left font-semibold">Locked Rate</th>
                      <th className="pb-2 text-left font-semibold">Status</th>
                      <th className="pb-2 text-left font-semibold">Closed By</th>
                      <th className="pb-2 text-right font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {closedPeriods.map((p) => (
                      <tr key={p.id} className="hover:bg-slate-800/30 transition-colors opacity-75">
                        <td className="py-3 font-medium text-white">{p.name}</td>
                        <td className="py-3 text-slate-400">{p.from} → {p.to}</td>
                        <td className="py-3 font-mono text-xs text-slate-400">
                          1 GBP = ₨{(p.exchangeRate || 350.0).toFixed(2)}
                        </td>
                        <td className="py-3"><StatusBadge status={p.status} /></td>
                        <td className="py-3 text-slate-500 text-xs">{p.approvedBy ?? '—'}</td>
                        <td className="py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedPeriod(p)}
                            className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 transition"
                          >
                            View →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
