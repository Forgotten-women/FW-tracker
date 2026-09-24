'use client';

// Live view of an employee's workstation screen.
//
// One session = request-stream, then poll live-frame about once a second. The
// backend answers every poll with a `phase` (see LivePhase in lib/types.ts), so
// this component is a small state machine over that answer rather than a
// spinner with a fixed timeout. The old viewer gave up after ~10s while older
// agents only checked for requests every 20s, which is why most attempts
// "timed out" before the laptop had even heard about them.

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { LiveFrameResponse, LivePhase, LiveStreamRequestResponse } from '@/lib/types';
import { Button } from '@/components/primitives';
import {
  AlertTriangleIcon,
  CheckIcon,
  ClockIcon,
  CoffeeIcon,
  LaptopIcon,
  LockIcon,
  MaximizeIcon,
  MinimizeIcon,
  RefreshIcon,
  XIcon,
} from '@/components/icons';

type ViewPhase =
  | 'REQUESTING'
  | LivePhase
  | 'NO_RESPONSE' // the laptop never picked the request up
  | 'NO_FRAME' // it did, but no frame arrived (or frames stopped)
  | 'ERROR';

const POLL_MS = 1000;
const BREAK_POLL_MS = 5000; // a break ends on its own; no need to ask every second
const WAIT_LIMIT_INSTANT_MS = 15_000; // agent with the instant doorbell (v1.0.32+)
const WAIT_LIMIT_LEGACY_MS = 40_000; // older agents check for requests every 20s
const START_LIMIT_MS = 20_000; // acknowledged, but no first frame yet
const STALL_LIMIT_MS = 20_000; // was live, frames stopped arriving
const MAX_POLL_ERRORS = 3;

function toSrc(frame: string) {
  return frame.startsWith('data:') ? frame : `data:image/jpeg;base64,${frame}`;
}

function errorMessage(err: unknown) {
  return err instanceof Error && err.message ? err.message : 'Could not reach the server.';
}

function clockTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ago(ms: number, now: number) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

interface Props {
  deviceId: string;
  employeeName: string;
  model?: string | null;
  onClose: () => void;
}

export function LiveScreenViewer({ deviceId, employeeName, model, onClose }: Props) {
  const [session, setSession] = useState(0);
  const [phase, setPhase] = useState<ViewPhase>('REQUESTING');
  const [info, setInfo] = useState<LiveFrameResponse | null>(null);
  const [request, setRequest] = useState<LiveStreamRequestResponse | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [frameAt, setFrameAt] = useState<number | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [fullscreen, setFullscreen] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);

  // Clock for the "12s ago" labels.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const resetSession = () => {
    setPhase('REQUESTING');
    setInfo(null);
    setRequest(null);
    setFrameSrc(null);
    setFrameAt(null);
    setErrorText(null);
    setStartedAt(Date.now());
    setSession((s) => s + 1);
  };

  // Nobody is looking at a hidden tab: end the stream so the laptop stops
  // capturing, and start a fresh one when the tab is shown again.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        setTabHidden(true);
        api.stopLiveStream(deviceId).catch(() => {});
      } else {
        setTabHidden(false);
        resetSession();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [deviceId]);

  // One session: request the stream, then poll until a final state.
  useEffect(() => {
    if (tabHidden) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sessionStart = Date.now();
    let instantStart = false;
    let shownFrameAt: number | null = null;
    let lastLiveAt: number | null = null;
    let ackSeenAt: number | null = null;
    let pollErrors = 0;

    const next = (ms: number) => {
      if (!cancelled) timer = setTimeout(poll, ms);
    };

    const poll = async () => {
      let res: LiveFrameResponse;
      try {
        res = await api.fetchLiveFrame(deviceId, shownFrameAt);
      } catch (err) {
        if (cancelled) return;
        pollErrors += 1;
        if (pollErrors >= MAX_POLL_ERRORS) {
          setErrorText(errorMessage(err));
          setPhase('ERROR');
          return;
        }
        next(POLL_MS * 2);
        return;
      }
      if (cancelled) return;
      pollErrors = 0;
      setInfo(res);

      const t = Date.now();
      const p: LivePhase = res.phase ?? (res.active ? 'LIVE' : 'WAITING');

      if (p === 'LIVE') {
        lastLiveAt = t;
        if (res.frameBase64) {
          shownFrameAt = res.lastFrameAt ?? t;
          setFrameSrc(toSrc(res.frameBase64));
          setFrameAt(shownFrameAt);
        }
        setPhase('LIVE');
        next(POLL_MS);
        return;
      }

      if (p === 'OFFLINE' || p === 'OUTSIDE_HOURS' || p === 'ENDED') {
        setPhase(p);
        return;
      }

      if (p === 'PAUSED_BREAK') {
        setPhase(p);
        next(BREAK_POLL_MS);
        return;
      }

      // WAITING or STARTING. Frames that were flowing and stopped count as a stall.
      if (lastLiveAt !== null) {
        if (t - lastLiveAt > STALL_LIMIT_MS) {
          setPhase('NO_FRAME');
          return;
        }
        setPhase(p);
        next(POLL_MS);
        return;
      }

      if (p === 'STARTING') {
        if (ackSeenAt === null) ackSeenAt = t;
        if (t - ackSeenAt > START_LIMIT_MS) {
          setPhase('NO_FRAME');
          return;
        }
        setPhase('STARTING');
        next(POLL_MS);
        return;
      }

      const limit = instantStart && res.agent?.doorbell ? WAIT_LIMIT_INSTANT_MS : WAIT_LIMIT_LEGACY_MS;
      if (t - sessionStart > limit) {
        setPhase('NO_RESPONSE');
        return;
      }
      setPhase('WAITING');
      next(POLL_MS);
    };

    (async () => {
      try {
        const r = await api.requestLiveStream(deviceId);
        if (cancelled) return;
        setRequest(r);
        instantStart = r.doorbell === 'SENT';
      } catch (err) {
        if (!cancelled) {
          setErrorText(errorMessage(err));
          setPhase('ERROR');
        }
        return;
      }
      poll();
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [deviceId, session, tabHidden]);

  const close = () => {
    api.stopLiveStream(deviceId).catch(() => {});
    onClose();
  };

  const isLive = phase === 'LIVE';
  const connecting = phase === 'REQUESTING' || phase === 'WAITING' || phase === 'STARTING';
  const stalled = Boolean(frameSrc) && !isLive;
  const warning = request?.warning || info?.warning || null;
  const instant = request?.doorbell === 'SENT' && Boolean(info?.agent?.doorbell);
  const agentVersion = info?.agent?.version || null;

  const stepState = (step: 0 | 1 | 2): 'done' | 'active' | 'todo' => {
    const reached = isLive ? 3 : phase === 'STARTING' ? 2 : phase === 'WAITING' ? 1 : phase === 'REQUESTING' ? 0 : -1;
    if (reached < 0) return 'todo';
    if (step < reached) return 'done';
    return step === reached ? 'active' : 'todo';
  };

  const dot = isLive
    ? 'bg-rose-500'
    : connecting || stalled
      ? 'bg-amber-400'
      : 'bg-slate-500';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={`Live screen of ${employeeName}`}
    >
      <div
        className={`glass-panel-elevated flex w-full flex-col overflow-hidden rounded-3xl transition-all duration-300 ${
          fullscreen ? 'h-[95vh] max-w-7xl' : 'max-h-[90vh] max-w-4xl'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              {(isLive || connecting) && (
                <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${dot}`} />
              )}
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dot}`} />
            </span>
            <span className="text-xs font-extrabold uppercase tracking-wider text-slate-300">Live screen</span>
            <span className="text-slate-500">·</span>
            <span className="truncate text-sm font-bold text-white">{employeeName}</span>
            {model && (
              <span className="hidden rounded-md border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[11px] text-slate-400 sm:inline-block">
                {model}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setFullscreen((f) => !f)}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white cursor-pointer"
            >
              {fullscreen ? <MinimizeIcon className="h-3.5 w-3.5" /> : <MaximizeIcon className="h-3.5 w-3.5" />}
              {fullscreen ? 'Normal' : 'Expand'}
            </button>
            <button
              type="button"
              onClick={close}
              aria-label="Close live screen"
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white cursor-pointer"
            >
              <XIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Progress while connecting */}
        {connecting && (
          <ol className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/8 px-5 py-2.5 text-[11px] font-semibold">
            {(['Request sent', 'Laptop notified', 'First frame'] as const).map((label, i) => {
              const st = stepState(i as 0 | 1 | 2);
              return (
                <li key={label} className="flex items-center gap-2">
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                      st === 'done'
                        ? 'border-transparent bg-emerald-500 text-on-accent'
                        : st === 'active'
                          ? 'border-indigo-400 text-indigo-300'
                          : 'border-white/15 text-slate-500'
                    }`}
                  >
                    {st === 'done' ? (
                      <CheckIcon className="h-3 w-3" />
                    ) : st === 'active' ? (
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                    ) : (
                      <span className="text-[10px]">{i + 1}</span>
                    )}
                  </span>
                  <span className={st === 'todo' ? 'text-slate-500' : 'text-slate-200'}>{label}</span>
                </li>
              );
            })}
            <li className="ml-auto font-mono text-slate-500 tnum">{Math.max(0, Math.round((now - startedAt) / 1000))}s</li>
          </ol>
        )}

        {warning === 'LIVE_STORE_NOT_SHARED' && (
          <div className="flex items-start gap-2.5 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2.5 text-xs text-amber-300">
            <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>Server setup needed:</strong> live frames need Upstash Redis on the backend
              (<code className="font-mono">UPSTASH_REDIS_REST_URL</code> / <code className="font-mono">_TOKEN</code> in Vercel).
              Without it, frames usually can&apos;t reach this viewer.
            </span>
          </div>
        )}

        {/* Viewport: always black -- it's a picture of someone's screen, not UI chrome */}
        <div className="relative flex min-h-[380px] flex-1 items-center justify-center overflow-hidden bg-black p-4">
          {frameSrc ? (
            <div className="relative flex max-h-full max-w-full items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL frame, not a static asset */}
              <img
                src={frameSrc}
                alt={`Live screen of ${employeeName}`}
                className={`max-h-[72vh] w-auto max-w-full rounded-lg border border-white/10 object-contain shadow-2xl transition ${
                  stalled ? 'opacity-40 grayscale' : ''
                }`}
              />
              <div className="absolute left-2 top-2 flex items-center gap-2 rounded-md border border-white/10 bg-black/75 px-2.5 py-1 font-mono text-[10px] text-slate-200 backdrop-blur-md">
                <span className={`h-2 w-2 rounded-full ${isLive ? 'animate-pulse bg-emerald-400' : 'bg-amber-400'}`} />
                {isLive ? (
                  info?.unchanged && frameAt ? (
                    <span>LIVE · screen unchanged {ago(frameAt, now)}</span>
                  ) : (
                    <span>LIVE{frameAt ? ` · ${ago(frameAt, now)}` : ''}</span>
                  )
                ) : (
                  <span>RECONNECTING…</span>
                )}
              </div>
              {stalled && !connecting && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <StatusCard
                    phase={phase}
                    info={info}
                    errorText={errorText}
                    now={now}
                    employeeName={employeeName}
                    instant={instant}
                    agentVersion={agentVersion}
                    doorbell={request?.doorbell}
                    onRetry={resetSession}
                  />
                </div>
              )}
            </div>
          ) : (
            <StatusCard
              phase={phase}
              info={info}
              errorText={errorText}
              now={now}
              employeeName={employeeName}
              instant={instant}
              agentVersion={agentVersion}
              doorbell={request?.doorbell}
              onRetry={resetSession}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col items-center justify-between gap-2 border-t border-white/10 px-5 py-3 text-[11px] text-slate-400 sm:flex-row">
          <div className="flex items-center gap-2">
            <LockIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span>
              <strong className="text-slate-300">Never stored:</strong> frames live in memory for a few seconds and
              are never saved to disk or the database. Pauses automatically during breaks.
            </span>
          </div>
          <Button size="sm" variant="secondary" onClick={close}>
            Close viewer
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusCard({
  phase,
  info,
  errorText,
  now,
  employeeName,
  instant,
  agentVersion,
  doorbell,
  onRetry,
}: {
  phase: ViewPhase;
  info: LiveFrameResponse | null;
  errorText: string | null;
  now: number;
  employeeName: string;
  instant: boolean;
  agentVersion: string | null;
  doorbell?: LiveStreamRequestResponse['doorbell'];
  onRetry: () => void;
}) {
  const first = employeeName.split(' ')[0] || employeeName;

  const retry = (
    <button
      type="button"
      onClick={onRetry}
      className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-accent-gradient px-3.5 py-1.5 text-xs font-bold text-on-accent shadow-accent transition hover:brightness-110 cursor-pointer"
    >
      <RefreshIcon className="h-3.5 w-3.5" />
      Try again
    </button>
  );

  const spinner = (
    <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
  );

  let icon: React.ReactNode = null;
  let title = '';
  let body: React.ReactNode = null;
  let action: React.ReactNode = null;
  let tone = 'text-white';

  switch (phase) {
    case 'REQUESTING':
      icon = spinner;
      title = 'Sending the request…';
      break;
    case 'WAITING':
      icon = spinner;
      title = `Waiting for ${first}'s laptop…`;
      body = instant
        ? 'The laptop was notified instantly. This normally takes a few seconds.'
        : doorbell === 'UNAVAILABLE'
          ? 'Instant start isn\'t set up on the server yet, so the laptop picks this up on its next check (up to 20 seconds).'
          : `This laptop${agentVersion ? ` (agent v${agentVersion})` : ''} checks for requests every 20 seconds. Agent v1.0.32+ starts instantly.`;
      break;
    case 'STARTING':
      icon = spinner;
      title = 'Laptop connected, capturing the first frame…';
      break;
    case 'PAUSED_BREAK':
      icon = <CoffeeIcon className="mx-auto h-10 w-10 text-amber-400" />;
      title = `${first} is on a break`;
      body = info?.breakMessage || 'Screen viewing is paused for privacy. It resumes automatically when the break ends.';
      break;
    case 'OUTSIDE_HOURS':
      icon = <ClockIcon className="mx-auto h-10 w-10 text-slate-400" />;
      title = 'Outside working hours';
      body = "Screen viewing is only available during the employee's working hours (15 minutes either side).";
      action = retry;
      break;
    case 'OFFLINE':
      icon = <LaptopIcon className="mx-auto h-10 w-10 text-slate-400" />;
      title = 'The laptop is offline';
      body = info?.lastSeenAt
        ? `Last heard from at ${clockTime(info.lastSeenAt)} (${ago(info.lastSeenAt, now)}). It may be asleep, shut down, or off the network.`
        : 'This laptop has not checked in today. It may be shut down, or the agent may not be running.';
      action = retry;
      break;
    case 'ENDED':
      icon = <LaptopIcon className="mx-auto h-10 w-10 text-slate-400" />;
      title = 'The stream ended';
      action = retry;
      break;
    case 'NO_RESPONSE':
      icon = <AlertTriangleIcon className="mx-auto h-9 w-9 text-rose-400" />;
      tone = 'text-rose-300';
      title = "The laptop didn't respond";
      body = (
        <ul className="mx-auto mt-1 max-w-sm list-disc space-y-1 pl-5 text-left">
          <li>The Office Tracker agent may not be running, or the laptop is asleep.</li>
          {!instant && <li>Older agents only check every 20 seconds; update to v1.0.32 for instant start.</li>}
        </ul>
      );
      action = retry;
      break;
    case 'NO_FRAME':
      icon = <AlertTriangleIcon className="mx-auto h-9 w-9 text-rose-400" />;
      tone = 'text-rose-300';
      title = 'No picture from the laptop';
      body = 'The laptop answered but no frames are arriving. This happens while the screen is locked or on the sign-in screen, or when its network drops.';
      action = retry;
      break;
    case 'ERROR':
      icon = <AlertTriangleIcon className="mx-auto h-9 w-9 text-rose-400" />;
      tone = 'text-rose-300';
      title = errorText || 'Something went wrong';
      action = retry;
      break;
    default:
      return null;
  }

  return (
    <div className="max-w-md space-y-3 rounded-2xl border border-white/10 bg-slate-950/85 p-7 text-center shadow-2xl backdrop-blur-md animate-fade-in">
      {icon}
      <h3 className={`text-base font-bold ${tone}`}>{title}</h3>
      {body && <div className="text-xs leading-relaxed text-slate-400">{body}</div>}
      {action}
    </div>
  );
}
