'use client';

// The Advanced HR alert board. Spec sections 20.2 and 21.
//
// Its data is separate from the live-presence summary and changes slowly, so it
// fetches on its own rather than riding the 15-second dashboard poll.

import { useCallback, useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { HrAlert, HrAlerts, AlertSeverity } from '@/lib/types';
import { Button, Empty, Panel } from './primitives';

// Colour SUPPLEMENTS the words, per spec 21 - the label is always present, so
// colour is never the only signal.
const SEVERITY: Record<AlertSeverity, { label: string; tone: string }> = {
  overdue: { label: 'Overdue', tone: 'border-danger text-danger' },
  urgent: { label: 'Due soon', tone: 'border-warn text-warn' },
  warning: { label: 'Upcoming', tone: 'border-line text-muted' },
};

const TYPE_LABEL: Record<HrAlert['type'], string> = {
  CONTRACT_EXPIRY: 'Contract',
  PROBATION_REVIEW: 'Probation',
  DOCUMENT_EXPIRY: 'Document',
  PERFORMANCE_REVIEW: 'Review',
};

function whenText(days: number): string {
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  if (days === 0) return 'today';
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

export function HrAlertsPanel() {
  const [data, setData] = useState<HrAlerts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.hrAlerts());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load HR alerts');
    }
  }, []);

  useEffect(() => {
    // Deferred off the effect body so the first load resolves in a callback
    // rather than calling setState synchronously as React commits this render.
    const initial = setTimeout(() => void load(), 0);
    const id = setInterval(() => void load(), 5 * 60 * 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [load]);

  const dismiss = async (a: HrAlert) => {
    setBusy(a.key);
    try {
      await api.dismissAlert(a.key, a.value);
      await load();
    } catch {
      // A failed dismissal just leaves the alert showing, which is the safe way
      // for it to fail.
    } finally {
      setBusy(null);
    }
  };

  const note = data
    ? `${data.summary.total} open${data.summary.overdue ? ` · ${data.summary.overdue} overdue` : ''}`
    : undefined;

  return (
    <Panel title="Advanced HR" note={note}>
      {error && <p className="mb-3 text-xs text-danger">{error}</p>}

      {!data ? (
        <Empty>Loading…</Empty>
      ) : data.alerts.length === 0 ? (
        <Empty>No contract, probation, document or review dates coming due.</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.alerts.map((a) => {
            const sev = SEVERITY[a.severity];
            return (
              <li
                key={a.key}
                className="flex items-center justify-between gap-3 rounded-lg border border-line bg-raised px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${sev.tone}`}>
                      {sev.label}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-dim">
                      {TYPE_LABEL[a.type]}
                    </span>
                    <span className="truncate text-sm font-medium text-text">{a.employeeName}</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {a.detail} · {whenText(a.daysUntil)}
                  </p>
                </div>
                <Button
                  onClick={() => dismiss(a)}
                  disabled={busy === a.key}
                  title="Hide until this date changes"
                >
                  {busy === a.key ? '…' : 'Dismiss'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
