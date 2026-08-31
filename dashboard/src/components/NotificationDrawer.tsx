'use client';

// Interactive HR Notification Drawer & Approval Hub. Spec Section 22.
//
// Provides real-time notifications for incoming employee requests (Leave, Attendance Disputes,
// Sickness Reports, Document Uploads) and HR system alerts.

import React, { useState } from 'react';
import type { NotificationItem } from '@/lib/types';
import { api } from '@/lib/api';

interface NotificationDrawerProps {
  open: boolean;
  onClose: () => void;
  notifications: NotificationItem[];
  unreadCount: number;
  onRefresh: () => Promise<void>;
  onNavigateTab?: (tab: string) => void;
}

const CATEGORY_META: Record<string, { label: string; icon: string; tabTarget: string; tone: string }> = {
  LEAVE: { label: 'Leave', icon: '🏖️', tabTarget: 'leave', tone: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30' },
  CORRECTION: { label: 'Dispute', icon: '⏱️', tabTarget: 'history', tone: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  ABSENCE: { label: 'Absence', icon: '🤒', tabTarget: 'warnings', tone: 'bg-rose-500/10 text-rose-400 border-rose-500/30' },
  DOCUMENT: { label: 'Document', icon: '📄', tabTarget: 'documents', tone: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  WARNING: { label: 'Warning', icon: '⚠️', tabTarget: 'warnings', tone: 'bg-orange-500/10 text-orange-400 border-orange-500/30' },
  HR_ALERT: { label: 'Compliance', icon: '🚨', tabTarget: 'live', tone: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
};

const SEVERITY_BADGE: Record<string, { label: string; tone: string }> = {
  urgent: { label: 'Urgent', tone: 'bg-red-500/20 text-red-400 border-red-500/40 animate-pulse' },
  warning: { label: 'Action Needed', tone: 'bg-amber-500/20 text-amber-400 border-amber-500/40' },
  info: { label: 'Info', tone: 'bg-blue-500/20 text-blue-400 border-blue-500/40' },
};

export function NotificationDrawer({
  open,
  onClose,
  notifications,
  unreadCount,
  onRefresh,
  onNavigateTab,
}: NotificationDrawerProps) {
  const [filter, setFilter] = useState<'ALL' | 'UNREAD' | 'LEAVE' | 'CORRECTION' | 'DOCUMENT' | 'ABSENCE'>('ALL');
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  if (!open) return null;

  const filtered = notifications.filter((n) => {
    if (filter === 'UNREAD') return !n.read;
    if (filter === 'LEAVE') return n.category === 'LEAVE';
    if (filter === 'CORRECTION') return n.category === 'CORRECTION';
    if (filter === 'DOCUMENT') return n.category === 'DOCUMENT';
    if (filter === 'ABSENCE') return n.category === 'ABSENCE';
    return true;
  });

  const handleMarkAllRead = async () => {
    setActionBusy('all');
    try {
      await api.markNotificationRead();
      await onRefresh();
    } catch (_) {
    } finally {
      setActionBusy(null);
    }
  };

  const handleCardClick = async (n: NotificationItem) => {
    if (!n.read) {
      try {
        await api.markNotificationRead(n.id);
        void onRefresh();
      } catch (_) {}
    }

    const meta = CATEGORY_META[n.category];
    if (meta && onNavigateTab) {
      onNavigateTab(meta.tabTarget);
      onClose();
    }
  };

  const handleDismiss = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setActionBusy(id);
    try {
      await api.dismissNotification(id);
      await onRefresh();
    } catch (_) {
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm transition-opacity duration-300">
      {/* Click outside to close */}
      <div className="flex-1" onClick={onClose} />

      {/* Drawer content */}
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800/80 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-900 border border-zinc-800 text-lg shadow-inner">
              🔔
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-white tracking-tight">Notifications</h2>
                {unreadCount > 0 && (
                  <span className="inline-flex items-center justify-center rounded-full bg-rose-500/20 border border-rose-500/40 px-2 py-0.5 text-xs font-semibold text-rose-400">
                    {unreadCount} new
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-400">Requests, approvals & alerts</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                disabled={actionBusy === 'all'}
                className="rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:text-white"
              >
                Mark all read
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-1.5 overflow-x-auto border-b border-zinc-800/60 px-4 py-2.5 text-xs scrollbar-none">
          {[
            { id: 'ALL', label: `All (${notifications.length})` },
            { id: 'UNREAD', label: `Unread (${unreadCount})` },
            { id: 'LEAVE', label: '🏖️ Leave' },
            { id: 'CORRECTION', label: '⏱️ Disputes' },
            { id: 'DOCUMENT', label: '📄 Docs' },
            { id: 'ABSENCE', label: '🤒 Absences' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id as typeof filter)}
              className={`whitespace-nowrap rounded-lg px-3 py-1 font-medium transition ${
                filter === tab.id
                  ? 'bg-zinc-100 text-zinc-950 shadow-sm'
                  : 'bg-zinc-900/60 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Notification List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {filtered.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center text-center p-6">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-900/80 border border-zinc-800 text-2xl mb-3 shadow-inner">
                ✨
              </div>
              <p className="text-sm font-medium text-zinc-300">All caught up!</p>
              <p className="text-xs text-zinc-400 max-w-xs mt-1">
                {filter === 'UNREAD'
                  ? 'No unread notifications right now.'
                  : 'No notification records match this filter.'}
              </p>
            </div>
          ) : (
            filtered.map((n) => {
              const meta = CATEGORY_META[n.category] || {
                label: n.category,
                icon: '📌',
                tabTarget: 'live',
                tone: 'bg-zinc-800 text-zinc-400 border-zinc-700',
              };
              const sev = SEVERITY_BADGE[n.severity] || SEVERITY_BADGE.info;

              return (
                <div
                  key={n.id}
                  onClick={() => handleCardClick(n)}
                  className={`group relative flex flex-col gap-2 rounded-xl border p-3.5 transition cursor-pointer ${
                    !n.read
                      ? 'border-zinc-700/80 bg-zinc-900/80 hover:bg-zinc-900 shadow-md ring-1 ring-white/5'
                      : 'border-zinc-800/60 bg-zinc-950/60 hover:bg-zinc-900/50 text-zinc-400'
                  }`}
                >
                  {/* Top row: Category tag, severity, time, and dismiss */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${meta.tone}`}>
                        <span>{meta.icon}</span>
                        <span>{meta.label}</span>
                      </span>
                      {n.severity !== 'info' && (
                        <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${sev.tone}`}>
                          {sev.label}
                        </span>
                      )}
                      {!n.read && (
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs text-zinc-400">
                      <span>{n.at}</span>
                      <button
                        type="button"
                        onClick={(e) => handleDismiss(e, n.id)}
                        disabled={actionBusy === n.id}
                        title="Dismiss notification"
                        className="opacity-0 group-hover:opacity-100 rounded p-1 hover:bg-zinc-800 hover:text-zinc-200 transition"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Title & Body */}
                  <div>
                    <h3 className={`text-sm font-semibold tracking-tight ${!n.read ? 'text-white' : 'text-zinc-300'}`}>
                      {n.title}
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-zinc-400 line-clamp-3">
                      {n.body}
                    </p>
                  </div>

                  {/* Bottom hint */}
                  <div className="flex items-center justify-between pt-1 text-[11px] text-zinc-400">
                    <span>Click to view details</span>
                    <span className="text-zinc-400 group-hover:text-zinc-300 transition">→</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-zinc-800/80 bg-zinc-950 px-5 py-3 text-center text-xs text-zinc-400">
          Connected to real-time notification stream (SSE)
        </div>
      </aside>
    </div>
  );
}
