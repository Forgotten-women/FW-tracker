'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import type {
  WorkstationItem,
  AppUsageItem,
  EmployeeAppBacklog,
  ScreenshotStorageStats,
  ScreenshotItem,
  EmployeeScreenshotsResponse,
} from '../lib/types';
import { Badge } from './primitives';

function formatAppDuration(seconds: number) {
  if (!seconds || seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s > 0 ? `${s}s` : ''}`.trim();
  if (m > 0) return `${m}m ${s > 0 ? `${s}s` : ''}`.trim();
  return `${s}s`;
}

function formatBytes(bytes: number) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
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
    return { label: 'AI Assistant', icon: '🤖', badgeClass: 'text-teal-400 bg-teal-500/10 border-teal-500/20' };
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
  if (lower.includes('code') || lower.includes('antigravity') || lower.includes('ide') || lower.includes('studio') || lower.includes('terminal') || lower.includes('git') || lower.includes('dbeaver') || lower.includes('postman')) {
    return { label: 'Development', icon: '⚡', badgeClass: 'text-sky-400 bg-sky-500/10 border-sky-500/20' };
  }
  if (lower.includes('chrome') || lower.includes('edge') || lower.includes('firefox') || lower.includes('browser') || lower.includes('safari') || lower.includes('brave')) {
    return { label: 'Web Browser', icon: '🌍', badgeClass: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' };
  }
  if (lower.includes('teams') || lower.includes('slack') || lower.includes('zoom') || lower.includes('meet') || lower.includes('outlook') || lower.includes('discord')) {
    return { label: 'Communication', icon: '💬', badgeClass: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' };
  }
  if (lower.includes('excel') || lower.includes('word') || lower.includes('docs') || lower.includes('sheets') || lower.includes('notion') || lower.includes('figma')) {
    return { label: 'Productivity', icon: '📊', badgeClass: 'text-amber-400 bg-amber-500/10 border-amber-500/20' };
  }
  if (lower.includes('spotify') || lower.includes('netflix')) {
    return { label: 'Media', icon: '🎬', badgeClass: 'text-rose-400 bg-rose-500/10 border-rose-500/20' };
  }
  return { label: 'Application', icon: '💻', badgeClass: 'text-slate-400 bg-slate-500/10 border-slate-500/20' };
}

export function WorkstationsPanel({
  onSelectEmployee,
}: {
  onSelectEmployee?: (employeeId: string) => void;
} = {}) {
  const [workstations, setWorkstations] = useState<WorkstationItem[]>([]);
  const [appUsage, setAppUsage] = useState<AppUsageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'workstations' | 'app_usage' | 'app_backlog'>('workstations');
  const [searchQuery, setSearchQuery] = useState('');

  // Screenshot Storage Stats State
  const [storageStats, setStorageStats] = useState<ScreenshotStorageStats | null>(null);
  const [isStorageModalOpen, setIsStorageModalOpen] = useState(false);
  const [retentionDaysInput, setRetentionDaysInput] = useState('30');
  const [quotaGbInput, setQuotaGbInput] = useState('10');
  const [storageSaving, setStorageSaving] = useState(false);
  const [storageMessage, setStorageMessage] = useState<string | null>(null);

  // Employee Screenshot Modal State
  const [selectedEmpForShots, setSelectedEmpForShots] = useState<{ id: string; name: string; model?: string } | null>(null);
  const [shotsModalTab, setShotsModalTab] = useState<'gallery' | 'settings'>('gallery');
  const [shotsData, setShotsData] = useState<EmployeeScreenshotsResponse | null>(null);
  const [selectedDateKey, setSelectedDateKey] = useState<string>('');
  const [shotsLoading, setShotsLoading] = useState(false);
  const [shotsError, setShotsError] = useState<string | null>(null);
  const [selectedShotIds, setSelectedShotIds] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState(false);

  // Lightbox State
  const [lightboxShot, setLightboxShot] = useState<ScreenshotItem | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number>(-1);

  // Per-Employee Screenshot Settings
  const [shotToggleEnabled, setShotToggleEnabled] = useState(false);
  const [shotIntervalMins, setShotIntervalMins] = useState(5);
  const [shotMode, setShotMode] = useState<'ACTIVE_ONLY' | 'CONTINUOUS'>('ACTIVE_ONLY');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSuccess, setSettingsSuccess] = useState<string | null>(null);

  // Backlog query state
  const [backlogEmployeeId, setBacklogEmployeeId] = useState('');
  const [backlogStartDate, setBacklogStartDate] = useState('');
  const [backlogEndDate, setBacklogEndDate] = useState('');
  const [backlogData, setBacklogData] = useState<EmployeeAppBacklog | null>(null);
  const [backlogLoading, setBacklogLoading] = useState(false);
  const [backlogError, setBacklogError] = useState<string | null>(null);

  const [expandedEmployees, setExpandedEmployees] = useState<Record<string, boolean>>({});

  const loadData = async () => {
    try {
      setLoading(true);
      const [wsRes, appRes, statsRes] = await Promise.all([
        api.fetchWorkstations(),
        api.fetchAppUsage(),
        api.fetchScreenshotStats().catch(() => null),
      ]);
      setWorkstations(wsRes.workstations || []);
      setAppUsage(appRes.appUsage || []);
      if (statsRes) {
        setStorageStats(statsRes);
        setRetentionDaysInput(String(statsRes.retentionDays || 30));
        setQuotaGbInput(String(statsRes.quotaGb || 10));
      }
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load workstation data');
    } finally {
      setLoading(false);
    }
  };

  const loadEmployeeScreenshots = useCallback(async (empId: string, dateKey?: string) => {
    setShotsLoading(true);
    setShotsError(null);
    setSelectedShotIds(new Set());
    try {
      const res = await api.fetchEmployeeScreenshots(empId, dateKey);
      setShotsData(res);
      setSelectedDateKey(res.dateKey);
      setShotToggleEnabled(res.employee.screenshotEnabled);
      setShotIntervalMins(res.employee.intervalMinutes || 5);
      setShotMode(res.employee.mode || 'ACTIVE_ONLY');
    } catch (err: any) {
      setShotsError(err?.message || 'Failed to load employee screenshots.');
    } finally {
      setShotsLoading(false);
    }
  }, []);

  const openScreenshotsModal = (emp: { id: string; name: string; model?: string }) => {
    setSelectedEmpForShots(emp);
    setShotsModalTab('gallery');
    setSettingsSuccess(null);
    loadEmployeeScreenshots(emp.id);
  };

  const closeScreenshotsModal = () => {
    setSelectedEmpForShots(null);
    setShotsData(null);
    setLightboxShot(null);
    loadData(); // Refresh storage stats
  };

  const handleToggleSelectShot = (id: string) => {
    setSelectedShotIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAllShots = () => {
    if (!shotsData?.screenshots) return;
    if (selectedShotIds.size === shotsData.screenshots.length) {
      setSelectedShotIds(new Set());
    } else {
      setSelectedShotIds(new Set(shotsData.screenshots.map(s => s.id)));
    }
  };

  const handleDeleteSelectedShots = async () => {
    if (selectedShotIds.size === 0 || !selectedEmpForShots) return;
    if (!confirm(`Are you sure you want to delete ${selectedShotIds.size} selected screenshot(s) permanently from Supabase S3?`)) return;

    setActionLoading(true);
    try {
      const res = await api.deleteScreenshots(Array.from(selectedShotIds));
      setSelectedShotIds(new Set());
      await loadEmployeeScreenshots(selectedEmpForShots.id, selectedDateKey);
      await loadData();
    } catch (err: any) {
      alert(err?.message || 'Failed to delete screenshots.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteEntireDay = async () => {
    if (!selectedEmpForShots || !selectedDateKey) return;
    if (!confirm(`Are you sure you want to purge ALL screenshots for ${selectedDateKey} permanently from Supabase S3?`)) return;

    setActionLoading(true);
    try {
      await api.bulkPurgeScreenshots({
        employeeId: selectedEmpForShots.id,
        dateKey: selectedDateKey,
      });
      await loadEmployeeScreenshots(selectedEmpForShots.id, selectedDateKey);
      await loadData();
    } catch (err: any) {
      alert(err?.message || 'Failed to purge day screenshots.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveScreenshotSettings = async () => {
    if (!selectedEmpForShots) return;
    setSettingsSaving(true);
    setSettingsSuccess(null);
    try {
      const res = await api.updateScreenshotConfig(selectedEmpForShots.id, {
        enabled: shotToggleEnabled,
        intervalMinutes: Number(shotIntervalMins),
        mode: shotMode,
      });
      setSettingsSuccess('✓ Configuration updated! Laptop will update monitoring on next heartbeat.');
      await loadData();
    } catch (err: any) {
      alert(err?.message || 'Failed to save settings.');
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleSaveStorageRetention = async (runPurgeNow = false) => {
    setStorageSaving(true);
    setStorageMessage(null);
    try {
      const res = await api.updateAutoRetention({
        retentionDays: parseInt(retentionDaysInput, 10) || 30,
        quotaGb: parseFloat(quotaGbInput) || 10,
        runPurgeNow,
      });
      setStorageMessage(`✓ Storage policy saved! ${runPurgeNow ? `Cleaned up ${res.purgedCount} old captures (${formatBytes(res.freedBytes)} freed).` : ''}`);
      await loadData();
    } catch (err: any) {
      alert(err?.message || 'Failed to update storage settings.');
    } finally {
      setStorageSaving(false);
    }
  };

  // Keyboard Navigation for Lightbox
  useEffect(() => {
    if (!lightboxShot || !shotsData?.screenshots) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        if (lightboxIndex < shotsData.screenshots.length - 1) {
          const nextIdx = lightboxIndex + 1;
          setLightboxIndex(nextIdx);
          setLightboxShot(shotsData.screenshots[nextIdx]);
        }
      } else if (e.key === 'ArrowLeft') {
        if (lightboxIndex > 0) {
          const prevIdx = lightboxIndex - 1;
          setLightboxIndex(prevIdx);
          setLightboxShot(shotsData.screenshots[prevIdx]);
        }
      } else if (e.key === 'Escape') {
        setLightboxShot(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxShot, lightboxIndex, shotsData?.screenshots]);

  const knownEmployees = React.useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const w of workstations) {
      if (w.employeeId && !map.has(w.employeeId)) {
        map.set(w.employeeId, { id: w.employeeId, name: w.employeeName });
      }
    }
    for (const a of appUsage) {
      if (a.employeeId && !map.has(a.employeeId)) {
        map.set(a.employeeId, { id: a.employeeId, name: a.employeeName });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [workstations, appUsage]);

  const handleQueryBacklog = async (empId?: string, sDate?: string, eDate?: string) => {
    const targetId = empId || backlogEmployeeId;
    if (!targetId) return;
    setBacklogLoading(true);
    setBacklogError(null);
    try {
      const res = await api.fetchEmployeeAppBacklog(
        targetId,
        sDate !== undefined ? sDate : backlogStartDate,
        eDate !== undefined ? eDate : backlogEndDate
      );
      setBacklogData(res);
    } catch (err: any) {
      setBacklogError(err?.message || 'Failed to fetch employee app backlog.');
    } finally {
      setBacklogLoading(false);
    }
  };

  const openEmployeeBacklog = (empId: string) => {
    setBacklogEmployeeId(empId);
    setActiveTab('app_backlog');
    handleQueryBacklog(empId);
  };

  useEffect(() => {
    loadData();
    // Not SSE-backed (unlike most other panels), so this is the only update
    // path -- kept well above 4s to limit Supabase read/egress volume for a
    // background admin view that doesn't need near-real-time refresh.
    const interval = setInterval(loadData, 45000);
    return () => clearInterval(interval);
  }, []);

  const activeCount = workstations.filter(w => w.status === 'ACTIVE').length;
  const inOfficeCount = workstations.filter(w => w.inOffice).length;
  const breakCount = workstations.filter(w => w.status === 'ON_BREAK' || w.status === 'AWAY' || w.status === 'IDLE').length;
  const totalAppsTracked = appUsage.length;

  const employeeGroups = React.useMemo(() => {
    const map = new Map<string, {
      employeeId: string;
      employeeName: string;
      totalSeconds: number;
      apps: AppUsageItem[];
      platform: string;
      deviceModel: string;
      lastActive: string;
      workstationActiveSeconds: number;
    }>();

    for (const app of appUsage) {
      const key = app.employeeId || app.employeeName;
      let group = map.get(key);
      if (!group) {
        group = {
          employeeId: app.employeeId,
          employeeName: app.employeeName,
          totalSeconds: 0,
          apps: [],
          platform: app.platform,
          deviceModel: app.deviceModel,
          lastActive: app.lastUsedAt,
          workstationActiveSeconds: app.workstationActiveSeconds || 0,
        };
        map.set(key, group);
      }
      if (app.workstationActiveSeconds && !group.workstationActiveSeconds) {
        group.workstationActiveSeconds = app.workstationActiveSeconds;
      }
      group.totalSeconds += (app.activeSeconds || 0);
      group.apps.push(app);
      if (app.lastUsedAt && (!group.lastActive || app.lastUsedAt > group.lastActive)) {
        group.lastActive = app.lastUsedAt;
      }
    }

    for (const group of map.values()) {
      group.apps.sort((a, b) => (b.activeSeconds || 0) - (a.activeSeconds || 0));
    }

    return Array.from(map.values()).sort((a, b) => b.totalSeconds - a.totalSeconds);
  }, [appUsage]);

  const filteredGroups = React.useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return employeeGroups;

    return employeeGroups
      .map(group => {
        const matchesEmp = group.employeeName.toLowerCase().includes(q);
        const matchingApps = group.apps.filter(a => a.appName.toLowerCase().includes(q));
        if (matchesEmp) return group;
        if (matchingApps.length > 0) {
          return {
            ...group,
            apps: matchingApps,
          };
        }
        return null;
      })
      .filter((g): g is NonNullable<typeof g> => g !== null);
  }, [employeeGroups, searchQuery]);

  const toggleEmployee = (key: string) => {
    setExpandedEmployees(prev => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const expandAll = () => {
    const all: Record<string, boolean> = {};
    for (const g of filteredGroups) {
      all[g.employeeId || g.employeeName] = true;
    }
    setExpandedEmployees(all);
  };

  const collapseAll = () => {
    setExpandedEmployees({});
  };

  const isExpanded = (key: string) => {
    if (searchQuery.trim().length > 0) return true;
    return !!expandedEmployees[key];
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            💻 Workstations & Surveillance Monitoring
          </h2>
          <p className="text-sm text-slate-400">
            Real-time active work tracking, periodic screenshot surveillance on Supabase S3, and software logs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsStorageModalOpen(true)}
            className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3.5 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <span>☁️</span> S3 Storage & Retention
          </button>
          <button
            onClick={loadData}
            disabled={loading}
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
          >
            <span>🔄</span> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-rose-950/40 border border-rose-800/60 rounded-xl text-rose-300 text-sm">
          {error}
        </div>
      )}

      {/* Supabase S3 Storage Usage Gauge Banner */}
      {storageStats && (
        <div className="glass-panel rounded-2xl p-4 border border-sky-500/20 bg-gradient-to-r from-sky-950/40 via-slate-900/60 to-slate-900/40">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-10 w-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-xl shrink-0">
                ☁️
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-sky-400">
                    Supabase S3 Screenshot Storage
                  </span>
                  <span className="text-[11px] font-mono text-slate-400">
                    ({storageStats.totalCount.toLocaleString()} captures stored)
                  </span>
                </div>
                <div className="mt-0.5 text-sm font-semibold text-white">
                  <span className="font-mono text-sky-300 font-bold">{formatBytes(storageStats.totalBytes)}</span>
                  <span className="text-slate-400 font-normal"> used of {storageStats.quotaGb} GB quota</span>
                  <span className="text-xs text-slate-400 ml-2 font-mono">({storageStats.usedPercentage}% capacity)</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 w-full md:w-72">
              <div className="flex-1 bg-slate-800 rounded-full h-2.5 overflow-hidden border border-white/5">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    storageStats.usedPercentage > 85
                      ? 'bg-rose-500'
                      : storageStats.usedPercentage > 60
                      ? 'bg-amber-500'
                      : 'bg-sky-400'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(2, storageStats.usedPercentage))}%` }}
                />
              </div>
              <button
                type="button"
                onClick={() => setIsStorageModalOpen(true)}
                className="px-2.5 py-1 rounded-lg bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 font-semibold text-xs border border-sky-500/30 transition cursor-pointer shrink-0"
              >
                Manage
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="glass-panel rounded-2xl p-4 border border-emerald-500/20 bg-emerald-500/5">
          <div className="text-xs font-semibold uppercase tracking-wider text-emerald-400">Active Workstations</div>
          <div className="mt-2 text-2xl font-bold text-white">{activeCount}</div>
          <div className="mt-1 text-[11px] text-slate-400">Currently active & typing</div>
        </div>

        <div className="glass-panel rounded-2xl p-4 border border-teal-500/20 bg-teal-500/5">
          <div className="text-xs font-semibold uppercase tracking-wider text-teal-400">In Office (Verified)</div>
          <div className="mt-2 text-2xl font-bold text-white">{inOfficeCount}</div>
          <div className="mt-1 text-[11px] text-slate-400">Connected to Office Wi-Fi</div>
        </div>

        <div className="glass-panel rounded-2xl p-4 border border-amber-500/20 bg-amber-500/5">
          <div className="text-xs font-semibold uppercase tracking-wider text-amber-400">Break / Idle / Away</div>
          <div className="mt-2 text-2xl font-bold text-white">{breakCount}</div>
          <div className="mt-1 text-[11px] text-slate-400">Paused or locked screen</div>
        </div>

        <div className="glass-panel rounded-2xl p-4 border border-indigo-500/20 bg-indigo-500/5">
          <div className="text-xs font-semibold uppercase tracking-wider text-indigo-400">Apps Tracked Today</div>
          <div className="mt-2 text-2xl font-bold text-white">{totalAppsTracked}</div>
          <div className="mt-1 text-[11px] text-slate-400">Software activity logs</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 gap-6">
        <button
          onClick={() => setActiveTab('workstations')}
          className={`pb-3 text-sm font-semibold transition-colors flex items-center gap-2 cursor-pointer ${
            activeTab === 'workstations'
              ? 'text-teal-400 border-b-2 border-teal-400'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          🖥️ Active Workstations ({workstations.length})
        </button>
        <button
          onClick={() => setActiveTab('app_usage')}
          className={`pb-3 text-sm font-semibold transition-colors flex items-center gap-2 cursor-pointer ${
            activeTab === 'app_usage'
              ? 'text-teal-400 border-b-2 border-teal-400'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          📊 Application & Software Usage ({appUsage.length})
        </button>
        <button
          onClick={() => {
            setActiveTab('app_backlog');
            if (backlogEmployeeId) {
              handleQueryBacklog(backlogEmployeeId);
            } else if (knownEmployees.length > 0) {
              setBacklogEmployeeId(knownEmployees[0].id);
              handleQueryBacklog(knownEmployees[0].id);
            }
          }}
          className={`pb-3 text-sm font-semibold transition-colors flex items-center gap-2 cursor-pointer ${
            activeTab === 'app_backlog'
              ? 'text-teal-400 border-b-2 border-teal-400'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          🗂️ Employee App Backlog
        </button>
      </div>

      {/* Tab: Workstations */}
      {activeTab === 'workstations' && (
        <div className="glass-panel rounded-2xl overflow-hidden border border-slate-800">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="bg-slate-900/80 text-xs font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Employee</th>
                  <th className="py-3 px-4">Device & OS</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Active Today</th>
                  <th className="py-3 px-4">Break / Idle</th>
                  <th className="py-3 px-4">📸 Screenshots</th>
                  <th className="py-3 px-4">Network & BSSID</th>
                  <th className="py-3 px-4">Last Seen</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {workstations.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-slate-500">
                      No desktop workstation sessions recorded today. Enrol a laptop using the Desktop Agent!
                    </td>
                  </tr>
                ) : (
                  workstations.map(ws => {
                    const empStats = storageStats?.employees.find(e => e.employeeId === ws.employeeId);
                    const isEnabled = empStats ? empStats.screenshotEnabled : false;
                    const interval = empStats ? empStats.intervalMinutes : 5;
                    const count = empStats ? empStats.shotCount : 0;

                    return (
                      <tr
                        key={ws.id}
                        onClick={() => ws.employeeId && onSelectEmployee?.(ws.employeeId)}
                        className="hover:bg-slate-800/40 transition-colors cursor-pointer group"
                        title="Click to view comprehensive telemetry profile"
                      >
                        <td className="py-3.5 px-4 font-medium text-slate-100">
                          <span className="group-hover:text-cyan-300 transition">{ws.employeeName}</span>
                          <div className="text-xs text-slate-400">{ws.employeeRole}</div>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="font-mono text-xs text-slate-200">{ws.model || 'Work Laptop'}</div>
                          <div className="text-xs text-slate-400 capitalize">{ws.platform} · {ws.label}</div>
                        </td>
                        <td className="py-3.5 px-4">
                          {ws.status === 'ACTIVE' ? (
                            <Badge tone="ok" dot>Active</Badge>
                          ) : ws.status === 'ON_BREAK' ? (
                            <Badge tone="warn">On Break</Badge>
                          ) : ws.status === 'AWAY' ? (
                            <Badge tone="warn">Locked (Away)</Badge>
                          ) : ws.status === 'IDLE' ? (
                            <Badge tone="warn">Idle (&gt;5m)</Badge>
                          ) : (
                            <Badge tone="muted">Offline</Badge>
                          )}
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="font-mono font-semibold text-emerald-400">
                            {Math.floor(ws.activeMinutes / 60)}h {ws.activeMinutes % 60}m
                          </div>
                          {ws.presenceMinutes != null && ws.presenceMinutes > 0 ? (
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              of {Math.floor(ws.presenceMinutes / 60)}h {ws.presenceMinutes % 60}m presence ({Math.min(100, Math.round((ws.activeMinutes / ws.presenceMinutes) * 100))}% active)
                            </div>
                          ) : (
                            <div className="text-[11px] text-slate-500 mt-0.5">Active typing/mousing</div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-xs text-slate-400">
                          Break: {ws.breakMinutes}m | Idle: {ws.idleMinutes}m
                        </td>
                        <td className="py-3.5 px-4">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (ws.employeeId) {
                                openScreenshotsModal({ id: ws.employeeId, name: ws.employeeName, model: ws.model });
                              }
                            }}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                              isEnabled
                                ? 'bg-sky-500/10 text-sky-300 border-sky-500/30 hover:bg-sky-500/20'
                                : 'bg-slate-800/60 text-slate-400 border-slate-700/60 hover:bg-slate-700/60'
                            }`}
                          >
                            <span>📸</span>
                            <span>{count > 0 ? `${count} shots` : 'Gallery'}</span>
                            <span className="text-[10px] font-mono opacity-80">
                              {isEnabled ? `(${interval}m)` : '(Off)'}
                            </span>
                          </button>
                        </td>
                        <td className="py-3.5 px-4">
                          {ws.inOffice ? (
                            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-400 bg-teal-950/40 px-2 py-1 rounded-md border border-teal-800/40">
                              🏢 In Office
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 bg-slate-800/40 px-2 py-1 rounded-md border border-slate-700/40">
                              🌐 Outside Office
                            </span>
                          )}
                          {ws.connectedBssid && (
                            <div className="font-mono text-[10px] text-slate-500 mt-1">
                              {ws.connectedBssid}
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-xs text-slate-400">
                          {ws.lastHeartbeat}
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {ws.employeeId && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openScreenshotsModal({ id: ws.employeeId, name: ws.employeeName, model: ws.model });
                                }}
                                className="inline-flex items-center gap-1 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[10px] font-bold text-sky-300 hover:bg-sky-500/20 transition cursor-pointer"
                                title="Open Screenshot Surveillance Gallery"
                              >
                                <span>📸 Photos</span>
                              </button>
                            )}
                            {onSelectEmployee && ws.employeeId && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectEmployee(ws.employeeId);
                                }}
                                className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[10px] font-bold text-cyan-300 hover:bg-cyan-500/20 hover:border-cyan-400 transition cursor-pointer"
                              >
                                <span>Profile →</span>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab: App Usage (Collapsible Breakdown View) */}
      {activeTab === 'app_usage' && (
        <div className="space-y-4">
          <div className="glass-panel rounded-2xl p-4 border border-slate-800 flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                <span>📁</span> Employee Activity Breakdown (Collapsible View)
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Click an employee row to expand or collapse their software usage breakdown.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
              <input
                type="text"
                placeholder="Search app or employee..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-teal-500 flex-1 md:w-60"
              />
              <button
                onClick={expandAll}
                className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800/60 hover:bg-slate-700/60 text-[11px] font-medium text-slate-300 transition-colors cursor-pointer"
              >
                Expand All
              </button>
              <button
                onClick={collapseAll}
                className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800/60 hover:bg-slate-700/60 text-[11px] font-medium text-slate-300 transition-colors cursor-pointer"
              >
                Collapse All
              </button>
            </div>
          </div>

          {filteredGroups.length === 0 ? (
            <div className="glass-panel rounded-2xl p-8 text-center text-slate-500 border border-slate-800">
              No application usage logged yet today. As employees work on their workstations, their software activity will automatically appear here.
            </div>
          ) : (
            <div className="space-y-3">
              {filteredGroups.map(group => {
                const key = group.employeeId || group.employeeName;
                const open = isExpanded(key);
                const topApp = group.apps[0];
                const formattedTotal = formatAppDuration(group.totalSeconds);

                return (
                  <div
                    key={key}
                    className="glass-panel rounded-2xl border border-slate-800 overflow-hidden transition-all duration-200"
                  >
                    <div
                      onClick={() => toggleEmployee(key)}
                      className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer hover:bg-slate-900/40 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-500/20 to-teal-500/20 border border-indigo-500/30 flex items-center justify-center text-lg font-bold text-teal-300 shrink-0">
                          {group.employeeName.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="font-semibold text-white text-sm truncate flex items-center gap-2">
                            <span>{group.employeeName}</span>
                            <span className="text-xs font-normal text-slate-400">
                              ({group.apps.length} {group.apps.length === 1 ? 'app' : 'apps'})
                            </span>
                          </div>
                          <div className="text-xs text-slate-400 flex items-center gap-2 mt-0.5">
                            <span className="capitalize">{group.platform}</span>
                            <span>•</span>
                            <span>Top: <strong className="text-slate-300 font-mono">{topApp ? topApp.appName : 'None'}</strong></span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <div className="text-sm font-bold text-teal-400 font-mono">{formattedTotal}</div>
                          <div className="text-[10px] text-slate-400">Tracked in software</div>
                        </div>
                        <span className="text-xs text-slate-400 bg-slate-800/80 px-2.5 py-1 rounded-lg border border-slate-700">
                          {open ? 'Collapse ▴' : 'View Breakdown ▾'}
                        </span>
                      </div>
                    </div>

                    {open && (
                      <div className="border-t border-slate-800/80 bg-slate-950/60 p-4">
                        <div className="overflow-x-auto rounded-xl border border-slate-800/70">
                          <table className="w-full text-left text-sm text-slate-300">
                            <thead className="bg-slate-900/90 text-[11px] font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-800">
                              <tr>
                                <th className="py-2.5 px-3.5">Software / Application</th>
                                <th className="py-2.5 px-3.5">Usage Time Today</th>
                                <th className="py-2.5 px-3.5">Share of Workday</th>
                                <th className="py-2.5 px-3.5">Platform</th>
                                <th className="py-2.5 px-3.5">Last Active</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/50">
                              {group.apps.map(app => {
                                const cat = getAppCategory(app.appName, app.category);
                                const formatted = formatAppDuration(app.activeSeconds);
                                const sharePct = group.totalSeconds > 0
                                  ? Math.min(100, Math.round((app.activeSeconds / group.totalSeconds) * 100))
                                  : 0;

                                return (
                                  <tr key={app.id} className="hover:bg-slate-900/40 transition-colors">
                                    <td className="py-2.5 px-3.5">
                                      <div className="flex items-center gap-2.5">
                                        <span className={`inline-flex items-center justify-center h-7 w-7 rounded-lg border text-sm ${cat.badgeClass}`}>
                                          {cat.icon}
                                        </span>
                                        <div>
                                          <div className="font-mono font-semibold text-white text-xs">{app.appName}</div>
                                          <span className="text-[10px] text-slate-400">{cat.label}</span>
                                        </div>
                                      </div>
                                    </td>
                                    <td className="py-2.5 px-3.5">
                                      <span className="font-mono font-bold text-emerald-400 text-xs">{formatted}</span>
                                    </td>
                                    <td className="py-2.5 px-3.5">
                                      <div className="flex items-center gap-2.5">
                                        <div className="w-24 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                          <div className="bg-teal-400 h-full rounded-full" style={{ width: `${sharePct}%` }} />
                                        </div>
                                        <span className="font-mono text-xs font-semibold text-slate-300">{sharePct}%</span>
                                      </div>
                                    </td>
                                    <td className="py-2.5 px-3.5 text-xs text-slate-400 capitalize">{app.platform}</td>
                                    <td className="py-2.5 px-3.5 text-xs text-slate-400">{app.lastUsedAt}</td>
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
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab: Employee App Activity Backlog */}
      {activeTab === 'app_backlog' && (
        <div className="space-y-4">
          <div className="glass-panel rounded-2xl p-4 border border-teal-500/20 bg-teal-500/5">
            <div className="flex items-start gap-3">
              <span className="text-xl">🗂️</span>
              <div>
                <h3 className="text-sm font-bold text-white">Storage-Optimized Activity Backlog</h3>
                <p className="mt-1 text-xs text-slate-300 leading-relaxed">
                  Historical workstation software activity aggregated daily per employee and application.
                </p>
              </div>
            </div>
          </div>

          <div className="glass-panel rounded-2xl p-4 border border-slate-800 flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">Select Employee</label>
              <select
                value={backlogEmployeeId}
                onChange={(e) => {
                  setBacklogEmployeeId(e.target.value);
                  handleQueryBacklog(e.target.value);
                }}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-xs text-white focus:border-teal-500 focus:outline-none"
              >
                <option value="">-- Choose Employee --</option>
                {knownEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.name}</option>
                ))}
              </select>
            </div>

            <div className="w-40">
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">From Date</label>
              <input
                type="date"
                value={backlogStartDate}
                onChange={(e) => setBacklogStartDate(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 p-1.5 text-xs text-white focus:border-teal-500 focus:outline-none"
              />
            </div>

            <div className="w-40">
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">To Date</label>
              <input
                type="date"
                value={backlogEndDate}
                onChange={(e) => setBacklogEndDate(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 p-1.5 text-xs text-white focus:border-teal-500 focus:outline-none"
              />
            </div>

            <button
              onClick={() => handleQueryBacklog()}
              disabled={backlogLoading || !backlogEmployeeId}
              className="px-4 py-2 rounded-lg bg-teal-500 hover:bg-teal-400 text-on-bright font-bold text-xs transition-colors disabled:opacity-50 cursor-pointer"
            >
              {backlogLoading ? 'Loading…' : 'Query Backlog'}
            </button>
          </div>

          {backlogData && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="glass-panel rounded-2xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-400 font-semibold uppercase">Employee</div>
                  <div className="mt-1 text-base font-bold text-white">{backlogData.employee.name}</div>
                </div>
                <div className="glass-panel rounded-2xl p-4 border border-teal-500/20 bg-teal-500/5">
                  <div className="text-xs text-teal-400 font-semibold uppercase">Total Active Time</div>
                  <div className="mt-1 text-2xl font-extrabold text-white">{formatAppDuration(backlogData.totalActiveSeconds)}</div>
                </div>
                <div className="glass-panel rounded-2xl p-4 border border-slate-800">
                  <div className="text-xs text-slate-400 font-semibold uppercase">Days with Activity</div>
                  <div className="mt-1 text-2xl font-extrabold text-indigo-400">{backlogData.dailyBreakdown.length}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* S3 Storage Quota & Auto-Retention Settings Modal */}
      {isStorageModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl">☁️</span>
                <div>
                  <h3 className="text-base font-bold text-white">Supabase S3 Storage & Retention</h3>
                  <p className="text-xs text-slate-400">Configure surveillance storage quotas and auto-retention rules.</p>
                </div>
              </div>
              <button
                onClick={() => setIsStorageModalOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            {storageMessage && (
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-300 text-xs font-semibold">
                {storageMessage}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Storage Warning Quota (GB)
                </label>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={quotaGbInput}
                  onChange={(e) => setQuotaGbInput(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-sky-500"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Alert threshold for the HR storage capacity bar (Default: 10 GB).
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Auto-Retention Cleanup (Days)
                </label>
                <select
                  value={retentionDaysInput}
                  onChange={(e) => setRetentionDaysInput(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-sky-500"
                >
                  <option value="7">Purge captures older than 7 days</option>
                  <option value="14">Purge captures older than 14 days</option>
                  <option value="30">Purge captures older than 30 days (Recommended)</option>
                  <option value="60">Purge captures older than 60 days</option>
                  <option value="90">Purge captures older than 90 days</option>
                  <option value="180">Purge captures older than 6 months</option>
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  Screenshots older than this retention period can be cleaned up automatically to maintain storage headroom.
                </p>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => handleSaveStorageRetention(true)}
                disabled={storageSaving}
                className="px-3 py-2 rounded-xl bg-rose-500/10 border border-rose-500/30 hover:bg-rose-500/20 text-rose-300 font-bold text-xs transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                <span>🧹</span> {storageSaving ? 'Purging…' : 'Run Purge Cleanup Now'}
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsStorageModalOpen(false)}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => handleSaveStorageRetention(false)}
                  disabled={storageSaving}
                  className="px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-on-bright font-bold text-xs transition cursor-pointer disabled:opacity-50"
                >
                  {storageSaving ? 'Saving…' : 'Save Policy'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Employee Screenshot Gallery & Settings Modal */}
      {selectedEmpForShots && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-6xl max-h-[92vh] flex flex-col rounded-2xl bg-slate-950 border border-slate-800 shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/90">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-xl">
                  📸
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-white">{selectedEmpForShots.name}</h3>
                    <span className="text-xs text-slate-400 font-mono">({selectedEmpForShots.model || 'Desktop'})</span>
                  </div>
                  <p className="text-xs text-slate-400">
                    Periodic workstation surveillance captures partitioned on Supabase S3.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {/* Tab Switcher in Modal */}
                <div className="flex bg-slate-900 rounded-lg p-1 border border-slate-800 text-xs">
                  <button
                    onClick={() => setShotsModalTab('gallery')}
                    className={`px-3 py-1 rounded-md font-semibold transition cursor-pointer ${
                      shotsModalTab === 'gallery'
                        ? 'bg-sky-500 text-on-bright shadow'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Gallery & Captures
                  </button>
                  <button
                    onClick={() => setShotsModalTab('settings')}
                    className={`px-3 py-1 rounded-md font-semibold transition cursor-pointer ${
                      shotsModalTab === 'settings'
                        ? 'bg-sky-500 text-on-bright shadow'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    ⚙️ Interval & Settings
                  </button>
                </div>

                <button
                  onClick={closeScreenshotsModal}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {shotsModalTab === 'gallery' ? (
                <>
                  {/* Date Picker & Action Toolbar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/60 p-3.5 rounded-xl border border-slate-800">
                    <div className="flex items-center gap-3">
                      <label className="text-xs font-semibold text-slate-300">Date:</label>
                      <input
                        type="date"
                        value={selectedDateKey}
                        onChange={(e) => {
                          setSelectedDateKey(e.target.value);
                          loadEmployeeScreenshots(selectedEmpForShots.id, e.target.value);
                        }}
                        className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:border-sky-500"
                      />

                      {shotsData?.availableDates && shotsData.availableDates.length > 0 && (
                        <select
                          value={selectedDateKey}
                          onChange={(e) => {
                            setSelectedDateKey(e.target.value);
                            loadEmployeeScreenshots(selectedEmpForShots.id, e.target.value);
                          }}
                          className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:border-sky-500 max-w-[180px]"
                        >
                          {shotsData.availableDates.map(d => (
                            <option key={d.dateKey} value={d.dateKey}>
                              {d.dateKey} ({d.count} shots)
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSelectAllShots}
                        disabled={!shotsData?.screenshots || shotsData.screenshots.length === 0}
                        className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition cursor-pointer disabled:opacity-40"
                      >
                        {selectedShotIds.size === (shotsData?.screenshots?.length || 0) && (shotsData?.screenshots?.length || 0) > 0
                          ? 'Deselect All'
                          : 'Select All'}
                      </button>

                      {selectedShotIds.size > 0 && (
                        <button
                          type="button"
                          onClick={handleDeleteSelectedShots}
                          disabled={actionLoading}
                          className="px-3 py-1.5 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-300 font-bold text-xs hover:bg-rose-500/30 transition cursor-pointer disabled:opacity-50 flex items-center gap-1"
                        >
                          <span>🗑️ Delete ({selectedShotIds.size})</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={handleDeleteEntireDay}
                        disabled={actionLoading || !shotsData?.screenshots || shotsData.screenshots.length === 0}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-950/40 hover:text-rose-300 hover:border-rose-700/60 border border-slate-700 text-xs font-semibold text-slate-400 transition cursor-pointer disabled:opacity-40"
                        title="Delete all screenshots for this date"
                      >
                        Purge Entire Day
                      </button>
                    </div>
                  </div>

                  {shotsLoading ? (
                    <div className="py-20 text-center space-y-3">
                      <div className="h-8 w-8 animate-spin rounded-full border-2 border-sky-400 border-t-transparent mx-auto" />
                      <p className="text-xs text-slate-400">Loading workstation captures from Supabase S3…</p>
                    </div>
                  ) : shotsError ? (
                    <div className="p-4 bg-rose-950/40 border border-rose-800/60 rounded-xl text-rose-300 text-xs">
                      {shotsError}
                    </div>
                  ) : !shotsData?.screenshots || shotsData.screenshots.length === 0 ? (
                    <div className="py-20 text-center space-y-2 border border-dashed border-slate-800 rounded-2xl">
                      <div className="text-3xl">📷</div>
                      <h4 className="text-sm font-bold text-white">No Screenshots Found for {selectedDateKey}</h4>
                      <p className="text-xs text-slate-400 max-w-sm mx-auto">
                        No periodic captures recorded on this date. Make sure screenshot surveillance is toggled ON in the Settings tab.
                      </p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3.5">
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
                            {/* Checkbox select */}
                            <div className="absolute top-2 left-2 z-10">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => handleToggleSelectShot(shot.id)}
                                className="h-4 w-4 rounded border-slate-700 bg-slate-900/90 text-sky-500 focus:ring-0 cursor-pointer"
                              />
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
                                <span className="p-1.5 rounded-lg bg-black/75 text-white text-xs font-semibold backdrop-blur-sm">
                                  🔍 Expand
                                </span>
                              </div>
                            </div>

                            {/* Meta */}
                            <div className="p-2.5 flex-1 flex flex-col justify-between text-[11px] bg-slate-950/80">
                              <div className="flex items-center justify-between font-mono font-bold text-white">
                                <span>{shot.displayTime}</span>
                                <span className="text-[10px] text-slate-400 font-normal">{formatBytes(shot.fileSizeBytes)}</span>
                              </div>
                              <div className="text-[10px] text-slate-400 truncate mt-1 flex items-center gap-1" title={shot.windowTitle || shot.activeApp}>
                                <span className="truncate max-w-[120px] font-mono">{shot.activeApp}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                /* Settings Tab */
                <div className="max-w-xl mx-auto space-y-6 bg-slate-900/60 p-6 rounded-2xl border border-slate-800">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                    <div>
                      <h4 className="text-sm font-bold text-white">Periodic Screen Capture Monitoring</h4>
                      <p className="text-xs text-slate-400">
                        Automatically captures and synchronizes workstation screens at custom intervals.
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={shotToggleEnabled}
                        onChange={(e) => setShotToggleEnabled(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sky-500" />
                    </label>
                  </div>

                  {settingsSuccess && (
                    <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-300 text-xs font-semibold">
                      {settingsSuccess}
                    </div>
                  )}

                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                        Capture Polling Interval
                      </label>
                      <select
                        value={shotIntervalMins}
                        onChange={(e) => setShotIntervalMins(Number(e.target.value))}
                        disabled={!shotToggleEnabled}
                        className="w-full bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-sky-500 disabled:opacity-50"
                      >
                        <option value="1">Every 1 Minute (High Precision)</option>
                        <option value="2">Every 2 Minutes</option>
                        <option value="3">Every 3 Minutes</option>
                        <option value="5">Every 5 Minutes (Recommended Standard)</option>
                        <option value="10">Every 10 Minutes</option>
                        <option value="15">Every 15 Minutes</option>
                        <option value="30">Every 30 Minutes</option>
                        <option value="60">Every 1 Hour (Light Footprint)</option>
                      </select>
                      <p className="text-[11px] text-slate-500 mt-1">
                        Time elapsed between each automatic background screen capture.
                      </p>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                        Capture Operating Mode
                      </label>
                      <div className="space-y-2">
                        <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition ${
                          shotMode === 'ACTIVE_ONLY'
                            ? 'bg-sky-500/10 border-sky-500/40 text-white'
                            : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                        }`}>
                          <input
                            type="radio"
                            name="shotMode"
                            checked={shotMode === 'ACTIVE_ONLY'}
                            onChange={() => setShotMode('ACTIVE_ONLY')}
                            disabled={!shotToggleEnabled}
                            className="mt-0.5 text-sky-500 focus:ring-0"
                          />
                          <div>
                            <div className="text-xs font-bold">Active Work Only (Recommended)</div>
                            <div className="text-[11px] opacity-80 mt-0.5">
                              Captures strictly when employee is active. Automatically pauses during breaks, screen lock, and idle inactivity (&gt;5m).
                            </div>
                          </div>
                        </label>

                        <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition ${
                          shotMode === 'CONTINUOUS'
                            ? 'bg-sky-500/10 border-sky-500/40 text-white'
                            : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                        }`}>
                          <input
                            type="radio"
                            name="shotMode"
                            checked={shotMode === 'CONTINUOUS'}
                            onChange={() => setShotMode('CONTINUOUS')}
                            disabled={!shotToggleEnabled}
                            className="mt-0.5 text-sky-500 focus:ring-0"
                          />
                          <div>
                            <div className="text-xs font-bold">Continuous During Shift</div>
                            <div className="text-[11px] opacity-80 mt-0.5">
                              Captures on schedule throughout working hours regardless of lock/idle status (always pauses on official breaks).
                            </div>
                          </div>
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-slate-800 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={handleSaveScreenshotSettings}
                      disabled={settingsSaving}
                      className="px-5 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-on-bright font-bold text-xs transition cursor-pointer disabled:opacity-50"
                    >
                      {settingsSaving ? 'Saving…' : 'Save Configuration'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Lightbox Full-Resolution Viewer */}
      {lightboxShot && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in">
          <div className="relative max-w-7xl max-h-[95vh] w-full flex flex-col items-center justify-center">
            {/* Header Overlay */}
            <div className="w-full flex items-center justify-between p-4 bg-gradient-to-b from-black/80 to-transparent text-on-accent z-10 absolute top-0 inset-x-0">
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs font-bold bg-sky-500/20 px-2.5 py-1 rounded border border-sky-500/40 text-sky-300">
                  {lightboxShot.displayTime}
                </span>
                <span className="text-xs text-slate-300 font-mono">
                  {lightboxShot.activeApp} {lightboxShot.windowTitle ? `— ${lightboxShot.windowTitle}` : ''}
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  ({formatBytes(lightboxShot.fileSizeBytes)})
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    if (!confirm('Delete this screenshot permanently from Supabase S3?')) return;
                    await api.deleteScreenshots([lightboxShot.id]);
                    setLightboxShot(null);
                    if (selectedEmpForShots) {
                      await loadEmployeeScreenshots(selectedEmpForShots.id, selectedDateKey);
                      await loadData();
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 border border-rose-500/40 text-xs font-semibold transition cursor-pointer"
                >
                  🗑️ Delete
                </button>
                <button
                  type="button"
                  onClick={() => setLightboxShot(null)}
                  className="p-1.5 rounded-lg bg-slate-800 text-white hover:bg-slate-700 transition cursor-pointer"
                >
                  ✕ Close
                </button>
              </div>
            </div>

            {/* Main Image */}
            <div className="relative flex items-center justify-center w-full h-full max-h-[85vh] p-4">
              <img
                src={lightboxShot.imageUrl}
                alt={`Screenshot at ${lightboxShot.displayTime}`}
                className="max-w-full max-h-[80vh] object-contain rounded-xl shadow-2xl border border-white/10"
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
                      className="absolute left-6 p-3 rounded-full bg-black/60 hover:bg-black/90 text-white text-lg border border-white/20 transition cursor-pointer"
                      title="Previous (Left Arrow)"
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
                      className="absolute right-6 p-3 rounded-full bg-black/60 hover:bg-black/90 text-white text-lg border border-white/20 transition cursor-pointer"
                      title="Next (Right Arrow)"
                    >
                      ›
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Footer index indicator */}
            <div className="text-xs text-slate-400 font-mono">
              Image {lightboxIndex + 1} of {shotsData?.screenshots?.length || 0}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
