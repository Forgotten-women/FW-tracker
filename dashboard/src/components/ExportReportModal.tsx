'use client';

import React, { useState } from 'react';
import { api } from '@/lib/api';
import { DownloadIcon, FileTextIcon, XIcon, CheckCircleIcon, CalendarIcon } from './icons';

interface ExportReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  employees: Array<{ id: string; name: string; role?: string; employeeNumber?: string | null }>;
  defaultEmployeeId?: string;
}

export function ExportReportModal({
  isOpen,
  onClose,
  employees,
  defaultEmployeeId,
}: ExportReportModalProps) {
  const [scope, setScope] = useState<'ALL' | 'SINGLE'>(defaultEmployeeId ? 'SINGLE' : 'ALL');
  const [selectedEmpId, setSelectedEmpId] = useState(defaultEmployeeId || (employees[0]?.id || ''));
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');

  // Date range presets
  const [preset, setPreset] = useState<'THIS_MONTH' | 'LAST_MONTH' | 'LAST_30' | 'CUSTOM'>('THIS_MONTH');

  const getPresetDates = (p: string) => {
    const now = new Date();
    if (p === 'THIS_MONTH') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return {
        from: start.toISOString().slice(0, 10),
        to: end.toISOString().slice(0, 10),
      };
    } else if (p === 'LAST_MONTH') {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return {
        from: start.toISOString().slice(0, 10),
        to: end.toISOString().slice(0, 10),
      };
    } else if (p === 'LAST_30') {
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 30);
      return {
        from: start.toISOString().slice(0, 10),
        to: end.toISOString().slice(0, 10),
      };
    }
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10),
      to: now.toISOString().slice(0, 10),
    };
  };

  const initialDates = getPresetDates('THIS_MONTH');
  const [fromDate, setFromDate] = useState(initialDates.from);
  const [toDate, setToDate] = useState(initialDates.to);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!isOpen) return null;

  const handlePresetChange = (newPreset: 'THIS_MONTH' | 'LAST_MONTH' | 'LAST_30' | 'CUSTOM') => {
    setPreset(newPreset);
    if (newPreset !== 'CUSTOM') {
      const dates = getPresetDates(newPreset);
      setFromDate(dates.from);
      setToDate(dates.to);
    }
  };

  const handleDownload = async () => {
    if (!fromDate || !toDate) {
      setError('Please provide valid start and end dates.');
      return;
    }
    if (fromDate > toDate) {
      setError('From date cannot be after To date.');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const file = await api.downloadReport({
        from: fromDate,
        to: toDate,
        employeeId: scope === 'SINGLE' ? selectedEmpId : undefined,
        format,
      });

      // Trigger browser download
      const url = URL.createObjectURL(file.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setSuccess(true);
      setLoading(false);
      setTimeout(() => {
        onClose();
      }, 1200);
    } catch (err: any) {
      setLoading(false);
      setError(err?.message || 'Failed to generate report.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-lg rounded-2xl border border-indigo-500/30 bg-slate-900/95 p-6 shadow-2xl shadow-indigo-950/50">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
              <DownloadIcon className="h-5 w-5 text-white" />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-white tracking-tight">
                Export Workforce & Attendance Report
              </h3>
              <p className="text-[11px] text-slate-400">
                Generate comprehensive multi-tab Excel (.xlsx) or CSV data sheets
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition cursor-pointer"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 text-xs">
          {/* Scope Selector */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1.5 uppercase tracking-wider">
              Export Scope
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setScope('ALL')}
                className={`py-2 px-3 rounded-xl border text-left transition cursor-pointer flex flex-col justify-between ${
                  scope === 'ALL'
                    ? 'border-indigo-500 bg-indigo-950/40 text-white shadow-md shadow-indigo-950/40'
                    : 'border-white/10 bg-slate-950/60 text-slate-400 hover:text-slate-200 hover:border-white/20'
                }`}
              >
                <div className="flex items-center justify-between w-full mb-1">
                  <span className="font-bold text-xs text-white">All Employees</span>
                  {scope === 'ALL' && <CheckCircleIcon className="h-3.5 w-3.5 text-indigo-400" />}
                </div>
                <span className="text-[10px] text-slate-400">
                  Overall summary + separate tab for each employee
                </span>
              </button>

              <button
                type="button"
                onClick={() => setScope('SINGLE')}
                className={`py-2 px-3 rounded-xl border text-left transition cursor-pointer flex flex-col justify-between ${
                  scope === 'SINGLE'
                    ? 'border-indigo-500 bg-indigo-950/40 text-white shadow-md shadow-indigo-950/40'
                    : 'border-white/10 bg-slate-950/60 text-slate-400 hover:text-slate-200 hover:border-white/20'
                }`}
              >
                <div className="flex items-center justify-between w-full mb-1">
                  <span className="font-bold text-xs text-white">Single Employee</span>
                  {scope === 'SINGLE' && <CheckCircleIcon className="h-3.5 w-3.5 text-indigo-400" />}
                </div>
                <span className="text-[10px] text-slate-400">
                  Individual employment, deficit & timesheet records
                </span>
              </button>
            </div>
          </div>

          {/* Employee dropdown if single */}
          {scope === 'SINGLE' && (
            <div>
              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                SELECT EMPLOYEE
              </label>
              <select
                value={selectedEmpId}
                onChange={(e) => setSelectedEmpId(e.target.value)}
                className="w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
              >
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.employeeNumber ? `[${emp.employeeNumber}] ` : ''}
                    {emp.name} {emp.role ? `(${emp.role})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Date Presets */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
                Date Range
              </label>
              <div className="flex items-center gap-1">
                {(['THIS_MONTH', 'LAST_MONTH', 'LAST_30', 'CUSTOM'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => handlePresetChange(p)}
                    className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition cursor-pointer ${
                      preset === p
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {p === 'THIS_MONTH'
                      ? 'Current Month'
                      : p === 'LAST_MONTH'
                      ? 'Last Month'
                      : p === 'LAST_30'
                      ? 'Past 30d'
                      : 'Custom'}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-slate-400 mb-1">From Date</label>
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => {
                    setFromDate(e.target.value);
                    setPreset('CUSTOM');
                  }}
                  className="w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] text-slate-400 mb-1">To Date</label>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => {
                    setToDate(e.target.value);
                    setPreset('CUSTOM');
                  }}
                  className="w-full rounded-xl border border-white/15 bg-slate-950 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Export Format */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-300 mb-1.5 uppercase tracking-wider">
              Output Format
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setFormat('xlsx')}
                className={`py-2 px-3 rounded-xl border text-left transition cursor-pointer flex items-center gap-2.5 ${
                  format === 'xlsx'
                    ? 'border-emerald-500/80 bg-emerald-950/40 text-white'
                    : 'border-white/10 bg-slate-950/60 text-slate-400 hover:text-slate-200'
                }`}
              >
                <FileTextIcon className="h-4 w-4 text-emerald-400 shrink-0" />
                <div>
                  <div className="font-bold text-xs text-white">Excel Workbook (.xlsx)</div>
                  <div className="text-[10px] text-slate-400">Multi-sheet with KPI cards & styles</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setFormat('csv')}
                className={`py-2 px-3 rounded-xl border text-left transition cursor-pointer flex items-center gap-2.5 ${
                  format === 'csv'
                    ? 'border-indigo-500 bg-indigo-950/40 text-white'
                    : 'border-white/10 bg-slate-950/60 text-slate-400 hover:text-slate-200'
                }`}
              >
                <FileTextIcon className="h-4 w-4 text-indigo-400 shrink-0" />
                <div>
                  <div className="font-bold text-xs text-white">CSV Spreadsheet (.csv)</div>
                  <div className="text-[10px] text-slate-400">Standard comma-separated table</div>
                </div>
              </button>
            </div>
          </div>

          {/* Privacy & Compliance Notice */}
          <div className="rounded-xl bg-slate-950/80 border border-white/5 p-3 text-[11px] text-slate-400 space-y-1">
            <div className="flex items-center gap-1.5 text-slate-300 font-semibold">
              <span>🔒 Employment Records Policy</span>
            </div>
            <p className="text-[10px] text-slate-400 leading-relaxed">
              Personal credentials, CNIC, and personal bank accounts are omitted. Export covers daily check-ins/outs, breaks, shift status, daily deficits, approved period credits, leave records, and total net shortfall / surplus.
            </p>
          </div>

          {error && (
            <div className="rounded-xl bg-rose-500/15 border border-rose-500/30 p-2.5 text-[11px] text-rose-300">
              {error}
            </div>
          )}

          {success && (
            <div className="rounded-xl bg-emerald-500/15 border border-emerald-500/30 p-2.5 text-[11px] text-emerald-300 flex items-center gap-2">
              <CheckCircleIcon className="h-4 w-4 text-emerald-400 shrink-0" />
              <span>Report downloaded successfully!</span>
            </div>
          )}

          {/* Footer actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-white/10">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-white/10 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={loading}
              className="rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-bold px-5 py-2 text-xs transition shadow-lg shadow-indigo-950/50 disabled:opacity-50 flex items-center gap-2 cursor-pointer"
            >
              {loading ? (
                <>
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span>Generating {format.toUpperCase()}...</span>
                </>
              ) : (
                <>
                  <DownloadIcon className="h-4 w-4" />
                  <span>Download Report</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
