'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, UnauthorizedError } from '@/lib/api';
import type { AdminEmployee, DashboardSummary } from '@/lib/types';

export type ConnectionState = 'live' | 'polling' | 'reconnecting';

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
 * degrades to stale-by-15s rather than silently frozen, which is what the old
 * dashboard did when its keepalive-less stream timed out.
 */
export function useDashboard(
  unlocked: boolean,
  onUnauthorized: (message: string) => void,
): UseDashboard {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [employees, setEmployees] = useState<AdminEmployee[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('polling');
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([api.summary(), api.employees()]);
      if (!aliveRef.current) return;
      setSummary(s);
      setEmployees(e.employees);
      setError(null);
    } catch (err) {
      if (!aliveRef.current) return;
      if (err instanceof UnauthorizedError) {
        onUnauthorized(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [onUnauthorized]);

  // Data plus the polling fallback.
  useEffect(() => {
    if (!unlocked) return;
    aliveRef.current = true;
    // Queued rather than called straight from the effect body, so the first
    // load resolves in a callback instead of triggering a synchronous
    // re-render while React is still committing this one.
    const initial = setTimeout(() => void refresh(), 0);
    const id = setInterval(() => void refresh(), 15000);
    return () => {
      aliveRef.current = false;
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [unlocked, refresh]);

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
        source.onmessage = () => void refresh();
        source.onerror = () => {
          if (cancelled) return;
          setConnection('reconnecting');
          // A ticket is single use, so the browser's own reconnect would 401.
          // Close and negotiate a fresh one instead.
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
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [unlocked, refresh]);

  return { summary, employees, connection, error, refresh };
}
