'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { Gate } from '@/components/Gate';
import {
  ActivityFeed,
  AttendanceCorrectionsPanel,
  AttendanceTable,
  CodeModal,
  Header,
  PresenceGrid,
  Stats,
  TeamPanel,
  WarningBar,
} from '@/components/panels';
import { HrAlertsPanel } from '@/components/HrAlerts';
import { LeaveManagementPanel } from '@/components/LeaveManagementPanel';
import DocumentVaultPanel from '@/components/DocumentVaultPanel';
import { WarningBoard } from '@/components/WarningBoard';
import { NotificationDrawer } from '@/components/NotificationDrawer';
import { PayrollPanel } from '@/components/PayrollPanel';
import { OtaPanel } from '@/components/OtaPanel';
import { WorkstationsPanel } from '@/components/WorkstationsPanel';
import { ComplaintsManagementPanel } from '@/components/ComplaintsManagementPanel';
import { EmployeeDetailDrawer } from '@/components/EmployeeDetailDrawer';

import { useDashboard } from '@/hooks/useDashboard';
import { api, clearKey, getKey, notifyKeyChanged, subscribeToKey } from '@/lib/api';
import type { AdminEmployee, AttendanceCorrection, EmployeeDay, EnrollmentCode, NotificationItem } from '@/lib/types';

type DashboardTab = 'overview' | 'attendance' | 'workstations' | 'leave' | 'disciplinary' | 'documents' | 'complaints' | 'workforce' | 'payroll' | 'ota';

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');
  const [gateError, setGateError] = useState<string>('');
  const [pairing, setPairing] = useState<(EnrollmentCode & { name: string }) | null>(null);
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeDay | null>(null);
  const [corrections, setCorrections] = useState<AttendanceCorrection[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadNotificationsCount, setUnreadNotificationsCount] = useState<number>(0);
  const [notificationDrawerOpen, setNotificationDrawerOpen] = useState<boolean>(false);
  const [toastNotification, setToastNotification] = useState<NotificationItem | null>(null);
  const [pendingComplaintsCount, setPendingComplaintsCount] = useState<number>(0);

  // The admin key lives in sessionStorage
  const unlocked = useSyncExternalStore(subscribeToKey, () => Boolean(getKey()), () => false);

  const lock = useCallback((message: string) => {
    clearKey();
    setGateError(message);
    notifyKeyChanged();
  }, []);

  const loadNotifications = useCallback(async () => {
    try {
      const res = await api.notifications();
      setNotifications(res.notifications || []);
      setUnreadNotificationsCount(res.unreadCount || 0);
    } catch (_) {}
  }, []);

  const loadComplaintsCount = useCallback(async () => {
    try {
      const res = await api.fetchComplaints({ status: 'SUBMITTED' });
      setPendingComplaintsCount(res.count || 0);
    } catch (_) {}
  }, []);

  const handleIncomingNotification = useCallback((n: NotificationItem) => {
    setToastNotification(n);
    setNotifications((prev) => [n, ...prev.filter((item) => item.id !== n.id)]);
    setUnreadNotificationsCount((c) => c + 1);

    // Auto dismiss toast popup after 7 seconds
    setTimeout(() => {
      setToastNotification((curr) => (curr?.id === n.id ? null : curr));
    }, 7000);
  }, []);

  const { summary, employees, connection, error, refresh } = useDashboard(
    unlocked,
    lock,
    handleIncomingNotification,
  );

  const loadCorrections = useCallback(async () => {
    try {
      const res = await api.attendanceCorrections('ALL');
      setCorrections(res.corrections || []);
    } catch {
      // Handled silently
    }
  }, []);

  useEffect(() => {
    if (!unlocked) return;

    loadCorrections();
    loadNotifications();
    loadComplaintsCount();

    const handleSse = () => {
      loadCorrections();
      loadNotifications();
      loadComplaintsCount();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('office-tracker-sse', handleSse);
    }

    const interval = setInterval(() => {
      loadCorrections();
      loadNotifications();
      loadComplaintsCount();
    }, 4000);

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('office-tracker-sse', handleSse);
      }
      clearInterval(interval);
    };
  }, [unlocked, loadCorrections, loadNotifications, loadComplaintsCount]);

  const decideCorrection = async (
    id: string,
    decision: 'APPROVED' | 'REJECTED' | 'AMENDED',
    notes: string,
    adjustmentMinutes?: number,
  ) => {
    await api.decideCorrection(id, decision, notes, adjustmentMinutes);
    await Promise.all([refresh(), loadCorrections()]);
  };

  const addEmployee = async (
    name: string,
    role: string,
    baseSalary?: number,
    currency?: string,
    startDate?: string
  ) => {
    await api.createEmployee(name, role, { baseSalary, currency, startDate });
    await refresh();
  };

  const pairDevice = async (employee: AdminEmployee) => {
    const result = await api.enrollmentCode(employee.id);
    setPairing({ ...result, name: employee.name });
    await refresh();
  };

  const exportCsv = async (from: string, to: string) => {
    const blob = await api.exportCsv(from, to);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (unlocked === undefined) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#07090E] text-sm text-slate-400">
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-900/80 p-6 shadow-2xl backdrop-blur-xl">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
          <span className="font-semibold text-slate-200">Authenticating HR Dashboard…</span>
        </div>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <Gate
        initialError={gateError}
        onUnlocked={() => {
          setGateError('');
          notifyKeyChanged();
        }}
      />
    );
  }

  const pendingCorrectionsCount = corrections.filter(
    (c) => c.status === 'PENDING',
  ).length;

  const navTabs: { id: DashboardTab; label: string; icon: React.ReactNode; badge?: number }[] = [
    {
      id: 'overview',
      label: 'Overview',
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
        </svg>
      ),
    },
    {
      id: 'attendance',
      label: 'Time & Attendance',
      badge: pendingCorrectionsCount,
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
    {
      id: 'workstations',
      label: 'Workstations & Laptops',
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      id: 'leave',
      label: 'Leave & Holidays',
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      id: 'disciplinary',
      label: 'Disciplinary & Warnings',
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      ),
    },
    {
      id: 'documents',
      label: 'Document Vault & KYC',
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
    },
    {
      id: 'complaints',
      label: 'Employee Concerns',
      badge: pendingComplaintsCount,
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>
      ),
    },
    {
      id: 'workforce',
      label: 'Workforce Directory',
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      ),
    },
    {
      id: 'payroll',
      label: 'Payroll Prep',
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      ),
    },
    {
      id: 'ota',
      label: 'App Releases & OTA',
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-[#07090E] text-slate-100 selection:bg-indigo-500 selection:text-white">
      {/* Global Header */}
      <Header
        summary={summary}
        connection={connection}
        onLock={() => lock('')}
        unreadNotificationsCount={unreadNotificationsCount}
        onOpenNotifications={() => setNotificationDrawerOpen(true)}
      />

      {/* Primary Navigation Tabs */}
      <nav className="sticky top-[65px] z-30 border-b border-white/8 bg-slate-950/70 px-6 backdrop-blur-xl">
        <div className="flex items-center justify-between overflow-x-auto py-2">
          <div className="flex items-center gap-1.5">
            {navTabs.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-bold tracking-tight transition-all duration-200 cursor-pointer ${
                    isActive
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30 border border-indigo-400/30'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  <span className={isActive ? 'text-white' : 'text-slate-400'}>{tab.icon}</span>
                  <span>{tab.label}</span>
                  {tab.badge !== undefined && tab.badge > 0 && (
                    <span className="ml-1 rounded-full bg-rose-500 px-1.5 py-0.5 text-[9px] font-black text-white shadow-md">
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="hidden items-center gap-3 lg:flex">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400 border border-emerald-500/20">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Office Beacon Active
            </span>
          </div>
        </div>
      </nav>

      {summary && <WarningBar summary={summary} />}

      {error && (
        <div className="mx-6 mt-4 flex items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300 shadow-lg shadow-rose-500/5">
          <svg className="h-4 w-4 shrink-0 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{error} — displaying cached state.</span>
        </div>
      )}

      <main className="px-6 py-6">
        {!summary ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
            <p className="text-sm font-medium text-slate-400">Synchronizing workforce intelligence…</p>
          </div>
        ) : (
          <>
            {/* 1. OVERVIEW TAB */}
            {activeTab === 'overview' && (
              <div className="flex flex-col gap-6">
                <Stats summary={summary} />

                <div className="grid grid-cols-1 gap-6 xl:grid-cols-[2fr_1fr]">
                  <div className="flex min-w-0 flex-col gap-6">
                    <PresenceGrid
                      summary={summary}
                      onSelectEmployee={setSelectedEmployee}
                    />
                  </div>

                  <div className="flex min-w-0 flex-col gap-6">
                    <HrAlertsPanel />
                    <ActivityFeed movements={summary.recentMovements} />
                  </div>
                </div>
              </div>
            )}

            {/* 2. TIME & ATTENDANCE TAB */}
            {activeTab === 'attendance' && (
              <div className="flex flex-col gap-6">
                <AttendanceTable
                  rows={summary.todayAttendance}
                  dateKey={summary.currentDateKey}
                  onExport={exportCsv}
                  onSelectEmployee={setSelectedEmployee}
                />
                <AttendanceCorrectionsPanel
                  corrections={corrections}
                  onDecide={decideCorrection}
                  onRefresh={loadCorrections}
                />
              </div>
            )}

            {/* 3. WORKSTATIONS & LAPTOPS TAB */}
            {activeTab === 'workstations' && (
              <div className="flex flex-col gap-6">
                <WorkstationsPanel
                  onSelectEmployee={(empId) => {
                    const match = summary?.todayAttendance.find((e) => e.employeeId === empId);
                    if (match) {
                      setSelectedEmployee(match);
                    } else {
                      const emp = employees.find((e) => e.id === empId);
                      if (emp) {
                        setSelectedEmployee({
                          employeeId: emp.id,
                          employeeName: emp.name,
                          employeeNumber: emp.employeeNumber,
                          role: emp.role,
                          status: 'IN_OFFICE',
                          firstCheckIn: '—',
                          lastActiveTime: '—',
                          sessions: [],
                          totalMinutes: 0,
                          breakMinutes: 0,
                          timeWorkedFormatted: '0h 00m',
                          onBreak: false,
                        } as EmployeeDay);
                      }
                    }
                  }}
                />
              </div>
            )}

            {/* 4. LEAVE & HOLIDAYS TAB */}
            {activeTab === 'leave' && (
              <div className="flex flex-col gap-6">
                <LeaveManagementPanel />
              </div>
            )}

            {/* 4. DISCIPLINARY & LATENESS TAB */}
            {activeTab === 'disciplinary' && (
              <div className="flex flex-col gap-6">
                <WarningBoard />
              </div>
            )}

            {/* 5. DOCUMENT VAULT & KYC TAB */}
            {activeTab === 'documents' && (
              <div className="flex flex-col gap-6">
                <DocumentVaultPanel />
              </div>
            )}

            {/* 6. EMPLOYEE CONCERNS & COMPLAINTS TAB */}
            {activeTab === 'complaints' && (
              <div className="flex flex-col gap-6">
                <ComplaintsManagementPanel />
              </div>
            )}

            {/* 6. WORKFORCE DIRECTORY TAB */}
            {activeTab === 'workforce' && (
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-[2fr_1fr]">
                <TeamPanel
                  employees={employees}
                  onAdd={addEmployee}
                  onPair={pairDevice}
                  onRefresh={refresh}
                />
                <div className="flex flex-col gap-6">
                  <div className="glass-panel rounded-2xl p-6">
                    <h3 className="text-base font-bold text-white">Staff Management & Onboarding</h3>
                    <p className="mt-2 text-xs leading-relaxed text-slate-400">
                      Generate 6-digit pairing codes to onboard staff devices onto the Office Tracker system.
                      Once enrolled, their presence will automatically synchronize via mobile check-ins, workstation activity, and office network sensors.
                    </p>
                    <div className="mt-4 rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4">
                      <div className="flex items-center gap-2 text-xs font-semibold text-indigo-300">
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Automatic Audit Compliance
                      </div>
                      <p className="mt-1 text-[11px] text-slate-400">
                        All device revocations, role adjustments, and KYC verifications are immutably logged with actor timestamps.
                      </p>
                    </div>
                  </div>
                  <ActivityFeed movements={summary.recentMovements} />
                </div>
              </div>
            )}

            {/* 7. PAYROLL PREPARATION TAB */}
            {activeTab === 'payroll' && (
              <div className="flex flex-col gap-6">
                <PayrollPanel />
              </div>
            )}

            {/* 8. APP RELEASES & OTA TAB */}
            {activeTab === 'ota' && (
              <div className="flex flex-col gap-6">
                <OtaPanel />
              </div>
            )}
          </>
        )}
      </main>

      {pairing && (
        <CodeModal
          code={pairing.code}
          employeeName={pairing.name}
          expires={pairing.expiresAtDisplay}
          onClose={() => setPairing(null)}
        />
      )}

      {/* Slide-out Employee Detail Drawer */}
      <EmployeeDetailDrawer
        employee={selectedEmployee}
        onClose={() => setSelectedEmployee(null)}
        onOpenPairing={(emp) => {
          pairDevice({ id: emp.id, name: emp.name } as any);
        }}
      />

      {/* Slide-out HR Notifications Drawer */}
      <NotificationDrawer
        open={notificationDrawerOpen}
        onClose={() => setNotificationDrawerOpen(false)}
        notifications={notifications}
        unreadCount={unreadNotificationsCount}
        onRefresh={loadNotifications}
        onNavigateTab={(tab) => {
          if (tab === 'leave') setActiveTab('leave');
          else if (tab === 'history') setActiveTab('attendance');
          else if (tab === 'warnings') setActiveTab('disciplinary');
          else if (tab === 'documents') setActiveTab('documents');
          else setActiveTab('overview');
        }}
      />

      {/* Real-Time Toast Notification Banner for Incoming Requests */}
      {toastNotification && (
        <div className="fixed bottom-6 right-6 z-50 flex max-w-md items-start gap-3.5 rounded-2xl border border-indigo-500/40 bg-slate-900/95 p-4 text-white shadow-2xl backdrop-blur-xl ring-1 ring-white/10 animate-in slide-in-from-bottom-5 duration-300">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600/20 border border-indigo-500/30 text-xl shadow-inner">
            🔔
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex rounded-md bg-indigo-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-300">
                {toastNotification.category}
              </span>
              <span className="text-[11px] text-slate-400">{toastNotification.at}</span>
            </div>
            <h4 className="mt-1 text-sm font-bold tracking-tight text-white line-clamp-1">
              {toastNotification.title}
            </h4>
            <p className="mt-0.5 text-xs text-slate-300 line-clamp-2">
              {toastNotification.body}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setNotificationDrawerOpen(true);
                  setToastNotification(null);
                }}
                className="rounded-xl bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-indigo-600/30 transition cursor-pointer"
              >
                Review Now
              </button>
              <button
                type="button"
                onClick={() => setToastNotification(null)}
                className="rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-300 transition cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
