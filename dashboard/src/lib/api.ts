// API client.
//
// Requests go to /api/* on this origin and are proxied to the backend by the
// rewrite in next.config.ts, so the browser never makes a cross-origin request
// and the backend's CORS stays locked down.

import type {
  AdminEmployee,
  DashboardSummary,
  EnrollmentCode,
} from './types';

// sessionStorage, not localStorage: the key is gone when the tab closes rather
// than sitting on a shared machine indefinitely.
const KEY_STORAGE = 'office_tracker_admin_key';

export class UnauthorizedError extends Error {}
export class NotConfiguredError extends Error {}

export function getKey(): string {
  if (typeof window === 'undefined') return '';
  return sessionStorage.getItem(KEY_STORAGE) ?? '';
}

export function setKey(key: string) {
  sessionStorage.setItem(KEY_STORAGE, key);
}

export function clearKey() {
  sessionStorage.removeItem(KEY_STORAGE);
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  key = getKey(),
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': key,
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401) {
    throw new UnauthorizedError('That admin key was not accepted.');
  }
  if (res.status === 503) {
    const body = await res.json().catch(() => null);
    throw new NotConfiguredError(
      body?.message ?? 'The server has no admin key configured.',
    );
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.message ?? `Request failed (HTTP ${res.status})`);
  }
  return body as T;
}

export const api = {
  summary: () => request<DashboardSummary>('/api/dashboard/summary'),

  employees: () =>
    request<{ employees: AdminEmployee[] }>('/api/admin/employees'),

  createEmployee: (name: string, role: string) =>
    request<{ employee: AdminEmployee }>('/api/admin/employees', {
      method: 'POST',
      body: JSON.stringify({ name, role }),
    }),

  enrollmentCode: (employeeId: string) =>
    request<EnrollmentCode>(
      `/api/admin/employees/${encodeURIComponent(employeeId)}/enrollment-code`,
      { method: 'POST' },
    ),

  /**
   * EventSource cannot send headers, so the admin key is exchanged for a
   * single-use, short-lived ticket. That keeps the key out of the URL, the
   * server access log and browser history.
   */
  sseTicket: () =>
    request<{ ticket: string }>('/api/admin/sse-ticket', { method: 'POST' }),

  /** Verifies a key before storing it. */
  verifyKey: async (key: string) => {
    await request<DashboardSummary>('/api/dashboard/summary', {}, key);
  },

  exportCsv: async (from: string, to: string) => {
    const res = await fetch(
      `/api/admin/export?from=${from}&to=${to}`,
      { headers: { 'X-Admin-Key': getKey() } },
    );
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },
};
