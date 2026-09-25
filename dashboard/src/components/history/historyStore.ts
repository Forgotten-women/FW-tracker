'use client';

// In-memory cache of fetched history, owned by the employee drawer so it
// survives switching tabs and lives exactly as long as the drawer is open.
//
// Past months and past days are kept for the drawer's lifetime (they only
// change when HR edits them, and the view has a refresh control). The current
// month and today are refetched once they are LIVE_TTL_MS old, while the
// cached copy stays on screen, so an open tab never shows data older than
// that.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { api } from '@/lib/api';
import type { EmployeeHistoryDaysResponse, HistoryDayDetail } from '@/lib/types';
import { monthBounds } from './historyMeta';

export const LIVE_TTL_MS = 2 * 60 * 1000;

export type Entry<T> =
  | { kind: 'ok'; data: T; fetchedAt: number }
  | { kind: 'error'; message: string; fetchedAt: number };

interface HistoryState {
  months: Record<string, Entry<EmployeeHistoryDaysResponse>>;
  days: Record<string, Entry<HistoryDayDetail>>;
}

type Bucket = keyof HistoryState;

const EMPTY: HistoryState = { months: {}, days: {} };

export interface HistoryStore {
  state: HistoryState;
  resolve: (bucket: Bucket, key: string, data: EmployeeHistoryDaysResponse | HistoryDayDetail, at: number) => void;
  fail: (bucket: Bucket, key: string, message: string, at: number) => void;
  drop: (bucket: Bucket, key: string) => void;
  clear: () => void;
  /** Requests in flight, so a re-render or a tab switch never fires a duplicate. */
  runtime: RefObject<{ generation: number; inflight: Set<string> }>;
}

export function useHistoryStore(): HistoryStore {
  const [state, setState] = useState<HistoryState>(EMPTY);
  // Mutable bookkeeping, only touched from effects and event handlers.
  const runtime = useRef({ generation: 0, inflight: new Set<string>() });

  const resolve = useCallback<HistoryStore['resolve']>((bucket, key, data, at) => {
    setState((s) => ({ ...s, [bucket]: { ...s[bucket], [key]: { kind: 'ok', data, fetchedAt: at } } }));
  }, []);

  // A failed background refresh keeps what is already on screen.
  const fail = useCallback<HistoryStore['fail']>((bucket, key, message, at) => {
    setState((s) => {
      const prev = s[bucket][key];
      const next = prev?.kind === 'ok' ? { ...prev, fetchedAt: at } : { kind: 'error' as const, message, fetchedAt: at };
      return { ...s, [bucket]: { ...s[bucket], [key]: next } };
    });
  }, []);

  const drop = useCallback<HistoryStore['drop']>((bucket, key) => {
    setState((s) => {
      if (!(key in s[bucket])) return s;
      const next = { ...s[bucket] };
      delete next[key];
      return { ...s, [bucket]: next };
    });
  }, []);

  const clear = useCallback(() => {
    runtime.current.generation += 1;
    runtime.current.inflight.clear();
    setState(EMPTY);
  }, [runtime]);

  return useMemo(() => ({ state, resolve, fail, drop, clear, runtime }), [state, resolve, fail, drop, clear, runtime]);
}

export const monthCacheKey = (employeeId: string, month: string) => `${employeeId}|${month}`;
export const dayCacheKey = (employeeId: string, dateKey: string) => `${employeeId}|${dateKey}`;

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'The request failed.';
}

interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Drop the cached copy and fetch again. */
  reload: () => void;
}

function useResource<T extends EmployeeHistoryDaysResponse | HistoryDayDetail>(
  store: HistoryStore,
  bucket: Bucket,
  key: string | null,
  live: boolean,
  load: () => Promise<T>,
): Resource<T> {
  const entry = key ? (store.state[bucket][key] as Entry<T> | undefined) : undefined;
  const fetchedAt = entry?.fetchedAt;
  const failed = entry?.kind === 'error';
  const { resolve, fail, drop, runtime } = store;

  useEffect(() => {
    if (!key || failed) return;
    if (fetchedAt !== undefined && !live) return;

    const run = () => {
      const rt = runtime.current;
      const flightKey = `${bucket}:${key}`;
      if (rt.inflight.has(flightKey)) return;
      rt.inflight.add(flightKey);
      const generation = rt.generation;
      // Results are stored even if this component has moved on: the store
      // outlives it. Only a cleared store (drawer closed) discards them.
      load()
        .then((data) => {
          if (rt.generation === generation) resolve(bucket, key, data, Date.now());
        })
        .catch((err) => {
          if (rt.generation === generation) fail(bucket, key, messageOf(err), Date.now());
        })
        .finally(() => {
          if (rt.generation === generation) rt.inflight.delete(flightKey);
        });
    };

    if (fetchedAt === undefined) {
      run();
      return;
    }
    const timer = setTimeout(run, Math.max(0, fetchedAt + LIVE_TTL_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [bucket, key, live, fetchedAt, failed, load, resolve, fail, runtime]);

  const reload = useCallback(() => {
    if (key) drop(bucket, key);
  }, [drop, bucket, key]);

  return {
    data: entry?.kind === 'ok' ? entry.data : null,
    error: entry?.kind === 'error' ? entry.message : null,
    loading: !!key && !entry,
    reload,
  };
}

/** One calendar month of DaySummary rows (one call; a month is well inside the 62-day limit). */
export function useHistoryMonth(store: HistoryStore, employeeId: string, month: string, live: boolean) {
  const load = useCallback(() => {
    const { from, to } = monthBounds(month);
    return api.employeeHistoryDays(employeeId, from, to);
  }, [employeeId, month]);
  return useResource<EmployeeHistoryDaysResponse>(store, 'months', monthCacheKey(employeeId, month), live, load);
}

/** One day in full. `dateKey` null means no day is open. */
export function useHistoryDay(store: HistoryStore, employeeId: string, dateKey: string | null, live: boolean) {
  const load = useCallback(
    () => api.employeeHistoryDay(employeeId, dateKey as string).then((res) => res.day),
    [employeeId, dateKey],
  );
  return useResource<HistoryDayDetail>(store, 'days', dateKey ? dayCacheKey(employeeId, dateKey) : null, live, load);
}

/** The employment start, from any month already fetched for this employee. */
export function knownEmploymentStart(store: HistoryStore, employeeId: string): { known: boolean; start: string | null } {
  const prefix = `${employeeId}|`;
  for (const [key, entry] of Object.entries(store.state.months)) {
    if (entry.kind === 'ok' && key.startsWith(prefix)) return { known: true, start: entry.data.employmentStart ?? null };
  }
  return { known: false, start: null };
}
