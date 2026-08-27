'use client';

import { useEffect, useState } from 'react';

import type {
  AdminEmployee,
  DashboardSummary,
  EmployeeDay,
  Movement,
} from '@/lib/types';
import { Badge, Button, Empty, Input, Panel, STATUS_META } from './primitives';

// --- header ----------------------------------------------------------------

export function Header({
  summary,
  connection,
  onLock,
}: {
  summary: DashboardSummary | null;
  connection: string;
  onLock: () => void;
}) {
  const [clock, setClock] = useState('');
  const [date, setDate] = useState('');
  const tz = summary?.timezone ?? 'UTC';

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      try {
        setClock(
          new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
          }).format(now),
        );
        setDate(
          new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            weekday: 'long',
            month: 'short',
            day: 'numeric',
          }).format(now),
        );
      } catch {
        // An unexpected zone from the server must not stop the clock.
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [tz]);

  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-6 py-4">
      <div>
        <h1 className="text-lg font-bold">
          {summary?.officeConfig.officeName ?? 'Office Tracker'}
        </h1>
        <p className="text-xs text-muted">
          {summary
            ? `${summary.officeConfig.networks.join(' · ')} — grace ${summary.officeConfig.gracePeriod}`
            : ''}
        </p>
      </div>

      <div className="flex items-center gap-4">
        <div className="text-right">
          <div className="font-mono text-sm">{clock || '--:--:--'}</div>
          <div className="text-[11px] text-dim">{date}</div>
        </div>
        <Badge tone={connection === 'live' ? 'ok' : 'muted'}>{connection}</Badge>
        <Button onClick={onLock} title="Forget the admin key on this browser">
          Lock
        </Button>
      </div>
    </header>
  );
}

/**
 * The weaker anti-spoofing posture is shown in the UI, not only in a startup
 * log line nobody reads.
 */
export function WarningBar({ summary }: { summary: DashboardSummary }) {
  const { bssidVerification, bssidListed } = summary.officeConfig;
  if (bssidVerification === 'enforced') return null;

  const code = 'rounded bg-black/30 px-1.5 py-0.5';

  // Collected-but-not-enforced is a deliberate step, not an outstanding task.
  // Telling the operator to add BSSIDs they had already added sent them to redo
  // finished work and hid the one thing actually left to do.
  if (bssidVerification === 'listed-not-enforced') {
    return (
      <div className="mx-6 mb-4 rounded-lg border border-warn bg-warn-dim px-4 py-3 text-xs leading-relaxed">
        <strong>{bssidListed} access point radio(s) listed, not yet enforced.</strong>{' '}
        Presence is still verified by source IP only. Check every radio your staff
        actually connect to is listed — run{' '}
        <code className={code}>npm run bssids</code> a few times, since the scan is
        cached — then set <code className={code}>&quot;enforceBssid&quot;: true</code> in{' '}
        <code className={code}>backend/config/office.json</code>.
        <div className="mt-1 text-muted">
          Turning it on with a radio missing silently stops counting everyone
          connected to that radio.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-6 mb-4 rounded-lg border border-warn bg-warn-dim px-4 py-3 text-xs leading-relaxed">
      No office BSSIDs configured — presence is verified by source IP only. Run{' '}
      <code className={code}>npm run bssids</code> and add them to{' '}
      <code className={code}>backend/config/office.json</code> to fully prevent
      off-site check-ins.
    </div>
  );
}

// --- stats -----------------------------------------------------------------

export function Stats({ summary }: { summary: DashboardSummary }) {
  const s = summary.stats;
  const cards: [string, string | number, string][] = [
    ['In office', s.currentlyInOffice, 'text-brand'],
    ['Grace period', s.currentlyInGracePeriod, 'text-warn'],
    ['Away', s.currentlyAway, 'text-text'],
    ['Attended today', s.totalAttendeesToday, 'text-text'],
    ['Avg worked', s.averageTimeWorkedToday, 'text-text'],
    ['Unrecognised devices', s.unknownDevicesSeen24h, 'text-text'],
  ];

  return (
    <div className="mb-5 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
      {cards.map(([label, value, tone]) => (
        <div key={label} className="rounded-xl border border-line bg-surface/70 p-4">
          <div className={`text-2xl font-bold ${tone}`}>{value}</div>
          <div className="mt-1 text-[11px] text-muted">{label}</div>
          {label === 'Unrecognised devices' && (
            <div className="mt-1 text-[10px] leading-snug text-muted">
              seen {s.unknownDeviceMinSightings}+ times in 24h
              {s.unknownDevicesTransient24h > 0 && (
                <>
                  {' '}&middot; {s.unknownDevicesTransient24h} one-off sighting
                  {s.unknownDevicesTransient24h === 1 ? '' : 's'} excluded
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// --- presence --------------------------------------------------------------

const BORDER: Record<string, string> = {
  ok: 'border-l-brand',
  warn: 'border-l-warn',
  muted: 'border-l-dim',
  dim: 'border-l-transparent opacity-60',
};

export function PresenceGrid({ summary }: { summary: DashboardSummary }) {
  const all = [
    ...summary.inOffice,
    ...summary.grace,
    ...summary.away,
    ...summary.notArrived,
  ];

  return (
    <Panel title="Presence" note={`${all.length} active employee(s)`}>
      {all.length === 0 ? (
        <Empty>No employees yet. Add someone in the Team panel.</Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
          {all.map((e) => {
            const meta = STATUS_META[e.status] ?? STATUS_META.NOT_CHECKED_IN;
            return (
              <div
                key={e.employeeId}
                className={`rounded-lg border border-line border-l-[3px] bg-raised p-3.5 ${BORDER[meta.tone]}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{e.employeeName}</span>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </div>
                <div className="mt-0.5 text-[11px] text-muted">{e.role}</div>
                <div className="mt-2.5 flex justify-between gap-2 text-[11px] text-muted">
                  <span title="First seen today">in {e.firstCheckIn}</span>
                  <span title="Last sighting">seen {e.lastActiveTime}</span>
                  <strong className="text-text">{e.timeWorkedFormatted}</strong>
                </div>
                {e.presenceSource && (
                  <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted">
                    <span
                      aria-hidden
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        e.sensorCarried ? 'bg-brand' : 'bg-warn'
                      }`}
                    />
                    <span>via {e.presenceSource}</span>
                    {!e.sensorCarried && (
                      // The app closing would stop this person's clock, which is
                      // the failure mode HR would otherwise only discover from a
                      // wrong timesheet at the end of the month.
                      <span
                        className="text-warn"
                        title="The office sensor has not recognised this phone yet, so closing the app will stop the clock."
                      >
                        — app must stay open
                      </span>
                    )}
                  </div>
                )}
                {e.needsReview && (
                  <div className="mt-2 text-[10px] text-warn">
                    Unusually long session — review
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// --- attendance ------------------------------------------------------------

export function AttendanceTable({
  rows,
  dateKey,
  onExport,
}: {
  rows: EmployeeDay[];
  dateKey: string;
  onExport: (from: string, to: string) => void;
}) {
  const [from, setFrom] = useState(dateKey);
  const [to, setTo] = useState(dateKey);

  return (
    <Panel
      title="Attendance today"
      actions={
        <>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="py-1 text-xs"
          />
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="py-1 text-xs"
          />
          <Button onClick={() => onExport(from, to)}>Export CSV</Button>
        </>
      }
    >
      <div className="scroll-x">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr>
              {['Employee', 'First in', 'Last seen', 'Sessions', 'Worked', 'Status'].map(
                (h) => (
                  <th
                    key={h}
                    className="border-b border-line px-2.5 py-2 text-left text-[11px] font-semibold tracking-wide text-dim uppercase"
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <Empty>Nobody has checked in today.</Empty>
                </td>
              </tr>
            ) : (
              rows.map((a) => {
                const meta = STATUS_META[a.status] ?? STATUS_META.NOT_CHECKED_IN;
                return (
                  <tr key={a.employeeId}>
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      {a.employeeName}
                      <div className="text-[11px] text-muted">{a.role}</div>
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      {a.firstCheckIn}
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      {a.lastActiveTime}
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top text-[11px] leading-relaxed text-muted">
                      {a.sessions.length
                        ? a.sessions.map((s, i) => (
                            <div key={i}>
                              {s.from}–{s.to}
                            </div>
                          ))
                        : '—'}
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      <strong>{a.timeWorkedFormatted}</strong>
                      {a.adjustmentMinutes !== 0 && (
                        <div className="text-[11px] text-muted">
                          incl. {a.adjustmentMinutes}m adj.
                        </div>
                      )}
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// --- team ------------------------------------------------------------------

export function TeamPanel({
  employees,
  onAdd,
  onPair,
}: {
  employees: AdminEmployee[];
  onAdd: (name: string, role: string) => Promise<void>;
  onPair: (employee: AdminEmployee) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onAdd(name.trim(), role.trim());
      setName('');
      setRole('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Team">
      <form onSubmit={submit} className="mb-3.5 flex flex-wrap gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          className="flex-1 py-1.5 text-xs"
          required
        />
        <Input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="Role"
          className="flex-1 py-1.5 text-xs"
        />
        <Button variant="primary" type="submit" disabled={busy}>
          Add
        </Button>
      </form>

      {employees.length === 0 ? (
        <Empty>No employees yet.</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {employees.map((e) => (
            <div
              key={e.id}
              className={`flex items-center justify-between gap-2 rounded-lg bg-raised px-3 py-2.5 ${
                e.active ? '' : 'opacity-50'
              }`}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{e.name}</div>
                <div className="text-[11px] text-muted">
                  {e.role} · {e.deviceCount} device(s)
                </div>
              </div>
              <Button onClick={() => void onPair(e)}>Pair device</Button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// --- activity --------------------------------------------------------------

const FEED_TONE: Record<string, string> = {
  ARRIVED: 'bg-brand-dim text-brand',
  RECONNECTED: 'bg-brand-dim text-brand',
  DEPARTED: 'bg-warn-dim text-warn',
  NEEDS_REVIEW: 'bg-danger-dim text-danger',
};

export function ActivityFeed({ movements }: { movements: Movement[] }) {
  return (
    <Panel title="Activity">
      {movements.length === 0 ? (
        <Empty>No activity recorded yet.</Empty>
      ) : (
        <div className="flex max-h-[460px] flex-col gap-2 overflow-y-auto">
          {movements.map((m) => (
            <div key={m.id} className="flex items-start gap-2.5 text-xs">
              <span
                className={`rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide whitespace-nowrap ${
                  FEED_TONE[m.type] ?? 'bg-white/6 text-muted'
                }`}
              >
                {m.type}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{m.name}</div>
                <div className="truncate text-[11px] text-dim">{m.details}</div>
              </div>
              <span className="text-[11px] whitespace-nowrap text-dim">{m.time}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// --- pairing code ----------------------------------------------------------

/**
 * A pairing code is a credential. It is shown once and never persisted in the
 * browser.
 */
export function CodeModal({
  code,
  employeeName,
  expires,
  onClose,
}: {
  code: string;
  employeeName: string;
  expires: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-7 text-center">
        <h2 className="text-lg font-bold">Pairing code</h2>
        <p className="mb-5 text-sm text-muted">for {employeeName}</p>

        <div className="mb-4 rounded-lg bg-raised p-4 font-mono text-3xl font-bold tracking-widest break-all text-brand">
          {code}
        </div>

        <p className="mb-5 text-[11px] leading-relaxed text-dim">
          Single use · Valid until {expires}. Give it to the employee to enter in the app. It
          will not be shown again.
        </p>

        <Button variant="primary" onClick={onClose} className="w-full py-2.5 text-sm">
          Done
        </Button>
      </div>
    </div>
  );
}

