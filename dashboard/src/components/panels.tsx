'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type {
  AdminEmployee,
  AttendanceCorrection,
  DashboardSummary,
  EmployeeDay,
  Movement,
  PresenceStatus,
} from '@/lib/types';
import { Badge, Button, Empty, Input, Panel, STATUS_META } from './primitives';
import { SetSalaryModal } from './PayrollPanel';

// --- header ----------------------------------------------------------------

export function Header({
  summary,
  connection,
  onLock,
  unreadNotificationsCount = 0,
  onOpenNotifications,
}: {
  summary: DashboardSummary | null;
  connection: string;
  onLock: () => void;
  unreadNotificationsCount?: number;
  onOpenNotifications?: () => void;
}) {
  const [clock, setClock] = useState('');
  const [date, setDate] = useState('');
  const tz = summary?.timezone ?? 'UTC';

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      try {
        setClock(
          new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
          }).format(now),
        );
        setDate(
          new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          }).format(now),
        );
      } catch {
        // Fallback
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [tz]);

  return (
    <header className="sticky top-0 z-40 border-b border-white/8 bg-slate-950/80 px-6 py-3.5 backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Brand & Location */}
        <div className="flex items-center gap-3.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-lg shadow-indigo-500/25 border border-indigo-400/30">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
              />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-extrabold tracking-tight text-white">
                {summary?.officeConfig.officeName ?? 'Office Tracker'}
              </h1>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400 border border-emerald-500/20">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Live Engine
              </span>
            </div>
            <p className="text-xs text-slate-400">
              {summary
                ? `${summary.officeConfig.networks.join(' · ')} — ${summary.officeConfig.gracePeriod} grace window`
                : 'Connecting to office presence engine…'}
            </p>
          </div>
        </div>

        {/* Global Stats Clock & Actions */}
        <div className="flex items-center gap-3.5">
          {/* Time & Timezone Pill */}
          <div className="hidden sm:flex items-center gap-2.5 rounded-xl border border-white/8 bg-slate-900/80 px-3.5 py-1.5 shadow-inner">
            <div className="text-right">
              <div className="font-mono text-xs font-bold text-slate-200 tnum">
                {clock || '--:--:--'}
              </div>
              <div className="text-[10px] text-slate-400">{date}</div>
            </div>
            <span className="rounded-md bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-300">
              {tz}
            </span>
          </div>

          {/* Notifications Bell */}
          {onOpenNotifications && (
            <button
              type="button"
              onClick={onOpenNotifications}
              title="Notifications & Requests"
              className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-slate-900 border border-white/10 text-slate-300 hover:border-indigo-500/50 hover:bg-slate-800 hover:text-white transition shadow-sm active:scale-95 cursor-pointer"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                />
              </svg>
              {unreadNotificationsCount > 0 && (
                <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white shadow-md ring-2 ring-[#07090E] animate-pulse">
                  {unreadNotificationsCount > 99 ? '99+' : unreadNotificationsCount}
                </span>
              )}
            </button>
          )}

          {/* Live Status Pill */}
          <Badge
            tone={connection === 'live' ? 'ok' : 'muted'}
            dot
            size="md"
          >
            {connection === 'live' ? 'SSE Sync Live' : connection}
          </Badge>

          {/* Lock Action Button */}
          <Button
            variant="secondary"
            size="sm"
            onClick={onLock}
            title="Lock administrative console"
            icon={
              <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            }
          >
            Lock
          </Button>
        </div>
      </div>
    </header>
  );
}

/**
 * Modern Security Posture Banner
 */
export function WarningBar({ summary }: { summary: DashboardSummary }) {
  const { bssidVerification, bssidListed } = summary.officeConfig;
  if (bssidVerification === 'enforced') return null;

  const code = 'rounded-md bg-black/40 px-1.5 py-0.5 font-mono text-amber-200 border border-amber-500/20';

  if (bssidVerification === 'listed-not-enforced') {
    return (
      <div className="mx-6 mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs leading-relaxed text-amber-200 shadow-lg shadow-amber-500/5">
        <div className="flex items-start gap-3">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400">
            ⚠️
          </div>
          <div>
            <strong>{bssidListed} access point radio(s) listed, not yet enforced.</strong>{' '}
            Presence is verified by source IP only. To fully prevent off-site spoofing, verify radios with{' '}
            <code className={code}>npm run bssids</code> and set{' '}
            <code className={code}>&quot;enforceBssid&quot;: true</code> in{' '}
            <code className={code}>backend/config/office.json</code>.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-6 mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs leading-relaxed text-amber-200 shadow-lg shadow-amber-500/5">
      <div className="flex items-start gap-3">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400">
          ⚠️
        </div>
        <div>
          No office BSSIDs configured — presence is verified by source IP only. Run{' '}
          <code className={code}>npm run bssids</code> and configure radios in{' '}
          <code className={code}>backend/config/office.json</code>.
        </div>
      </div>
    </div>
  );
}

// --- stats -----------------------------------------------------------------

export function Stats({ summary }: { summary: DashboardSummary }) {
  const s = summary.stats;
  const cards = [
    {
      label: 'In Office Now',
      value: s.currentlyInOffice,
      tone: 'text-emerald-400',
      badgeTone: 'ok',
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      subtext: 'Active attendance',
    },
    {
      label: 'Grace Window',
      value: s.currentlyInGracePeriod,
      tone: 'text-amber-400',
      badgeTone: 'warn',
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      subtext: 'Within 10m buffer',
    },
    {
      label: 'Away / Out',
      value: s.currentlyAway,
      tone: 'text-slate-200',
      badgeTone: 'muted',
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
        </svg>
      ),
      subtext: 'Checked out or stepped away',
    },
    {
      label: 'Attended Today',
      value: s.totalAttendeesToday,
      tone: 'text-indigo-400',
      badgeTone: 'accent',
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
      ),
      subtext: 'Total unique staff',
    },
    {
      label: 'Avg Worked Time',
      value: s.averageTimeWorkedToday,
      tone: 'text-sky-400',
      badgeTone: 'info',
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
      subtext: 'Daily average',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((c) => (
        <div
          key={c.label}
          className="glass-panel rounded-2xl p-4.5 transition-all duration-200 hover:border-white/15 hover:shadow-xl relative overflow-hidden group"
        >
          {/* Subtle gradient accent */}
          <div className="absolute top-0 right-0 h-16 w-16 bg-white/[0.02] rounded-bl-full pointer-events-none group-hover:bg-white/[0.04] transition-all" />

          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-slate-400">{c.label}</span>
            <div className={`p-2 rounded-xl bg-slate-800/80 border border-white/5 ${c.tone}`}>
              {c.icon}
            </div>
          </div>

          <div className={`text-2xl font-extrabold tracking-tight ${c.tone} tnum`}>
            {c.value}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">{c.subtext}</div>
        </div>
      ))}
    </div>
  );
}

// --- presence --------------------------------------------------------------

export function PresenceGrid({ summary }: { summary: DashboardSummary }) {
  const all = [
    ...summary.inOffice,
    ...summary.grace,
    ...summary.away,
    ...summary.notArrived,
  ];

  return (
    <Panel
      title="Live Office Presence"
      subtitle={`${all.length} enrolled workforce members`}
      icon={
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      }
    >
      {all.length === 0 ? (
        <Empty
          title="No Workforce Members Enrolled"
          description="Register employees and pair mobile devices to start monitoring real-time presence."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
          {all.map((e) => {
            const meta = STATUS_META[e.status] ?? STATUS_META.NOT_CHECKED_IN;
            const initials = e.employeeName
              .split(' ')
              .map((n) => n[0])
              .slice(0, 2)
              .join('')
              .toUpperCase();

            return (
              <div
                key={e.employeeId}
                className="glass-panel-elevated rounded-2xl p-4 transition-all duration-200 hover:border-white/20 hover:shadow-2xl relative overflow-hidden"
              >
                <div className="flex items-start justify-between gap-3">
                  {/* Avatar & Name */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 border border-white/10 text-xs font-bold text-white shadow-inner">
                      {initials}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <h4 className="truncate text-sm font-bold text-white">
                          {e.employeeName}
                        </h4>
                        {e.employeeNumber && (
                          <span className="shrink-0 rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                            {e.employeeNumber}
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs text-slate-400">{e.role}</p>
                    </div>
                  </div>

                  {/* Status Badge & Late Flag */}
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    {((e.lateMinutes ?? 0) > 0 || e.isLate) && (
                      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30 shadow-[0_0_8px_rgba(244,63,94,0.2)]">
                        <span>⚠️</span> Late (+{e.lateMinutes}m)
                      </span>
                    )}
                    <Badge tone={meta.tone} dot size="sm">
                      {meta.label}
                    </Badge>
                  </div>
                </div>

                {/* Late Arrival Policy Warning Banner */}
                {((e.lateMinutes ?? 0) > 0 || e.isLate) && (
                  <div className="mt-3 flex items-center justify-between rounded-xl bg-rose-500/10 border border-rose-500/25 px-3 py-1.5 text-xs text-rose-300">
                    <span className="font-semibold flex items-center gap-1.5">
                      <span>⚠️</span> Late Arrival (Policy Flag)
                    </span>
                    <span className="font-mono font-bold text-rose-400">
                      +{e.lateMinutes}m deficit
                    </span>
                  </div>
                )}

                {/* On Break Pill */}
                {e.onBreak && (
                  <div className="mt-3 flex items-center justify-between rounded-xl bg-amber-500/10 border border-amber-500/25 px-3 py-1.5 text-xs text-amber-300">
                    <span className="font-semibold flex items-center gap-1.5">
                      <span>☕</span> On Official Break
                    </span>
                    <span className="font-mono font-bold">
                      {e.activeBreakMinutes ?? 0}m active
                    </span>
                  </div>
                )}

                {/* Stats Row */}
                <div className="mt-3.5 grid grid-cols-3 gap-2 rounded-xl bg-slate-900/60 p-2.5 text-center text-[11px] border border-white/5">
                  <div>
                    <span className="text-slate-400 block text-[10px]">First In</span>
                    <span className={`font-semibold ${((e.lateMinutes ?? 0) > 0 || e.isLate) ? 'text-rose-400 font-bold' : 'text-slate-200'}`}>
                      {e.firstCheckIn}
                    </span>
                    {((e.lateMinutes ?? 0) > 0 || e.isLate) && (
                      <span className="text-[9px] text-rose-400 font-mono font-bold block">
                        +{e.lateMinutes}m late
                      </span>
                    )}
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">Last Seen</span>
                    <span className="font-semibold text-slate-200">{e.lastActiveTime}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">Worked</span>
                    <span className="font-bold text-emerald-400">{e.timeWorkedFormatted}</span>
                  </div>
                </div>

                {/* Facilitator Posture */}
                {e.presenceSource && (
                  <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400 pt-2 border-t border-white/5">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          e.sensorCarried ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]' : 'bg-teal-400'
                        }`}
                      />
                      <span>via {e.presenceSource}</span>
                    </span>
                    {e.sensorCarried ? (
                      <span className="text-emerald-400 font-medium text-[10px]">
                        Sensor Verified
                      </span>
                    ) : (
                      <span className="text-teal-400 font-medium text-[10px]">
                        App / Workstation
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// --- attendance table ------------------------------------------------------

export function AttendanceTable({
  rows,
  dateKey,
  onExport,
}: {
  rows: EmployeeDay[];
  dateKey: string;
  onExport: (from: string, to: string) => void;
}) {
  const [selectedDate, setSelectedDate] = useState(dateKey);
  const [historyRows, setHistoryRows] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [from, setFrom] = useState(dateKey);
  const [to, setTo] = useState(dateKey);

  const isToday = selectedDate === dateKey;

  useEffect(() => {
    if (isToday) return;
    let active = true;
    setLoadingHistory(true);
    api
      .history(selectedDate, selectedDate)
      .then((res) => {
        if (active) {
          setHistoryRows(res.days || []);
          setLoadingHistory(false);
        }
      })
      .catch(() => {
        if (active) {
          setHistoryRows([]);
          setLoadingHistory(false);
        }
      });
    return () => {
      active = false;
    };
  }, [selectedDate, isToday]);

  const shiftDate = (days: number) => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + days);
    const newKey = d.toISOString().split('T')[0];
    setSelectedDate(newKey);
  };

  return (
    <Panel
      title="Timesheets & Daily Ledger"
      subtitle={isToday ? 'Live real-time observations' : `Historical log for ${selectedDate}`}
      icon={
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      }
      actions={
        <div className="flex flex-wrap items-center gap-3">
          {/* Historical Date Picker Navigation */}
          <div className="flex items-center rounded-xl border border-white/10 bg-slate-900/90 p-1 shadow-inner">
            <button
              onClick={() => shiftDate(-1)}
              className="rounded-lg px-2.5 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition"
              title="Previous Day"
            >
              ◀
            </button>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="bg-transparent px-2 py-0.5 text-xs font-mono text-white focus:outline-none cursor-pointer"
            />
            <button
              onClick={() => shiftDate(1)}
              className="rounded-lg px-2.5 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition"
              title="Next Day"
            >
              ▶
            </button>
            {!isToday && (
              <Button
                size="sm"
                variant="accent"
                onClick={() => setSelectedDate(dateKey)}
                className="ml-1 py-1 text-[11px]"
              >
                Today
              </Button>
            )}
          </div>

          {/* Export Range */}
          <div className="flex items-center gap-2 pl-3 border-l border-white/10">
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="py-1 text-xs w-28"
            />
            <span className="text-xs text-slate-400">to</span>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="py-1 text-xs w-28"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onExport(from, to)}
              icon={
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              }
            >
              Export CSV
            </Button>
          </div>
        </div>
      }
    >
      <div className="mb-3 px-3.5 py-2.5 rounded-xl bg-teal-500/10 border border-teal-500/20 text-xs text-teal-300 flex flex-wrap items-center justify-between gap-2 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="text-teal-400 font-bold flex items-center gap-1.5">
            <span>⏱️</span> Required Working Time:
          </span>
          <span className="font-semibold text-white">7 hours 30 minutes / day</span>
          <span className="text-teal-400/80">(37.5 hours / week)</span>
        </div>
        <div className="text-slate-400 text-[11px] flex items-center gap-3">
          <span>Office Window: <strong className="text-slate-200">11:00 AM – 7:00 PM</strong></span>
          <span>•</span>
          <span>Authorised Break: <strong className="text-slate-200">30 mins</strong></span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-white/8">
        <table className="w-full min-w-[760px] border-collapse text-left text-xs">
          <thead className="bg-slate-900/90 text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-white/8">
            <tr>
              <th className="px-4 py-3.5">Employee</th>
              <th className="px-3 py-3.5">First In</th>
              <th className="px-3 py-3.5">Last Seen</th>
              <th className="px-3 py-3.5">Sessions</th>
              <th className="px-3 py-3.5">Worked (7h 30m Target)</th>
              <th className="px-3 py-3.5">Break Taken</th>
              <th className="px-3 py-3.5">Deficit</th>
              <th className="px-4 py-3.5 text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 bg-slate-950/40">
            {isToday ? (
              rows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <Empty title="No Check-Ins Recorded Today" description="Staff will appear here as they clock in or connect to the office beacon." />
                  </td>
                </tr>
              ) : (
                rows.map((a) => {
                  const meta = STATUS_META[a.status] ?? STATUS_META.NOT_CHECKED_IN;
                  const hasExcessBreak = (a.excessBreakMinutes ?? 0) > 0;
                  const hasDeficit = (a.dailyDeficitMinutes ?? 0) > 0;
                  const netWorkedMinutes = Math.max(0, (a.totalMinutes || 0) - (a.breakMinutes || a.activeBreakMinutes || 0));
                  const isTargetMet = netWorkedMinutes >= 450;
                  const shortMins = Math.max(0, 450 - netWorkedMinutes);
                  const extraMins = Math.max(0, netWorkedMinutes - 450);

                  return (
                    <tr key={a.employeeId} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-3.5">
                        <span className="font-bold text-white block">{a.employeeName}</span>
                        <span className="text-[11px] text-slate-400">{a.role}</span>
                      </td>
                      <td className="px-3 py-3.5 font-mono">
                        <span className={((a.lateMinutes ?? 0) > 0 || (a as any).isLate) ? 'text-rose-400 font-bold' : 'text-slate-300'}>
                          {a.firstCheckIn}
                        </span>
                        {((a.lateMinutes ?? 0) > 0 || (a as any).isLate) && (
                          <div className="text-[10px] text-rose-400 font-bold flex items-center gap-0.5">
                            <span>⚠️</span> +{a.lateMinutes ?? 0}m late
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3.5 font-mono text-slate-300">{a.lastActiveTime}</td>
                      <td className="px-3 py-3.5 text-[11px] text-slate-400">
                        {a.sessions.length
                          ? a.sessions.map((s, i) => (
                              <div key={i} className="font-mono text-slate-300">
                                {s.from} – {s.to}
                              </div>
                            ))
                          : '—'}
                      </td>
                      <td className="px-3 py-3.5">
                        <strong className="text-emerald-400 text-sm font-bold block">{a.timeWorkedFormatted}</strong>
                        {((a.breakMinutes ?? 0) > 0 || (a.activeBreakMinutes ?? 0) > 0) ? (
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            Net: <span className="text-teal-300 font-semibold">{Math.floor(netWorkedMinutes / 60)}h {netWorkedMinutes % 60}m</span>
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-500 mt-0.5">Full presence</div>
                        )}
                        <div className="mt-1">
                          {isTargetMet ? (
                            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-500/20">
                              ✓ 7h 30m met {extraMins > 0 ? `(+${Math.floor(extraMins / 60)}h ${extraMins % 60}m)` : ''}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 border border-amber-500/20">
                              ⏳ Short: {Math.floor(shortMins / 60)}h {shortMins % 60}m of 7h 30m
                            </span>
                          )}
                        </div>
                        {a.adjustmentMinutes !== 0 && (
                          <span className="text-[10px] text-amber-400 font-semibold block mt-0.5">
                            incl. {a.adjustmentMinutes}m adj.
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3.5">
                        {a.onBreak ? (
                          <span className="font-bold text-amber-400">
                            ☕ On break ({a.activeBreakMinutes ?? 0}m)
                          </span>
                        ) : a.breakMinutes ? (
                          <span className="text-slate-300">{a.breakMinutes}m</span>
                        ) : (
                          <span className="text-slate-400">0m</span>
                        )}
                        {hasExcessBreak && (
                          <div className="text-[10px] font-bold text-rose-400">
                            +{a.excessBreakMinutes}m excess
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3.5">
                        {hasDeficit ? (
                          <span className="font-bold text-rose-400">{a.dailyDeficitMinutes}m</span>
                        ) : ((a.lateMinutes ?? 0) > 0) ? (
                          <span className="font-bold text-rose-400">{a.lateMinutes}m</span>
                        ) : (
                          <span className="text-slate-400">0m</span>
                        )}
                        {((a.lateMinutes ?? 0) > 0 || (a as any).isLate) && (
                          <div className="text-[10px] text-rose-400 font-semibold">⚠️ Late arrival</div>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-1.5 flex-wrap">
                          {((a.lateMinutes ?? 0) > 0 || (a as any).isLate) && (
                            <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30">
                              LATE
                            </span>
                          )}
                          <Badge tone={meta.tone} dot size="sm">
                            {meta.label}
                          </Badge>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )
            ) : loadingHistory ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-400">
                  <div className="flex items-center justify-center gap-3">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
                    <span>Loading historical records for {selectedDate}…</span>
                  </div>
                </td>
              </tr>
            ) : historyRows.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <Empty title={`No records for ${selectedDate}`} description="There were no active working sessions logged on this date." />
                </td>
              </tr>
            ) : (
              historyRows.map((h) => {
                const meta = STATUS_META[h.status as PresenceStatus] ?? STATUS_META.NOT_CHECKED_IN;
                return (
                  <tr key={h.employeeId} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3.5">
                      <span className="font-bold text-white block">{h.employeeName}</span>
                      <span className="text-[11px] text-slate-400">{h.role}</span>
                    </td>
                    <td className="px-3 py-3.5 font-mono text-slate-300">{h.firstCheckIn}</td>
                    <td className="px-3 py-3.5 font-mono text-slate-300">{h.lastActive}</td>
                    <td className="px-3 py-3.5 text-[11px] text-slate-400">
                      {h.sessions && h.sessions.length
                        ? h.sessions.map((s: any, i: number) => (
                            <div key={i} className="font-mono text-slate-300">
                              {s.from} – {s.to} ({s.duration})
                            </div>
                          ))
                        : '—'}
                    </td>
                    <td className="px-3 py-3.5">
                      <strong className="text-white text-sm font-bold block">{h.timeWorked}</strong>
                      {h.adjustmentMinutes !== 0 && h.adjustmentMinutes != null && (
                        <div className="text-[10px] text-amber-400 font-semibold">
                          {h.adjustmentMinutes > 0 ? `+${h.adjustmentMinutes}m` : `${h.adjustmentMinutes}m`} adj.
                          {h.adjustmentNote ? ` (${h.adjustmentNote})` : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3.5 text-slate-400">
                      {h.adjustmentNote ? h.adjustmentNote : '—'}
                    </td>
                    <td className="px-3 py-3.5">
                      {h.totalMinutes >= 450 ? (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-500/20">
                          ✓ 7h 30m met {h.totalMinutes > 450 ? `(+${Math.floor((h.totalMinutes - 450) / 60)}h ${(h.totalMinutes - 450) % 60}m)` : ''}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 border border-amber-500/20">
                          ⏳ Short: {Math.floor((450 - h.totalMinutes) / 60)}h {(450 - h.totalMinutes) % 60}m
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <Badge tone={meta.tone} dot size="sm">
                        {meta.label}
                      </Badge>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// --- team ------------------------------------------------------------------

export function TeamPanel({
  employees,
  onAdd,
  onPair,
  onRefresh,
}: {
  employees: AdminEmployee[];
  onAdd: (name: string, role: string, baseSalary?: number, currency?: string) => Promise<void>;
  onPair: (employee: AdminEmployee) => Promise<void>;
  onRefresh?: () => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [baseSalary, setBaseSalary] = useState('');
  const [currency, setCurrency] = useState('PKR');
  const [busy, setBusy] = useState(false);
  const [showSalaryModal, setShowSalaryModal] = useState(false);
  const [selectedEmpId, setSelectedEmpId] = useState<string | undefined>(undefined);
  const [viewProfileEmp, setViewProfileEmp] = useState<AdminEmployee | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const parsedSalary = baseSalary ? parseFloat(baseSalary) : undefined;
      await onAdd(name.trim(), role.trim(), parsedSalary, currency);
      setName('');
      setRole('');
      setBaseSalary('');
    } finally {
      setBusy(false);
    }
  };

  const handleUnpair = async (emp: AdminEmployee) => {
    const ok = window.confirm(
      `Are you sure you want to unpair all devices for "${emp.name}" (${emp.employeeNumber || emp.id})?\n\nThis will disconnect active mobile app sessions. Attendance and payroll history will be safely preserved.`
    );
    if (!ok) return;

    try {
      setBusy(true);
      const res = await api.unpairEmployeeDevices(emp.id);
      alert(res.message || 'Devices successfully unpaired.');
      if (onRefresh) onRefresh();
    } catch (err: any) {
      alert(err?.message || 'Failed to unpair devices');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel
        title="Workforce Enrolment & Compensation"
        subtitle={`${employees.length} registered employee(s)`}
        icon={
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
        }
      >
        {/* Quick Add Form */}
        <form onSubmit={submit} className="mb-5 flex flex-wrap gap-3 rounded-2xl border border-white/8 bg-slate-900/60 p-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Employee Full Name *"
            className="flex-1 min-w-[160px]"
            required
          />
          <Input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Role / Designation *"
            className="flex-1 min-w-[140px]"
            required
          />
          <div className="flex gap-2 flex-1 min-w-[160px]">
            <Input
              type="number"
              value={baseSalary}
              onChange={(e) => setBaseSalary(e.target.value)}
              placeholder="Base Pay (optional)"
              className="flex-1"
            />
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="rounded-xl border border-white/10 bg-slate-900 px-3 text-xs font-mono text-white focus:border-indigo-500 focus:outline-none"
            >
              <option value="PKR">PKR (₨)</option>
              <option value="GBP">GBP (£)</option>
              <option value="USD">USD ($)</option>
              <option value="EUR">EUR (€)</option>
            </select>
          </div>
          <Button variant="accent" type="submit" disabled={busy}>
            {busy ? 'Registering…' : '+ Register Employee'}
          </Button>
        </form>

        {employees.length === 0 ? (
          <Empty title="No Employees Registered" description="Add your first team member above to issue mobile pairing credentials and set base pay." />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {employees.map((e) => {
              const cur = e.currency || 'PKR';
              const curSymbol = cur === 'GBP' ? '£' : cur === 'PKR' ? '₨' : '$';
              return (
                <div
                  key={e.id}
                  className="flex flex-col justify-between gap-3 rounded-2xl border border-white/8 bg-slate-900/60 p-4 transition-all hover:border-white/15 overflow-hidden"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-500/10 text-indigo-400 font-bold border border-indigo-500/20 shrink-0">
                        {e.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-white text-sm truncate">{e.name}</span>
                          {e.employeeNumber && (
                            <span className="rounded-md bg-indigo-500/15 px-2 py-0.5 text-[11px] font-mono font-bold text-indigo-300 border border-indigo-500/30 shrink-0">
                              {e.employeeNumber}
                            </span>
                          )}
                          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-extrabold text-emerald-400 border border-emerald-500/20 shrink-0">
                            {e.deviceCount} Device{e.deviceCount === 1 ? '' : 's'}
                          </span>
                        </div>
                        <span className="text-xs text-slate-400 block truncate">{e.role}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      {e.baseSalary ? (
                        <div className="font-mono text-xs font-bold text-emerald-400">
                          {curSymbol}{Number(e.baseSalary).toLocaleString()}
                          <span className="text-[10px] text-slate-500 font-normal block">/ month</span>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-500 italic block">No salary set</span>
                      )}
                      {e.startDate && (
                        <span className="text-[10px] text-slate-400 block mt-0.5">
                          Joined {e.startDate}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/5 pt-2.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setViewProfileEmp(e);
                      }}
                      icon={
                        <svg className="h-3.5 w-3.5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                      }
                    >
                      View Details
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setSelectedEmpId(e.id);
                        setShowSalaryModal(true);
                      }}
                      icon={
                        <svg className="h-3.5 w-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
                        </svg>
                      }
                    >
                      {e.baseSalary ? 'Update Salary' : 'Set Base Salary'}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void onPair(e)}
                      icon={
                        <svg className="h-3.5 w-3.5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                      }
                    >
                      Pair App
                    </Button>
                    {e.deviceCount > 0 && (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={() => void handleUnpair(e)}
                        icon={
                          <svg className="h-3.5 w-3.5 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                          </svg>
                        }
                      >
                        Unpair App
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {showSalaryModal && (
        <SetSalaryModal
          employees={employees}
          prefilledEmployeeId={selectedEmpId}
          onClose={() => {
            setShowSalaryModal(false);
            setSelectedEmpId(undefined);
          }}
          onSuccess={() => {
            onRefresh?.();
          }}
        />
      )}

      {viewProfileEmp && (
        <EmployeeProfileModal
          employee={viewProfileEmp}
          onClose={() => setViewProfileEmp(null)}
        />
      )}
    </>
  );
}

// --- activity --------------------------------------------------------------

export function ActivityFeed({ movements }: { movements: Movement[] }) {
  const feedColors: Record<string, { bg: string; text: string; dot: string }> = {
    ARRIVED: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', dot: 'bg-emerald-400' },
    RECONNECTED: { bg: 'bg-indigo-500/10', text: 'text-indigo-400', dot: 'bg-indigo-400' },
    DEPARTED: { bg: 'bg-amber-500/10', text: 'text-amber-400', dot: 'bg-amber-400' },
    NEEDS_REVIEW: { bg: 'bg-rose-500/10', text: 'text-rose-400', dot: 'bg-rose-400' },
  };

  return (
    <Panel
      title="Live Activity Stream"
      subtitle="Multi-source presence & event log"
      icon={
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      }
    >
      {movements.length === 0 ? (
        <Empty title="No Activity Logged" description="Recent arrivals and departures will appear here in real-time." />
      ) : (
        <div className="flex max-h-[420px] flex-col gap-2.5 overflow-y-auto pr-1">
          {movements.map((m) => {
            const style = feedColors[m.type] ?? {
              bg: 'bg-slate-800',
              text: 'text-slate-400',
              dot: 'bg-slate-400',
            };
            return (
              <div
                key={m.id}
                className="flex items-start gap-3 rounded-xl border border-white/5 bg-slate-900/50 p-3 transition-colors hover:bg-slate-900/80"
              >
                <span
                  className={`mt-0.5 rounded-md px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wider ${style.bg} ${style.text}`}
                >
                  {m.type}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-bold text-slate-200">{m.name}</div>
                  <div className="truncate text-[11px] text-slate-400">{m.details}</div>
                </div>
                <span className="font-mono text-[11px] text-slate-400 shrink-0">{m.time}</span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// --- pairing code modal ----------------------------------------------------

export function CodeModal({
  code,
  employeeName,
  expires,
  onClose,
}: {
  code: string;
  employeeName: string;
  expires: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6 backdrop-blur-md">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-slate-900 p-8 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
          <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        </div>

        <h2 className="text-xl font-extrabold text-white">Single-Use Pairing Key</h2>
        <p className="mt-1 text-xs text-slate-400">for {employeeName}</p>

        <div
          onClick={copy}
          title="Click to copy"
          className="my-5 cursor-pointer rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5 font-mono text-3xl font-black tracking-widest text-emerald-400 transition-all hover:bg-emerald-500/20 active:scale-95"
        >
          {code}
        </div>

        <p className="mb-6 text-xs text-slate-400">
          {copied ? '✅ Copied to clipboard!' : `Single use · Valid until ${expires}. Enter in mobile app.`}
        </p>

        <Button variant="accent" onClick={onClose} size="lg" className="w-full">
          Done
        </Button>
      </div>
    </div>
  );
}

// --- attendance corrections panel ------------------------------------------

export function AttendanceCorrectionsPanel({
  corrections,
  onDecide,
  onRefresh,
}: {
  corrections: AttendanceCorrection[];
  onDecide: (
    id: string,
    decision: 'APPROVED' | 'REJECTED' | 'AMENDED',
    notes: string,
    adjustmentMinutes?: number,
  ) => Promise<void>;
  onRefresh: () => void;
}) {
  const [activeCorrection, setActiveCorrection] = useState<AttendanceCorrection | null>(null);
  const [decisionAction, setDecisionAction] = useState<'APPROVED' | 'AMENDED' | 'REJECTED'>('APPROVED');
  const [adjustmentMinutes, setAdjustmentMinutes] = useState<number>(30);
  const [notes, setNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'PENDING' | 'ALL'>('PENDING');

  const filtered = corrections.filter((c) =>
    statusFilter === 'ALL' ? true : c.status === 'PENDING',
  );
  const pendingCount = corrections.filter((c) => c.status === 'PENDING').length;

  const openDecision = (
    c: AttendanceCorrection,
    action: 'APPROVED' | 'AMENDED' | 'REJECTED',
  ) => {
    setActiveCorrection(c);
    setDecisionAction(action);
    const initialMinutes =
      (c.requestedChange?.adjustmentMinutes as number | undefined) ?? 30;
    setAdjustmentMinutes(initialMinutes);
    setNotes(
      action === 'APPROVED'
        ? 'Approved as requested.'
        : action === 'AMENDED'
          ? 'Approved with modified adjustment.'
          : '',
    );
  };

  const handleConfirm = async () => {
    if (!activeCorrection) return;
    if (!notes.trim()) {
      alert('Please provide a decision note explaining the outcome.');
      return;
    }
    setSubmitting(true);
    try {
      await onDecide(
        activeCorrection.id,
        decisionAction,
        notes.trim(),
        decisionAction === 'REJECTED' ? undefined : adjustmentMinutes,
      );
      setActiveCorrection(null);
      onRefresh();
    } catch (e: unknown) {
      const err = e as Error;
      alert(err.message || 'Failed to submit decision.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Panel
      title="Attendance Disputes & Correction Appeals"
      subtitle={pendingCount > 0 ? `${pendingCount} dispute(s) pending administrative decision` : 'All disputes reviewed'}
      icon={
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      }
      actions={
        <div className="flex items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'PENDING' | 'ALL')}
            className="rounded-xl border border-white/10 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 focus:outline-none"
          >
            <option value="PENDING">Pending Review ({pendingCount})</option>
            <option value="ALL">All History</option>
          </select>
          <Button size="sm" variant="secondary" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      }
    >
      {filtered.length === 0 ? (
        <Empty
          title={statusFilter === 'PENDING' ? 'No Pending Disputes' : 'No Dispute Records'}
          description="Submitted employee attendance adjustments will appear here for HR adjudication."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/8">
          <table className="w-full min-w-[700px] border-collapse text-left text-xs">
            <thead className="bg-slate-900/90 text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-white/8">
              <tr>
                <th className="px-4 py-3.5">Employee</th>
                <th className="px-3 py-3.5">Disputed Date</th>
                <th className="px-3 py-3.5">Reason & Evidence</th>
                <th className="px-3 py-3.5">Requested Credit</th>
                <th className="px-3 py-3.5">Status</th>
                <th className="px-4 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 bg-slate-950/40">
              {filtered.map((c) => {
                const isPending = c.status === 'PENDING';
                const requestedMins = c.requestedChange?.adjustmentMinutes as number | undefined;
                const statusTone =
                  c.status === 'APPROVED' ? 'ok' : c.status === 'REJECTED' ? 'danger' : 'warn';

                return (
                  <tr key={c.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3.5">
                      <span className="font-bold text-white block">{c.employeeName}</span>
                      <span className="text-[11px] text-slate-400">{c.role}</span>
                    </td>
                    <td className="px-3 py-3.5 font-mono text-slate-300">
                      {c.date}
                      <span className="block text-[10px] text-slate-400">{c.requestedAt}</span>
                    </td>
                    <td className="px-3 py-3.5 max-w-[260px]">
                      <div className="text-xs text-slate-200 leading-snug">{c.reason}</div>
                      {c.reviewNotes && (
                        <div className="mt-1 text-[11px] text-indigo-400 italic">
                          HR: {c.reviewNotes}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3.5">
                      {requestedMins !== undefined ? (
                        <span className="font-bold text-emerald-400">+{requestedMins}m</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3.5">
                      <Badge tone={statusTone} dot size="sm">
                        {c.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      {isPending ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => openDecision(c, 'APPROVED')}
                          >
                            Approve
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openDecision(c, 'AMENDED')}
                          >
                            Amend
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => openDecision(c, 'REJECTED')}
                          >
                            Reject
                          </Button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-400">Decided {c.reviewedAt ?? ''}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Decision Modal */}
      {activeCorrection && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6 backdrop-blur-md">
          <div className="w-full max-w-md rounded-3xl border border-white/10 bg-slate-900 p-7 shadow-2xl">
            <h2 className="text-lg font-bold text-white">
              {decisionAction === 'APPROVED'
                ? 'Approve Attendance Dispute'
                : decisionAction === 'AMENDED'
                  ? 'Amend & Approve Dispute'
                  : 'Reject Attendance Dispute'}
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              {activeCorrection.employeeName} · {activeCorrection.date}
            </p>

            <div className="my-4 rounded-xl bg-slate-950/70 border border-white/5 p-3.5 text-xs">
              <span className="text-slate-400 block mb-1">Employee Explanation:</span>
              <p className="text-slate-200 font-medium">{activeCorrection.reason}</p>
            </div>

            {decisionAction !== 'REJECTED' && (
              <div className="mb-4">
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Adjustment Minutes to Credit
                </label>
                <Input
                  type="number"
                  value={adjustmentMinutes}
                  onChange={(e) => setAdjustmentMinutes(Math.max(0, parseInt(e.target.value) || 0))}
                />
                <span className="text-[11px] text-slate-400 mt-1 block">
                  Reduces employee deficit balance by this amount.
                </span>
              </div>
            )}

            <div className="mb-5">
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Decision Note & Audit Rationale
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Enter justification for the audit log…"
                rows={3}
                className="w-full rounded-xl border border-white/10 bg-slate-950 p-3 text-xs text-slate-200 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2.5">
              <Button variant="secondary" onClick={() => setActiveCorrection(null)} disabled={submitting}>
                Cancel
              </Button>
              <Button
                variant={decisionAction === 'REJECTED' ? 'danger' : 'primary'}
                onClick={handleConfirm}
                disabled={submitting}
              >
                {submitting ? 'Submitting…' : `Confirm ${decisionAction}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

export function EmployeeProfileModal({
  employee,
  onClose,
}: {
  employee: AdminEmployee;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentStartDate, setCurrentStartDate] = useState<string>('');
  const [editingStartDate, setEditingStartDate] = useState(false);
  const [newStartDate, setNewStartDate] = useState<string>('');
  const [savingStartDate, setSavingStartDate] = useState(false);
  const [startDateSuccess, setStartDateSuccess] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.getEmployeeProfile(employee.id)
      .then((res) => {
        if (active) {
          setProfile(res.profile);
          const start = res.profile?.employment?.startDate || employee.startDate || '';
          setCurrentStartDate(start);
          setNewStartDate(start);
          setLoading(false);
        }
      })
      .catch((err: any) => {
        if (active) {
          setError(err?.message || 'Failed to load employee profile');
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [employee.id]);

  const p = profile?.personal;
  const contacts = profile?.emergencyContacts || [];
  const schedule = profile?.schedule;
  const salary = profile?.salary;

  const address = p
    ? [p.addressLine1, p.addressLine2, p.city, p.postcode, p.country]
        .filter(Boolean)
        .join(', ')
    : '';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 sm:p-6 backdrop-blur-md overflow-y-auto">
      <div className="w-full max-w-2xl rounded-3xl border border-white/10 bg-slate-900 p-6 sm:p-7 shadow-2xl my-8">
        <div className="flex items-start justify-between border-b border-white/10 pb-5">
          <div className="flex items-center gap-3.5">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-indigo-500/20 text-indigo-400 font-bold text-lg border border-indigo-500/30">
              {employee.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-white">{employee.name}</h2>
                <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[10px] font-extrabold text-emerald-400 border border-emerald-500/20">
                  {employee.deviceCount} Device{employee.deviceCount === 1 ? '' : 's'}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                {employee.role || 'Team Member'} · ID: <span className="font-mono text-indigo-400 font-bold">{profile?.employeeNumber || employee.employeeNumber || employee.id}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 hover:bg-white/5 hover:text-white transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="py-16 text-center text-sm text-slate-400">
            <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
            Loading employee personal & HR profile…
          </div>
        ) : error ? (
          <div className="my-6 rounded-2xl border border-rose-500/20 bg-rose-500/10 p-4 text-xs text-rose-300">
            {error}
          </div>
        ) : (
          <div className="mt-5 space-y-5 max-h-[70vh] overflow-y-auto pr-1">
            {/* Personal Details & Identification */}
            <div className="rounded-2xl border border-white/8 bg-slate-950/60 p-4">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-sky-400 mb-3">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2" />
                </svg>
                Personal Details & Identification
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-slate-400 block text-[11px]">National ID / CNIC</span>
                  <span className="font-semibold text-white font-mono">{p?.nationalId || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[11px]">Mobile Phone</span>
                  <span className="font-semibold text-white">{p?.mobilePhone || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[11px]">Personal Email</span>
                  <span className="font-semibold text-white">{p?.personalEmail || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[11px]">Date of Birth</span>
                  <span className="font-semibold text-white">{p?.dateOfBirth || '—'}</span>
                </div>
                <div className="sm:col-span-2">
                  <span className="text-slate-400 block text-[11px]">Residential Address</span>
                  <span className="font-semibold text-white">{address || '—'}</span>
                </div>
              </div>
            </div>

            {/* Next of Kin & Emergency Contacts */}
            <div className="rounded-2xl border border-white/8 bg-slate-950/60 p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-teal-400">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                  Next of Kin & Emergency Contacts ({contacts.length})
                </div>
              </div>
              {contacts.length === 0 ? (
                <p className="text-xs text-slate-500 italic py-2">
                  No emergency contacts registered by employee yet.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {contacts.map((c: any, idx: number) => (
                    <div
                      key={c.id || idx}
                      className="flex items-center justify-between rounded-xl border border-white/5 bg-slate-900/80 p-3"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white text-xs">{c.name}</span>
                          {c.isPrimary && (
                            <span className="rounded bg-teal-500/20 px-1.5 py-0.5 text-[9px] font-bold text-teal-400 border border-teal-500/30">
                              PRIMARY
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-slate-400 block mt-0.5">
                          {c.relationship} · {c.phone} {c.email ? `· ${c.email}` : ''}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Employment Status & Join Date */}
            <div className="rounded-2xl border border-white/8 bg-slate-950/60 p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-indigo-400">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  Employment & Join Date (HR Only)
                </div>
                {!editingStartDate && (
                  <button
                    onClick={() => {
                      setNewStartDate(currentStartDate || '');
                      setEditingStartDate(true);
                      setStartDateSuccess(null);
                    }}
                    className="text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    Edit Join Date
                  </button>
                )}
              </div>

              {editingStartDate ? (
                <div className="space-y-3 pt-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <input
                      type="date"
                      value={newStartDate}
                      onChange={(e) => setNewStartDate(e.target.value)}
                      className="rounded-xl border border-white/15 bg-slate-900 px-3 py-1.5 text-xs text-white outline-none focus:border-indigo-500"
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={savingStartDate || !newStartDate}
                      onClick={async () => {
                        setSavingStartDate(true);
                        try {
                          await api.updateStartDate(employee.id, newStartDate, 'Join date updated by HR');
                          setCurrentStartDate(newStartDate);
                          employee.startDate = newStartDate;
                          try {
                            const ref = await api.getEmployeeProfile(employee.id);
                            if (ref?.profile) setProfile(ref.profile);
                          } catch {}
                          setEditingStartDate(false);
                          setStartDateSuccess('Join date updated successfully.');
                        } catch (err: any) {
                          alert(err?.message || 'Failed to update start date');
                        } finally {
                          setSavingStartDate(false);
                        }
                      }}
                    >
                      {savingStartDate ? 'Saving…' : 'Save'}
                    </Button>
                    <button
                      onClick={() => setEditingStartDate(false)}
                      className="text-xs text-slate-400 hover:text-white"
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400">
                    Updating the employee's official start date updates all initial employment records and audit logs.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  <div>
                    <span className="text-slate-400 block text-[11px]">Official Start Date</span>
                    <span className="font-semibold text-white">
                      {currentStartDate || employee.startDate || 'Not Set'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[11px]">Designation</span>
                    <span className="font-semibold text-white">{employee.role || 'Team Member'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[11px]">Status</span>
                    <span className="font-semibold text-emerald-400">Active Employee</span>
                  </div>
                </div>
              )}

              {startDateSuccess && (
                <div className="mt-2 text-[11px] font-medium text-emerald-400">
                  ✓ {startDateSuccess}
                </div>
              )}
            </div>

            {/* Employment & Shift Schedule */}
            {schedule && (
              <div className="rounded-2xl border border-white/8 bg-slate-950/60 p-4">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-400 mb-3">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Work Schedule & Policy Windows
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  <div>
                    <span className="text-slate-400 block text-[11px]">Assigned Hours</span>
                    <span className="font-semibold text-white">{schedule.startTime} – {schedule.endTime}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[11px]">Required Working Time</span>
                    <span className="font-semibold text-teal-300">7h 30m / day (37.5h / wk)</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[11px]">Paid Break</span>
                    <span className="font-semibold text-white">{schedule.breakMinutes} min</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[11px]">Grace Window</span>
                    <span className="font-semibold text-white">{schedule.graceMinutes} min (to 11:10)</span>
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-slate-400 block text-[11px]">Scheduled Working Days</span>
                    <span className="font-semibold text-white">{schedule.workDays}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Compensation */}
            {salary && (
              <div className="rounded-2xl border border-white/8 bg-slate-950/60 p-4">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-emerald-400 mb-3">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                  Compensation & Payroll Basis
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  <div>
                    <span className="text-slate-400 block text-[11px]">Base Monthly Pay</span>
                    <span className="font-bold text-emerald-400 text-sm">
                      {salary.currency === 'GBP' ? '£' : salary.currency === 'PKR' ? '₨ ' : '$'}
                      {Number(salary.monthly ?? salary.baseAmount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[11px]">Daily Rate</span>
                    <span className="font-semibold text-white">
                      {salary.currency === 'GBP' ? '£' : salary.currency === 'PKR' ? '₨ ' : '$'}
                      {Number(salary.daily ?? salary.dailyRate ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[11px]">Effective Since</span>
                    <span className="font-semibold text-white">{salary.effectiveFrom || currentStartDate || employee.startDate || '—'}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
