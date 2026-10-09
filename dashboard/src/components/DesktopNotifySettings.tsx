'use client';

// This browser's desktop-notification settings (see lib/desktopNotify.ts).
// Saved per browser, so each HR person chooses for themselves.

import { useState, useSyncExternalStore } from 'react';

import {
  NOTIFY_CATEGORIES, getPrefs, notifyDesktop, permission, requestPermission, setPrefs, subscribePrefs,
  type NotifyMode,
} from '@/lib/desktopNotify';

const MODES: { id: NotifyMode; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'silent', label: 'Silent' },
  { id: 'sound', label: 'With sound' },
];

export function DesktopNotifySettings() {
  const prefs = useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
  const perm = useSyncExternalStore(subscribePrefs, permission, () => 'default' as const);
  const [open, setOpen] = useState(false);

  const setMode = async (mode: NotifyMode) => {
    if (mode !== 'off' && perm === 'default') await requestPermission();
    setPrefs({ ...prefs, mode });
  };

  return (
    <div className="border-b border-zinc-800/60 px-5 py-2.5 text-xs">
      <button type="button" onClick={() => setOpen(o => !o)} className="flex w-full items-center justify-between text-zinc-300 hover:text-white">
        <span>
          Desktop notifications: <strong className="text-white">{MODES.find(m => m.id === prefs.mode)?.label}</strong>
          {prefs.mode !== 'off' && perm === 'denied' && <span className="ml-1 text-rose-400">(blocked by the browser)</span>}
        </span>
        <span className="text-zinc-500">{open ? 'Hide' : 'Settings'}</span>
      </button>

      {open && (
        <div className="mt-2.5 space-y-2.5">
          <p className="text-[11px] text-zinc-500">
            Saved in this browser only: everyone signed in elsewhere keeps their own setting.
          </p>
          {perm === 'unsupported' ? (
            <p className="text-amber-400">This browser doesn&apos;t support desktop notifications.</p>
          ) : (
            <>
              <div className="flex gap-1.5">
                {MODES.map(m => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => void setMode(m.id)}
                    className={`rounded-lg border px-2.5 py-1 font-medium ${prefs.mode === m.id ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white'}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              {perm === 'denied' && (
                <p className="text-rose-400">
                  The browser has blocked notifications for this site. Allow them from the padlock icon next to the address, then reload.
                </p>
              )}
              {perm === 'default' && prefs.mode !== 'off' && (
                <button type="button" onClick={() => void requestPermission()} className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-zinc-300 hover:text-white">
                  Allow notifications in this browser
                </button>
              )}
              <label className="flex items-center gap-2 text-zinc-300">
                <input
                  type="checkbox"
                  checked={prefs.onlyWhenHidden}
                  onChange={e => setPrefs({ ...prefs, onlyWhenHidden: e.target.checked })}
                />
                Only when the dashboard isn&apos;t the window in front
              </label>
              <div className="grid grid-cols-2 gap-1">
                {NOTIFY_CATEGORIES.map(c => (
                  <label key={c.id} className="flex items-center gap-2 text-zinc-400">
                    <input
                      type="checkbox"
                      checked={prefs.categories[c.id] !== false}
                      onChange={e => setPrefs({ ...prefs, categories: { ...prefs.categories, [c.id]: e.target.checked } })}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
              {perm === 'granted' && (
                <button
                  type="button"
                  onClick={() => notifyDesktop({
                    id: `test-${Date.now()}`, category: 'OTHER', title: 'FWSync test notification',
                    body: prefs.mode === 'sound' ? 'Desktop notifications are on, with sound.' : 'Desktop notifications are on.',
                    severity: 'info', at: '', date: '', createdAt: Date.now(), read: false, dismissed: false,
                  }, undefined, { force: true })}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-zinc-300 hover:text-white"
                >
                  Send a test notification
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
