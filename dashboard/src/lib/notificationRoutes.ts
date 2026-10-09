// Where a notification takes HR: the dashboard tab, and the section to open
// on it. One table for the drawer, the toast and desktop notifications.

import type { NotificationItem } from './types';

export type DashboardTabId =
  | 'overview' | 'workstations' | 'leave' | 'disciplinary' | 'documents'
  | 'complaints' | 'workforce' | 'payroll' | 'ota';

/** Sections a tab can open or scroll to when HR arrives from a notification. */
export type FocusTarget = 'corrections' | 'hr-alerts';

export interface NotificationRoute { tab: DashboardTabId; focus?: FocusTarget }

const BY_CATEGORY: Record<string, NotificationRoute> = {
  LEAVE: { tab: 'leave' },
  CORRECTION: { tab: 'overview', focus: 'corrections' },
  ABSENCE: { tab: 'disciplinary' },
  WARNING: { tab: 'disciplinary' },
  DOCUMENT: { tab: 'documents' },
  HR_ALERT: { tab: 'overview', focus: 'hr-alerts' },
  PAYROLL: { tab: 'payroll' },
  COMPLAINT: { tab: 'complaints' },
  ATTENDANCE: { tab: 'overview' },
  BREAK: { tab: 'overview' },
};

// The server's link, for categories the table doesn't know.
const BY_LINK: Record<string, NotificationRoute> = {
  '/leave': { tab: 'leave' },
  '/attendance': { tab: 'overview', focus: 'corrections' },
  '/documents': { tab: 'documents' },
  '/payroll': { tab: 'payroll' },
  '/complaints': { tab: 'complaints' },
  '/warnings': { tab: 'disciplinary' },
};

export function notificationRoute(n: Pick<NotificationItem, 'category' | 'link'>): NotificationRoute {
  return BY_CATEGORY[n.category]
    || (n.link ? BY_LINK[n.link.split('?')[0]] : undefined)
    || { tab: 'overview' };
}
