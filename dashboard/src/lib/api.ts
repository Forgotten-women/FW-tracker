// API client.
//
// Requests go to /api/* on this origin and are proxied to the backend by the
// rewrite in next.config.ts, so the browser never makes a cross-origin request
// and the backend's CORS stays locked down.

import type {
  AbsenceRecord,
  AdminEmployee,
  AttendanceCorrection,
  DashboardSummary,
  DocumentTypeOption,
  EmployeeDocumentItem,
  EmployeeLeaveOverview,
  EnrollmentCode,
  FormalWarningItem,
  HrAlerts,
  KycChecklistResponse,
  LeaverCalculation,
  AppReleaseItem,
  OtaConfig,
  LeaveRequestItem,
  LeaveTypeItem,
  NotificationItem,
  NotificationsResponse,
  PayrollAdjustment,
  PayrollPeriod,
  PayrollPrepareSheet,
  PendingVerificationDoc,
  PresenceStatus,
  SalaryRecord,
  SalaryBlocked,
  StarterCalculation,
  TeamCalendarLeave,
  WarningBoardSummary,
  WarningTrigger,
  WorkstationItem,
  ProcessAnomalyItem,
  AppUsageItem,
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
  notifyKeyChanged();
}

export function clearKey() {
  sessionStorage.removeItem(KEY_STORAGE);
  notifyKeyChanged();
}

// sessionStorage is an external store, so components read it through
// useSyncExternalStore rather than mirroring it into React state. That needs a
// way to tell subscribers it changed, because storage events only fire in OTHER
// tabs, never the one that made the write.
const keyListeners = new Set<() => void>();

export function subscribeToKey(listener: () => void): () => void {
  keyListeners.add(listener);
  return () => {
    keyListeners.delete(listener);
  };
}

export function notifyKeyChanged() {
  for (const listener of keyListeners) listener();
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

  createEmployee: (
    name: string,
    role: string,
    options?: { baseSalary?: number; currency?: string; startDate?: string; reason?: string }
  ) =>
    request<{ employee: AdminEmployee }>('/api/admin/employees', {
      method: 'POST',
      body: JSON.stringify({ name, role, ...options }),
    }),

  enrollmentCode: (employeeId: string) =>
    request<EnrollmentCode>(
      `/api/admin/employees/${encodeURIComponent(employeeId)}/enrollment-code`,
      { method: 'POST' },
    ),

  deleteEmployee: (employeeId: string) =>
    request<{ status: string; message: string }>(
      `/api/admin/employees/${encodeURIComponent(employeeId)}`,
      { method: 'DELETE' },
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

  hrAlerts: () => request<HrAlerts>('/api/hr/alerts'),

  dismissAlert: (key: string, value: string, note?: string) =>
    request<{ status: string }>('/api/hr/alerts/dismiss', {
      method: 'POST',
      body: JSON.stringify({ key, value, note }),
    }),

  exportCsv: async (from: string, to: string) => {
    const res = await fetch(
      `/api/admin/export?from=${from}&to=${to}`,
      { headers: { 'X-Admin-Key': getKey() } },
    );
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },

  history: (from: string, to: string) =>
    request<{
      status: string;
      from: string;
      to: string;
      days: Array<{
        date: string;
        employeeId: string;
        employeeName: string;
        role: string;
        firstCheckIn: string;
        lastActive: string;
        timeWorked: string;
        totalMinutes: number;
        adjustmentMinutes: number;
        adjustmentNote: string | null;
        status: PresenceStatus;
        sessions: Array<{
          from: string;
          to: string;
          duration: string;
        }>;
      }>;
    }>(`/api/dashboard/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  attendanceCorrections: (status = 'PENDING') =>
    request<{ status: string; corrections: AttendanceCorrection[] }>(
      `/api/attendance/corrections?status=${encodeURIComponent(status)}`,
    ),

  decideCorrection: (
    id: string,
    decision: 'APPROVED' | 'REJECTED' | 'AMENDED' | 'INFO_REQUESTED',
    notes: string,
    adjustmentMinutes?: number,
  ) =>
    request<{ status: string; decision: string }>(
      `/api/attendance/corrections/${encodeURIComponent(id)}/decide`,
      {
        method: 'POST',
        body: JSON.stringify({
          decision,
          notes,
          adjustmentMinutes,
        }),
      },
    ),

  warningBoard: (date?: string) =>
    request<WarningBoardSummary>(
      `/api/warnings/board${date ? `?date=${encodeURIComponent(date)}` : ''}`,
    ),

  warningTriggers: (status = 'PENDING_REVIEW') =>
    request<{ status: string; triggers: WarningTrigger[] }>(
      `/api/warnings/triggers?status=${encodeURIComponent(status)}`,
    ),

  reviewWarningTrigger: (
    id: string,
    decision: 'CONFIRMED' | 'WAIVED' | 'CORRECTED',
    notes: string,
    explanation?: string,
  ) =>
    request<{ status: string; decision: string; warning?: FormalWarningItem }>(
      `/api/warnings/triggers/${encodeURIComponent(id)}/review`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, notes, explanation }),
      },
    ),

  formalWarnings: () =>
    request<{ status: string; warnings: FormalWarningItem[] }>(
      '/api/warnings/formal',
    ),

  issueFormalWarning: (
    employeeId: string,
    level: string,
    explanation: string,
    warningType = 'OTHER',
  ) =>
    request<{ status: string; warning: FormalWarningItem }>(
      `/api/warnings/employee/${encodeURIComponent(employeeId)}/issue`,
      {
        method: 'POST',
        body: JSON.stringify({ level, explanation, warningType }),
      },
    ),

  withdrawFormalWarning: (id: string, reason: string) =>
    request<{ status: string; message: string }>(
      `/api/warnings/${encodeURIComponent(id)}/withdraw`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    ),

  absences: (status = 'ALL', from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (status && status !== 'ALL') params.append('status', status);
    if (from) params.append('from', from);
    if (to) params.append('to', to);
    const qs = params.toString();
    return request<{
      status: string;
      absences: AbsenceRecord[];
      counts: { pending: number; confirmed: number; dismissed: number };
    }>(`/api/warnings/absences${qs ? `?${qs}` : ''}`);
  },

  reviewAbsence: (
    id: string,
    payload: {
      status: 'CONFIRMED' | 'DISMISSED';
      deductAnnualLeave?: boolean;
      treatAsUnpaid?: boolean;
      createWarningTrigger?: boolean;
      notes: string;
    },
  ) =>
    request<{ status: string; message: string }>(
      `/api/warnings/absences/${encodeURIComponent(id)}/review`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  scanAbsences: (dateKey?: string) =>
    request<{
      status: string;
      dateKey: string;
      scannedCount: number;
      detectedCount: number;
      detected: Array<{ employeeId: string; employeeName: string; dateKey: string; absenceId: string }>;
      message: string;
    }>('/api/warnings/absences/scan', {
      method: 'POST',
      body: JSON.stringify({ dateKey }),
    }),

  pendingLeaveRequests: () =>
    request<{ status: string; requests: LeaveRequestItem[] }>(
      '/api/leave/pending',
    ),

  leaveRequests: (status = 'ALL') =>
    request<{ status: string; requests: LeaveRequestItem[] }>(
      `/api/leave/requests${status !== 'ALL' ? `?status=${encodeURIComponent(status)}` : ''}`,
    ),

  decideLeaveRequest: (
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    notes: string,
    overdraftReason?: string,
  ) =>
    request<{ status: string; decision: string }>(
      `/api/leave/request/${encodeURIComponent(id)}/decide`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, notes, overdraftReason }),
      },
    ),

  leaveBalances: () =>
    request<{ status: string; employees: EmployeeLeaveOverview[] }>(
      '/api/leave/balances',
    ),

  teamLeaveCalendar: (from?: string, to?: string) =>
    request<{ status: string; from: string; to: string; leaves: TeamCalendarLeave[] }>(
      `/api/leave/calendar${from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : ''}`,
    ),

  adjustLeaveBalance: (
    employeeId: string,
    days: number,
    reason: string,
    onDate?: string,
  ) =>
    request<{ status: string; balance: unknown }>(
      `/api/leave/employee/${encodeURIComponent(employeeId)}/adjust`,
      {
        method: 'POST',
        body: JSON.stringify({ days, reason, onDate }),
      },
    ),

  leaveTypes: () =>
    request<{ status: string; types: LeaveTypeItem[] }>(
      '/api/leave/types',
    ),

  documentTypes: () =>
    request<{ status: string; types: DocumentTypeOption[] }>(
      '/api/documents/types',
    ),

  pendingDocuments: () =>
    request<{ status: string; pendingDocuments: PendingVerificationDoc[] }>(
      '/api/documents/pending-verification',
    ),

  verifyDocument: (documentId: string) =>
    request<{ status: string; documentId: string; verificationStatus: string }>(
      `/api/documents/${encodeURIComponent(documentId)}/verify`,
      {
        method: 'POST',
      },
    ),

  rejectDocument: (documentId: string, reason: string) =>
    request<{ status: string; documentId: string; verificationStatus: string }>(
      `/api/documents/${encodeURIComponent(documentId)}/reject`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    ),

  employeeKycChecklist: (employeeId: string) =>
    request<KycChecklistResponse & { status: string }>(
      `/api/documents/employee/${encodeURIComponent(employeeId)}/kyc-checklist`,
    ),

  employeeDocuments: (employeeId: string) =>
    request<{ status: string; documents: EmployeeDocumentItem[] }>(
      `/api/documents/employee/${encodeURIComponent(employeeId)}`,
    ),

  uploadDocument: (employeeId: string, formData: FormData) => {
    const key = getKey();
    return fetch(`/api/documents/employee/${encodeURIComponent(employeeId)}`, {
      method: 'POST',
      headers: {
        ...(key ? { 'X-Admin-Key': key } : {}),
      },
      body: formData,
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Upload failed');
      return data;
    });
  },

  documentDownloadToken: (documentId: string) =>
    request<{ status: string; token: string; expiresInMs: number }>(
      `/api/documents/${encodeURIComponent(documentId)}/download-token`,
      {
        method: 'POST',
      },
    ),

  archiveDocument: (documentId: string, reason?: string) =>
    request<{ status: string }>(
      `/api/documents/${encodeURIComponent(documentId)}/archive`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    ),

  deleteDocument: (documentId: string) =>
    request<{ status: string; deleted: boolean }>(
      `/api/documents/${encodeURIComponent(documentId)}`,
      {
        method: 'DELETE',
      },
    ),

  notifications: (all = false) =>
    request<NotificationsResponse>(
      `/api/notifications${all ? '?all=true' : ''}`,
    ),

  markNotificationRead: (id?: string) =>
    request<{ status: string }>('/api/notifications/read', {
      method: 'POST',
      body: JSON.stringify({ id: id || null }),
    }),

  dismissNotification: (id: string) =>
    request<{ status: string }>(
      `/api/notifications/${encodeURIComponent(id)}/dismiss`,
      {
        method: 'POST',
      },
    ),

  // -------------------------------------------------------------------------
  // Payroll (2.13)
  // -------------------------------------------------------------------------

  payrollPeriods: () =>
    request<{ status: string; periods: PayrollPeriod[] }>('/api/payroll/periods'),

  createPayrollPeriod: (name: string, startDate: string, endDate: string, exchangeRate?: number) =>
    request<{ status: string; period: PayrollPeriod }>('/api/payroll/periods', {
      method: 'POST',
      body: JSON.stringify({ name, startDate, endDate, exchangeRate }),
    }),

  updatePeriodExchangeRate: (periodId: string, exchangeRate: number) =>
    request<{ status: string; exchangeRate: number }>(
      `/api/payroll/periods/${encodeURIComponent(periodId)}/exchange-rate`,
      {
        method: 'POST',
        body: JSON.stringify({ exchangeRate }),
      },
    ),

  payrollPrepare: (periodId: string) =>
    request<{ status: string } & PayrollPrepareSheet>(
      `/api/payroll/periods/${encodeURIComponent(periodId)}/prepare`,
    ),

  closePayrollPeriod: (periodId: string) =>
    request<{ status: string; period: PayrollPeriod }>(
      `/api/payroll/periods/${encodeURIComponent(periodId)}/close`,
      { method: 'POST' },
    ),

  payrollAdjustments: (periodId: string) =>
    request<{ status: string; adjustments: PayrollAdjustment[] }>(
      `/api/payroll/periods/${encodeURIComponent(periodId)}/adjustments`,
    ),

  proposePayrollAdjustment: (
    periodId: string,
    employeeId: string,
    adjustmentType: string,
    calculatedDays: number | null,
    calculatedAmount: number,
    explanation: string,
  ) =>
    request<{ status: string; adjustment: PayrollAdjustment }>(
      `/api/payroll/periods/${encodeURIComponent(periodId)}/adjustments`,
      {
        method: 'POST',
        body: JSON.stringify({ employeeId, adjustmentType, calculatedDays, calculatedAmount, explanation }),
      },
    ),

  decidePayrollAdjustment: (
    adjId: string,
    decision: 'APPROVED' | 'REJECTED',
    notes: string,
    approvedDays?: number | null,
    approvedAmount?: number | null,
  ) =>
    request<{ status: string }>(
      `/api/payroll/adjustments/${encodeURIComponent(adjId)}/decide`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, notes, approvedDays: approvedDays ?? null, approvedAmount: approvedAmount ?? null }),
      },
    ),

  starterPreview: (employeeId: string, from: string, to: string) =>
    request<{ status: string; calculation: StarterCalculation }>(
      `/api/payroll/employee/${encodeURIComponent(employeeId)}/starter?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),

  leaverPreview: (employeeId: string, lastWorkingDate: string) =>
    request<{ status: string; calculation: LeaverCalculation }>(
      `/api/payroll/employee/${encodeURIComponent(employeeId)}/leaver?lastWorkingDate=${encodeURIComponent(lastWorkingDate)}`,
    ),

  employeeSalary: (employeeId: string) =>
    request<{ status: string; onDate: string; current: SalaryRecord | SalaryBlocked; history: (SalaryRecord & { from: string; to: string | null; reason: string; setBy: string; setAt: string })[] }>(
      `/api/payroll/employee/${encodeURIComponent(employeeId)}/salary`,
    ),

  setEmployeeSalary: (
    employeeId: string,
    data: {
      amount: number;
      effectiveFrom: string;
      reason: string;
      currency?: string;
      payFrequency?: string;
    },
  ) =>
    request<{ status: string; salary: SalaryRecord; message: string }>(
      `/api/payroll/employee/${encodeURIComponent(employeeId)}/salary`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ),

  // -------------------------------------------------------------------------
  // Settings & Configuration
  // -------------------------------------------------------------------------

  getSettings: () =>
    request<{ status: string; settings: Record<string, string> }>('/api/admin/settings'),

  updateSetting: (key: string, value: string) =>
    request<{ status: string; key: string; value: string }>('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    }),

  // -------------------------------------------------------------------------
  // App Releases & OTA Manager
  // -------------------------------------------------------------------------

  getReleases: () =>
    request<{ status: string; releases: AppReleaseItem[]; config: OtaConfig }>('/api/admin/releases'),

  createRelease: (data: {
    versionName: string;
    versionCode: number;
    platform?: string;
    fileName?: string;
    fileSize?: number;
    downloadUrl: string;
    releaseNotes?: string;
    mandatory?: boolean;
  }) =>
    request<{ status: string; release: AppReleaseItem }>('/api/admin/releases', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateRelease: (
    id: string,
    data: { active?: boolean; mandatory?: boolean; releaseNotes?: string }
  ) =>
    request<{ status: string; release: AppReleaseItem }>(
      `/api/admin/releases/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(data),
      }
    ),

  deleteRelease: (id: string) =>
    request<{ status: string; success: boolean }>(
      `/api/admin/releases/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    ),

  updateOtaConfig: (data: Partial<OtaConfig>) =>
    request<{ status: string; message: string }>('/api/admin/releases/config', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  fetchWorkstations: () =>
    request<{ status: string; dateKey: string; workstations: WorkstationItem[] }>('/api/admin/workstations'),

  fetchAnomalies: () =>
    request<{ status: string; anomalies: ProcessAnomalyItem[] }>('/api/admin/anomalies'),

  fetchAppUsage: (date?: string) =>
    request<{ status: string; dateKey: string; appUsage: AppUsageItem[] }>(`/api/admin/app-usage${date ? `?date=${encodeURIComponent(date)}` : ''}`),

  resolveAnomaly: (id: string) =>
    request<{ status: string }>(`/api/admin/anomalies/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
    }),
};



