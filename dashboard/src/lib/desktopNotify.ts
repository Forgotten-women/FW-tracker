// OS-level (desktop) notifications for the HR dashboard.
//
// Everyone signs in to the dashboard with the same admin key, so the server
// can't tell HR people apart: each person's choice is kept in THEIR browser
// (localStorage), so one person turning notifications off or silent never
// affects anyone else. Nothing here leaves the browser.

import type { NotificationItem } from './types';

export type NotifyMode = 'off' | 'silent' | 'sound';

export interface NotifyPrefs {
  mode: NotifyMode;
  /** Only notify while the dashboard tab isn't the one in front (it shows its own toast then). */
  onlyWhenHidden: boolean;
  /** Category id -> wanted. Missing = wanted. */
  categories: Record<string, boolean>;
}

export const NOTIFY_CATEGORIES: { id: string; label: string }[] = [
  { id: 'LEAVE', label: 'Leave requests' },
  { id: 'CORRECTION', label: 'Attendance disputes' },
  { id: 'ABSENCE', label: 'Absences & no-shows' },
  { id: 'DOCUMENT', label: 'Documents' },
  { id: 'WARNING', label: 'Warnings' },
  { id: 'HR_ALERT', label: 'HR alerts (contracts, probation)' },
  { id: 'OTHER', label: 'Everything else' },
];

const PREFS_KEY = 'fw_dashboard_notify_prefs';
const SEEN_KEY = 'fw_dashboard_notified_ids';
const DEFAULTS: NotifyPrefs = { mode: 'off', onlyWhenHidden: true, categories: {} };

const listeners = new Set<() => void>();
let cached: NotifyPrefs | null = null;

export function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function permission(): NotificationPermission | 'unsupported' {
  return supported() ? Notification.permission : 'unsupported';
}

export function getPrefs(): NotifyPrefs {
  if (cached) return cached;
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null;
    cached = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    cached = DEFAULTS;
  }
  return cached as NotifyPrefs;
}

export function setPrefs(next: NotifyPrefs) {
  cached = next;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* private mode: kept for this tab only */ }
  for (const l of listeners) l();
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function requestPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!supported()) return 'unsupported';
  const p = await Notification.requestPermission();
  for (const l of listeners) l();
  return p;
}

// Ids already shown, shared by every open tab, so a notification arriving by
// both the live stream and the backstop poll (or in two tabs) shows once.
function alreadyShown(id: string): boolean {
  try {
    const seen: string[] = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
    if (seen.includes(id)) return true;
    seen.push(id);
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-300)));
  } catch { /* storage unavailable: the tag below still collapses duplicates */ }
  return false;
}

function wanted(n: NotificationItem, prefs: NotifyPrefs): boolean {
  const known = NOTIFY_CATEGORIES.some(c => c.id === n.category);
  const cat = known ? n.category : 'OTHER';
  return prefs.categories[cat] !== false;
}

/** Shows n as a desktop notification if this browser's settings want it. */
export function notifyDesktop(n: NotificationItem, onClick?: () => void, { force = false } = {}) {
  const prefs = getPrefs();
  if (!supported() || Notification.permission !== 'granted') return;
  if (!force) {
    if (prefs.mode === 'off' || !wanted(n, prefs)) return;
    if (prefs.onlyWhenHidden && document.visibilityState === 'visible' && document.hasFocus()) return;
    if (alreadyShown(n.id)) return;
  }
  try {
    const note = new Notification(n.title || 'FWSync', {
      body: n.body || '',
      tag: n.id,                       // the OS replaces rather than stacks a repeat
      silent: force ? prefs.mode !== 'sound' : prefs.mode === 'silent',
      requireInteraction: n.severity === 'urgent',
      icon: '/favicon.ico',
    });
    note.onclick = () => {
      window.focus();
      onClick?.();
      note.close();
    };
  } catch { /* some browsers only allow notifications from a service worker */ }
}
