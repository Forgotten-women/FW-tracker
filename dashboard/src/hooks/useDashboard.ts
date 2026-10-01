'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, UnauthorizedError } from '@/lib/api';
import type { AdminEmployee, DashboardSummary, NotificationItem } from '@/lib/types';

export type ConnectionState = 'live' | 'polling' | 'reconnecting';

// How often the board reloads while the tab is visible (never while hidden).
const POLL_MS = 30_000;
// Background reloads refresh the employee directory at most this often;
// explicit refresh() calls (after an HR edit) always include it.
const EMPLOYEES_MAX_AGE_MS = 5 * 60 * 1000;

interface UseDashboard {
  summary: DashboardSummary | null;
  employees: AdminEmployee[];
  connection: ConnectionState;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Loads the dashboard and keeps it current.
 *
 * Polls every 30s while the tab is visible, and not at all while it is
 * hidden (see the effect below for why it no longer holds a stream open).
 */
export function useDashboard(
  unlocked: boolean,
  onUnauthorized: (message: string) => void,
  onNotification?: (notification: NotificationItem) => void,
): UseDashboard {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [employees, setEmployees] = useState<AdminEmployee[]>([]);
  const [connection] = useState<ConnectionState>('polling');
  const [error, setError] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const lastEmployeesAtRef = useRef(0);
  const aliveRef = useRef(true);
  // Kept for callers; notifications now arrive through the page's own poll.
  void onNotification;

  // The employee directory changes rarely (HR edits), unlike the live board,
  // so it is re-fetched at most every few minutes rather than on every update.
  const refresh = useCallback(async (opts: { employees?: boolean } = {}) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const wantEmployees =
        opts.employees || Date.now() - lastEmployeesAtRef.current > EMPLOYEES_MAX_AGE_MS;
      const [s, e] = await Promise.all([
        api.summary(),
        wantEmployees ? api.employees() : Promise.resolve(null),
      ]);
      if (wantEmployees && e) lastEmployeesAtRef.current = Date.now();
      if (!aliveRef.current) return;
      if (s) setSummary(s);
      if (e && Array.isArray(e.employees)) {
        setEmployees(e.employees);
      }
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      if (err instanceof UnauthorizedError) {
        onUnauthorized(err.message);
        return;
      }
      // Don't overwrite existing valid data on transient poll failures
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      inFlightRef.current = false;
    }
  }, [onUnauthorized]);

  // Data, polled while the tab is visible.
  //
  // This used to hold a Server-Sent Events stream open next to a backstop
  // timer. On Vercel an open stream keeps a function instance alive -- and
  // billed as provisioned memory -- for as long as the tab is open, and every
  // phone ping and laptop heartbeat on the stream triggered a reload of the
  // whole board every few seconds. Together that used up the Hobby plan. A
  // poll every 30s while someone is actually looking, and nothing while the
  // tab is hidden, keeps the board current at a small fraction of the cost.
  useEffect(() => {
    if (!unlocked) return;
    aliveRef.current = true;
    let id: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (id) return;
      void refresh();
      id = setInterval(() => void refresh(), POLL_MS);
    };
    const stop = () => {
      if (id) clearInterval(id);
      id = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    if (typeof document === 'undefined' || !document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      aliveRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [unlocked, refresh]);

  const refreshAll = useCallback(() => refresh({ employees: true }), [refresh]);

  return { summary, employees, connection, error, refresh: refreshAll };
}
