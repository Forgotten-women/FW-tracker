'use client';

import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { WorkstationItem, AppUsageItem } from '../lib/types';
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

function getAppCategory(appName: string) {
  const lower = (appName || '').toLowerCase();
  if (lower.includes('code') || lower.includes('antigravity') || lower.includes('ide') || lower.includes('studio') || lower.includes('terminal') || lower.includes('git') || lower.includes('dbeaver') || lower.includes('postman')) {
    return { label: 'Development', icon: '⚡', badgeClass: 'text-sky-400 bg-sky-500/10 border-sky-500/20' };
  }
  if (lower.includes('chrome') || lower.includes('edge') || lower.includes('firefox') || lower.includes('browser') || lower.includes('safari') || lower.includes('brave')) {
    return { label: 'Web / Cloud', icon: '🌐', badgeClass: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' };
  }
  if (lower.includes('teams') || lower.includes('slack') || lower.includes('zoom') || lower.includes('meet') || lower.includes('outlook') || lower.includes('discord')) {
    return { label: 'Communication', icon: '💬', badgeClass: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' };
  }
  if (lower.includes('excel') || lower.includes('word') || lower.includes('docs') || lower.includes('sheets') || lower.includes('notion') || lower.includes('figma')) {
    return { label: 'Productivity', icon: '📊', badgeClass: 'text-amber-400 bg-amber-500/10 border-amber-500/20' };
  }
  if (lower.includes('youtube') || lower.includes('spotify') || lower.includes('netflix')) {
    return { label: 'Media', icon: '🎬', badgeClass: 'text-rose-400 bg-rose-500/10 border-rose-500/20' };
  }
  return { label: 'Application', icon: '💻', badgeClass: 'text-slate-400 bg-slate-500/10 border-slate-500/20' };
}

export function WorkstationsPanel() {
  const [workstations, setWorkstations] = useState<WorkstationItem[]>([]);
  const [appUsage, setAppUsage] = useState<AppUsageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'workstations' | 'app_usage'>('workstations');
  const [searchQuery, setSearchQuery] = useState('');

  const loadData = async () => {
    try {
      setLoading(true);
      const [wsRes, appRes] = await Promise.all([
        api.fetchWorkstations(),
        api.fetchAppUsage(),
      ]);
      setWorkstations(wsRes.workstations || []);
      setAppUsage(appRes.appUsage || []);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load workstation data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 20000); // 20s auto refresh
    return () => clearInterval(interval);
  }, []);

  const activeCount = workstations.filter(w => w.status === 'ACTIVE').length;
  const inOfficeCount = workstations.filter(w => w.inOffice).length;
  const breakCount = workstations.filter(w => w.status === 'ON_BREAK' || w.status === 'AWAY' || w.status === 'IDLE').length;
  const totalAppsTracked = appUsage.length;

  const [expandedEmployees, setExpandedEmployees] = useState<Record<string, boolean>>({});

  // Group apps by employee
  const employeeGroups = React.useMemo(() => {
    const map = new Map<string, {
      employeeId: string;
      employeeName: string;
      totalSeconds: number;
      apps: AppUsageItem[];
      platform: string;
      deviceModel: string;
      lastActive: string;
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
        };
        map.set(key, group);
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
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            💻 Workstations & Application Activity
          </h2>
          <p className="text-sm text-slate-400">
            Real-time tracking of employee workstations, active work hours, and software usage records.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
                  <th className="py-3 px-4">Network & BSSID</th>
                  <th className="py-3 px-4">Last Seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {workstations.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      No desktop workstation sessions recorded today. Enrol a laptop using the Desktop Agent!
                    </td>
                  </tr>
                ) : (
                  workstations.map(ws => (
                    <tr key={ws.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3.5 px-4 font-medium text-slate-100">
                        {ws.employeeName}
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
                      <td className="py-3.5 px-4 font-mono font-semibold text-emerald-400">
                        {Math.floor(ws.activeMinutes / 60)}h {ws.activeMinutes % 60}m
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-400">
                        Break: {ws.breakMinutes}m | Idle: {ws.idleMinutes}m
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
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab: App Usage (Collapsible Breakdown View) */}
      {activeTab === 'app_usage' && (
        <div className="space-y-4">
          {/* Header Controls */}
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

          {/* Collapsible Employee Cards */}
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
                    className="glass-panel rounded-2xl border border-slate-800 overflow-hidden transition-all duration-200 shadow-sm"
                  >
                    {/* Collapsible Header Row */}
                    <div
                      onClick={() => toggleEmployee(key)}
                      className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 cursor-pointer hover:bg-slate-800/40 transition-colors select-none"
                    >
                      <div className="flex items-center gap-3.5">
                        {/* Chevron */}
                        <div
                          className={`w-7 h-7 rounded-lg bg-slate-800 border border-slate-700/80 flex items-center justify-center text-slate-400 transition-transform duration-200 ${
                            open ? 'rotate-90 text-teal-400 bg-teal-950/40 border-teal-700/50' : ''
                          }`}
                        >
                          <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 20 20">
                            <path d="M6 4l8 6-8 6V4z" />
                          </svg>
                        </div>

                        {/* Avatar */}
                        <div className="h-9 w-9 rounded-full bg-gradient-to-tr from-teal-500/20 to-emerald-500/20 border border-teal-500/40 flex items-center justify-center font-bold text-xs text-teal-300 shadow-inner">
                          {group.employeeName.charAt(0).toUpperCase()}
                        </div>

                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-slate-100 text-sm">
                              {group.employeeName}
                            </span>
                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700/60 font-medium">
                              {group.apps.length} {group.apps.length === 1 ? 'app' : 'apps'} tracked
                            </span>
                          </div>

                          {topApp && (
                            <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-1.5">
                              <span>Top:</span>
                              <span className="text-slate-200 font-medium font-mono text-[11px]">
                                {topApp.appName}
                              </span>
                              <span className="text-emerald-400 font-mono text-[11px] font-semibold">
                                ({formatAppDuration(topApp.activeSeconds)})
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Right Summary Info */}
                      <div className="flex items-center justify-between md:justify-end gap-6 w-full md:w-auto">
                        <div className="text-left md:text-right">
                          <div className="text-[10px] uppercase font-semibold text-slate-400 tracking-wider">
                            Total Active Usage
                          </div>
                          <div className="font-mono font-bold text-emerald-400 text-base">
                            {formattedTotal}
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono">
                            {group.totalSeconds.toLocaleString()}s total today
                          </div>
                        </div>

                        <div className="hidden lg:block text-right text-xs text-slate-400">
                          <div className="truncate max-w-[200px] capitalize">
                            {group.platform} ({group.deviceModel || 'Desktop'})
                          </div>
                          <div className="text-[11px] text-slate-500">
                            Last Active: {group.lastActive || 'Today'}
                          </div>
                        </div>

                        <div className="hidden sm:block">
                          <span
                            className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                              open
                                ? 'bg-teal-500/10 border-teal-500/30 text-teal-300'
                                : 'bg-slate-800/80 border-slate-700/80 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {open ? 'Collapse ▴' : 'View Breakdown ▾'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Expanded Breakdown Table */}
                    {open && (
                      <div className="border-t border-slate-800/80 bg-slate-950/60 p-4">
                        <div className="text-xs font-semibold text-slate-400 mb-2.5 flex items-center justify-between">
                          <span>Detailed Software Usage Breakdown for {group.employeeName}:</span>
                          <span className="text-[11px] text-slate-500 font-normal">
                            Sorted by duration
                          </span>
                        </div>

                        <div className="overflow-x-auto rounded-xl border border-slate-800/70">
                          <table className="w-full text-left text-sm text-slate-300">
                            <thead className="bg-slate-900/90 text-[11px] font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-800">
                              <tr>
                                <th className="py-2.5 px-3.5">Software / Application</th>
                                <th className="py-2.5 px-3.5">Usage Time Today</th>
                                <th className="py-2.5 px-3.5">Share of Workday</th>
                                <th className="py-2.5 px-3.5">Platform & Hardware</th>
                                <th className="py-2.5 px-3.5">Last Active</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/50">
                              {group.apps.map(app => {
                                const cat = getAppCategory(app.appName);
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
                                          <div className="font-mono font-semibold text-white text-xs">
                                            {app.appName}
                                          </div>
                                          <span className="text-[10px] text-slate-400 font-sans">
                                            {cat.label}
                                          </span>
                                        </div>
                                      </div>
                                    </td>
                                    <td className="py-2.5 px-3.5">
                                      <div>
                                        <span className="font-mono font-bold text-emerald-400 text-xs">
                                          {formatted}
                                        </span>
                                        <div className="text-[10px] text-slate-500 font-mono">
                                          {app.activeSeconds.toLocaleString()}s
                                        </div>
                                      </div>
                                    </td>
                                    <td className="py-2.5 px-3.5">
                                      <div className="flex items-center gap-2.5">
                                        <div className="w-24 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                          <div
                                            className="bg-gradient-to-r from-teal-500 to-emerald-400 h-full rounded-full"
                                            style={{ width: `${sharePct}%` }}
                                          />
                                        </div>
                                        <span className="font-mono text-xs font-semibold text-slate-300">
                                          {sharePct}%
                                        </span>
                                      </div>
                                    </td>
                                    <td className="py-2.5 px-3.5 text-xs text-slate-400 capitalize">
                                      {app.platform} ({app.deviceModel || 'Desktop'})
                                    </td>
                                    <td className="py-2.5 px-3.5 text-xs text-slate-400">
                                      {app.lastUsedAt}
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
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
