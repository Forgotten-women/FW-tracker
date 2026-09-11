'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type {
  AdminEmployee,
  AppUsageItem,
  AttendanceCorrection,
  DashboardSummary,
  EmployeeDay,
  PresenceStatus,
  WorkstationItem,
} from '@/lib/types';
import { Badge, Button, Empty, STATUS_META } from '@/components/primitives';
import { AttendanceCorrectionsPanel } from '@/components/panels';

interface UnifiedWorkforcePanelProps {
  summary: DashboardSummary;
  employees: AdminEmployee[];
  corrections: AttendanceCorrection[];
  onDecideCorrection: (
    id: string,
    decision: 'APPROVED' | 'REJECTED' | 'AMENDED',
    notes: string,
    adjustmentMinutes?: number,
  ) => Promise<void>;
  onRefreshCorrections: () => Promise<void>;
  onExportCsv: (from: string, to: string) => Promise<void>;
  onSelectEmployee: (employee: EmployeeDay) => void;
}

export function UnifiedWorkforcePanel({
  summary,
  employees,
  corrections,
  onDecideCorrection,
  onRefreshCorrections,
  onExportCsv,
  onSelectEmployee,
}: UnifiedWorkforcePanelProps) {
  const [viewMode, setViewMode] = useState<'CARDS' | 'TABLE'>('CARDS');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'ALL' | 'IN_OFFICE' | 'WORKSTATION' | 'ON_BREAK' | 'LATE' | 'AWAY'
  >('ALL');

  // Workstation and app telemetry cache
  const [workstations, setWorkstations] = useState<WorkstationItem[]>([]);
  const [appUsage, setAppUsage] = useState<AppUsageItem[]>([]);

  // Historical date selector state
  const [selectedDate, setSelectedDate] = useState<string>(summary.currentDateKey);
  const [historyRows, setHistoryRows] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Collapsible corrections drawer
  const [showCorrections, setShowCorrections] = useState(false);
  const pendingCorrections = useMemo(
    () => corrections.filter((c) => c.status === 'PENDING'),
    [corrections],
  );

  // Load workstation and app telemetry on mount
  useEffect(() => {
    let isMounted = true;
    const loadTelemetry = async () => {
      try {
        const [wsRes, appRes] = await Promise.all([
          api.fetchWorkstations().catch(() => null),
          api.fetchAppUsage().catch(() => null),
        ]);
        if (isMounted) {
          if (wsRes?.workstations) setWorkstations(wsRes.workstations);
          if (appRes?.appUsage) setAppUsage(appRes.appUsage);
        }
      } catch (_) {}
    };
    loadTelemetry();
    return () => {
      isMounted = false;
    };
  }, [summary.currentDateKey]);

  // Load historical data when selectedDate changes
  useEffect(() => {
    if (selectedDate === summary.currentDateKey) {
      setHistoryRows([]);
      return;
    }
    let isMounted = true;
    setLoadingHistory(true);
    api
      .history(selectedDate, selectedDate)
      .then((res) => {
        if (isMounted) {
          setHistoryRows(res.days || []);
        }
      })
      .catch(() => {
        if (isMounted) setHistoryRows([]);
      })
      .finally(() => {
        if (isMounted) setLoadingHistory(false);
      });
    return () => {
      isMounted = false;
    };
  }, [selectedDate, summary.currentDateKey]);

  // Base list of today's employees
  const allTodayEmployees = useMemo(() => {
    return [
      ...summary.inOffice,
      ...summary.grace,
      ...summary.away,
      ...summary.notArrived,
    ];
  }, [summary]);

  // Workstation mapping
  const workstationMap = useMemo(() => {
    const map = new Map<string, WorkstationItem>();
    for (const ws of workstations) {
      if (ws.employeeId) map.set(ws.employeeId, ws);
    }
    return map;
  }, [workstations]);

  // Top app mapping
  const topAppMap = useMemo(() => {
    const map = new Map<string, AppUsageItem>();
    for (const app of appUsage) {
      if (app.employeeId) {
        const existing = map.get(app.employeeId);
        if (!existing || app.activeSeconds > existing.activeSeconds) {
          map.set(app.employeeId, app);
        }
      }
    }
    return map;
  }, [appUsage]);

  // KPI counters
  const inOfficeCount = summary.inOffice.length;
  const workstationActiveCount = workstations.filter((w) => w.status === 'ACTIVE').length;
  const breakCount = allTodayEmployees.filter((e) => e.onBreak).length;
  const lateCount = allTodayEmployees.filter(
    (e) => (e.lateMinutes ?? 0) > 0 || e.isLate,
  ).length;
  const awayCount = allTodayEmployees.filter(
    (e) =>
      e.status === 'AWAY' ||
      e.status === 'GRACE_PERIOD' ||
      e.status === 'NOT_CHECKED_IN',
  ).length;

  // Filtered employees for today
  const filteredTodayEmployees = useMemo(() => {
    return allTodayEmployees.filter((e) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const ws = workstationMap.get(e.employeeId);
        const topApp = topAppMap.get(e.employeeId);
        const match =
          e.employeeName.toLowerCase().includes(q) ||
          e.role.toLowerCase().includes(q) ||
          (e.employeeNumber && e.employeeNumber.toLowerCase().includes(q)) ||
          (ws && ws.model?.toLowerCase().includes(q)) ||
          (topApp && topApp.appName.toLowerCase().includes(q));
        if (!match) return false;
      }

      if (statusFilter === 'IN_OFFICE') return e.status === 'IN_OFFICE';
      if (statusFilter === 'WORKSTATION') {
        const ws = workstationMap.get(e.employeeId);
        return ws && ws.status === 'ACTIVE';
      }
      if (statusFilter === 'ON_BREAK') return e.onBreak;
      if (statusFilter === 'LATE') return (e.lateMinutes ?? 0) > 0 || e.isLate;
      if (statusFilter === 'AWAY') {
        return (
          e.status === 'AWAY' ||
          e.status === 'GRACE_PERIOD' ||
          e.status === 'NOT_CHECKED_IN'
        );
      }
      return true;
    });
  }, [allTodayEmployees, searchQuery, statusFilter, workstationMap, topAppMap]);

  // Filtered historical rows
  const filteredHistoryRows = useMemo(() => {
    if (!historyRows.length) return [];
    return historyRows.filter((h) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          h.employeeName.toLowerCase().includes(q) ||
          h.role.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [historyRows, searchQuery]);

  const isHistorical = selectedDate !== summary.currentDateKey;

  return (
    <div className="flex flex-col gap-6">
      {/* 1. EXECUTIVE KPI SUMMARY STRIP */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {/* Total Workforce */}
        <div className="rounded-2xl border border-white/8 bg-slate-900/60 p-4 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">Total Enrolled</span>
            <span className="text-base">👥</span>
          </div>
          <div className="mt-2 text-2xl font-black tracking-tight text-white">
            {allTodayEmployees.length}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">Team members</div>
        </div>

        {/* In Office */}
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-950/20 p-4 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-emerald-300">In Office</span>
            <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse shadow-sm shadow-emerald-400" />
          </div>
          <div className="mt-2 text-2xl font-black tracking-tight text-emerald-400">
            {inOfficeCount}
          </div>
          <div className="mt-1 text-[11px] text-emerald-300/80">Presence verified</div>
        </div>

        {/* Active Workstations */}
        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-950/20 p-4 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-cyan-300">Laptops Active</span>
            <span className="text-base">💻</span>
          </div>
          <div className="mt-2 text-2xl font-black tracking-tight text-cyan-400">
            {workstationActiveCount}
          </div>
          <div className="mt-1 text-[11px] text-cyan-300/80">Typing / Working</div>
        </div>

        {/* On Break */}
        <div className="rounded-2xl border border-amber-500/20 bg-amber-950/20 p-4 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-amber-300">On Break</span>
            <span className="text-base">☕</span>
          </div>
          <div className="mt-2 text-2xl font-black tracking-tight text-amber-400">
            {breakCount}
          </div>
          <div className="mt-1 text-[11px] text-amber-300/80">Authorised pause</div>
        </div>

        {/* Late Arrival / Deficit */}
        <div className="rounded-2xl border border-rose-500/20 bg-rose-950/20 p-4 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-rose-300">Late / Deficit</span>
            <span className="text-base">⚠️</span>
          </div>
          <div className="mt-2 text-2xl font-black tracking-tight text-rose-400">
            {lateCount}
          </div>
          <div className="mt-1 text-[11px] text-rose-300/80">Policy flagged</div>
        </div>

        {/* Away / Offline */}
        <div className="rounded-2xl border border-slate-700/40 bg-slate-900/40 p-4 shadow-xl backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">Away / Out</span>
            <span className="text-base">🌐</span>
          </div>
          <div className="mt-2 text-2xl font-black tracking-tight text-slate-300">
            {awayCount}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">Not in office</div>
        </div>
      </div>

      {/* 2. PENDING CORRECTIONS ALERT BANNER */}
      {pendingCorrections.length > 0 && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 shadow-xl">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/20 text-lg text-amber-300">
              ⚠️
            </div>
            <div>
              <div className="text-sm font-bold text-amber-200">
                {pendingCorrections.length} Attendance Correction Request{pendingCorrections.length > 1 ? 's' : ''} Awaiting Review
              </div>
              <p className="text-xs text-amber-300/80">
                Staff have submitted manual time adjustments or forgotten punch amendments.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowCorrections(!showCorrections)}
            className="rounded-xl border border-amber-500/40 bg-amber-500/20 px-3.5 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/30 transition cursor-pointer"
          >
            {showCorrections ? 'Hide Correction Requests' : 'Review & Decide'}
          </button>
        </div>
      )}

      {/* Collapsible Corrections Panel */}
      {showCorrections && pendingCorrections.length > 0 && (
        <AttendanceCorrectionsPanel
          corrections={corrections}
          onDecide={onDecideCorrection}
          onRefresh={onRefreshCorrections}
        />
      )}

      {/* 3. MASTER WORKFORCE CONTROL BAR */}
      <div className="rounded-2xl border border-white/8 bg-slate-900/80 p-4 shadow-xl backdrop-blur-xl">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
          {/* Left: View Mode Toggle & Search */}
          <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
            {/* View Mode Switcher */}
            <div className="flex items-center rounded-xl border border-white/10 bg-slate-950/80 p-1 shadow-inner">
              <button
                type="button"
                onClick={() => setViewMode('CARDS')}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
                  viewMode === 'CARDS'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>🗂️</span>
                <span>Cards View</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('TABLE')}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
                  viewMode === 'TABLE'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>📋</span>
                <span>Table Ledger</span>
              </button>
            </div>

            {/* Search Input */}
            <div className="relative flex-1 sm:w-64">
              <input
                type="text"
                placeholder="Search name, role, ID, laptop..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-slate-950/80 pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none transition shadow-inner"
              />
              <svg
                className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-2 text-xs text-slate-500 hover:text-slate-300 cursor-pointer"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Right: Date Selector & CSV Export */}
          <div className="flex flex-wrap items-center gap-2.5 w-full lg:w-auto justify-end">
            {/* Historical Date Picker */}
            <div className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-slate-950/80 px-2.5 py-1 text-xs text-slate-300">
              <span className="text-slate-500">Date:</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-transparent text-xs text-slate-200 focus:outline-none"
              />
              {selectedDate !== summary.currentDateKey && (
                <button
                  type="button"
                  onClick={() => setSelectedDate(summary.currentDateKey)}
                  className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] font-bold text-cyan-300 hover:bg-cyan-500/30 transition cursor-pointer"
                  title="Reset to today"
                >
                  Today
                </button>
              )}
            </div>

            {/* CSV Export Button */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onExportCsv(selectedDate, selectedDate)}
              icon={
                <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              }
            >
              Export Day CSV
            </Button>
          </div>
        </div>

        {/* Status Filter Chips (For Today's view) */}
        {!isHistorical && (
          <div className="mt-3.5 flex flex-wrap items-center gap-1.5 border-t border-white/8 pt-3">
            <button
              type="button"
              onClick={() => setStatusFilter('ALL')}
              className={`rounded-lg px-3 py-1 text-xs font-semibold transition cursor-pointer ${
                statusFilter === 'ALL'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20'
                  : 'bg-slate-950/60 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              All ({allTodayEmployees.length})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('IN_OFFICE')}
              className={`rounded-lg px-3 py-1 text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
                statusFilter === 'IN_OFFICE'
                  ? 'bg-emerald-600 text-white shadow-md shadow-emerald-500/20'
                  : 'bg-slate-950/60 text-emerald-400 hover:bg-slate-800'
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              In Office ({inOfficeCount})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('WORKSTATION')}
              className={`rounded-lg px-3 py-1 text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
                statusFilter === 'WORKSTATION'
                  ? 'bg-cyan-600 text-white shadow-md shadow-cyan-500/20'
                  : 'bg-slate-950/60 text-cyan-400 hover:bg-slate-800'
              }`}
            >
              <span>💻</span>
              Workstation Active ({workstationActiveCount})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('ON_BREAK')}
              className={`rounded-lg px-3 py-1 text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
                statusFilter === 'ON_BREAK'
                  ? 'bg-amber-600 text-white shadow-md shadow-amber-500/20'
                  : 'bg-slate-950/60 text-amber-400 hover:bg-slate-800'
              }`}
            >
              <span>☕</span>
              On Break ({breakCount})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('LATE')}
              className={`rounded-lg px-3 py-1 text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
                statusFilter === 'LATE'
                  ? 'bg-rose-600 text-white shadow-md shadow-rose-500/20'
                  : 'bg-slate-950/60 text-rose-400 hover:bg-slate-800'
              }`}
            >
              <span>⚠️</span>
              Late Arrival ({lateCount})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('AWAY')}
              className={`rounded-lg px-3 py-1 text-xs font-semibold transition cursor-pointer ${
                statusFilter === 'AWAY'
                  ? 'bg-slate-700 text-white shadow-md'
                  : 'bg-slate-950/60 text-slate-400 hover:bg-slate-800'
              }`}
            >
              Away / Out ({awayCount})
            </button>
          </div>
        )}
      </div>

      {/* 4. WORKFORCE ROSTER CONTENT */}
      {isHistorical ? (
        /* Historical Attendance Ledger */
        <div className="rounded-2xl border border-white/8 bg-slate-900/60 p-6 shadow-xl backdrop-blur-xl">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-base font-bold text-white">
              Historical Attendance Ledger for {selectedDate}
            </h3>
            <span className="text-xs text-slate-400">
              {filteredHistoryRows.length} records found
            </span>
          </div>

          {loadingHistory ? (
            <div className="flex h-48 items-center justify-center gap-3 text-sm text-slate-400">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
              <span>Loading historical timesheets…</span>
            </div>
          ) : filteredHistoryRows.length === 0 ? (
            <Empty
              title={`No records for ${selectedDate}`}
              description="There were no working sessions recorded on this date."
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-white/8">
              <table className="w-full min-w-[760px] border-collapse text-left text-xs">
                <thead className="bg-slate-950 text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-white/8">
                  <tr>
                    <th className="px-4 py-3.5">Employee</th>
                    <th className="px-3 py-3.5">First In</th>
                    <th className="px-3 py-3.5">Last Seen</th>
                    <th className="px-3 py-3.5">Worked (Target 7h 30m)</th>
                    <th className="px-3 py-3.5">Break Taken</th>
                    <th className="px-3 py-3.5">Deficit</th>
                    <th className="px-3 py-3.5 text-center">Status</th>
                    <th className="px-4 py-3.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/6">
                  {filteredHistoryRows.map((h) => {
                    const meta =
                      STATUS_META[h.status as PresenceStatus] ??
                      STATUS_META.NOT_CHECKED_IN;
                    return (
                      <tr
                        key={h.employeeId}
                        onClick={() => {
                          onSelectEmployee({
                            employeeId: h.employeeId,
                            employeeName: h.employeeName,
                            role: h.role,
                            status: h.status,
                            firstCheckIn: h.firstCheckIn,
                            lastActiveTime: h.lastActive,
                            sessions: h.sessions || [],
                            totalMinutes: h.totalMinutes || 0,
                            breakMinutes: h.breakMinutes || 0,
                            timeWorkedFormatted: h.timeWorked || '0h 00m',
                            dailyDeficitMinutes: h.dailyDeficitMinutes || 0,
                            onBreak: false,
                          } as unknown as EmployeeDay);
                        }}
                        className="hover:bg-cyan-500/[0.04] transition-colors cursor-pointer group"
                      >
                        <td className="px-4 py-3.5">
                          <span className="font-bold text-white group-hover:text-cyan-300 transition block">
                            {h.employeeName}
                          </span>
                          <span className="text-[11px] text-slate-400">{h.role}</span>
                        </td>
                        <td className="px-3 py-3.5 font-mono text-slate-300">{h.firstCheckIn}</td>
                        <td className="px-3 py-3.5 font-mono text-slate-300">{h.lastActive}</td>
                        <td className="px-3 py-3.5 font-mono font-bold text-emerald-400">
                          {h.timeWorked || '0h 00m'}
                        </td>
                        <td className="px-3 py-3.5 text-slate-300">{h.breakMinutes || 0}m</td>
                        <td className="px-3 py-3.5 font-mono text-rose-400 font-bold">
                          {h.dailyDeficitMinutes > 0 ? `-${h.dailyDeficitMinutes}m` : '0m'}
                        </td>
                        <td className="px-3 py-3.5 text-center">
                          <Badge tone={meta.tone} dot size="sm">
                            {meta.label}
                          </Badge>
                        </td>
                        <td className="px-4 py-3.5 text-right">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[10px] font-bold text-cyan-300 group-hover:bg-cyan-500/20 transition"
                          >
                            <span>Details</span>
                            <span>→</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : viewMode === 'CARDS' ? (
        /* CARDS VIEW (Clean, informative, modern cards) */
        <div>
          {filteredTodayEmployees.length === 0 ? (
            <div className="rounded-2xl border border-white/8 bg-slate-900/60 p-12 text-center text-slate-400">
              <span className="text-3xl block mb-2">🔍</span>
              <p className="font-semibold text-white">No employees match this filter</p>
              <p className="text-xs text-slate-500 mt-1">
                Try selecting a different status chip or clearing your search.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {filteredTodayEmployees.map((e) => {
                const meta = STATUS_META[e.status] ?? STATUS_META.NOT_CHECKED_IN;
                const ws = workstationMap.get(e.employeeId);
                const topApp = topAppMap.get(e.employeeId);
                const isLate = (e.lateMinutes ?? 0) > 0 || e.isLate;

                // Shift target calculations
                const workedMinutes = e.totalMinutes || 0;
                const targetPercent = Math.min(100, Math.round((workedMinutes / 450) * 100)); // 450m = 7h 30m

                const initials = e.employeeName
                  .split(' ')
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join('')
                  .toUpperCase();

                return (
                  <div
                    key={e.employeeId}
                    onClick={() => onSelectEmployee(e)}
                    className="group relative rounded-2xl border border-white/8 bg-slate-900/70 p-5 shadow-xl transition-all duration-200 hover:-translate-y-0.5 hover:border-cyan-500/40 hover:bg-slate-900/90 hover:shadow-cyan-500/10 cursor-pointer overflow-hidden"
                  >
                    {/* Top Header: Avatar, Name, Status Badge */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600/30 to-cyan-500/30 border border-white/10 font-bold text-sm text-cyan-300 shadow-inner group-hover:border-cyan-400/50 transition">
                          {initials}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h4 className="font-bold text-sm text-white tracking-tight truncate group-hover:text-cyan-300 transition">
                              {e.employeeName}
                            </h4>
                            {e.employeeNumber && (
                              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] font-mono font-semibold text-slate-400 border border-slate-700">
                                {e.employeeNumber}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-400 truncate mt-0.5">
                            {e.role}
                          </div>
                        </div>
                      </div>

                      {/* Status Badges */}
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        {e.onBreak ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[10px] font-bold text-amber-300 shadow-sm animate-pulse">
                            <span>☕</span>
                            <span>On Break</span>
                          </span>
                        ) : (
                          <Badge tone={meta.tone} dot size="sm">
                            {meta.label}
                          </Badge>
                        )}
                        {isLate && (
                          <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30">
                            +{e.lateMinutes ?? 0}m late
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Shift Progress Bar (Target: 7h 30m) */}
                    <div className="mt-4 pt-3 border-t border-white/6">
                      <div className="flex items-center justify-between text-[11px] mb-1.5">
                        <span className="text-slate-400 font-medium">Worked Today:</span>
                        <div className="flex items-center gap-1.5 font-mono">
                          <span className="font-bold text-emerald-400">
                            {e.timeWorkedFormatted}
                          </span>
                          <span className="text-slate-500 text-[10px]">/ 7h 30m</span>
                        </div>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-950 overflow-hidden border border-white/5">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-teal-500 to-cyan-400 transition-all duration-500"
                          style={{ width: `${targetPercent}%` }}
                        />
                      </div>
                    </div>

                    {/* Quick Metrics Ribbon (First In, Last Seen, Break) */}
                    <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-slate-950/60 p-2.5 text-center border border-white/4">
                      <div>
                        <div className="text-[9px] uppercase font-bold text-slate-500">First In</div>
                        <div className="font-mono text-xs font-semibold text-slate-200 mt-0.5">
                          {e.firstCheckIn || '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase font-bold text-slate-500">Last Seen</div>
                        <div className="font-mono text-xs font-semibold text-slate-200 mt-0.5">
                          {e.lastActiveTime || '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase font-bold text-slate-500">Break</div>
                        <div className="font-mono text-xs font-semibold text-amber-400 mt-0.5">
                          {e.breakMinutes ?? 0}m
                        </div>
                      </div>
                    </div>

                    {/* Workstation & App Telemetry Pill (Consolidated from Screenshot 3) */}
                    <div className="mt-3 flex items-center justify-between pt-2 border-t border-white/6 text-[11px]">
                      <div className="flex items-center gap-2 truncate">
                        {ws ? (
                          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-cyan-300 bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20 truncate">
                            <span>💻</span>
                            <span>{ws.model || 'Laptop'}</span>
                            <span className="text-cyan-400/60 capitalize">({ws.status.toLowerCase()})</span>
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-500">No workstation connected</span>
                        )}
                        {topApp && (
                          <span className="hidden sm:inline-block font-mono text-[10px] text-slate-400 truncate">
                            App: <strong className="text-slate-300">{topApp.appName}</strong>
                          </span>
                        )}
                      </div>

                      <span className="shrink-0 text-cyan-400 text-xs font-bold group-hover:translate-x-0.5 transition-transform">
                        Details →
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* TABLE LEDGER VIEW (Consolidated from Screenshot 2 & 3) */
        <div className="rounded-2xl border border-white/8 bg-slate-900/60 p-4 shadow-xl backdrop-blur-xl">
          <div className="overflow-x-auto rounded-xl border border-white/8">
            <table className="w-full min-w-[900px] border-collapse text-left text-xs">
              <thead className="bg-slate-950 text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-white/8">
                <tr>
                  <th className="px-4 py-3.5">Employee</th>
                  <th className="px-3 py-3.5">Live Status</th>
                  <th className="px-3 py-3.5">First In</th>
                  <th className="px-3 py-3.5">Last Seen</th>
                  <th className="px-3 py-3.5">Worked (Target 7h 30m)</th>
                  <th className="px-3 py-3.5">Break / Deficit</th>
                  <th className="px-3 py-3.5">Workstation & App</th>
                  <th className="px-4 py-3.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/6">
                {filteredTodayEmployees.map((e) => {
                  const meta = STATUS_META[e.status] ?? STATUS_META.NOT_CHECKED_IN;
                  const ws = workstationMap.get(e.employeeId);
                  const topApp = topAppMap.get(e.employeeId);
                  const isLate = (e.lateMinutes ?? 0) > 0 || e.isLate;

                  return (
                    <tr
                      key={e.employeeId}
                      onClick={() => onSelectEmployee(e)}
                      className="hover:bg-cyan-500/[0.04] transition-colors cursor-pointer group"
                    >
                      {/* Employee Info */}
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="h-7 w-7 rounded-lg bg-indigo-500/20 border border-white/10 flex items-center justify-center font-bold text-[10px] text-cyan-300">
                            {e.employeeName.charAt(0)}
                          </div>
                          <div>
                            <span className="font-bold text-white group-hover:text-cyan-300 transition block">
                              {e.employeeName}
                            </span>
                            <span className="text-[11px] text-slate-400">{e.role}</span>
                          </div>
                        </div>
                      </td>

                      {/* Status */}
                      <td className="px-3 py-3.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {e.onBreak ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[10px] font-bold text-amber-300 animate-pulse">
                              <span>☕</span>
                              <span>On Break</span>
                            </span>
                          ) : (
                            <Badge tone={meta.tone} dot size="sm">
                              {meta.label}
                            </Badge>
                          )}
                          {isLate && (
                            <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30">
                              LATE
                            </span>
                          )}
                        </div>
                      </td>

                      {/* First In */}
                      <td className="px-3 py-3.5 font-mono text-slate-300">{e.firstCheckIn || '—'}</td>

                      {/* Last Seen */}
                      <td className="px-3 py-3.5 font-mono text-slate-300">{e.lastActiveTime || '—'}</td>

                      {/* Worked Hours */}
                      <td className="px-3 py-3.5">
                        <div className="font-mono font-bold text-emerald-400">
                          {e.timeWorkedFormatted}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          of 7h 30m target
                        </div>
                      </td>

                      {/* Break / Deficit */}
                      <td className="px-3 py-3.5">
                        <div className="text-slate-300">
                          Break: <strong className="text-amber-400 font-mono">{e.breakMinutes ?? 0}m</strong>
                        </div>
                        {(e.dailyDeficitMinutes ?? 0) > 0 ? (
                          <div className="text-[10px] text-rose-400 font-mono font-semibold">
                            Deficit: -{e.dailyDeficitMinutes}m
                          </div>
                        ) : (
                          <div className="text-[10px] text-slate-500 font-mono">No deficit</div>
                        )}
                      </td>

                      {/* Workstation & App */}
                      <td className="px-3 py-3.5">
                        {ws ? (
                          <div>
                            <div className="font-mono text-[11px] text-cyan-300 font-semibold flex items-center gap-1">
                              <span>💻</span>
                              <span>{ws.model || 'Laptop'}</span>
                              <span className="text-slate-400 text-[10px] font-normal">({ws.platform})</span>
                            </div>
                            {topApp && (
                              <div className="text-[10px] text-slate-400 truncate max-w-[160px] mt-0.5">
                                Top: <span className="text-slate-200">{topApp.appName}</span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-500">Mobile app only</span>
                        )}
                      </td>

                      {/* Action */}
                      <td className="px-4 py-3.5 text-right">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[10px] font-bold text-cyan-300 group-hover:bg-cyan-500/20 group-hover:border-cyan-400 transition"
                        >
                          <span>Profile</span>
                          <span>→</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
