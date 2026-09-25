'use client';

// Everything recorded about one day: the month's summary row is shown at once,
// the full detail (sessions, breaks, corrections, laptop, apps, movements)
// fills in when it arrives.

import { useEffect, useRef, type ReactNode } from 'react';
import type { HistoryBreak, HistoryDayDetail, HistoryDaySummary, HistorySession } from '@/lib/types';
import { Badge, Button } from '@/components/primitives';
import {
  ActivityIcon,
  AlertTriangleIcon,
  CameraIcon,
  ChartBarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CoffeeIcon,
  LaptopIcon,
  PalmTreeIcon,
  PencilIcon,
  RefreshIcon,
  ScaleIcon,
  XIcon,
} from '@/components/icons';
import { formatTimestamp } from '@/components/payroll/format';
import { deficitLines, describeRequestedChange, fmtMinutes, longDate, sentenceCase, statusMeta } from './historyMeta';

interface DayDetailPanelProps {
  dateKey: string;
  /** The month's row for this day, shown while the detail loads. */
  summary: HistoryDaySummary | null;
  detail: HistoryDayDetail | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onViewScreenshots: (dateKey: string) => void;
}

const CORRECTION_TONE: Record<string, string> = {
  PENDING: 'warn',
  APPROVED: 'ok',
  AMENDED: 'info',
  REJECTED: 'danger',
  INFO_REQUESTED: 'accent',
};

// The movements query stops at 200 rows (backend/src/domain/history.js).
const MOVEMENTS_LIMIT = 200;

function Section({ title, icon, aside, children }: { title: string; icon: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass-panel rounded-2xl p-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-bold text-white">
          <span className="text-slate-400">{icon}</span>
          {title}
        </h4>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, tone = 'text-white', hint }: { label: string; value: ReactNode; tone?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/5 p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-0.5 font-mono text-sm font-bold tnum ${tone}`}>{value}</div>
      {hint && <div className="text-[10px] text-slate-500">{hint}</div>}
    </div>
  );
}

function SkeletonLines({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-8 animate-pulse rounded-lg bg-white/5" />
      ))}
    </div>
  );
}

/** Sessions (and breaks beneath them) laid out across the span of the day that was recorded. */
function Timeline({ sessions, breaks }: { sessions: HistorySession[]; breaks: HistoryBreak[] }) {
  const spans = sessions
    .map((s) => ({
      start: s.startAt,
      end: s.endAt ?? (s.startAt ? s.startAt + s.minutes * 60000 : null),
      label: s.start,
      endLabel: s.end,
    }))
    .filter((s): s is { start: number; end: number; label: string | null; endLabel: string | null } => !!s.start && !!s.end && s.end > s.start);
  const pauses = breaks
    .map((b) => ({ start: b.startedAt, end: b.endedAt ?? b.startedAt + (b.actualMinutes ?? 0) * 60000, over: b.excessMinutes > 0 }))
    .filter((b) => b.start && b.end > b.start);
  if (spans.length === 0) return null;

  const min = Math.min(...spans.map((s) => s.start), ...pauses.map((b) => b.start));
  const max = Math.max(...spans.map((s) => s.end), ...pauses.map((b) => b.end));
  const range = max - min || 1;
  const pos = (t: number) => ((t - min) / range) * 100;
  const first = spans[0];
  const last = spans[spans.length - 1];

  return (
    <div className="mb-3" aria-hidden="true">
      <div className="relative h-9 overflow-hidden rounded-xl border border-white/8 bg-white/5">
        {spans.map((s, i) => (
          <div
            key={`s-${i}`}
            className="absolute top-1 bottom-2.5 rounded-md bg-emerald-500/60"
            style={{ left: `${pos(s.start)}%`, width: `${Math.max(0.6, pos(s.end) - pos(s.start))}%` }}
          />
        ))}
        {pauses.map((b, i) => (
          <div
            key={`b-${i}`}
            className={`absolute bottom-0.5 h-1.5 rounded-full ${b.over ? 'bg-rose-400' : 'bg-amber-400'}`}
            style={{ left: `${pos(b.start)}%`, width: `${Math.max(0.6, pos(b.end) - pos(b.start))}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500 tnum">
        <span>{first.label ?? ''}</span>
        <span>{last.endLabel === 'now' ? 'now' : last.endLabel ?? ''}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-emerald-500/60" /> present</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-3 rounded-full bg-amber-400" /> break</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-3 rounded-full bg-rose-400" /> break over allowance</span>
      </div>
    </div>
  );
}

export function DayDetailPanel({
  dateKey,
  summary,
  detail,
  loading,
  error,
  onRetry,
  onClose,
  onPrev,
  onNext,
  onViewScreenshots,
}: DayDetailPanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the panel when a day is opened, so keyboard and screen
  // reader users land on what they asked for.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [dateKey]);

  const day: HistoryDaySummary | null = detail ?? summary;
  const meta = day ? statusMeta(day.status) : null;
  const lines = day ? deficitLines(day.deficit) : [];
  const worked = day?.workedMinutes ?? 0;

  return (
    <section
      aria-labelledby={`history-day-${dateKey}`}
      className="glass-panel-elevated rounded-2xl p-4 sm:p-5 space-y-4 animate-fade-in"
    >
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            id={`history-day-${dateKey}`}
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-extrabold tracking-tight text-white focus:outline-none"
          >
            {longDate(dateKey)}
          </h3>
          {day && meta && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Badge tone={meta.tone} size="md">
                <span className={meta.glyph} aria-hidden="true">{meta.icon('h-3.5 w-3.5')}</span>
                {day.statusLabel || meta.label}
              </Badge>
              {day.attendanceStatus && day.attendanceStatus !== day.status && (
                <span className="text-[11px] text-slate-500">Recorded as {sentenceCase(day.attendanceStatus)}</span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={onPrev ?? undefined} disabled={!onPrev} aria-label="Previous day" icon={<ChevronLeftIcon className="h-4 w-4" />} />
          <Button variant="ghost" size="sm" onClick={onNext ?? undefined} disabled={!onNext} aria-label="Next day" icon={<ChevronRightIcon className="h-4 w-4" />} />
          <Button variant="secondary" size="sm" onClick={onClose} aria-label="Close day details" icon={<XIcon className="h-4 w-4" />} />
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onViewScreenshots(dateKey)}
          icon={<CameraIcon className="h-3.5 w-3.5 text-sky-400" />}
        >
          View screenshots for this day
        </Button>
        {day && (
          <span className="text-[11px] text-slate-400">
            {day.isWorkingDay
              ? `Scheduled ${day.scheduledStart ?? '—'} – ${day.scheduledEnd ?? '—'}`
              : day.nonWorkingReason || sentenceCase(day.dayType)}
          </span>
        )}
      </div>

      {day && (
        <>
          {/* Figures */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="First in" value={day.firstIn ?? '—'} tone={day.deficit.lateMinutes > 0 ? 'text-amber-300' : 'text-white'} />
            <Stat label="Last out" value={day.lastOut ?? '—'} />
            <Stat label="Worked" value={worked > 0 ? fmtMinutes(worked) : '0m'} tone="text-emerald-400" />
            <Stat
              label="Break"
              value={`${day.breakMinutes}m`}
              tone={day.deficit.excessBreakMinutes > 0 ? 'text-rose-400' : 'text-amber-300'}
              hint={day.deficit.excessBreakMinutes > 0 ? `${day.deficit.excessBreakMinutes}m over allowance` : undefined}
            />
          </div>

          {/* Deficit in words */}
          <Section
            title="Deficit"
            icon={<ScaleIcon className="h-4 w-4" />}
            aside={
              <span className={`font-mono text-sm font-bold tnum ${day.deficit.totalMinutes > 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                {day.deficit.totalMinutes > 0 ? `−${fmtMinutes(day.deficit.totalMinutes)}` : '0m'}
              </span>
            }
          >
            {lines.length === 0 ? (
              <p className="text-xs text-slate-400">
                {day.deficit.totalMinutes > 0
                  ? `A net deficit of ${fmtMinutes(day.deficit.totalMinutes)} was recorded for this day.`
                  : 'No deficit was recorded for this day.'}
              </p>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {lines.map((l) => (
                  <li key={l.text} className="flex items-start justify-between gap-3">
                    <span className="text-slate-300">{l.text}</span>
                    <span className={`shrink-0 font-mono font-semibold tnum ${l.credit ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {l.credit ? '+' : '−'}{fmtMinutes(l.minutes)}
                    </span>
                  </li>
                ))}
                <li className="flex items-start justify-between gap-3 border-t border-white/8 pt-1.5 font-semibold">
                  <span className="text-white">Net deficit for the day</span>
                  <span className="shrink-0 font-mono text-rose-400 tnum">−{fmtMinutes(day.deficit.totalMinutes)}</span>
                </li>
              </ul>
            )}
            {day.adjustment && (
              <p className="mt-3 rounded-xl border border-indigo-500/25 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200">
                <strong className="font-semibold">HR time adjustment:</strong>{' '}
                <span className="font-mono tnum">{day.adjustment.minutes > 0 ? '+' : '−'}{fmtMinutes(Math.abs(day.adjustment.minutes))}</span>
                {day.adjustment.note ? ` — ${day.adjustment.note}` : ''}
              </p>
            )}
          </Section>

          {/* Leave and absence */}
          {(day.leave || day.absence) && (
            <Section title="Leave and absence" icon={<PalmTreeIcon className="h-4 w-4" />}>
              <div className="space-y-2 text-xs">
                {day.leave && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-500/25 bg-sky-500/10 px-3 py-2">
                    <span className="font-semibold text-sky-200">
                      {day.leave.type}
                      <span className="font-normal text-sky-300/80">
                        {' · '}{day.leave.dayPortion === 'FULL' ? 'Full day' : `${sentenceCase(day.leave.dayPortion)} (half day)`}
                        {day.leave.isPaid === null ? '' : day.leave.isPaid ? ' · Paid' : ' · Unpaid'}
                      </span>
                    </span>
                    <Badge tone={day.leave.status === 'APPROVED' ? 'ok' : 'warn'} size="sm">
                      {day.leave.status === 'APPROVED' ? 'Approved' : 'Pending approval'}
                    </Badge>
                  </div>
                )}
                {day.absence && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2">
                    <span className="font-semibold text-rose-200">
                      {sentenceCase(day.absence.type) || 'Absence'}
                      {day.absence.treatAsUnpaid && <span className="font-normal text-rose-300/80"> · Treated as unpaid</span>}
                    </span>
                    <Badge tone={day.absence.status === 'CONFIRMED' ? 'danger' : day.absence.status === 'DISMISSED' ? 'muted' : 'warn'} size="sm">
                      {sentenceCase(day.absence.status)}
                    </Badge>
                  </div>
                )}
              </div>
            </Section>
          )}
        </>
      )}

      {/* Detail-only sections */}
      {error ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
          <span className="flex items-center gap-2">
            <AlertTriangleIcon className="h-4 w-4 shrink-0" />
            Could not load the rest of this day: {error}
          </span>
          <Button variant="danger" size="sm" onClick={onRetry} icon={<RefreshIcon className="h-3.5 w-3.5" />}>
            Retry
          </Button>
        </div>
      ) : loading || !detail ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only">Loading the day’s sessions, breaks and activity…</span>
          {!day && <SkeletonLines rows={2} />}
          <SkeletonLines rows={3} />
        </div>
      ) : (
        <>
          <Section
            title="Sessions"
            icon={<ClockIcon className="h-4 w-4" />}
            aside={<span className="text-[11px] text-slate-400">{detail.sessions.length}</span>}
          >
            {detail.sessions.length === 0 ? (
              <p className="text-xs text-slate-400">No presence sessions were recorded.</p>
            ) : (
              <>
                <Timeline sessions={detail.sessions} breaks={detail.breaks} />
                <ol className="space-y-1.5 text-xs">
                  {detail.sessions.map((s, i) => (
                    <li key={`${s.startAt}-${i}`} className="flex items-center justify-between gap-3 rounded-lg border border-white/6 bg-white/5 px-3 py-1.5">
                      <span className="font-mono text-slate-200 tnum">
                        {s.start ?? '—'} <span className="text-slate-500">→</span>{' '}
                        {s.end === 'now' ? <span className="text-emerald-400">now (open)</span> : s.end ?? '—'}
                      </span>
                      <span className="font-mono font-semibold text-emerald-400 tnum">{s.duration}</span>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </Section>

          <Section
            title="Breaks"
            icon={<CoffeeIcon className="h-4 w-4" />}
            aside={<span className="text-[11px] text-slate-400">{detail.breaks.length}</span>}
          >
            {detail.breaks.length === 0 ? (
              <p className="text-xs text-slate-400">No breaks were recorded.</p>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {detail.breaks.map((b, i) => {
                  const over = b.excessMinutes > 0;
                  return (
                    <li
                      key={`${b.startedAt}-${i}`}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-1.5 ${
                        over ? 'border-rose-500/35 bg-rose-500/10' : 'border-white/6 bg-white/5'
                      }`}
                    >
                      <span className="font-mono text-slate-200 tnum">
                        {b.start ?? '—'} <span className="text-slate-500">→</span> {b.end ?? <span className="text-amber-300">still on break</span>}
                      </span>
                      <span className="flex items-center gap-2 font-mono tnum">
                        <span className="text-slate-300">
                          {b.actualMinutes === null ? '—' : `${b.actualMinutes}m`}
                          {b.permittedMinutes ? <span className="text-slate-500"> / {b.permittedMinutes}m allowed</span> : null}
                        </span>
                        {over && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-rose-500/15 px-1.5 py-0.5 font-bold text-rose-300">
                            <AlertTriangleIcon className="h-3 w-3" /> +{b.excessMinutes}m over
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section
            title="Correction requests"
            icon={<PencilIcon className="h-4 w-4" />}
            aside={
              day && day.corrections.pending > 0 ? (
                <Badge tone="warn" size="sm">{day.corrections.pending} pending</Badge>
              ) : (
                <span className="text-[11px] text-slate-400">{detail.correctionRequests.length}</span>
              )
            }
          >
            {detail.correctionRequests.length === 0 ? (
              <p className="text-xs text-slate-400">No corrections were requested for this day.</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {detail.correctionRequests.map((c) => {
                  const change = describeRequestedChange(c.requestedChange);
                  return (
                    <li key={c.id} className="rounded-xl border border-white/8 bg-white/5 p-3 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Badge tone={CORRECTION_TONE[c.status] ?? 'muted'} size="sm">{sentenceCase(c.status)}</Badge>
                        <span className="text-[11px] text-slate-500">Requested {formatTimestamp(c.requestedAt)}</span>
                      </div>
                      {change.length > 0 && (
                        <ul className="font-semibold text-slate-200">
                          {change.map((line) => <li key={line}>{line}</li>)}
                        </ul>
                      )}
                      {c.reason && <p className="text-slate-300">“{c.reason}”</p>}
                      {(c.reviewedAt || c.reviewNotes) && (
                        <p className="border-t border-white/6 pt-1.5 text-slate-400">
                          {c.reviewedAt && <>Reviewed {formatTimestamp(c.reviewedAt)}{c.reviewNotes ? ': ' : ''}</>}
                          {c.reviewNotes && <span className="text-slate-300">{c.reviewNotes}</span>}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section
            title="Laptop"
            icon={<LaptopIcon className="h-4 w-4" />}
            aside={
              detail.laptop ? (
                <span className="font-mono text-[11px] text-slate-400 tnum">
                  {fmtMinutes(detail.laptop.activeMinutes)} active · {fmtMinutes(detail.laptop.idleMinutes)} idle
                </span>
              ) : undefined
            }
          >
            {detail.laptopSessions.length === 0 ? (
              <p className="text-xs text-slate-400">No laptop activity was recorded.</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {detail.laptopSessions.map((l, i) => (
                  <li key={`${l.deviceId}-${i}`} className="rounded-xl border border-white/8 bg-white/5 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-cyan-300">{l.device}</span>
                      <span className="font-mono text-[11px] text-slate-400 tnum">
                        {l.firstSeen ?? '—'} → {l.lastSeen ?? '—'}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Stat label="Active" value={fmtMinutes(l.activeMinutes)} tone="text-emerald-400" />
                      <Stat label="Idle" value={fmtMinutes(l.idleMinutes)} tone="text-slate-300" />
                      <Stat label="Break" value={fmtMinutes(l.breakMinutes)} tone="text-amber-300" />
                      <Stat label="Unverified" value={fmtMinutes(l.unverifiedMinutes)} tone={l.unverifiedMinutes > 0 ? 'text-rose-400' : 'text-slate-400'} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {detail.topApps && (
            <Section title="Top applications" icon={<ChartBarIcon className="h-4 w-4" />}>
              {detail.topApps.length === 0 ? (
                <p className="text-xs text-slate-400">No application usage was recorded.</p>
              ) : (
                <ul className="space-y-1.5 text-xs">
                  {(() => {
                    const top = Math.max(1, ...detail.topApps.map((a) => a.minutes));
                    return detail.topApps.map((a) => (
                      <li key={a.app} className="space-y-1">
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate text-slate-200">{a.app}</span>
                          <span className="shrink-0 font-mono text-slate-400 tnum">{fmtMinutes(a.minutes)}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-white/8" aria-hidden="true">
                          <div className="h-full rounded-full bg-accent-gradient" style={{ width: `${Math.max(2, (a.minutes / top) * 100)}%` }} />
                        </div>
                      </li>
                    ));
                  })()}
                </ul>
              )}
            </Section>
          )}

          {detail.movements && (
            <Section
              title="Movements log"
              icon={<ActivityIcon className="h-4 w-4" />}
              aside={<span className="text-[11px] text-slate-400">{detail.movements.length}</span>}
            >
              {detail.movements.length === 0 ? (
                <p className="text-xs text-slate-400">No movements were logged.</p>
              ) : (
                <>
                  <ol className="max-h-72 space-y-1 overflow-y-auto pr-1 text-xs">
                    {detail.movements.map((m, i) => (
                      <li key={`${m.at}-${i}`} className="flex items-start gap-3 rounded-lg px-2 py-1 hover:bg-white/5">
                        <span className="w-24 shrink-0 font-mono text-slate-400 tnum">{m.time ?? '—'}</span>
                        <span className="shrink-0 font-semibold text-slate-200">{sentenceCase(m.type)}</span>
                        {m.details && <span className="min-w-0 break-words text-slate-400">{m.details}</span>}
                      </li>
                    ))}
                  </ol>
                  {detail.movements.length >= MOVEMENTS_LIMIT && (
                    <p className="mt-2 text-[11px] text-slate-500">Showing the first {MOVEMENTS_LIMIT} events of the day.</p>
                  )}
                </>
              )}
            </Section>
          )}
        </>
      )}
    </section>
  );
}
