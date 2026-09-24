'use client';

import React, { useState } from 'react';
import { api } from '@/lib/api';

interface ManualTimeModalProps {
  isOpen: boolean;
  onClose: () => void;
  employees: Array<{ id: string; name: string; role?: string }>;
  defaultEmployeeId?: string;
  defaultDate?: string;
  onSuccess?: () => void;
}

export function ManualTimeModal({
  isOpen,
  onClose,
  employees,
  defaultEmployeeId = '',
  defaultDate = new Date().toISOString().slice(0, 10),
  onSuccess,
}: ManualTimeModalProps) {
  const [employeeId, setEmployeeId] = useState(defaultEmployeeId || (employees[0]?.id || ''));
  const [dateKey, setDateKey] = useState(defaultDate);
  const [minutes, setMinutes] = useState('15');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const empTarget = employeeId || defaultEmployeeId || employees[0]?.id;
    if (!empTarget) {
      setError('Please select an employee.');
      return;
    }
    const numMins = parseInt(minutes, 10);
    if (isNaN(numMins) || numMins === 0) {
      setError('Minutes must be a non-zero number.');
      return;
    }
    if (!reason.trim()) {
      setError('A explanation/reason is required.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await api.addManualAttendanceTime(empTarget, numMins, reason.trim(), dateKey);
      setLoading(false);
      onClose();
      if (onSuccess) onSuccess();
    } catch (err: any) {
      setLoading(false);
      setError(err?.message || 'Failed to apply manual time entry.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md rounded-2xl border border-indigo-500/30 bg-slate-900/95 p-6 shadow-2xl shadow-indigo-950/50">
        <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-4">
          <div className="flex items-center gap-2">
            <span className="text-xl">⏱️</span>
            <div>
              <h3 className="text-sm font-extrabold text-white">HR Manual Time Adjustment</h3>
              <p className="text-[11px] text-slate-400">Directly credit worked minutes without requiring dispute appeal</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Employee Selection */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              EMPLOYEE
            </label>
            <select
              value={employeeId || defaultEmployeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
            >
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name} {emp.role ? `(${emp.role})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Date Picker */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              DATE
            </label>
            <input
              type="date"
              value={dateKey}
              onChange={(e) => setDateKey(e.target.value)}
              className="w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {/* Minutes to Add */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              MINUTES TO ADD (e.g. 11 for +11 mins, -15 for deduction)
            </label>
            <input
              type="number"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              placeholder="e.g. 15"
              className="w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-2 text-xs font-mono font-bold text-emerald-400 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {/* Reason */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              EXPLANATION / REASON (Visible to Employee)
            </label>
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Employee arrived at 11:09 AM; Wi-Fi connection recorded at 11:20 AM."
              className="w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {error && (
            <div className="rounded-xl bg-rose-500/15 border border-rose-500/30 p-2.5 text-[11px] text-rose-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-white/10 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-xl bg-indigo-600 hover:bg-indigo-500 text-on-accent px-4 py-2 text-xs font-bold transition shadow-lg shadow-indigo-950/40 disabled:opacity-50"
            >
              {loading ? 'Applying...' : '➕ Credit Manual Time'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
