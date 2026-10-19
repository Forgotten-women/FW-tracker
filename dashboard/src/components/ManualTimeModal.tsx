'use client';

import React, { useState } from 'react';
import { api } from '@/lib/api';
import { CoffeeIcon, PlusIcon, TimerIcon, XIcon } from './icons';

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
  const [mode, setMode] = useState<'TIME' | 'BREAK'>('TIME');
  const [employeeId, setEmployeeId] = useState(defaultEmployeeId || (employees[0]?.id || ''));
  const [dateKey, setDateKey] = useState(defaultDate);
  const [minutes, setMinutes] = useState('15');
  const [breakMinutes, setBreakMinutes] = useState('30');
  const [useBreakWindow, setUseBreakWindow] = useState(false);
  const [breakStartTime, setBreakStartTime] = useState('13:00');
  const [breakEndTime, setBreakEndTime] = useState('13:30');
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

    if (!reason.trim()) {
      setError('An explanation / reason is required.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (mode === 'TIME') {
        const numMins = parseInt(minutes, 10);
        if (isNaN(numMins) || numMins === 0) {
          setError('Minutes must be a non-zero number.');
          setLoading(false);
          return;
        }
        await api.addManualAttendanceTime(empTarget, numMins, reason.trim(), dateKey);
      } else {
        if (useBreakWindow) {
          if (!breakStartTime || !breakEndTime) {
            setError('Please provide both break start and end times.');
            setLoading(false);
            return;
          }
          await api.addManualBreak({
            employeeId: empTarget,
            dateKey,
            startTime: breakStartTime,
            endTime: breakEndTime,
            reason: reason.trim(),
          });
        } else {
          const numBreakMins = parseInt(breakMinutes, 10);
          if (isNaN(numBreakMins) || numBreakMins <= 0) {
            setError('Break duration must be a positive number of minutes.');
            setLoading(false);
            return;
          }
          await api.addManualBreak({
            employeeId: empTarget,
            dateKey,
            breakMinutes: numBreakMins,
            reason: reason.trim(),
          });
        }
      }

      setLoading(false);
      onClose();
      if (onSuccess) onSuccess();
    } catch (err: any) {
      setLoading(false);
      setError(err?.message || 'Failed to apply manual entry.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md rounded-2xl border border-indigo-500/30 bg-slate-900/95 p-6 shadow-2xl shadow-indigo-950/50">
        <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-3">
          <div className="flex items-center gap-2">
            {mode === 'TIME' ? (
              <TimerIcon className="h-5 w-5 text-indigo-400 shrink-0" />
            ) : (
              <CoffeeIcon className="h-5 w-5 text-amber-400 shrink-0" />
            )}
            <div>
              <h3 className="text-sm font-extrabold text-white">
                {mode === 'TIME' ? 'HR Manual Time Adjustment' : 'HR Manual Break Entry'}
              </h3>
              <p className="text-[11px] text-slate-400">
                {mode === 'TIME'
                  ? 'Directly credit or adjust worked minutes for an employee'
                  : 'Manually record an authorized employee break for today or past days'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Tab Switcher: Worked Time vs Manual Break */}
        <div className="flex gap-2 p-1 bg-slate-950/90 rounded-xl border border-white/10 mb-4 text-xs font-bold">
          <button
            type="button"
            onClick={() => {
              setMode('TIME');
              setError(null);
            }}
            className={`flex-1 py-1.5 px-3 rounded-lg flex items-center justify-center gap-1.5 transition cursor-pointer ${
              mode === 'TIME'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950/40'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <TimerIcon className="h-3.5 w-3.5" />
            <span>Time Adjustment</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('BREAK');
              setError(null);
            }}
            className={`flex-1 py-1.5 px-3 rounded-lg flex items-center justify-center gap-1.5 transition cursor-pointer ${
              mode === 'BREAK'
                ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <CoffeeIcon className="h-3.5 w-3.5" />
            <span>Manual Break</span>
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

          {mode === 'TIME' ? (
            /* Mode TIME: Minutes to Add/Deduct */
            <div>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                MINUTES TO ADD (e.g. 15 for +15 mins, -15 for deduction)
              </label>
              <input
                type="number"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                placeholder="e.g. 15"
                className="w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-2 text-xs font-mono font-bold text-emerald-400 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          ) : (
            /* Mode BREAK: Manual Break Entry */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="block text-[11px] font-semibold text-slate-300">
                  BREAK DURATION SPECIFICATION
                </label>
                <button
                  type="button"
                  onClick={() => setUseBreakWindow(!useBreakWindow)}
                  className="text-[10px] text-amber-400 hover:underline cursor-pointer"
                >
                  {useBreakWindow ? 'Switch to duration in minutes' : 'Specify exact start & end times'}
                </button>
              </div>

              {!useBreakWindow ? (
                <div>
                  <input
                    type="number"
                    min="1"
                    max="240"
                    value={breakMinutes}
                    onChange={(e) => setBreakMinutes(e.target.value)}
                    placeholder="e.g. 30"
                    className="w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-2 text-xs font-mono font-bold text-amber-300 focus:border-amber-500 focus:outline-none"
                  />
                  <p className="text-[10px] text-slate-400 mt-1">
                    Duration in minutes (e.g. 15, 30, 45, 60). Excess break past allowance will be deducted.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Start Time</label>
                    <input
                      type="time"
                      value={breakStartTime}
                      onChange={(e) => setBreakStartTime(e.target.value)}
                      className="w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-1.5 text-xs font-mono font-bold text-white focus:border-amber-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">End Time</label>
                    <input
                      type="time"
                      value={breakEndTime}
                      onChange={(e) => setBreakEndTime(e.target.value)}
                      className="w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-1.5 text-xs font-mono font-bold text-white focus:border-amber-500 focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Reason */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
              EXPLANATION / REASON (Visible to Employee & Audits)
            </label>
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                mode === 'TIME'
                  ? 'e.g. Employee arrived at 11:09 AM; Wi-Fi connection recorded at 11:20 AM.'
                  : 'e.g. Authorized medical/lunch break or personal errand approved by manager.'
              }
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
              className={`rounded-xl px-4 py-2 text-xs font-bold transition shadow-lg disabled:opacity-50 flex items-center gap-1.5 ${
                mode === 'TIME'
                  ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-950/40'
                  : 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-amber-950/40'
              }`}
            >
              {loading ? (
                'Applying...'
              ) : mode === 'TIME' ? (
                <>
                  <PlusIcon className="h-3.5 w-3.5" /> Credit Manual Time
                </>
              ) : (
                <>
                  <CoffeeIcon className="h-3.5 w-3.5" /> Record Break Entry
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
