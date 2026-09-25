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
import { OverviewHero, type HeroFilter } from '@/components/OverviewHero';
import { XIcon } from '@/components/icons';
import type { DrawerOpenOptions } from '@/components/EmployeeDetailDrawer';

const LaptopIcon = ({ className = 'h-3 w-3' }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h12a2 2 0 012 2v9H4V6zm-2 12h20" />
  </svg>
);
const CoffeeIcon = ({ className = 'h-3 w-3' }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M17 8h1a4 4 0 010 8h-1M3 8h14v9a4 4 0 01-4 4H7a4 4 0 01-4-4V8zm3-6v2m4-2v2m4-2v2" />
  </svg>
);

const FILTER_LABEL: Record<HeroFilter, string> = {
  ALL: 'Everyone',
  IN_OFFICE: 'In office',
  WORKSTATION: 'Laptops active',
  ON_BREAK: 'On break',
  LATE: 'Late / deficit',
  AWAY: 'Away / out',
};

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
  /** `open` asks the drawer for a tab/date, e.g. the History tab on a past date. */
  onSelectEmployee: (employee: EmployeeDay, open?: DrawerOpenOptions) => void;
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
  const [statusFilter, setStatusFilter] = useState<HeroFilter>('ALL');

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
      {/* 1. OVERVIEW HERO: live presence ring + filterable KPI tiles */}
      <OverviewHero
        summary={summary}
        total={allTodayEmployees.length}
        inOffice={inOfficeCount}
        laptopsActive={workstationActiveCount}
        onBreak={breakCount}
        late={lateCount}
        away={awayCount}
        pendingCorrections={pendingCorrections.length}
        activeFilter={statusFilter}
        onFilter={(f) => {
          setSelectedDate(summary.currentDateKey);
          setStatusFilter(f);
        }}
        onReviewCorrections={() => setShowCorrections((v) => !v)}
        correctionsOpen={showCorrections}
      />

      {/* Collapsible Corrections Panel */}
      {showCorrections && pendingCorrections.length > 0 && (
        <AttendanceCorrectionsPanel
          corrections={corrections}
          onDecide={onDecideCorrection}
          onRefresh={onRefreshCorrections}
        />
      )}

      {/* 3. MASTER WORKFORCE CONTROL BAR */}
      <div className="glass-panel rounded-2xl p-3.5">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
          {/* Left: View Mode Toggle & Search */}
          <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
            {/* View Mode Switcher */}
            <div className="flex items-center rounded-xl border border-white/10 bg-white/5 p-1" role="group" aria-label="View mode">
              <button
                type="button"
                onClick={() => setViewMode('CARDS')}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
                  viewMode === 'CARDS'
                    ? 'bg-accent-gradient text-on-accent shadow-accent'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z" />
                </svg>
                <span>Cards</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('TABLE')}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
                  viewMode === 'TABLE'
                    ? 'bg-accent-gradient text-on-accent shadow-accent'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
                <span>Table</span>
              </button>
            </div>

            {/* Search Input */}
            <div className="relative flex-1 sm:w-64">
              <input
                type="text"
                placeholder="Search name, role, ID, laptop..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search employees"
                className="w-full rounded-xl border border-white/10 bg-white/5 pl-9 pr-8 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-indigo-500/70 focus:outline-none focus:ring-4 focus:ring-indigo-500/15 transition"
              />
              <svg
                className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-500 hover:text-slate-300 cursor-pointer"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Right: Date Selector & CSV Export */}
          <div className="flex flex-wrap items-center gap-2.5 w-full lg:w-auto justify-end">
            {/* Historical Date Picker */}
            <div className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-300">
              <span className="text-slate-500">Date:</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                aria-label="Attendance date"
                className="bg-transparent text-xs text-slate-100 focus:outline-none"
              />
              {selectedDate !== summary.currentDateKey && (
                <button
                  type="button"
                  onClick={() => setSelectedDate(summary.currentDateKey)}
                  className="rounded-md bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-bold text-indigo-300 hover:bg-indigo-500/25 transition cursor-pointer"
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

        {/* Active filter (set from the hero tiles above) */}
        {!isHistorical && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/8 pt-3 text-xs">
            <span className="text-slate-400">
              Showing <strong className="font-mono text-slate-100 tnum">{filteredTodayEmployees.length}</strong> of{' '}
              <span className="font-mono tnum">{allTodayEmployees.length}</span>
              {statusFilter !== 'ALL' && (
                <>
                  {' '}·{' '}
                  <span className="rounded-md bg-indigo-500/15 px-1.5 py-0.5 font-bold text-indigo-300">
                    {FILTER_LABEL[statusFilter]}
                  </span>
                </>
              )}
            </span>
            {statusFilter !== 'ALL' && (
              <button
                type="button"
                onClick={() => setStatusFilter('ALL')}
                className="font-semibold text-slate-400 hover:text-slate-100 transition cursor-pointer"
              >
                Clear filter
              </button>
            )}
          </div>
        )}
      </div>

      {/* 4. WORKFORCE ROSTER CONTENT */}
      {isHistorical ? (
        /* Historical Attendance Ledger */
        <div className="glass-panel rounded-3xl p-6">
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
                <thead className="bg-white/5 text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-white/8">
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
                          } as unknown as EmployeeDay, { tab: 'history', date: selectedDate });
                        }}
                        className="hover:bg-indigo-500/[0.05] transition-colors cursor-pointer group"
                      >
                        <td className="px-4 py-3.5">
                          <span className="font-bold text-white group-hover:text-indigo-300 transition block">
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
                            className="inline-flex items-center gap-1 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-[10px] font-bold text-indigo-300 group-hover:bg-indigo-500/20 transition"
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
            <div className="glass-panel rounded-3xl p-12 text-center text-slate-400">
              <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-slate-400">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </span>
              <p className="font-semibold text-white">No employees match this filter</p>
              <p className="text-xs text-slate-500 mt-1">
                Pick a different tile above, or clear your search.
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
                    className="glass-panel group relative rounded-3xl p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-500/40 cursor-pointer overflow-hidden"
                  >
                    {/* Top Header: Avatar, Name, Status Badge */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-gradient font-extrabold text-sm text-on-accent shadow-accent">
                          {initials}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h4 className="font-bold text-sm text-white tracking-tight truncate group-hover:text-indigo-300 transition">
                              {e.employeeName}
                            </h4>
                            {e.employeeNumber && (
                              <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[9px] font-mono font-semibold text-slate-400 border border-white/10">
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
                            <CoffeeIcon />
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
                      <div className="h-1.5 w-full rounded-full bg-white/8 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent-gradient transition-all duration-500"
                          style={{ width: `${targetPercent}%` }}
                        />
                      </div>
                    </div>

                    {/* Quick Metrics Ribbon (First In, Last Seen, Break) */}
                    <div className="mt-3 grid grid-cols-3 gap-2 rounded-2xl bg-white/5 p-2.5 text-center border border-white/6">
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
                          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-cyan-300 bg-cyan-500/10 px-2 py-0.5 rounded-md border border-cyan-500/20 truncate">
                            <LaptopIcon />
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

                      <span className="shrink-0 text-indigo-400 text-xs font-bold group-hover:translate-x-0.5 transition-transform">
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
        <div className="glass-panel rounded-3xl p-4">
          <div className="overflow-x-auto rounded-xl border border-white/8">
            <table className="w-full min-w-[900px] border-collapse text-left text-xs">
              <thead className="bg-white/5 text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-white/8">
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
                      className="hover:bg-indigo-500/[0.05] transition-colors cursor-pointer group"
                    >
                      {/* Employee Info */}
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="h-7 w-7 rounded-lg bg-accent-gradient flex items-center justify-center font-bold text-[10px] text-on-accent">
                            {e.employeeName.charAt(0)}
                          </div>
                          <div>
                            <span className="font-bold text-white group-hover:text-indigo-300 transition block">
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
                              <CoffeeIcon />
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
                              <LaptopIcon />
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
                          className="inline-flex items-center gap-1 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-[10px] font-bold text-indigo-300 group-hover:bg-indigo-500/20 transition"
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
