'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import type { EmployeeDay, WorkstationItem, AppUsageItem, LiveFrameResponse, ScreenshotItem, EmployeeScreenshotsResponse } from '../lib/types';
import { Badge, Button } from './primitives';
import { ManualTimeModal } from './ManualTimeModal';

interface EmployeeDetailDrawerProps {
  employee: EmployeeDay | null;
  onClose: () => void;
  onOpenPairing?: (employee: { id: string; name: string }) => Promise<void> | void;
  onRefresh?: () => void;
}

type DrawerTab = 'sessions' | 'workstation' | 'apps' | 'policy' | 'screenshots';

function formatBytes(bytes: number) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

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

export function EmployeeDetailDrawer({ employee, onClose, onOpenPairing, onRefresh }: EmployeeDetailDrawerProps) {
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

  // Screenshots & Surveillance State
  const [shotsData, setShotsData] = useState<EmployeeScreenshotsResponse | null>(null);
  const [shotsLoading, setShotsLoading] = useState(false);
  const [shotsError, setShotsError] = useState<string | null>(null);
  const [selectedShotDate, setSelectedShotDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [shotEnabled, setShotEnabled] = useState<boolean>(false);
  const [shotInterval, setShotInterval] = useState<number>(5);
  const [shotMode, setShotMode] = useState<'ACTIVE_ONLY' | 'CONTINUOUS'>('ACTIVE_ONLY');
  const [savingShotConfig, setSavingShotConfig] = useState<boolean>(false);
  const [shotConfigSuccess, setShotConfigSuccess] = useState<string | null>(null);
  const [lightboxShot, setLightboxShot] = useState<ScreenshotItem | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number>(0);
  const [selectedShotIds, setSelectedShotIds] = useState<Set<string>>(new Set());
  const [isDeletingShots, setIsDeletingShots] = useState<boolean>(false);

  const loadEmployeeScreenshots = useCallback(async (empId: string, dateStr: string) => {
    setShotsLoading(true);
    setShotsError(null);
    try {
      const res = await api.fetchEmployeeScreenshots(empId, dateStr);
      setShotsData(res);
      if (res.employee) {
        setShotEnabled(res.employee.screenshotEnabled);
        setShotInterval(res.employee.intervalMinutes || 5);
        setShotMode(res.employee.mode || 'ACTIVE_ONLY');
      }
    } catch (err: any) {
      setShotsError(err?.message || 'Failed to load screenshots');
    } finally {
      setShotsLoading(false);
    }
  }, []);

  const handleSaveScreenshotConfig = async () => {
    if (!employee?.employeeId) return;
    setSavingShotConfig(true);
    setShotConfigSuccess(null);
    try {
      await api.updateScreenshotConfig(employee.employeeId, {
        enabled: shotEnabled,
        intervalMinutes: shotInterval,
        mode: shotMode,
      });
      setShotConfigSuccess(
        shotEnabled
          ? `Screen surveillance activated! Capturing every ${shotInterval}m in ${shotMode === 'ACTIVE_ONLY' ? 'Active Work' : 'Continuous'} mode.`
          : 'Screenshot surveillance disabled for this employee.'
      );
      setTimeout(() => setShotConfigSuccess(null), 5000);
      loadEmployeeScreenshots(employee.employeeId, selectedShotDate);
    } catch (err: any) {
      alert('Failed to update screenshot config: ' + (err?.message || 'Unknown error'));
    } finally {
      setSavingShotConfig(false);
    }
  };

  const handleDeleteSingleShot = async (shotId: string) => {
    if (!confirm('Are you sure you want to permanently delete this screenshot from Supabase S3?')) return;
    try {
      await api.deleteScreenshots([shotId]);
      if (employee?.employeeId) {
        loadEmployeeScreenshots(employee.employeeId, selectedShotDate);
      }
      if (lightboxShot?.id === shotId) {
        setLightboxShot(null);
      }
    } catch (err: any) {
      alert('Failed to delete screenshot: ' + (err?.message || 'Unknown error'));
    }
  };

  const handleDeleteSelectedShots = async () => {
    if (selectedShotIds.size === 0) return;
    if (!confirm(`Permanently delete ${selectedShotIds.size} selected screenshot(s) from Supabase S3?`)) return;
    setIsDeletingShots(true);
    try {
      await api.deleteScreenshots(Array.from(selectedShotIds));
      setSelectedShotIds(new Set());
      if (employee?.employeeId) {
        loadEmployeeScreenshots(employee.employeeId, selectedShotDate);
      }
    } catch (err: any) {
      alert('Failed to delete screenshots: ' + (err?.message || 'Unknown error'));
    } finally {
      setIsDeletingShots(false);
    }
  };

  const handleToggleSelectShot = (shotId: string) => {
    setSelectedShotIds((prev) => {
      const next = new Set(prev);
      if (next.has(shotId)) next.delete(shotId);
      else next.add(shotId);
      return next;
    });
  };

  const handleSelectAllShots = () => {
    if (!shotsData?.screenshots) return;
    if (selectedShotIds.size === shotsData.screenshots.length) {
      setSelectedShotIds(new Set());
    } else {
      setSelectedShotIds(new Set(shotsData.screenshots.map((s) => s.id)));
    }
  };

  useEffect(() => {
    if (employee?.employeeId) {
      loadTelemetry(employee.employeeId);
      loadEmployeeScreenshots(employee.employeeId, selectedShotDate);
    }
  }, [employee?.employeeId, selectedShotDate, loadTelemetry, loadEmployeeScreenshots]);

  // Live Screen Handlers
  const handleOpenLiveScreen = async () => {
    if (!workstation?.deviceId) return;
    const confirmed = window.confirm(
      `Start live screen viewing for ${employee?.employeeName || 'this employee'}? ` +
        'Their workstation screen will be streamed to you in near real time until you close this view.',
    );
    if (!confirmed) return;
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
          } else if (!frame.isBreak && pollCount > 10) {
            // Only timeout after at least ~10 seconds of polling with no
            // active frame -- and then actually stop polling. This used to
            // only set an error message while leaving the interval running
            // indefinitely, so an admin who left this view open (or switched
            // tabs) kept hammering the backend/desktop agent with no cap for
            // as long as the drawer stayed open.
            setLiveStreamError('Live stream ended or timed out.');
            clearInterval(interval);
          }
        }
      } catch (err: any) {
        if (isMounted) {
          console.error('Error fetching live frame:', err);
        }
      }
    };

    pollFrame();
    // Matches the desktop agent's ~1 FPS capture rate (main.rs) -- polling
    // faster than frames are actually produced only burns extra Redis
    // commands/bandwidth (see backend/src/lib/liveFrame.js) for no benefit.
    const interval = setInterval(pollFrame, 1000);

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

                  {/* Screenshots Quick Button */}
                  <button
                    type="button"
                    onClick={() => setActiveTab('screenshots')}
                    className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-bold transition-all duration-200 cursor-pointer active:scale-95 shadow-sm ${
                      activeTab === 'screenshots'
                        ? 'bg-sky-500 text-white shadow-sky-500/30'
                        : 'bg-sky-600/20 hover:bg-sky-600/40 text-sky-200 border border-sky-500/30'
                    }`}
                    title="Configure screenshots & view capture gallery"
                  >
                    <span>📸 Screenshots</span>
                    {shotEnabled && (
                      <span className="h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
                    )}
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
            <div className="flex border-b border-white/10 gap-2 overflow-x-auto pb-0.5">
              <button
                type="button"
                onClick={() => setActiveTab('sessions')}
                className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition-all cursor-pointer whitespace-nowrap ${
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
                className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
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
                className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
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
                className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition-all cursor-pointer whitespace-nowrap ${
                  activeTab === 'policy'
                    ? 'border-indigo-500 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                ⚖️ Policy & Deficit
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('screenshots')}
                className={`pb-2.5 px-3 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
                  activeTab === 'screenshots'
                    ? 'border-sky-400 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                📸 Screenshots
                {shotEnabled ? (
                  <span className="rounded-full bg-sky-500/20 px-1.5 py-0.2 text-[9px] font-bold text-sky-300 border border-sky-500/30">
                    Active ({shotsData?.screenshots?.length || 0})
                  </span>
                ) : (
                  <span className="text-slate-500 text-[10px]">Off</span>
                )}
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

            {/* Tab 5: Screenshots & Surveillance Gallery */}
            {activeTab === 'screenshots' && (
              <div className="space-y-6">
                {/* 1. Surveillance Settings & Policy Card */}
                <div className="glass-panel rounded-2xl p-4.5 border border-white/10 space-y-4">
                  <div className="flex items-center justify-between pb-3 border-b border-white/8 flex-wrap gap-2">
                    <div>
                      <h4 className="text-sm font-bold text-white flex items-center gap-2">
                        <span>📸</span> Screen Surveillance Policy
                      </h4>
                      <p className="text-xs text-slate-400">
                        Periodic background screen capture configured for {employee.employeeName}.
                      </p>
                    </div>

                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={shotEnabled}
                        onChange={(e) => setShotEnabled(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sky-500 shadow-inner" />
                      <span className="ml-2 text-xs font-bold text-slate-300">
                        {shotEnabled ? (
                          <span className="text-sky-400 font-bold">Enabled</span>
                        ) : (
                          <span className="text-slate-500">Disabled</span>
                        )}
                      </span>
                    </label>
                  </div>

                  {shotConfigSuccess && (
                    <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-300 text-xs font-semibold animate-fade-in flex items-center gap-2">
                      <span>✅</span> {shotConfigSuccess}
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                        Capture Interval
                      </label>
                      <select
                        value={shotInterval}
                        onChange={(e) => setShotInterval(Number(e.target.value))}
                        disabled={!shotEnabled}
                        className="w-full bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-sky-500 disabled:opacity-50 cursor-pointer"
                      >
                        <option value="1">Every 1 Minute (High Frequency)</option>
                        <option value="2">Every 2 Minutes</option>
                        <option value="3">Every 3 Minutes</option>
                        <option value="5">Every 5 Minutes (Standard Recommended)</option>
                        <option value="10">Every 10 Minutes</option>
                        <option value="15">Every 15 Minutes</option>
                        <option value="30">Every 30 Minutes</option>
                        <option value="60">Every 1 Hour (Light Storage Footprint)</option>
                      </select>
                      <p className="text-[10px] text-slate-500 mt-1">
                        How frequently the agent captures the workstation screen.
                      </p>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                        Operating Mode
                      </label>
                      <div className="space-y-1.5">
                        <label className={`flex items-start gap-2.5 p-2 rounded-xl border cursor-pointer transition text-xs ${
                          shotMode === 'ACTIVE_ONLY'
                            ? 'bg-sky-500/10 border-sky-500/40 text-white'
                            : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700'
                        }`}>
                          <input
                            type="radio"
                            name="drawerShotMode"
                            checked={shotMode === 'ACTIVE_ONLY'}
                            onChange={() => setShotMode('ACTIVE_ONLY')}
                            disabled={!shotEnabled}
                            className="mt-0.5 text-sky-500 focus:ring-0"
                          />
                          <div>
                            <span className="font-bold block text-white text-xs">Active Work Only (Recommended)</span>
                            <span className="text-[10px] text-slate-400">Pauses on breaks, idle lock, and outside office hours</span>
                          </div>
                        </label>

                        <label className={`flex items-start gap-2.5 p-2 rounded-xl border cursor-pointer transition text-xs ${
                          shotMode === 'CONTINUOUS'
                            ? 'bg-sky-500/10 border-sky-500/40 text-white'
                            : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700'
                        }`}>
                          <input
                            type="radio"
                            name="drawerShotMode"
                            checked={shotMode === 'CONTINUOUS'}
                            onChange={() => setShotMode('CONTINUOUS')}
                            disabled={!shotEnabled}
                            className="mt-0.5 text-sky-500 focus:ring-0"
                          />
                          <div>
                            <span className="font-bold block text-white text-xs">Continuous During Shift</span>
                            <span className="text-[10px] text-slate-400">Captures on fixed interval throughout shift</span>
                          </div>
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end pt-2 border-t border-white/5">
                    <button
                      type="button"
                      disabled={savingShotConfig}
                      onClick={handleSaveScreenshotConfig}
                      className="px-4 py-2 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-xs font-bold text-white shadow-lg shadow-sky-950/40 border border-sky-400/30 transition-all cursor-pointer active:scale-95 disabled:opacity-50"
                    >
                      {savingShotConfig ? 'Saving Policy…' : 'Save Screenshot Settings'}
                    </button>
                  </div>
                </div>

                {/* 2. Gallery Header & Date Filter */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-slate-900/60 p-3.5 rounded-2xl border border-white/5">
                  <div className="flex items-center gap-3 flex-wrap">
                    <label className="text-xs font-semibold text-slate-300 flex items-center gap-2">
                      <span>📅 Date:</span>
                      <input
                        type="date"
                        value={selectedShotDate}
                        onChange={(e) => {
                          setSelectedShotDate(e.target.value);
                          if (employee?.employeeId) {
                            loadEmployeeScreenshots(employee.employeeId, e.target.value);
                          }
                        }}
                        className="bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1 text-xs text-white focus:outline-none focus:border-sky-500 cursor-pointer"
                      />
                    </label>

                    <button
                      type="button"
                      onClick={() => {
                        if (employee?.employeeId) {
                          loadEmployeeScreenshots(employee.employeeId, selectedShotDate);
                        }
                      }}
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer text-xs"
                      title="Refresh Gallery"
                    >
                      🔄
                    </button>

                    {shotsData && (
                      <span className="text-xs text-slate-400 font-mono">
                        {shotsData.screenshots?.length || 0} Captures ({formatBytes(
                          (shotsData.screenshots || []).reduce((acc, s) => acc + (s.fileSizeBytes || 0), 0)
                        )})
                      </span>
                    )}
                  </div>

                  {shotsData?.screenshots && shotsData.screenshots.length > 0 && (
                    <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                      <button
                        type="button"
                        onClick={handleSelectAllShots}
                        className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-semibold text-slate-300 hover:text-white transition cursor-pointer border border-white/5"
                      >
                        {selectedShotIds.size === shotsData.screenshots.length ? 'Deselect All' : 'Select All'}
                      </button>

                      {selectedShotIds.size > 0 && (
                        <button
                          type="button"
                          disabled={isDeletingShots}
                          onClick={handleDeleteSelectedShots}
                          className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/40 text-[11px] font-bold text-rose-300 border border-rose-500/30 transition cursor-pointer active:scale-95"
                        >
                          {isDeletingShots ? 'Deleting…' : `Delete (${selectedShotIds.size})`}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* 3. Screenshots Grid */}
                {shotsLoading ? (
                  <div className="py-16 text-center space-y-3">
                    <div className="h-7 w-7 animate-spin rounded-full border-2 border-sky-400 border-t-transparent mx-auto" />
                    <p className="text-xs text-slate-400">Loading workstation captures from Supabase S3…</p>
                  </div>
                ) : shotsError ? (
                  <div className="p-4 bg-rose-950/40 border border-rose-800/60 rounded-xl text-rose-300 text-xs">
                    {shotsError}
                  </div>
                ) : !shotsData?.screenshots || shotsData.screenshots.length === 0 ? (
                  <div className="py-16 text-center space-y-2 border border-dashed border-white/10 rounded-2xl glass-panel">
                    <div className="text-3xl">📷</div>
                    <h4 className="text-sm font-bold text-white">No Screenshots for {selectedShotDate}</h4>
                    <p className="text-xs text-slate-400 max-w-sm mx-auto">
                      {shotEnabled
                        ? 'Captures will appear here automatically as the desktop agent uploads periodic frames.'
                        : 'Screen surveillance is currently turned OFF. Toggle it ON above to begin capturing.'}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {shotsData.screenshots.map((shot, idx) => {
                      const isSelected = selectedShotIds.has(shot.id);
                      return (
                        <div
                          key={shot.id}
                          className={`group relative rounded-xl border overflow-hidden transition-all bg-slate-900/60 flex flex-col ${
                            isSelected
                              ? 'border-sky-400 ring-2 ring-sky-400/40'
                              : 'border-slate-800 hover:border-slate-700'
                          }`}
                        >
                          {/* Selection Checkbox */}
                          <div className="absolute top-2 left-2 z-10">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleSelectShot(shot.id)}
                              className="h-4 w-4 rounded border-slate-700 bg-slate-900/90 text-sky-500 focus:ring-0 cursor-pointer"
                            />
                          </div>

                          {/* Quick Delete Single Button */}
                          <div className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteSingleShot(shot.id);
                              }}
                              className="p-1 rounded-md bg-black/75 hover:bg-rose-900/90 text-slate-400 hover:text-rose-200 text-xs transition cursor-pointer"
                              title="Delete from S3"
                            >
                              🗑
                            </button>
                          </div>

                          {/* Thumbnail */}
                          <div
                            onClick={() => {
                              setLightboxShot(shot);
                              setLightboxIndex(idx);
                            }}
                            className="aspect-video w-full bg-black cursor-pointer relative overflow-hidden flex items-center justify-center"
                          >
                            <img
                              src={shot.imageUrl}
                              alt={`Capture at ${shot.displayTime}`}
                              loading="lazy"
                              className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-300"
                            />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                              <span className="p-1 rounded-lg bg-black/75 text-white text-[11px] font-semibold backdrop-blur-sm">
                                🔍 Expand
                              </span>
                            </div>
                          </div>

                          {/* Meta footer */}
                          <div className="p-2 flex-1 flex flex-col justify-between text-[11px] bg-slate-950/80">
                            <div className="flex items-center justify-between font-mono font-bold text-white">
                              <span>{shot.displayTime}</span>
                              <span className="text-[10px] text-slate-400 font-normal">{formatBytes(shot.fileSizeBytes)}</span>
                            </div>
                            <div className="text-[10px] text-slate-400 truncate mt-1" title={shot.windowTitle || shot.activeApp}>
                              <span className="truncate block font-mono">{shot.activeApp || 'Active Screen'}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
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

      {/* Full-Resolution Screenshot Lightbox Modal */}
      {lightboxShot && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in">
          <div className="relative w-full max-w-5xl h-[88vh] flex flex-col rounded-2xl bg-slate-950 border border-white/20 shadow-2xl overflow-hidden">
            {/* Header bar */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10 bg-slate-900/90">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-sm font-bold text-white flex items-center gap-2">
                  <span>📸</span> Workstation Capture
                </span>
                <span className="text-slate-500">•</span>
                <span className="text-xs font-mono font-bold text-sky-400">
                  {lightboxShot.displayTime} ({lightboxShot.dateKey})
                </span>
                <span className="text-slate-500">•</span>
                <span className="text-xs text-slate-400 truncate max-w-xs font-mono">
                  {lightboxShot.activeApp || 'Desktop'} {lightboxShot.windowTitle ? `— ${lightboxShot.windowTitle}` : ''}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 font-mono hidden sm:inline">
                  {formatBytes(lightboxShot.fileSizeBytes)}
                </span>

                <a
                  href={lightboxShot.imageUrl}
                  target="_blank"
                  rel="noreferrer"
                  download
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-semibold transition flex items-center gap-1 border border-white/5"
                  title="Open/Download full size"
                >
                  <span>⬇️</span> Download
                </a>

                <button
                  type="button"
                  onClick={() => handleDeleteSingleShot(lightboxShot.id)}
                  className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 text-xs font-bold transition border border-rose-500/30 cursor-pointer"
                  title="Delete from S3"
                >
                  🗑 Delete
                </button>

                <button
                  type="button"
                  onClick={() => setLightboxShot(null)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
                  title="Close (Esc)"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Image viewport */}
            <div className="flex-1 bg-black flex items-center justify-center relative overflow-hidden p-2">
              <img
                src={lightboxShot.imageUrl}
                alt={`Screenshot at ${lightboxShot.displayTime}`}
                className="max-h-full max-w-full object-contain rounded-lg shadow-2xl"
              />

              {/* Prev / Next Arrows */}
              {shotsData?.screenshots && shotsData.screenshots.length > 1 && (
                <>
                  {lightboxIndex > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        const nextIdx = lightboxIndex - 1;
                        setLightboxIndex(nextIdx);
                        setLightboxShot(shotsData.screenshots[nextIdx]);
                      }}
                      className="absolute left-6 p-3 rounded-full bg-black/60 hover:bg-black/90 text-white text-lg border border-white/20 transition cursor-pointer shadow-lg"
                      title="Previous"
                    >
                      ‹
                    </button>
                  )}

                  {lightboxIndex < shotsData.screenshots.length - 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        const nextIdx = lightboxIndex + 1;
                        setLightboxIndex(nextIdx);
                        setLightboxShot(shotsData.screenshots[nextIdx]);
                      }}
                      className="absolute right-6 p-3 rounded-full bg-black/60 hover:bg-black/90 text-white text-lg border border-white/20 transition cursor-pointer shadow-lg"
                      title="Next"
                    >
                      ›
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Lightbox Footer indicator */}
            <div className="px-5 py-2.5 border-t border-white/10 bg-slate-950 flex items-center justify-between text-xs text-slate-400 font-mono">
              <span>Device: {lightboxShot.deviceId || 'Workstation'}</span>
              <span>
                Image {lightboxIndex + 1} of {shotsData?.screenshots?.length || 0}
              </span>
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
          if (onRefresh) {
            onRefresh();
          }
        }}
      />
    </div>
  );
}
