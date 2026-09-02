'use client';

import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { WorkstationItem, ProcessAnomalyItem } from '../lib/types';
import { Badge } from './primitives';

export function WorkstationsPanel() {
  const [workstations, setWorkstations] = useState<WorkstationItem[]>([]);
  const [anomalies, setAnomalies] = useState<ProcessAnomalyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'workstations' | 'anomalies'>('workstations');

  const loadData = async () => {
    try {
      setLoading(true);
      const [wsRes, anomRes] = await Promise.all([
        api.fetchWorkstations(),
        api.fetchAnomalies(),
      ]);
      setWorkstations(wsRes.workstations || []);
      setAnomalies(anomRes.anomalies || []);
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

  const handleResolveAnomaly = async (id: string) => {
    try {
      await api.resolveAnomaly(id);
      setAnomalies(prev => prev.map(a => a.id === id ? { ...a, resolved: true } : a));
    } catch (err: any) {
      alert('Failed to resolve anomaly: ' + err.message);
    }
  };

  const activeCount = workstations.filter(w => w.status === 'ACTIVE').length;
  const inOfficeCount = workstations.filter(w => w.inOffice).length;
  const breakCount = workstations.filter(w => w.status === 'ON_BREAK' || w.status === 'AWAY' || w.status === 'IDLE').length;
  const unresolvedAnomalies = anomalies.filter(a => !a.resolved).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            💻 Workstations & Desktop Agents
          </h2>
          <p className="text-sm text-slate-400">
            Real-time tracking of employee laptops (active time, screen locks, and unknown process alerts).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadData}
            disabled={loading}
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-50"
          >
            🔄 Refresh
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

        <div className={`glass-panel rounded-2xl p-4 border ${unresolvedAnomalies > 0 ? 'border-rose-500/30 bg-rose-500/10' : 'border-slate-800 bg-slate-900/40'}`}>
          <div className="text-xs font-semibold uppercase tracking-wider text-rose-400">Process Anomalies</div>
          <div className="mt-2 text-2xl font-bold text-white">{unresolvedAnomalies}</div>
          <div className="mt-1 text-[11px] text-slate-400">Unknown / unapproved apps</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 gap-6">
        <button
          onClick={() => setActiveTab('workstations')}
          className={`pb-3 text-sm font-semibold transition-colors flex items-center gap-2 ${
            activeTab === 'workstations'
              ? 'text-teal-400 border-b-2 border-teal-400'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          🖥️ Active Workstations ({workstations.length})
        </button>
        <button
          onClick={() => setActiveTab('anomalies')}
          className={`pb-3 text-sm font-semibold transition-colors flex items-center gap-2 ${
            activeTab === 'anomalies'
              ? 'text-teal-400 border-b-2 border-teal-400'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          ⚠️ Process Anomalies
          {unresolvedAnomalies > 0 && (
            <span className="px-2 py-0.5 text-xs font-bold bg-rose-500/20 text-rose-300 rounded-full border border-rose-500/30">
              {unresolvedAnomalies}
            </span>
          )}
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

      {/* Tab: Anomalies */}
      {activeTab === 'anomalies' && (
        <div className="glass-panel rounded-2xl overflow-hidden border border-slate-800">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="bg-slate-900/80 text-xs font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Employee</th>
                  <th className="py-3 px-4">Unapproved Process</th>
                  <th className="py-3 px-4">Duration</th>
                  <th className="py-3 px-4">Detected At</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {anomalies.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500">
                      No unapproved process anomalies detected. All workstation activity is within policy!
                    </td>
                  </tr>
                ) : (
                  anomalies.map(a => (
                    <tr key={a.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3.5 px-4 font-medium text-slate-100">
                        {a.employeeName}
                        <div className="text-xs text-slate-400">{a.deviceModel}</div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="font-mono font-semibold text-rose-400">{a.processName}</div>
                        {a.windowTitle && (
                          <div className="text-xs text-slate-400 max-w-xs truncate">{a.windowTitle}</div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 font-mono font-semibold text-slate-200">
                        {a.durationMinutes} minutes
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-400">
                        {a.detectedDate} at {a.detectedAt}
                      </td>
                      <td className="py-3.5 px-4">
                        {a.resolved ? (
                          <Badge tone="ok">Resolved</Badge>
                        ) : (
                          <Badge tone="danger">⚠️ Unresolved</Badge>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        {!a.resolved && (
                          <button
                            onClick={() => handleResolveAnomaly(a.id)}
                            className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-white/10 transition-colors"
                          >
                            Mark Reviewed
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
