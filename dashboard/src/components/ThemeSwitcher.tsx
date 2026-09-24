'use client';

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

type Mode = 'light' | 'dark' | 'system';
type Accent = 'indigo' | 'teal' | 'rose' | 'amber' | 'sky';

const MODE_KEY = 'ot-theme';
const ACCENT_KEY = 'ot-accent';

const ACCENTS: { id: Accent; label: string; from: string; to: string }[] = [
  { id: 'indigo', label: 'Indigo', from: '#6366f1', to: '#8b5cf6' },
  { id: 'teal', label: 'Teal', from: '#14b8a6', to: '#06b6d4' },
  { id: 'rose', label: 'Rose', from: '#f43f5e', to: '#ec4899' },
  { id: 'amber', label: 'Amber', from: '#f59e0b', to: '#f97316' },
  { id: 'sky', label: 'Sky', from: '#0ea5e9', to: '#6366f1' },
];

function readMode(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === 'light' || m === 'dark' ? m : 'system';
  } catch {
    return 'system';
  }
}

function readAccent(): Accent {
  try {
    const a = localStorage.getItem(ACCENT_KEY);
    return ACCENTS.some((x) => x.id === a) ? (a as Accent) : 'indigo';
  } catch {
    return 'indigo';
  }
}

function resolve(mode: Mode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function apply(mode: Mode, accent: Accent) {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolve(mode));
  root.setAttribute('data-accent', accent);
}

// In-memory copy so a choice still applies for this visit when storage is blocked.
const memory: { mode?: Mode; accent?: Accent } = {};
const CHANGE_EVENT = 'ot-theme-change';

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows / blocked storage: `memory` carries it instead.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

// The theme lives outside React (localStorage + the OS setting), so read it
// as an external store: the server snapshot keeps hydration consistent and
// other tabs stay in sync through the storage event.
function subscribe(onChange: () => void) {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  mq.addEventListener('change', onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
    mq.removeEventListener('change', onChange);
  };
}

function getSnapshot(): string {
  const mode = storageWorks() ? readMode() : (memory.mode ?? 'system');
  const accent = storageWorks() ? readAccent() : (memory.accent ?? 'indigo');
  return `${mode}|${accent}|${resolve(mode)}`;
}

let storageOk: boolean | undefined;
function storageWorks(): boolean {
  if (storageOk === undefined) {
    try {
      localStorage.setItem('ot-probe', '1');
      localStorage.removeItem('ot-probe');
      storageOk = true;
    } catch {
      storageOk = false;
    }
  }
  return storageOk;
}

function getServerSnapshot(): string {
  return 'system|indigo|dark';
}

function saveMode(m: Mode) {
  memory.mode = m;
  persist(MODE_KEY, m);
}

function saveAccent(a: Accent) {
  memory.accent = a;
  persist(ACCENT_KEY, a);
}

const SunIcon = () => (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <circle cx="12" cy="12" r="4" />
    <path strokeLinecap="round" d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const MoonIcon = () => (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);
const SystemIcon = () => (
  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path strokeLinecap="round" d="M8 20h8m-4-4v4" />
  </svg>
);

export function ThemeSwitcher() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [mode, accent, resolved] = snapshot.split('|') as [Mode, Accent, 'light' | 'dark'];
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Sync <html> before paint. This also re-applies after React's dev-mode
  // remount, which resets the attributes the inline <head> script set.
  useLayoutEffect(() => {
    apply(mode, accent);
  }, [mode, accent, resolved]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const chooseMode = saveMode;
  const chooseAccent = saveAccent;

  const modes: { id: Mode; label: string; icon: React.ReactNode }[] = [
    { id: 'light', label: 'Light', icon: <SunIcon /> },
    { id: 'dark', label: 'Dark', icon: <MoonIcon /> },
    { id: 'system', label: 'System', icon: <SystemIcon /> },
  ];

  return (
    <div
      ref={wrapRef}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Appearance"
        title="Appearance"
        className="flex h-10 w-10 items-center justify-center rounded-xl glass-panel text-slate-200 transition hover:text-white active:scale-95 cursor-pointer"
      >
        {resolved === 'light' ? <SunIcon /> : <MoonIcon />}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Appearance"
          className="glass-panel-elevated absolute right-0 top-12 z-50 w-72 rounded-2xl p-4 animate-fade-in"
        >
          <div className="text-sm font-bold text-white">Appearance</div>
          <p className="mt-0.5 text-xs text-slate-400">Saved on this browser.</p>

          <div className="mt-3 grid grid-cols-3 gap-1.5 rounded-xl border border-white/10 bg-white/5 p-1">
            {modes.map((m) => {
              const active = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => chooseMode(m.id)}
                  aria-pressed={active}
                  className={`flex flex-col items-center gap-1 rounded-lg py-2 text-[11px] font-bold transition cursor-pointer ${
                    active
                      ? 'bg-accent-gradient text-on-accent shadow-accent'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                  }`}
                >
                  {m.icon}
                  {m.label}
                </button>
              );
            })}
          </div>

          <div className="mt-4 text-xs font-bold text-slate-300">Accent colour</div>
          <div className="mt-2 flex items-center gap-2.5">
            {ACCENTS.map((a) => {
              const active = accent === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => chooseAccent(a.id)}
                  aria-label={`${a.label} accent`}
                  aria-pressed={active}
                  title={a.label}
                  className={`flex h-9 w-9 items-center justify-center rounded-full border-2 border-slate-950 transition cursor-pointer ${
                    active ? 'ring-2 ring-offset-0 scale-105' : 'hover:scale-105'
                  }`}
                  style={{
                    backgroundImage: `linear-gradient(135deg, ${a.from}, ${a.to})`,
                    ...(active ? { boxShadow: `0 0 0 2px ${a.from}` } : {}),
                  }}
                >
                  {active && (
                    <svg className="h-4 w-4 text-on-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-slate-500">
            System follows your computer&apos;s light or dark setting.
          </p>
        </div>
      )}
    </div>
  );
}
