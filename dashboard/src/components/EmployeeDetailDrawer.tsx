'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import type { EmployeeDay, WorkstationItem, AppUsageItem } from '../lib/types';
import { Badge, Button } from './primitives';

interface EmployeeDetailDrawerProps {
  employee: EmployeeDay | null;
  onClose: () => void;
  onOpenPairing?: (employee: { id: string; name: string }) => void;
}

type DrawerTab = 'sessions' | 'workstation' | 'apps' | 'policy';

function formatSeconds(secs: number) {
  if (!secs || secs <= 0) return '0m';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function getAppCategory(appName: string) {
  const lower = (appName || '').toLowerCase();
  if (
    lower.includes('code') ||
    lower.includes('antigravity') ||
    lower.includes('ide') ||
    lower.includes('studio') ||
    lower.includes('terminal') ||
    lower.includes('git') ||
    lower.includes('dbeaver') ||
    lower.includes('postman')
  ) {
    return { label: 'Development', icon: '⚡', badgeClass: 'text-sky-400 bg-sky-500/10 border-sky-500/20' };
  }
  if (
    lower.includes('chrome') ||
    lower.includes('edge') ||
    lower.includes('firefox') ||
    lower.includes('browser') ||
    lower.includes('safari') ||
    lower.includes('brave')
  ) {
    return { label: 'Web / Cloud', icon: '🌐', badgeClass: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' };
  }
  if (
    lower.includes('teams') ||
    lower.includes('slack') ||
    lower.includes('zoom') ||
    lower.includes('meet') ||
    lower.includes('outlook') ||
    lower.includes('discord')
  ) {
    return { label: 'Communication', icon: '💬', badgeClass: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' };
  }
  if (
    lower.includes('excel') ||
    lower.includes('word') ||
    lower.includes('docs') ||
    lower.includes('sheets') ||
    lower.includes('notion') ||
    lower.includes('figma')
  ) {
    return { label: 'Productivity', icon: '📊', badgeClass: 'text-amber-400 bg-amber-500/10 border-amber-500/20' };
  }
  if (lower.includes('youtube') || lower.includes('spotify') || lower.includes('netflix')) {
    return { label: 'Media', icon: '🎬', badgeClass: 'text-rose-400 bg-rose-500/10 border-rose-500/20' };
  }
  return { label: 'Application', icon: '💻', badgeClass: 'text-slate-400 bg-slate-500/10 border-slate-500/20' };
}

export function EmployeeDetailDrawer({ employee, onClose, onOpenPairing }: EmployeeDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<DrawerTab>('sessions');
  const [workstation, setWorkstation] = useState<WorkstationItem | null>(null);
  const [apps, setApps] = useState<AppUsageItem[]>([]);
  const [loadingTelemetry, setLoadingTelemetry] = useState(false);

  // Close on Escape key press
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Load workstation and app telemetry when an employee is selected
  const loadTelemetry = useCallback(async (empId: string) => {
    setLoadingTelemetry(true);
    try {
      const [wsRes, appRes] = await Promise.all([
        api.fetchWorkstations().catch(() => null),
        api.fetchAppUsage().catch(() => null),
      ]);

      if (wsRes?.workstations) {
        const matchWs = wsRes.workstations.find((w) => w.employeeId === empId) || null;
        setWorkstation(matchWs);
      } else {
        setWorkstation(null);
      }

      if (appRes?.appUsage) {
        const matchApps = appRes.appUsage.filter((a) => a.employeeId === empId);
        // Sort descending by activeSeconds
        matchApps.sort((a, b) => (b.activeSeconds || 0) - (a.activeSeconds || 0));
        setApps(matchApps);
      } else {
        setApps([]);
      }
    } finally {
      setLoadingTelemetry(false);
    }
  }, []);

  useEffect(() => {
    if (employee?.employeeId) {
      loadTelemetry(employee.employeeId);
    }
  }, [employee?.employeeId, loadTelemetry]);

  if (!employee) return null;

  const initials = employee.employeeName
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  // Shift calculation (450 minutes = 7h 30m required shift; 480 minutes = 8h 00m standard target)
  const REQUIRED_SHIFT_MINUTES = 450;
  const workedMinutes = employee.totalMinutes || 0;
  const shiftProgressPercent = Math.min(100, Math.round((workedMinutes / REQUIRED_SHIFT_MINUTES) * 100));
  const remainingMinutes = Math.max(0, REQUIRED_SHIFT_MINUTES - workedMinutes);
  const remainingFormatted = `${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}m`;

  const isLate = (employee.lateMinutes ?? 0) > 0 || employee.isLate;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/60 backdrop-blur-md transition-opacity animate-fade-in cursor-pointer"
        aria-hidden="true"
      />

      {/* Slide-over Drawer Panel */}
      <div className="fixed inset-y-0 right-0 flex max-w-full pl-6 pointer-events-none">
        <div className="w-screen max-w-2xl pointer-events-auto bg-[#0A0E17] border-l border-white/10 shadow-2xl flex flex-col animate-slide-in-right">
          {/* Top Bar / Header */}
          <div className="flex items-center justify-between border-b border-white/8 px-6 py-4 bg-slate-950/60 backdrop-blur-xl">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Workforce Intelligence Profile
              </span>
            </div>
            <button
              onClick={onClose}
              type="button"
              className="rounded-xl border border-white/10 bg-slate-900/80 p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition cursor-pointer"
              title="Close (Esc)"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Drawer Body */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* Employee Hero Card */}
            <div className="glass-panel-elevated rounded-2xl p-5 relative overflow-hidden border border-white/12">
              {/* Subtle ambient accent glow */}
              <div className="absolute top-0 right-0 -mr-16 -mt-16 h-48 w-48 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-slate-900 border border-indigo-400/30 text-lg font-black text-white shadow-xl">
                    {initials}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-lg font-black text-white tracking-tight truncate">
                        {employee.employeeName}
                      </h2>
                      {employee.employeeNumber && (
                        <span className="rounded bg-indigo-500/20 px-2 py-0.5 text-xs font-mono font-bold text-indigo-300 border border-indigo-500/30">
                          {employee.employeeNumber}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-medium text-slate-400 mt-0.5">{employee.role}</p>
                    <div className="flex items-center gap-2 mt-2 text-[11px] text-slate-400">
                      <span className="flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        {employee.presenceSource ? `via ${employee.presenceSource}` : 'App / Workstation'}
                      </span>
                      <span>•</span>
                      <span className="text-emerald-400 font-semibold">Office Wi-Fi Verified</span>
                    </div>
                  </div>
                </div>

                {/* Status Badges */}
                <div className="flex sm:flex-col items-start sm:items-end gap-2 shrink-0">
                  <Badge
                    tone={
                      employee.status === 'IN_OFFICE'
                        ? 'ok'
                        : employee.status === 'GRACE_PERIOD'
                        ? 'warn'
                        : employee.status === 'AWAY'
                        ? 'muted'
                        : 'dim'
                    }
                    dot
                    size="md"
                  >
                    {employee.statusLabel || employee.status}
                  </Badge>

                  {isLate && (
                    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30 shadow-[0_0_10px_rgba(244,63,94,0.2)]">
                      <span>⚠️</span> Late (+{employee.lateMinutes}m)
                    </span>
                  )}

                  {employee.onBreak && (
                    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.2)]">
                      <span>☕</span> On Break ({employee.activeBreakMinutes ?? 0}m)
                    </span>
                  )}
                </div>
              </div>

              {/* Policy Warning Callout if Late */}
              {isLate && (
                <div className="mt-4 flex items-center justify-between rounded-xl bg-rose-500/10 border border-rose-500/25 px-3.5 py-2 text-xs text-rose-300">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">⚠️</span>
                    <div>
                      <strong className="font-semibold">Late Arrival Policy Exception:</strong> Arrived at{' '}
                      <span className="font-mono text-white">{employee.firstCheckIn}</span> (Official window opens 11:00 AM).
                    </div>
                  </div>
                  <span className="font-mono font-bold text-rose-400 shrink-0">
                    +{employee.lateMinutes}m deficit
                  </span>
                </div>
              )}

              {/* Shift Target Progress Bar */}
              <div className="mt-4 pt-4 border-t border-white/8">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                    <span>⏱️</span> Daily Shift Target (7h 30m / day)
                  </span>
                  <span className="font-mono font-bold text-emerald-400">
                    {employee.timeWorkedFormatted}{' '}
                    <span className="text-slate-400 font-normal">({shiftProgressPercent}%)</span>
                  </span>
                </div>
                <div className="h-2.5 w-full rounded-full bg-slate-800/80 overflow-hidden border border-white/5 p-0.5">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      shiftProgressPercent >= 100
                        ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                        : 'bg-gradient-to-r from-indigo-500 to-emerald-400'
                    }`}
                    style={{ width: `${Math.max(4, shiftProgressPercent)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1.5">
                  <span>Target: 7h 30m required</span>
                  <span>
                    {remainingMinutes > 0 ? (
                      <span className="text-amber-400 font-medium">⏳ {remainingFormatted} remaining</span>
                    ) : (
                      <span className="text-emerald-400 font-bold">✅ Target Achieved</span>
                    )}
                  </span>
                </div>
              </div>
            </div>

            {/* Quick Metrics Grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="glass-panel rounded-xl p-3 text-center">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 block mb-1">
                  First In
                </span>
                <span className={`text-sm font-extrabold tnum ${isLate ? 'text-rose-400 font-bold' : 'text-white'}`}>
                  {employee.firstCheckIn || '—'}
                </span>
                <span className="text-[10px] text-slate-400 block mt-0.5">Office Arrival</span>
              </div>

              <div className="glass-panel rounded-xl p-3 text-center">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 block mb-1">
                  Last Active
                </span>
                <span className="text-sm font-extrabold text-white tnum">
                  {employee.lastActiveTime || '—'}
                </span>
                <span className="text-[10px] text-slate-400 block mt-0.5">Network Ping</span>
              </div>

              <div className="glass-panel rounded-xl p-3 text-center">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 block mb-1">
                  Break Taken
                </span>
                <span className="text-sm font-extrabold text-amber-300 tnum">
                  {employee.breakMinutes ? `${employee.breakMinutes}m` : '0m'}
                </span>
                <span className="text-[10px] text-slate-400 block mt-0.5">of 30m permitted</span>
              </div>

              <div className="glass-panel rounded-xl p-3 text-center">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 block mb-1">
                  Daily Deficit
                </span>
                <span className={`text-sm font-extrabold tnum ${((employee.dailyDeficitMinutes ?? 0) > 0 || isLate) ? 'text-rose-400' : 'text-slate-400'}`}>
                  {employee.dailyDeficitMinutes ? `${employee.dailyDeficitMinutes}m` : (isLate ? `+${employee.lateMinutes}m` : '0m')}
                </span>
                <span className="text-[10px] text-slate-400 block mt-0.5">Accumulated</span>
              </div>
            </div>

            {/* Navigation Tabs within Drawer */}
            <div className="flex border-b border-white/10 gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('sessions')}
                className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition-all cursor-pointer ${
                  activeTab === 'sessions'
                    ? 'border-indigo-500 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                🕒 Work Sessions ({employee.sessions?.length || 0})
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('workstation')}
                className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'workstation'
                    ? 'border-indigo-500 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                💻 Workstation Telemetry
                {workstation && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('apps')}
                className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'apps'
                    ? 'border-indigo-500 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                📊 App Activity ({apps.length})
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('policy')}
                className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition-all cursor-pointer ${
                  activeTab === 'policy'
                    ? 'border-indigo-500 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                ⚖️ Policy & Deficit
              </button>
            </div>

            {/* Tab 1: Work Sessions Timeline */}
            {activeTab === 'sessions' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Recorded Presence Intervals Today ({employee.date})</span>
                  <span className="text-emerald-400 font-semibold">{employee.timeWorkedFormatted} total</span>
                </div>

                {(!employee.sessions || employee.sessions.length === 0) ? (
                  <div className="glass-panel rounded-2xl p-8 text-center text-slate-400 text-xs">
                    <p>No active presence sessions recorded for today yet.</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {employee.sessions.map((sess, idx) => (
                      <div
                        key={`${sess.from}-${idx}`}
                        className="glass-panel rounded-xl p-3.5 flex items-center justify-between text-xs border border-white/5 hover:border-white/15 transition"
                      >
                        <div className="flex items-center gap-3">
                          <div className={`h-8 w-8 rounded-lg flex items-center justify-center font-bold text-xs ${
                            sess.open ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-300'
                          }`}>
                            #{idx + 1}
                          </div>
                          <div>
                            <div className="font-semibold text-white flex items-center gap-2">
                              <span className="font-mono">{sess.from}</span>
                              <span className="text-slate-400">→</span>
                              <span className="font-mono">{sess.to}</span>
                              {sess.open && (
                                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-400 border border-emerald-500/30 animate-pulse">
                                  Live Now
                                </span>
                              )}
                            </div>
                            <span className="text-[11px] text-slate-400">Continuous in-office presence</span>
                          </div>
                        </div>

                        <div className="text-right">
                          <span className="font-extrabold text-emerald-400 font-mono text-sm block">
                            {sess.duration}
                          </span>
                          <span className="text-[10px] text-slate-400">Session length</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Tab 2: Workstation & Hardware */}
            {activeTab === 'workstation' && (
              <div className="space-y-4">
                {loadingTelemetry ? (
                  <div className="glass-panel rounded-2xl p-8 text-center">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent mx-auto mb-2" />
                    <span className="text-xs text-slate-400">Loading workstation telemetry…</span>
                  </div>
                ) : workstation ? (
                  <div className="space-y-4">
                    <div className="glass-panel rounded-2xl p-4.5 border border-white/10 space-y-4">
                      <div className="flex items-center justify-between pb-3 border-b border-white/8">
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-bold text-white">{workstation.model || 'Workstation Agent'}</h4>
                            <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-slate-300">
                              {workstation.platform || 'Desktop'}
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 mt-0.5">{workstation.label || 'Assigned Work Laptop'}</p>
                        </div>
                        <Badge
                          tone={
                            workstation.status === 'ACTIVE'
                              ? 'ok'
                              : workstation.status === 'ON_BREAK'
                              ? 'warn'
                              : 'muted'
                          }
                          dot
                          size="md"
                        >
                          {workstation.status}
                        </Badge>
                      </div>

                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <div className="bg-slate-900/60 p-3 rounded-xl border border-white/5">
                          <span className="text-[11px] text-slate-400 block mb-1">Active Typing / Mouse Time</span>
                          <span className="text-base font-extrabold text-emerald-400 font-mono">
                            {workstation.activeMinutes}m
                          </span>
                          <span className="text-[10px] text-slate-400 block mt-0.5">
                            {Math.round(((workstation.activeMinutes || 0) / Math.max(1, (workstation.activeMinutes || 0) + (workstation.idleMinutes || 0))) * 100)}% efficiency
                          </span>
                        </div>

                        <div className="bg-slate-900/60 p-3 rounded-xl border border-white/5">
                          <span className="text-[11px] text-slate-400 block mb-1">Idle / Lock Time</span>
                          <span className="text-base font-extrabold text-amber-300 font-mono">
                            {workstation.idleMinutes}m
                          </span>
                          <span className="text-[10px] text-slate-400 block mt-0.5">Lock state: {workstation.lockState || 'UNLOCKED'}</span>
                        </div>

                        <div className="bg-slate-900/60 p-3 rounded-xl border border-white/5">
                          <span className="text-[11px] text-slate-400 block mb-1">Connected Network</span>
                          <span className="text-xs font-semibold text-white block truncate">
                            {workstation.connectedBssid ? `Office AP (${workstation.connectedBssid})` : 'Office Subnet Verified'}
                          </span>
                          <span className="text-[10px] text-emerald-400 block mt-0.5">In-Office Hardware</span>
                        </div>

                        <div className="bg-slate-900/60 p-3 rounded-xl border border-white/5">
                          <span className="text-[11px] text-slate-400 block mb-1">Last Heartbeat</span>
                          <span className="text-xs font-mono font-semibold text-white block">
                            {workstation.lastHeartbeat || '—'}
                          </span>
                          <span className="text-[10px] text-slate-400 block mt-0.5">Real-time sync</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="glass-panel rounded-2xl p-8 text-center text-slate-400 text-xs space-y-3">
                    <p className="text-slate-300 font-medium">No Desktop Workstation Paired</p>
                    <p className="text-[11px] text-slate-400 max-w-sm mx-auto">
                      This staff member is currently checking in via the mobile app. You can pair their work laptop to monitor software usage and idle time.
                    </p>
                    {onOpenPairing && (
                      <Button
                        size="sm"
                        variant="accent"
                        onClick={() => onOpenPairing({ id: employee.employeeId, name: employee.employeeName })}
                      >
                        Generate Workstation Pairing Code
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Tab 3: Application Activity */}
            {activeTab === 'apps' && (
              <div className="space-y-4">
                <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/20 p-3 text-[11px] text-indigo-300 flex items-start gap-2">
                  <span className="text-sm">🔒</span>
                  <div>
                    <strong>Privacy-Preserving Application Tracking:</strong> Active application telemetry is only captured on enrolled office workstations during working hours. Monitoring automatically pauses when the employee is on break.
                  </div>
                </div>

                {loadingTelemetry ? (
                  <div className="glass-panel rounded-2xl p-8 text-center">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent mx-auto mb-2" />
                    <span className="text-xs text-slate-400">Loading application telemetry…</span>
                  </div>
                ) : apps.length === 0 ? (
                  <div className="glass-panel rounded-2xl p-8 text-center text-slate-400 text-xs">
                    <p>No application activity logged for today yet.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {apps.map((app) => {
                      const cat = getAppCategory(app.appName);
                      const appMins = app.activeMinutes || Math.round((app.activeSeconds || 0) / 60);

                      return (
                        <div
                          key={app.id || app.appName}
                          className="glass-panel rounded-xl p-3 flex items-center justify-between text-xs border border-white/5 hover:border-white/12 transition"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="text-lg shrink-0">{cat.icon}</span>
                            <div className="min-w-0">
                              <div className="font-bold text-white truncate">{app.appName}</div>
                              <span className={`inline-block px-1.5 py-0.2 rounded text-[10px] font-semibold border ${cat.badgeClass}`}>
                                {cat.label}
                              </span>
                            </div>
                          </div>

                          <div className="text-right shrink-0">
                            <span className="font-extrabold text-white font-mono text-sm block">
                              {appMins}m
                            </span>
                            <span className="text-[10px] text-slate-400">
                              {app.activeSeconds ? `${formatSeconds(app.activeSeconds)} active` : 'tracked'}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Tab 4: Policy & Deficit Breakdown */}
            {activeTab === 'policy' && (
              <div className="space-y-4">
                <div className="glass-panel rounded-2xl p-4.5 border border-white/10 space-y-3 text-xs">
                  <h4 className="font-bold text-white text-sm">Policy & Deficit Rules</h4>
                  <div className="space-y-2 text-slate-300 text-xs">
                    <div className="flex items-center justify-between py-1.5 border-b border-white/5">
                      <span className="text-slate-400">Official Office Hours Window</span>
                      <span className="font-semibold text-white">11:00 AM – 7:00 PM (Mon – Fri)</span>
                    </div>
                    <div className="flex items-center justify-between py-1.5 border-b border-white/5">
                      <span className="text-slate-400">Required Daily Working Time</span>
                      <span className="font-semibold text-white">7 hours 30 minutes / day</span>
                    </div>
                    <div className="flex items-center justify-between py-1.5 border-b border-white/5">
                      <span className="text-slate-400">Authorised Daily Break</span>
                      <span className="font-semibold text-amber-300">30 minutes</span>
                    </div>
                    <div className="flex items-center justify-between py-1.5 border-b border-white/5">
                      <span className="text-slate-400">Arrival Grace Period</span>
                      <span className="font-semibold text-white">5 minutes (up to 11:05 AM)</span>
                    </div>
                  </div>
                </div>

                <div className="glass-panel rounded-2xl p-4.5 border border-white/10 space-y-3 text-xs">
                  <h4 className="font-bold text-white text-sm">Today&apos;s Policy Flags & Deficit Breakdown</h4>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between bg-slate-900/60 p-2.5 rounded-xl border border-white/5">
                      <div>
                        <span className="font-semibold text-white block">Late Arrival Time</span>
                        <span className="text-[10px] text-slate-400">Arrival after 11:05 AM grace window</span>
                      </div>
                      <span className={`font-mono font-bold ${isLate ? 'text-rose-400 text-sm' : 'text-slate-400'}`}>
                        {isLate ? `+${employee.lateMinutes}m` : '0m'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between bg-slate-900/60 p-2.5 rounded-xl border border-white/5">
                      <div>
                        <span className="font-semibold text-white block">Excess Break Time</span>
                        <span className="text-[10px] text-slate-400">Break duration exceeding 30 minutes</span>
                      </div>
                      <span className={`font-mono font-bold ${(employee.excessBreakMinutes ?? 0) > 0 ? 'text-rose-400 text-sm' : 'text-slate-400'}`}>
                        {(employee.excessBreakMinutes ?? 0) > 0 ? `+${employee.excessBreakMinutes}m` : '0m'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between bg-slate-900/60 p-2.5 rounded-xl border border-white/5">
                      <div>
                        <span className="font-semibold text-white block">Approved HR Adjustments</span>
                        <span className="text-[10px] text-slate-400">Disputes approved by management</span>
                      </div>
                      <span className="font-mono font-bold text-emerald-400">
                        {employee.adjustmentMinutes ? `-${employee.adjustmentMinutes}m` : '0m'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Drawer Footer Actions */}
          <div className="border-t border-white/8 p-4 bg-slate-950/80 backdrop-blur-xl flex items-center justify-between gap-3">
            <div className="text-[11px] text-slate-400">
              Press <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[10px] border border-white/10">Esc</kbd> to exit
            </div>

            <div className="flex items-center gap-2">
              {onOpenPairing && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onOpenPairing({ id: employee.employeeId, name: employee.employeeName })}
                >
                  Pair Device
                </Button>
              )}
              <Button size="sm" variant="accent" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
