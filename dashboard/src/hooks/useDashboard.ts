'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, UnauthorizedError } from '@/lib/api';
import type { AdminEmployee, DashboardSummary, NotificationItem } from '@/lib/types';

export type ConnectionState = 'live' | 'polling' | 'reconnecting';

// Live updates are coalesced into one reload per this window (see onmessage).
const SSE_COALESCE_MS = 5000;
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
 * Live updates arrive over SSE; the interval is a fallback so a dropped stream
 * degrades to stale-by-15s rather than silently frozen.
 */
export function useDashboard(
  unlocked: boolean,
  onUnauthorized: (message: string) => void,
  onNotification?: (notification: NotificationItem) => void,
): UseDashboard {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [employees, setEmployees] = useState<AdminEmployee[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('polling');
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const lastEmployeesAtRef = useRef(0);
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  const onNotificationRef = useRef(onNotification);
  onNotificationRef.current = onNotification;

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

  // Data plus the polling fallback.
  //
  // This used to poll every 6s unconditionally, in addition to SSE's
  // onmessage handler (below) already calling refresh() on every push -- so
  // a live SSE connection meant every update was fetched twice, and the
  // timer alone fired every 6s regardless of whether the stream was healthy.
  // Slowing it down while 'live' (SSE is doing the real-time work; this is
  // only a safety net against a stream that silently stopped delivering
  // without erroring) and keeping it fast while not 'live' (genuinely the
  // only thing keeping data current) preserves the documented "stale by at
  // most ~15s" guarantee without the redundant fetch volume.
  useEffect(() => {
    if (!unlocked) return;
    aliveRef.current = true;
    const initial = setTimeout(() => void refresh(), 0);
    const intervalMs = connection === 'live' ? 60000 : 6000;
    const id = setInterval(() => void refresh(), intervalMs);
    return () => {
      aliveRef.current = false;
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [unlocked, refresh, connection]);

  // Live stream.
  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;

    const connect = async () => {
      try {
        const { ticket } = await api.sseTicket();
        if (cancelled) return;

        sourceRef.current?.close();
        const source = new EventSource(
          `/api/events?ticket=${encodeURIComponent(ticket)}`,
        );
        sourceRef.current = source;

        source.onopen = () => {
          if (!cancelled) setConnection('live');
        };
        source.onmessage = (event) => {
          let type: string | null = null;
          try {
            const parsed = JSON.parse(event.data);
            type = parsed && typeof parsed.type === 'string' ? parsed.type : null;
            if (parsed && parsed.type === 'NOTIFICATION' && parsed.data) {
              onNotificationRef.current?.(parsed.data as NotificationItem);
            }
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('office-tracker-sse', { detail: parsed }));
            }
          } catch (_) {}
          // Every phone ping and laptop heartbeat is a PRESENCE_UPDATED --
          // around one a second across the team -- and each used to trigger a
          // full reload of everyone's day, which was a large share of the
          // database's egress. Coalesce: at most one reload per few seconds,
          // however many updates arrive in between.
          if (!pendingRefreshRef.current) {
            const employees = type === 'SETTINGS_UPDATED' || type === 'DAY_ROLLOVER';
            pendingRefreshRef.current = setTimeout(() => {
              pendingRefreshRef.current = null;
              void refresh({ employees });
            }, SSE_COALESCE_MS);
          }
        };
        source.onerror = () => {
          if (cancelled) return;
          setConnection('reconnecting');
          source.close();
          sourceRef.current = null;
          retryRef.current = setTimeout(() => void connect(), 5000);
        };
      } catch {
        if (!cancelled) setConnection('polling');
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      if (pendingRefreshRef.current) {
        clearTimeout(pendingRefreshRef.current);
        pendingRefreshRef.current = null;
      }
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [unlocked, refresh]);

  const refreshAll = useCallback(() => refresh({ employees: true }), [refresh]);

  return { summary, employees, connection, error, refresh: refreshAll };
}
