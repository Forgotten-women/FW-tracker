'use client';

import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type {
  AdminEmployee,
  AttendanceCorrection,
  DashboardSummary,
  EmployeeDay,
  Movement,
  PresenceStatus,
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
                  <div className="flex items-center gap-1.5">
                    {e.onBreak && (
                      <span className="rounded border border-warn bg-warn-dim px-1.5 py-0.5 text-[10px] font-semibold text-warn">
                        ☕ On Break · {e.activeBreakMinutes ?? 0}m
                      </span>
                    )}
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </div>
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
  const [selectedDate, setSelectedDate] = useState(dateKey);
  const [historyRows, setHistoryRows] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [from, setFrom] = useState(dateKey);
  const [to, setTo] = useState(dateKey);

  const isToday = selectedDate === dateKey;

  useEffect(() => {
    if (isToday) return;
    let active = true;
    setLoadingHistory(true);
    api
      .history(selectedDate, selectedDate)
      .then((res) => {
        if (active) {
          setHistoryRows(res.days || []);
          setLoadingHistory(false);
        }
      })
      .catch(() => {
        if (active) {
          setHistoryRows([]);
          setLoadingHistory(false);
        }
      });
    return () => {
      active = false;
    };
  }, [selectedDate, isToday]);

  const shiftDate = (days: number) => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + days);
    const newKey = d.toISOString().split('T')[0];
    setSelectedDate(newKey);
  };

  return (
    <Panel
      title={
        <div className="flex items-center gap-3">
          <span>Timesheets & Attendance</span>
          <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-800 text-indigo-400 font-semibold border border-indigo-900/50">
            {isToday ? '🟢 Live (Today)' : `📅 ${selectedDate}`}
          </span>
        </div>
      }
      actions={
        <div className="flex flex-wrap items-center gap-3">
          {/* Historical Date Picker Navigation */}
          <div className="flex items-center bg-slate-900 border border-slate-700 rounded-lg p-0.5">
            <button
              onClick={() => shiftDate(-1)}
              className="px-2.5 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-800 rounded transition font-medium"
              title="Previous Day"
            >
              ◀ Prev
            </button>
            <Input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="py-1 px-2 text-xs border-0 bg-transparent text-white font-mono focus:ring-0 cursor-pointer"
            />
            <button
              onClick={() => shiftDate(1)}
              className="px-2.5 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-800 rounded transition font-medium"
              title="Next Day"
            >
              Next ▶
            </button>
            {!isToday && (
              <button
                onClick={() => setSelectedDate(dateKey)}
                className="px-2.5 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded ml-1 transition shadow-sm"
              >
                Today
              </button>
            )}
          </div>

          {/* CSV Export Range */}
          <div className="flex items-center gap-1.5 pl-3 border-l border-slate-700">
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="py-1 text-xs w-32"
              title="Export Range Start"
            />
            <span className="text-xs text-slate-500">to</span>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="py-1 text-xs w-32"
              title="Export Range End"
            />
            <Button onClick={() => onExport(from, to)}>Export CSV</Button>
          </div>
        </div>
      }
    >
      <div className="scroll-x">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr>
              {['Employee', 'First in', 'Last seen', 'Sessions Breakdown', 'Worked', 'Break / Notes', 'Deficit', 'Status'].map(
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
            {isToday ? (
              rows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <Empty>Nobody has checked in today.</Empty>
                  </td>
                </tr>
              ) : (
                rows.map((a) => {
                  const meta = STATUS_META[a.status] ?? STATUS_META.NOT_CHECKED_IN;
                  const hasExcessBreak = (a.excessBreakMinutes ?? 0) > 0;
                  const hasDeficit = (a.dailyDeficitMinutes ?? 0) > 0;

                  return (
                    <tr key={a.employeeId}>
                      <td className="border-b border-line px-2.5 py-2.5 align-top">
                        <span className="font-semibold text-white">{a.employeeName}</span>
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
                              <div key={i} className="font-mono text-slate-300">
                                {s.from} – {s.to}
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
                        <div>
                          {a.onBreak ? (
                            <span className="font-semibold text-warn">
                              On break ({a.activeBreakMinutes ?? 0}m)
                            </span>
                          ) : a.breakMinutes ? (
                            <span>{a.breakMinutes}m</span>
                          ) : (
                            <span className="text-dim">0m</span>
                          )}
                        </div>
                        {hasExcessBreak && (
                          <div className="text-[10px] font-semibold text-danger">
                            +{a.excessBreakMinutes}m excess
                          </div>
                        )}
                      </td>
                      <td className="border-b border-line px-2.5 py-2.5 align-top">
                        {hasDeficit ? (
                          <span className="font-semibold text-danger">
                            {a.dailyDeficitMinutes}m
                          </span>
                        ) : (
                          <span className="text-dim">0m</span>
                        )}
                        {(a.lateMinutes ?? 0) > 0 && (
                          <div className="text-[10px] text-muted">
                            late: {a.lateMinutes}m
                          </div>
                        )}
                      </td>
                      <td className="border-b border-line px-2.5 py-2.5 align-top">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </td>
                    </tr>
                  );
                })
              )
            ) : loadingHistory ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-slate-400">
                  <div className="flex items-center justify-center gap-2">
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-indigo-500 border-t-transparent"></span>
                    <span>Loading timesheet records for {selectedDate}...</span>
                  </div>
                </td>
              </tr>
            ) : historyRows.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <Empty>No attendance records found for {selectedDate}.</Empty>
                </td>
              </tr>
            ) : (
              historyRows.map((h) => {
                const meta = STATUS_META[h.status as PresenceStatus] ?? STATUS_META.NOT_CHECKED_IN;
                return (
                  <tr key={h.employeeId}>
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      <span className="font-semibold text-white">{h.employeeName}</span>
                      <div className="text-[11px] text-muted">{h.role}</div>
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top font-mono text-slate-300">
                      {h.firstCheckIn}
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top font-mono text-slate-300">
                      {h.lastActive}
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top text-[11px] leading-relaxed text-muted">
                      {h.sessions && h.sessions.length
                        ? h.sessions.map((s: any, i: number) => (
                            <div key={i} className="font-mono text-slate-300">
                              {s.from} – {s.to} ({s.duration})
                            </div>
                          ))
                        : '—'}
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      <strong className="text-white">{h.timeWorked}</strong>
                      {h.adjustmentMinutes !== 0 && h.adjustmentMinutes != null && (
                        <div className="text-[11px] text-amber-400 font-medium">
                          {h.adjustmentMinutes > 0 ? `+${h.adjustmentMinutes}m` : `${h.adjustmentMinutes}m`} adj.
                          {h.adjustmentNote ? ` (${h.adjustmentNote})` : ''}
                        </div>
                      )}
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top text-xs text-slate-400">
                      {h.adjustmentNote ? h.adjustmentNote : '—'}
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      {h.totalMinutes >= 480 ? (
                        <span className="text-xs text-emerald-400 font-semibold">Completed</span>
                      ) : (
                        <span className="text-xs text-amber-400 font-semibold">
                          {480 - h.totalMinutes}m deficit
                        </span>
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

// --- attendance corrections (spec 11) --------------------------------------

export function AttendanceCorrectionsPanel({
  corrections,
  onDecide,
  onRefresh,
}: {
  corrections: AttendanceCorrection[];
  onDecide: (
    id: string,
    decision: 'APPROVED' | 'REJECTED' | 'AMENDED',
    notes: string,
    adjustmentMinutes?: number,
  ) => Promise<void>;
  onRefresh: () => void;
}) {
  const [activeCorrection, setActiveCorrection] = useState<AttendanceCorrection | null>(null);
  const [decisionAction, setDecisionAction] = useState<'APPROVED' | 'AMENDED' | 'REJECTED'>('APPROVED');
  const [adjustmentMinutes, setAdjustmentMinutes] = useState<number>(30);
  const [notes, setNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'PENDING' | 'ALL'>('PENDING');

  const filtered = corrections.filter((c) =>
    statusFilter === 'ALL' ? true : c.status === 'PENDING',
  );
  const pendingCount = corrections.filter((c) => c.status === 'PENDING').length;

  const openDecision = (
    c: AttendanceCorrection,
    action: 'APPROVED' | 'AMENDED' | 'REJECTED',
  ) => {
    setActiveCorrection(c);
    setDecisionAction(action);
    const initialMinutes =
      (c.requestedChange?.adjustmentMinutes as number | undefined) ?? 30;
    setAdjustmentMinutes(initialMinutes);
    setNotes(
      action === 'APPROVED'
        ? 'Approved as requested.'
        : action === 'AMENDED'
          ? 'Approved with modified adjustment.'
          : '',
    );
  };

  const handleConfirm = async () => {
    if (!activeCorrection) return;
    if (!notes.trim()) {
      alert('Please provide a decision note explaining the outcome.');
      return;
    }
    setSubmitting(true);
    try {
      await onDecide(
        activeCorrection.id,
        decisionAction,
        notes.trim(),
        decisionAction === 'REJECTED' ? undefined : adjustmentMinutes,
      );
      setActiveCorrection(null);
      onRefresh();
    } catch (e: unknown) {
      const err = e as Error;
      alert(err.message || 'Failed to submit decision.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Panel
      title="Attendance Disputes & Corrections"
      note={pendingCount > 0 ? `${pendingCount} pending review` : undefined}
      actions={
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'PENDING' | 'ALL')}
            className="rounded border border-line bg-raised px-2 py-1 text-xs text-text"
          >
            <option value="PENDING">Pending ({pendingCount})</option>
            <option value="ALL">All Disputes</option>
          </select>
          <Button onClick={onRefresh} className="py-1 text-xs">
            Refresh
          </Button>
        </div>
      }
    >
      {filtered.length === 0 ? (
        <Empty>No attendance disputes {statusFilter === 'PENDING' ? 'awaiting review' : 'recorded'}.</Empty>
      ) : (
        <div className="scroll-x">
          <table className="w-full min-w-[680px] border-collapse text-sm">
            <thead>
              <tr>
                {['Employee', 'Date', 'Reason & Details', 'Proposed Adjustment', 'Status', 'Actions'].map(
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
              {filtered.map((c) => {
                const isPending = c.status === 'PENDING';
                const requestedMins = c.requestedChange?.adjustmentMinutes as number | undefined;
                const statusTone =
                  c.status === 'APPROVED'
                    ? 'brand'
                    : c.status === 'REJECTED'
                      ? 'danger'
                      : 'warn';

                return (
                  <tr key={c.id} className="hover:bg-white/[0.02]">
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      <div className="font-semibold">{c.employeeName}</div>
                      <div className="text-[11px] text-muted">{c.role}</div>
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      <span className="font-mono text-xs">{c.date}</span>
                      <div className="text-[10px] text-dim">{c.requestedAt}</div>
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top max-w-[240px]">
                      <div className="text-xs leading-snug">{c.reason}</div>
                      {c.reviewNotes && (
                        <div className="mt-1 text-[11px] italic text-muted">
                          HR: {c.reviewNotes}
                        </div>
                      )}
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      {requestedMins !== undefined ? (
                        <span className="font-semibold text-brand">+{requestedMins}m</span>
                      ) : (
                        <span className="text-dim">—</span>
                      )}
                      {c.appliedChange?.adjustmentMinutes !== undefined && (
                        <div className="text-[10px] text-dim">
                          applied: +{String(c.appliedChange.adjustmentMinutes)}m
                        </div>
                      )}
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      <Badge tone={statusTone}>{c.status}</Badge>
                    </td>
                    <td className="border-b border-line px-2.5 py-2.5 align-top">
                      {isPending ? (
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="primary"
                            onClick={() => openDecision(c, 'APPROVED')}
                            className="py-1 px-2 text-[11px]"
                          >
                            Approve
                          </Button>
                          <Button
                            onClick={() => openDecision(c, 'AMENDED')}
                            className="py-1 px-2 text-[11px]"
                          >
                            Amend
                          </Button>
                          <Button
                            onClick={() => openDecision(c, 'REJECTED')}
                            className="py-1 px-2 text-[11px] text-danger hover:bg-danger-dim"
                          >
                            Reject
                          </Button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-dim">Decided {c.reviewedAt ?? ''}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeCorrection && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6">
            <h2 className="text-base font-bold text-text">
              {decisionAction === 'APPROVED'
                ? 'Approve Attendance Dispute'
                : decisionAction === 'AMENDED'
                  ? 'Amend & Approve Attendance Dispute'
                  : 'Reject Attendance Dispute'}
            </h2>
            <p className="mt-1 text-xs text-muted">
              {activeCorrection.employeeName} · {activeCorrection.date}
            </p>

            <div className="my-4 rounded-lg bg-raised p-3 text-xs">
              <div className="text-dim">Reason:</div>
              <div className="mt-0.5 text-text font-medium">{activeCorrection.reason}</div>
            </div>

            {decisionAction !== 'REJECTED' && (
              <div className="mb-4">
                <label className="block text-xs font-semibold text-text mb-1">
                  Adjustment Minutes to Credit (Spec 11)
                </label>
                <Input
                  type="number"
                  value={adjustmentMinutes}
                  onChange={(e) => setAdjustmentMinutes(Math.max(0, parseInt(e.target.value) || 0))}
                  className="w-full"
                />
                <span className="text-[11px] text-muted mt-1 block">
                  This will reduce the employee&apos;s daily deficit balance and recompute attendance.
                </span>
              </div>
            )}

            <div className="mb-5">
              <label className="block text-xs font-semibold text-text mb-1">
                Decision Note {decisionAction === 'REJECTED' ? '(Required - explain rejection)' : '(Required)'}
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Explain the decision rationale for the audit log and employee..."
                rows={3}
                className="w-full rounded-lg border border-line bg-raised p-2.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button onClick={() => setActiveCorrection(null)} disabled={submitting}>
                Cancel
              </Button>
              <Button
                variant={decisionAction === 'REJECTED' ? 'ghost' : 'primary'}
                onClick={handleConfirm}
                disabled={submitting}
                className={decisionAction === 'REJECTED' ? 'bg-danger text-white hover:bg-danger/90' : ''}
              >
                {submitting ? 'Submitting…' : `Confirm ${decisionAction}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

