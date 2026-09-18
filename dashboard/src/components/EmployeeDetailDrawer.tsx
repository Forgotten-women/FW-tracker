'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import type { EmployeeDay, WorkstationItem, AppUsageItem, LiveFrameResponse } from '../lib/types';
import { Badge, Button } from './primitives';
import { ManualTimeModal } from './ManualTimeModal';

interface EmployeeDetailDrawerProps {
  employee: EmployeeDay | null;
  onClose: () => void;
  onOpenPairing?: (employee: { id: string; name: string }) => Promise<void> | void;
}

type DrawerTab = 'sessions' | 'workstation' | 'apps' | 'policy';

function formatSeconds(secs: number) {
  if (!secs || secs <= 0) return '0m';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function getAppCategory(appName: string, explicitCategory?: 'WEBSITE' | 'APPLICATION') {
  const lower = (appName || '').toLowerCase();

  if (lower.includes('youtube')) {
    return { label: 'Streaming (Web)', icon: '🎬', badgeClass: 'text-rose-400 bg-rose-500/10 border-rose-500/20' };
  }
  if (lower.includes('whatsapp') || lower.includes('web.whatsapp')) {
    return { label: 'WhatsApp Web', icon: '💬', badgeClass: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' };
  }
  if (lower.includes('github') || lower.includes('gitlab')) {
    return { label: 'Code Repository', icon: '🐙', badgeClass: 'text-purple-400 bg-purple-500/10 border-purple-500/20' };
  }
  if (lower.includes('chatgpt') || lower.includes('openai') || lower.includes('claude') || lower.includes('gemini')) {
    return { label: 'AI Portal', icon: '🤖', badgeClass: 'text-teal-400 bg-teal-500/10 border-teal-500/20' };
  }
  if (lower.includes('mail.google') || lower.includes('gmail')) {
    return { label: 'Email (Web)', icon: '✉️', badgeClass: 'text-red-400 bg-red-500/10 border-red-500/20' };
  }
  if (lower.includes('linkedin')) {
    return { label: 'Professional Network', icon: '💼', badgeClass: 'text-blue-400 bg-blue-500/10 border-blue-500/20' };
  }
  if (
    explicitCategory === 'WEBSITE' ||
    lower.includes('.com') ||
    lower.includes('.org') ||
    lower.includes('.net') ||
    lower.includes('.io') ||
    lower.includes('.app') ||
    lower.includes('.dev') ||
    lower.includes('.ai') ||
    lower.includes('.co')
  ) {
    return { label: 'Website / Portal', icon: '🌐', badgeClass: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20' };
  }
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
    return { label: 'Web Browser', icon: '🌍', badgeClass: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' };
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
  if (lower.includes('spotify') || lower.includes('netflix')) {
    return { label: 'Media', icon: '🎬', badgeClass: 'text-rose-400 bg-rose-500/10 border-rose-500/20' };
  }
  return { label: 'Application', icon: '💻', badgeClass: 'text-slate-400 bg-slate-500/10 border-slate-500/20' };
}

export function EmployeeDetailDrawer({ employee, onClose, onOpenPairing }: EmployeeDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<DrawerTab>('sessions');
  const [workstation, setWorkstation] = useState<WorkstationItem | null>(null);
  const [apps, setApps] = useState<AppUsageItem[]>([]);
  const [loadingTelemetry, setLoadingTelemetry] = useState(false);
  const [generatingPairing, setGeneratingPairing] = useState(false);
  const [isManualTimeModalOpen, setIsManualTimeModalOpen] = useState(false);

  // Live Screen View State
  const [isLiveScreenOpen, setIsLiveScreenOpen] = useState(false);
  const [liveFrame, setLiveFrame] = useState<LiveFrameResponse | null>(null);
  const [liveStreamLoading, setLiveStreamLoading] = useState(false);
  const [liveStreamError, setLiveStreamError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handlePairDevice = async () => {
    if (!onOpenPairing || !employee || generatingPairing) return;
    setGeneratingPairing(true);
    try {
      await onOpenPairing({ id: employee.employeeId, name: employee.employeeName });
    } finally {
      setGeneratingPairing(false);
    }
  };

  const handleCloseDrawer = useCallback(() => {
    if (isLiveScreenOpen && workstation?.deviceId) {
      api.stopLiveStream(workstation.deviceId).catch(() => {});
    }
    setIsLiveScreenOpen(false);
    setLiveFrame(null);
    setLiveStreamError(null);
    onClose();
  }, [isLiveScreenOpen, workstation?.deviceId, onClose]);

  // Close on Escape key press
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isLiveScreenOpen) {
          if (workstation?.deviceId) {
            api.stopLiveStream(workstation.deviceId).catch(() => {});
          }
          setIsLiveScreenOpen(false);
          setLiveFrame(null);
        } else {
          handleCloseDrawer();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCloseDrawer, isLiveScreenOpen, workstation?.deviceId]);

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

  // Live Screen Handlers
  const handleOpenLiveScreen = async () => {
    if (!workstation?.deviceId) return;
    setIsLiveScreenOpen(true);
    setLiveStreamLoading(true);
    setLiveStreamError(null);
    try {
      await api.requestLiveStream(workstation.deviceId);
    } catch (err: any) {
      console.error('Failed to request live stream:', err);
      setLiveStreamError(err?.message || 'Failed to start live stream');
    } finally {
      setLiveStreamLoading(false);
    }
  };

  const handleCloseLiveScreen = useCallback(() => {
    if (workstation?.deviceId) {
      api.stopLiveStream(workstation.deviceId).catch(() => {});
    }
    setIsLiveScreenOpen(false);
    setLiveFrame(null);
    setLiveStreamError(null);
    setIsFullscreen(false);
  }, [workstation?.deviceId]);

  // Poll live screen frame when modal is open
  useEffect(() => {
    if (!isLiveScreenOpen || !workstation?.deviceId) return;

    let isMounted = true;
    let pollCount = 0;
    const pollFrame = async () => {
      try {
        pollCount++;
        const frame = await api.fetchLiveFrame(workstation.deviceId);
        if (isMounted) {
          setLiveFrame(frame);
          if (frame.active) {
            setLiveStreamError(null);
          } else if (!frame.isBreak && pollCount > 35) {
            // Only timeout after at least ~10 seconds of polling with no active frame
            setLiveStreamError('Live stream ended or timed out.');
          }
        }
      } catch (err: any) {
        if (isMounted) {
          console.error('Error fetching live frame:', err);
        }
      }
    };

    pollFrame();
    const interval = setInterval(pollFrame, 300);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [isLiveScreenOpen, workstation?.deviceId]);

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

  // Separate website domains vs desktop software
  const isWebsiteApp = (app: AppUsageItem) => {
    if (app.category === 'WEBSITE') return true;
    if (app.category === 'APPLICATION') return false;
    const lower = (app.appName || '').toLowerCase();
    return (
      lower.includes('.com') ||
      lower.includes('.org') ||
      lower.includes('.net') ||
      lower.includes('.io') ||
      lower.includes('.app') ||
      lower.includes('.dev') ||
      lower.includes('.ai') ||
      lower.includes('.co') ||
      lower.includes('.gov') ||
      lower.includes('youtube') ||
      lower.includes('github') ||
      lower.includes('whatsapp') ||
      lower.includes('localhost')
    );
  };

  const websiteItems = apps.filter(isWebsiteApp);
  const desktopItems = apps.filter((a) => !isWebsiteApp(a));

  const totalWebSeconds = websiteItems.reduce((acc, a) => acc + (a.activeSeconds || 0), 0);
  const totalDesktopSeconds = desktopItems.reduce((acc, a) => acc + (a.activeSeconds || 0), 0);

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        onClick={handleCloseDrawer}
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
              onClick={handleCloseDrawer}
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

              {/* Top Section: Identity & Status Badge */}
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0 flex-1">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-slate-900 border border-indigo-400/30 text-lg font-black text-white shadow-xl shadow-indigo-950/50">
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <h2 className="text-xl font-black text-white tracking-tight">
                        {employee.employeeName}
                      </h2>
                      {employee.employeeNumber && (
                        <span className="shrink-0 rounded-lg bg-indigo-500/20 px-2 py-0.5 text-xs font-mono font-bold text-indigo-300 border border-indigo-500/30">
                          {employee.employeeNumber}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap mt-1">
                      <span className="text-xs font-medium text-slate-300">{employee.role}</span>
                      <span className="text-slate-600">•</span>
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 whitespace-nowrap">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        {employee.presenceSource ? `via ${employee.presenceSource}` : 'App / Workstation'}
                      </span>
                      <span className="text-slate-600">•</span>
                      <span className="text-[11px] text-emerald-400 font-semibold whitespace-nowrap">
                        Office Wi-Fi Verified
                      </span>
                    </div>
                  </div>
                </div>

                {/* Primary Status Badge Top Right */}
                <div className="shrink-0">
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
                </div>
              </div>

              {/* Actions & Alerts Toolbar */}
              <div className="mt-4 pt-3.5 border-t border-white/8 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Live Screen Quick Button */}
                  {workstation?.deviceId && (
                    <button
                      type="button"
                      onClick={handleOpenLiveScreen}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-red-600 via-rose-600 to-red-700 hover:from-red-500 hover:to-rose-500 px-3.5 py-1.5 text-xs font-bold text-white shadow-lg shadow-rose-950/40 border border-rose-400/30 transition-all duration-200 cursor-pointer active:scale-95"
                      title="Real-time ephemeral live screen feed"
                    >
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-300 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
                      </span>
                      <span>📹 Live Screen</span>
                    </button>
                  )}

                  {/* HR Direct Manual Time Button */}
                  <button
                    type="button"
                    onClick={() => setIsManualTimeModalOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-200 border border-indigo-500/30 px-3.5 py-1.5 text-xs font-bold transition-all duration-200 cursor-pointer active:scale-95 shadow-sm"
                    title="HR Direct Attendance & Time Adjustment"
                  >
                    <span>⏱️ Add Manual Time</span>
                  </button>
                </div>

                {/* Contextual Badges (Late / Break) */}
                <div className="flex items-center gap-2 flex-wrap">
                  {isLate && (
                    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30 shadow-[0_0_10px_rgba(244,63,94,0.2)] whitespace-nowrap">
                      <span>⚠️</span> Late (+{employee.lateMinutes}m)
                    </span>
                  )}

                  {employee.onBreak && (
                    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.2)] whitespace-nowrap">
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
                📊 App & Web Activity ({apps.length})
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
                      <div className="flex items-center justify-between pb-3 border-b border-white/8 flex-wrap gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-bold text-white">{workstation.model || 'Workstation Agent'}</h4>
                            <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-slate-300">
                              {workstation.platform || 'Desktop'}
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 mt-0.5">{workstation.label || 'Assigned Work Laptop'}</p>
                        </div>
                        <div className="flex items-center gap-2">
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

                          {workstation.deviceId && (
                            <button
                              type="button"
                              onClick={handleOpenLiveScreen}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 px-2.5 py-1 text-xs font-semibold transition cursor-pointer"
                            >
                              <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
                              <span>View Live Screen</span>
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <div className="bg-slate-900/60 p-3 rounded-xl border border-white/5">
                          <span className="text-[11px] text-slate-400 block mb-1">Active Typing / Mouse Time</span>
                          <span className="text-base font-extrabold text-emerald-400 font-mono">
                            {workstation.activeMinutes}m
                          </span>
                          {(workstation.unverifiedMinutes || 0) > 0 ? (
                            <span className="text-[10px] text-amber-300 block mt-1 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 font-medium">
                              Verified Office: {workstation.verifiedActiveMinutes || 0}m • Remote/Hotspot: {workstation.unverifiedMinutes}m
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400 block mt-0.5">
                              {Math.round(((workstation.activeMinutes || 0) / Math.max(1, (workstation.activeMinutes || 0) + (workstation.idleMinutes || 0))) * 100)}% efficiency (Verified Office)
                            </span>
                          )}
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

            {/* Tab 3: Application & Browsing Activity */}
            {activeTab === 'apps' && (
              <div className="space-y-5">
                <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/20 p-3 text-[11px] text-indigo-300 flex items-start gap-2">
                  <span className="text-sm">🔒</span>
                  <div>
                    <strong>Domain & Software Telemetry:</strong> Active window titles and browser URLs are inspected natively during office hours. Telemetry pauses automatically during official breaks.
                  </div>
                </div>

                {loadingTelemetry ? (
                  <div className="glass-panel rounded-2xl p-8 text-center">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent mx-auto mb-2" />
                    <span className="text-xs text-slate-400">Loading application & browsing telemetry…</span>
                  </div>
                ) : apps.length === 0 ? (
                  <div className="glass-panel rounded-2xl p-8 text-center text-slate-400 text-xs">
                    <p>No software or browsing activity logged for today yet.</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {/* Section 1: Websites & Web Services */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-base">🌐</span>
                          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                            Websites Visited Today ({websiteItems.length})
                          </h4>
                        </div>
                        <span className="text-[11px] font-mono text-cyan-400 font-semibold">
                          {formatSeconds(totalWebSeconds)} active browsing
                        </span>
                      </div>

                      {websiteItems.length === 0 ? (
                        <div className="glass-panel rounded-xl p-4 text-center text-slate-500 text-xs">
                          No direct website domains recorded yet.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {websiteItems.map((app) => {
                            const cat = getAppCategory(app.appName, app.category);
                            const appMins = app.activeMinutes || Math.round((app.activeSeconds || 0) / 60);
                            const webShare = totalWebSeconds > 0 ? Math.min(100, Math.round(((app.activeSeconds || 0) / totalWebSeconds) * 100)) : 0;

                            return (
                              <div
                                key={app.id || app.appName}
                                className="glass-panel rounded-xl p-3 flex items-center justify-between text-xs border border-white/5 hover:border-cyan-500/30 transition"
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <span className="text-lg shrink-0">{cat.icon}</span>
                                  <div className="min-w-0">
                                    <div className="font-bold text-white font-mono truncate text-xs">
                                      {app.appName}
                                    </div>
                                    <span className={`inline-block px-1.5 py-0.2 rounded text-[10px] font-semibold border ${cat.badgeClass}`}>
                                      {cat.label}
                                    </span>
                                  </div>
                                </div>

                                <div className="text-right shrink-0">
                                  <div className="flex items-center gap-2 justify-end">
                                    <span className="font-extrabold text-cyan-300 font-mono text-sm">
                                      {appMins}m
                                    </span>
                                    <span className="text-[10px] text-slate-500 font-mono">
                                      ({webShare}%)
                                    </span>
                                  </div>
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

                    {/* Section 2: Desktop Software */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-base">💻</span>
                          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                            Desktop Software Used Today ({desktopItems.length})
                          </h4>
                        </div>
                        <span className="text-[11px] font-mono text-emerald-400 font-semibold">
                          {formatSeconds(totalDesktopSeconds)} desktop runtime
                        </span>
                      </div>

                      {desktopItems.length === 0 ? (
                        <div className="glass-panel rounded-xl p-4 text-center text-slate-500 text-xs">
                          No desktop application sessions logged yet.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {desktopItems.map((app) => {
                            const cat = getAppCategory(app.appName, app.category);
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
                  disabled={generatingPairing}
                  onClick={handlePairDevice}
                >
                  {generatingPairing ? (
                    <span className="flex items-center gap-1.5">
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-transparent" />
                      <span>Generating Key…</span>
                    </span>
                  ) : (
                    'Pair Device'
                  )}
                </Button>
              )}
              <Button size="sm" variant="accent" onClick={handleCloseDrawer}>
                Close
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Real-time Workstation Live Screen Modal */}
      {isLiveScreenOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in">
          <div
            className={`w-full ${
              isFullscreen ? 'max-w-7xl h-[95vh]' : 'max-w-4xl max-h-[90vh]'
            } flex flex-col rounded-2xl bg-slate-950 border border-white/15 shadow-2xl overflow-hidden transition-all duration-300`}
          >
            {/* Live Modal Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10 bg-slate-900/90">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500" />
                  </span>
                  <span className="text-xs font-black tracking-wider uppercase text-rose-400 font-mono">
                    LIVE WORKSTATION MONITOR
                  </span>
                </div>
                <span className="text-slate-500">•</span>
                <div className="text-xs font-bold text-white truncate">
                  {employee.employeeName}
                </div>
                {workstation?.model && (
                  <span className="hidden sm:inline-block text-[11px] font-mono text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded border border-white/5">
                    {workstation.model}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsFullscreen(!isFullscreen)}
                  className="px-2.5 py-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer text-xs font-semibold border border-white/5"
                  title={isFullscreen ? 'Exit Fullscreen' : 'Expand View'}
                >
                  {isFullscreen ? '⤓ Normal' : '⤢ Expand'}
                </button>
                <button
                  type="button"
                  onClick={handleCloseLiveScreen}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
                  title="Close Live Screen"
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Live Stream Viewport */}
            <div className="flex-1 bg-black flex items-center justify-center p-4 min-h-[380px] relative overflow-hidden">
              {/* Privacy Barrier (Break Mode) */}
              {liveFrame?.isBreak ? (
                <div className="max-w-md text-center p-8 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 space-y-3 shadow-2xl animate-fade-in">
                  <div className="text-4xl">☕</div>
                  <h3 className="text-base font-bold text-white">Employee Currently on Break</h3>
                  <p className="text-xs text-amber-300/90 leading-relaxed">
                    {liveFrame.breakMessage || 'Workstation screen capture is automatically suspended at the hardware level during official breaks to protect privacy.'}
                  </p>
                  <div className="inline-flex items-center gap-1.5 text-[11px] font-mono text-amber-400/80 bg-amber-950/40 px-3 py-1 rounded-full border border-amber-500/20">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                    <span>Stream resumes automatically once break ends</span>
                  </div>
                </div>
              ) : (liveFrame?.frameBase64 && (liveFrame.frameBase64.startsWith('data:') || liveFrame.frameBase64.startsWith('/9j/') || liveFrame.frameBase64.startsWith('iVBOR')) && liveFrame.frameBase64.length > 200) ? (
                <div className="relative max-h-full max-w-full flex items-center justify-center">
                  <img
                    src={
                      liveFrame.frameBase64.startsWith('data:')
                        ? liveFrame.frameBase64
                        : `data:image/jpeg;base64,${liveFrame.frameBase64}`
                    }
                    alt={`Real-time screen of ${employee.employeeName}`}
                    className="rounded-lg shadow-2xl object-contain max-h-[72vh] w-auto max-w-full border border-white/10"
                    onError={() => {
                      setLiveStreamError('Workstation screen frame could not be decoded.');
                    }}
                  />
                  <div className="absolute top-2 left-2 flex items-center gap-2 bg-black/75 backdrop-blur-md px-2.5 py-1 rounded-md text-[10px] font-mono text-slate-300 border border-white/10">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span>STREAMING LIVE</span>
                    {liveFrame.lastFrameAt && (
                      <span className="text-slate-400">
                        ({Math.max(0, Math.round((Date.now() - liveFrame.lastFrameAt) / 1000))}s ago)
                      </span>
                    )}
                  </div>

                  {liveFrame.lastFrameAt && (Date.now() - liveFrame.lastFrameAt > 4000) && (
                    <div className="absolute bottom-4 inset-x-4 max-w-md mx-auto flex items-center justify-between p-3 rounded-xl bg-amber-950/90 border border-amber-500/40 text-amber-200 shadow-2xl backdrop-blur-md animate-fade-in">
                      <div className="flex items-center gap-2 text-xs">
                        <span>⚠️</span>
                        <span>Frame delivery paused ({Math.round((Date.now() - liveFrame.lastFrameAt) / 1000)}s ago).</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleOpenLiveScreen}
                        className="px-2.5 py-1 rounded-lg bg-amber-500 text-slate-950 font-bold text-[11px] hover:bg-amber-400 transition cursor-pointer"
                      >
                        Reconnect
                      </button>
                    </div>
                  )}
                </div>
              ) : liveStreamLoading || (isLiveScreenOpen && !liveStreamError) ? (
                <div className="text-center space-y-3 p-8 animate-fade-in">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-rose-500 border-t-transparent mx-auto" />
                  <p className="text-sm font-semibold text-white">Connecting to workstation agent…</p>
                  <p className="text-xs text-slate-400 max-w-xs mx-auto">
                    Awaiting live ephemeral frame from employee laptop. The desktop agent polls every 2-3 seconds.
                  </p>
                </div>
              ) : (
                <div className="text-center space-y-3 p-8 animate-fade-in">
                  <div className="text-3xl">⚠️</div>
                  <p className="text-sm font-semibold text-rose-400">
                    {liveStreamError || 'No live screen feed available.'}
                  </p>
                  <button
                    type="button"
                    onClick={handleOpenLiveScreen}
                    className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition cursor-pointer"
                  >
                    Retry Connection
                  </button>
                </div>
              )}
            </div>

            {/* Live Modal Footer */}
            <div className="px-5 py-3 border-t border-white/10 bg-slate-950 flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-slate-400">
              <div className="flex items-center gap-2">
                <span className="text-emerald-400">🔒</span>
                <span>
                  <strong>Zero-Storage Protocol:</strong> Ephemeral in-memory frames only. Zero screenshots or recordings are saved to disk or database.
                </span>
              </div>
              <Button size="sm" variant="secondary" onClick={handleCloseLiveScreen}>
                Close Viewer
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Time Entry Modal */}
      <ManualTimeModal
        isOpen={isManualTimeModalOpen}
        onClose={() => setIsManualTimeModalOpen(false)}
        employees={[{ id: employee.employeeId, name: employee.employeeName }]}
        defaultEmployeeId={employee.employeeId}
        defaultDate={employee.date}
        onSuccess={() => {
          if (employee?.employeeId) {
            loadTelemetry(employee.employeeId);
          }
        }}
      />
    </div>
  );
}
