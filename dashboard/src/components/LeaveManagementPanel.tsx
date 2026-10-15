'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type {
  AbsenceRecord,
  EmployeeLeaveOverview,
  LeaveRequestItem,
  TeamCalendarLeave,
  ApproachingAnniversaryEmployee,
  HistoricalLeaveCycle,
  LeaveBalanceDetails,
  MonthlyLeaveReport,
  BankHolidayItem,
} from '@/lib/types';
import { Badge, Button, Empty, Input, Panel } from './primitives';
import {
  AlertTriangleIcon,
  CalendarIcon,
  CheckIcon,
  FileTextIcon,
  HistoryIcon,
  HourglassIcon,
  InfoIcon,
  LightbulbIcon,
  LockIcon,
  PaperclipIcon,
  RefreshIcon,
  ShieldCheckIcon,
  SirenIcon,
  ThermometerIcon,
  TimerIcon,
  XIcon,
} from './icons';

export function LeaveManagementPanel() {
  const [pendingRequests, setPendingRequests] = useState<LeaveRequestItem[]>([]);
  const [allRequests, setAllRequests] = useState<LeaveRequestItem[]>([]);
  const [balances, setBalances] = useState<EmployeeLeaveOverview[]>([]);
  const [calendarLeaves, setCalendarLeaves] = useState<TeamCalendarLeave[]>([]);
  const [absences, setAbsences] = useState<AbsenceRecord[]>([]);
  const [approachingEmployees, setApproachingEmployees] = useState<ApproachingAnniversaryEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tabs: 'pending' | 'absences' | 'calendar' | 'all' | 'balances' | 'carry_forward' | 'holidays'
  const [activeTab, setActiveTab] = useState<'pending' | 'absences' | 'calendar' | 'all' | 'balances' | 'carry_forward' | 'holidays'>('pending');

  // Filters
  const [historyFilter, setHistoryFilter] = useState<'ALL' | 'APPROVED' | 'REJECTED' | 'CANCELLED'>('ALL');
  const [absenceStatusFilter, setAbsenceStatusFilter] = useState<'ALL' | 'PENDING_REVIEW' | 'CONFIRMED' | 'DISMISSED'>('ALL');
  const [search, setSearch] = useState('');
  // Set by the Shortfall Warnings card: the pending queue shows only requests beyond the accrued balance.
  const [shortfallOnly, setShortfallOnly] = useState(false);

  // Modals & Action states (Leave Requests)
  const [selectedRequest, setSelectedRequest] = useState<LeaveRequestItem | null>(null);
  const [decisionAction, setDecisionAction] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [decisionNotes, setDecisionNotes] = useState('');
  const [overdraftReason, setOverdraftReason] = useState('');
  const [decisionIsPaid, setDecisionIsPaid] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState(false);

  // Modals & Action states (Absences / Sickness)
  const [selectedAbsence, setSelectedAbsence] = useState<AbsenceRecord | null>(null);
  const [absenceAction, setAbsenceAction] = useState<'CONFIRMED' | 'DISMISSED' | 'EXCUSED' | null>(null);
  const [absenceNotes, setAbsenceNotes] = useState('');
  const [paidSickness, setPaidSickness] = useState(false);
  const [deductAnnualLeave, setDeductAnnualLeave] = useState(false);
  const [treatAsUnpaid, setTreatAsUnpaid] = useState(true);
  const [createWarningTrigger, setCreateWarningTrigger] = useState(false);

  // Manual Adjustment Modal
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [adjustEmployeeId, setAdjustEmployeeId] = useState('');
  const [adjustDays, setAdjustDays] = useState<number>(1);
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustDate, setAdjustDate] = useState('');

  // Record Leave Modal (HR Direct Entry)
  const [showRecordLeaveModal, setShowRecordLeaveModal] = useState(false);
  const [recordEmployeeId, setRecordEmployeeId] = useState('');
  const [recordLeaveTypeId, setRecordLeaveTypeId] = useState('annual');
  const [recordStartDate, setRecordStartDate] = useState('');
  const [recordEndDate, setRecordEndDate] = useState('');
  const [recordReason, setRecordReason] = useState('');
  const [recordIsPaid, setRecordIsPaid] = useState(true);
  const [recordOverdraftReason, setRecordOverdraftReason] = useState('');
  const [recordSubmitting, setRecordSubmitting] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);

  // Team Calendar Breakdown State (Year -> Month hierarchy)
  const [selectedYear, setSelectedYear] = useState<number | 'ALL' | null>(null);
  const [selectedMonthKey, setSelectedMonthKey] = useState<string>('');
  const [calendarViewMode, setCalendarViewMode] = useState<'EMPLOYEES' | 'CARDS'>('EMPLOYEES');
  const [calendarSearch, setCalendarSearch] = useState<string>('');

  // Carry Forward Review Modal
  const [carryModalEmployee, setCarryModalEmployee] = useState<ApproachingAnniversaryEmployee | null>(null);
  // The most that can be carried: the unused balance once the cycle is complete.
  const carryMax = carryModalEmployee ? (carryModalEmployee.maxEligibleCarryForward ?? carryModalEmployee.availableDays) : 0;
  const [carryApprovedDays, setCarryApprovedDays] = useState<number>(0);
  const [carryNotes, setCarryNotes] = useState<string>('');
  const [carrySaving, setCarrySaving] = useState<boolean>(false);

  // Historical Leave Cycles Modal
  const [showCyclesModal, setShowCyclesModal] = useState<boolean>(false);
  const [cyclesEmployeeName, setCyclesEmployeeName] = useState<string>('');
  const [cyclesEmployeeId, setCyclesEmployeeId] = useState<string>('');
  const [historicalCycles, setHistoricalCycles] = useState<HistoricalLeaveCycle[]>([]);
  const [cyclesCurrentBalance, setCyclesCurrentBalance] = useState<LeaveBalanceDetails | null>(null);
  const [cyclesLoading, setCyclesLoading] = useState<boolean>(false);

  // Monthly Leave Statement Modal
  const [showMonthlyModal, setShowMonthlyModal] = useState<boolean>(false);
  const [monthlyEmployeeName, setMonthlyEmployeeName] = useState<string>('');
  const [monthlyEmployeeId, setMonthlyEmployeeId] = useState<string>('');
  const [monthlyReport, setMonthlyReport] = useState<MonthlyLeaveReport | null>(null);
  const [monthlyLoading, setMonthlyLoading] = useState<boolean>(false);

  // Bank Holidays State (5 Designated Annual Days - Configurable only by HR)
  const [bankHolidays, setBankHolidays] = useState<BankHolidayItem[]>([]);
  const [calendarBankHolidays, setCalendarBankHolidays] = useState<BankHolidayItem[]>([]);
  const [holidayYear, setHolidayYear] = useState<number>(new Date().getFullYear());
  const [showHolidayModal, setShowHolidayModal] = useState<boolean>(false);
  const [editingHolidays, setEditingHolidays] = useState<Array<{ id?: string; date: string; name: string; notes?: string }>>([]);
  const [holidaySaving, setHolidaySaving] = useState<boolean>(false);
  const [holidayModalError, setHolidayModalError] = useState<string | null>(null);
  const [holidaySuccessMsg, setHolidaySuccessMsg] = useState<string | null>(null);

  // The polling interval and SSE listener below are set up once per
  // historyFilter change (see the effect's dependency array), not once per
  // render, so a `refresh` closure they hold onto can be arbitrarily old.
  // Reading holidayYear through a ref instead of the closed-over state
  // value means every future tick -- regardless of which render's `refresh`
  // fired it -- always sees whichever year is currently selected. Without
  // this, clicking a different year button updated `holidayYear` for one
  // render, but the still-running interval kept calling a `refresh` that
  // had captured the *previous* year, silently reverting the bank-holiday
  // list back to it every ~4 seconds.
  const holidayYearRef = useRef(holidayYear);
  useEffect(() => {
    holidayYearRef.current = holidayYear;
  }, [holidayYear]);

  const refresh = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [pData, rData, bData, cData, aData, appData, hData] = await Promise.all([
        api.pendingLeaveRequests(),
        api.leaveRequests(historyFilter),
        api.leaveBalances(),
        api.teamLeaveCalendar(),
        api.absences('ALL'),
        api.fetchApproachingAnniversaries().catch(() => ({ employees: [] })),
        api.fetchBankHolidays(holidayYearRef.current).catch(() => ({ holidays: [] })),
      ]);
      setPendingRequests(pData.requests || []);
      setAllRequests(rData.requests || []);
      setBalances(bData.employees || []);
      setCalendarLeaves(cData.leaves || []);
      setCalendarBankHolidays(cData.bankHolidays || []);
      setAbsences(aData.absences || []);
      setApproachingEmployees(appData.employees || []);
      setBankHolidays(hData.holidays || []);
    } catch (err: unknown) {
      if (!silent) setError(err instanceof Error ? err.message : 'Failed to load leave data.');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    refresh();

    const handleSse = () => {
      refresh(true);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('office-tracker-sse', handleSse);
    }

    // SSE (above) is the primary update path; this is only a backstop for a
    // stream that silently stops delivering. It used to run every 4s next to
    // SSE already refreshing on every relevant event -- doubling every push,
    // and each tick here fires 6 parallel queries (balances, calendar
    // leaves, bank holidays, absences, approaching-anniversary, holidays).
    const interval = setInterval(() => {
      if (document.hidden) return; // no requests while the tab isn't being looked at
      refresh(true);
    }, 60000);

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('office-tracker-sse', handleSse);
      }
      clearInterval(interval);
    };
  }, [historyFilter]);

  const openReviewModal = (r: LeaveRequestItem, action: 'APPROVED' | 'REJECTED' | null = null) => {
    setSelectedRequest(r);
    setDecisionAction(action);
    const initialPaid = r.isPaid ?? r.defaultIsPaid ?? (r.leaveTypeId !== 'unpaid');
    setDecisionIsPaid(initialPaid);
    setDecisionNotes(action === 'APPROVED' ? (initialPaid ? 'Approved as paid leave by HR.' : 'Approved as unpaid leave by HR.') : '');
    const available = r.balance?.availableDays ?? r.balance?.available ?? 0;
    const reqDays = r.days || 0;
    const shortfall = Math.max(0, Math.round((reqDays - available) * 100) / 100);
    setOverdraftReason(
      shortfall > 0 && initialPaid
        ? `Approved in advance of monthly accrual (Shortfall: ${shortfall}d).`
        : '',
    );
  };

  const handleDecision = async (action: 'APPROVED' | 'REJECTED') => {
    if (!selectedRequest) return;

    if (action === 'REJECTED' && !decisionNotes.trim()) {
      alert('A rejection reason note is required for the employee.');
      return;
    }

    const available = selectedRequest.balance?.availableDays ?? selectedRequest.balance?.available ?? 0;
    const reqDays = selectedRequest.days || 0;
    const calculatedShortfall = Math.max(0, Math.round((reqDays - available) * 100) / 100);
    const hasShortfall = decisionIsPaid && (calculatedShortfall > 0);

    if (
      action === 'APPROVED' &&
      decisionIsPaid &&
      hasShortfall &&
      !overdraftReason.trim()
    ) {
      alert(`An overdraft justification is required when approving paid leave beyond the accrued balance (Shortfall: ${calculatedShortfall} day(s)).`);
      return;
    }

    setSubmitting(true);
    try {
      const finalNotes =
        decisionNotes.trim() ||
        (action === 'APPROVED'
          ? (decisionIsPaid ? 'Approved as paid leave by HR.' : 'Approved as unpaid leave by HR.')
          : '');

      await api.decideLeaveRequest(
        selectedRequest.id,
        action,
        finalNotes,
        overdraftReason.trim() || undefined,
        action === 'APPROVED' ? decisionIsPaid : undefined,
      );
      setSelectedRequest(null);
      setDecisionAction(null);
      setDecisionNotes('');
      setOverdraftReason('');
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to decide leave request.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAdjustBalance = async () => {
    if (!adjustEmployeeId) {
      alert('Please select an employee.');
      return;
    }
    if (!adjustReason.trim()) {
      alert('A reason is required for the audit trail.');
      return;
    }
    if (isNaN(adjustDays) || adjustDays === 0) {
      alert('Please enter a valid non-zero number of days.');
      return;
    }

    setSubmitting(true);
    try {
      await api.adjustLeaveBalance(
        adjustEmployeeId,
        adjustDays,
        adjustReason.trim(),
        adjustDate || undefined,
      );
      setShowAdjustModal(false);
      setAdjustEmployeeId('');
      setAdjustDays(1);
      setAdjustReason('');
      setAdjustDate('');
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to adjust leave balance.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRecordLeave = async () => {
    if (!recordEmployeeId) {
      alert('Please select an employee.');
      return;
    }
    if (!recordStartDate) {
      alert('Please choose a start date.');
      return;
    }

    setRecordSubmitting(true);
    setRecordError(null);
    try {
      const effectiveOverdraftReason =
        recordOverdraftReason.trim() ||
        recordReason.trim() ||
        'Approved by HR during direct manual entry';

      await api.recordEmployeeLeave(recordEmployeeId, {
        leaveTypeId: recordLeaveTypeId,
        startDate: recordStartDate,
        endDate: recordEndDate || recordStartDate,
        reason: recordReason.trim() || 'Recorded by HR',
        isPaid: recordIsPaid,
        overdraftReason: effectiveOverdraftReason,
      });
      setShowRecordLeaveModal(false);
      setRecordEmployeeId('');
      setRecordReason('');
      setRecordOverdraftReason('');
      await refresh();
    } catch (err: unknown) {
      setRecordError(err instanceof Error ? err.message : 'Failed to record leave.');
    } finally {
      setRecordSubmitting(false);
    }
  };

  const handleReviewAbsence = async () => {
    if (!selectedAbsence || !absenceAction) return;
    if (!absenceNotes.trim()) {
      alert('A review note explaining the decision is required.');
      return;
    }

    setSubmitting(true);
    try {
      await api.reviewAbsence(selectedAbsence.id, {
        status: absenceAction === 'DISMISSED' ? 'DISMISSED' : 'CONFIRMED',
        deductAnnualLeave: paidSickness ? false : deductAnnualLeave,
        treatAsUnpaid: paidSickness ? false : treatAsUnpaid,
        createWarningTrigger: paidSickness ? false : createWarningTrigger,
        notes: absenceNotes.trim(),
      });
      setSelectedAbsence(null);
      setAbsenceAction(null);
      setAbsenceNotes('');
      setPaidSickness(false);
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to review absence.');
    } finally {
      setSubmitting(false);
    }
  };

  const formatFullDate = (d?: string | null) => {
    if (!d) return '—';
    const parts = d.split('-');
    if (parts.length === 3) {
      const dt = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      if (!isNaN(dt.getTime())) {
        return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      }
    }
    return d;
  };

  const openCarryModal = (emp: ApproachingAnniversaryEmployee) => {
    setCarryModalEmployee(emp);
    const existingDays = emp.carryForwardDecision?.approvedDays != null
      ? emp.carryForwardDecision.approvedDays
      : Math.min(5, Math.max(0, emp.maxEligibleCarryForward ?? emp.availableDays));
    setCarryApprovedDays(existingDays);
    setCarryNotes(emp.carryForwardDecision?.notes || '');
  };

  const handleSaveCarryForward = async () => {
    if (!carryModalEmployee) return;
    setCarrySaving(true);
    try {
      await api.recordCarryForward({
        employeeId: carryModalEmployee.employeeId,
        approvedDays: carryApprovedDays,
        notes: carryNotes.trim(),
      });
      setCarryModalEmployee(null);
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to record carry forward decision.');
    } finally {
      setCarrySaving(false);
    }
  };

  const openCyclesModal = async (empId: string, empName: string) => {
    setCyclesEmployeeId(empId);
    setCyclesEmployeeName(empName);
    setShowCyclesModal(true);
    setCyclesLoading(true);
    try {
      const res = await api.fetchEmployeeLeaveCycles(empId);
      setHistoricalCycles(res.cycles || []);
      setCyclesCurrentBalance(res.currentBalance || null);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to load employee leave cycles.');
    } finally {
      setCyclesLoading(false);
    }
  };

  const openMonthlyModal = async (empId: string, empName: string, monthKey?: string) => {
    setMonthlyEmployeeId(empId);
    setMonthlyEmployeeName(empName);
    setShowMonthlyModal(true);
    setMonthlyLoading(true);
    try {
      const res = await api.fetchEmployeeMonthlyLeaveReport(empId, monthKey);
      const blocked = (res.report as unknown as { blocked?: boolean; message?: string } | undefined);
      if (blocked?.blocked) {
        setShowMonthlyModal(false);
        alert(blocked.message || 'No leave statement for this employee yet (no employment start date).');
        return;
      }
      setMonthlyReport(res.report || null);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to load monthly leave report.');
    } finally {
      setMonthlyLoading(false);
    }
  };

  const handleSelectMonth = async (monthKey: string) => {
    if (!monthlyEmployeeId) return;
    setMonthlyLoading(true);
    try {
      const res = await api.fetchEmployeeMonthlyLeaveReport(monthlyEmployeeId, monthKey);
      setMonthlyReport(res.report || null);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to load monthly leave report.');
    } finally {
      setMonthlyLoading(false);
    }
  };

  // Derive summary metrics
  const pendingCount = pendingRequests.length;
  const pendingAbsencesCount = absences.filter((a) => a.status === 'PENDING_REVIEW').length;
  const isShortfall = (r: LeaveRequestItem) => !!(r.exceedsBalance || (r.shortfallDays && r.shortfallDays > 0));
  const shortfallCount = pendingRequests.filter(isShortfall).length;
  const visiblePending = shortfallOnly ? pendingRequests.filter(isShortfall) : pendingRequests;
  const openPending = (onlyShortfalls: boolean) => {
    setActiveTab('pending');
    setShortfallOnly(onlyShortfalls);
  };

  const todayStr = new Date().toISOString().slice(0, 10);
  const onLeaveToday = calendarLeaves.filter(
    (l) => l.from <= todayStr && l.to >= todayStr,
  );

  // Group calendar leaves into Monthly Buckets
  const monthBuckets = useMemo(() => {
    const map = new Map<
      string,
      {
        monthKey: string;
        label: string;
        year: number;
        leaves: TeamCalendarLeave[];
        employees: Map<
          string,
          {
            employeeId: string;
            employeeName: string;
            employeeNumber?: string | null;
            employeeRole?: string | null;
            totalDays: number;
            leaves: TeamCalendarLeave[];
          }
        >;
        totalDays: number;
      }
    >();

    for (const l of calendarLeaves) {
      const mKey = l.from.slice(0, 7);
      if (!map.has(mKey)) {
        const [y, m] = mKey.split('-');
        const dateObj = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
        const label = dateObj.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
        map.set(mKey, {
          monthKey: mKey,
          label,
          year: parseInt(y, 10),
          leaves: [],
          employees: new Map(),
          totalDays: 0,
        });
      }
      const bucket = map.get(mKey)!;
      bucket.leaves.push(l);
      const leaveDays = Number(l.days) || 1;
      bucket.totalDays += leaveDays;

      if (!bucket.employees.has(l.employeeId)) {
        bucket.employees.set(l.employeeId, {
          employeeId: l.employeeId,
          employeeName: l.employeeName,
          employeeNumber: l.employeeNumber,
          employeeRole: l.employeeRole,
          totalDays: 0,
          leaves: [],
        });
      }
      const emp = bucket.employees.get(l.employeeId)!;
      emp.totalDays += leaveDays;
      emp.leaves.push(l);
    }

    // Sort descending by monthKey (e.g. 2026-10, 2026-09...)
    return Array.from(map.values()).sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  }, [calendarLeaves]);

  const currentYearNum = new Date().getFullYear(); // e.g. 2026
  const currentMonthKey = todayStr.slice(0, 7); // e.g. "2026-10"

  // Derive Years from Month Buckets
  const yearBuckets = useMemo(() => {
    const map = new Map<
      number,
      {
        year: number;
        leaves: TeamCalendarLeave[];
        employees: Map<
          string,
          {
            employeeId: string;
            employeeName: string;
            employeeNumber?: string | null;
            employeeRole?: string | null;
            totalDays: number;
            leaves: TeamCalendarLeave[];
          }
        >;
        totalDays: number;
        monthsCount: number;
      }
    >();

    for (const b of monthBuckets) {
      if (!map.has(b.year)) {
        map.set(b.year, {
          year: b.year,
          leaves: [],
          employees: new Map(),
          totalDays: 0,
          monthsCount: 0,
        });
      }
      const yBucket = map.get(b.year)!;
      yBucket.monthsCount += 1;
      yBucket.totalDays += b.totalDays;
      yBucket.leaves.push(...b.leaves);
      for (const [empId, empData] of b.employees.entries()) {
        if (!yBucket.employees.has(empId)) {
          yBucket.employees.set(empId, {
            employeeId: empData.employeeId,
            employeeName: empData.employeeName,
            employeeNumber: empData.employeeNumber,
            employeeRole: empData.employeeRole,
            totalDays: 0,
            leaves: [],
          });
        }
        const existingEmp = yBucket.employees.get(empId)!;
        existingEmp.totalDays += empData.totalDays;
        existingEmp.leaves.push(...empData.leaves);
      }
    }

    return Array.from(map.values()).sort((a, b) => b.year - a.year);
  }, [monthBuckets]);

  // Active year: user selected year or current year if present or first available year
  const activeYear: number | 'ALL' = useMemo(() => {
    if (selectedYear !== null) return selectedYear;
    if (yearBuckets.some((y) => y.year === currentYearNum)) return currentYearNum;
    return yearBuckets[0]?.year ?? 'ALL';
  }, [selectedYear, yearBuckets, currentYearNum]);

  // Month buckets visible under the active year
  const visibleMonthBuckets = useMemo(() => {
    if (activeYear === 'ALL') return monthBuckets;
    return monthBuckets.filter((b) => b.year === activeYear);
  }, [monthBuckets, activeYear]);

  // Active month: if user selected a month that exists in visibleMonthBuckets, use it.
  // Otherwise if current month is in visibleMonthBuckets, use current month.
  // Otherwise default to the first available month in the year (or 'ALL')
  const activeMonthKey = useMemo(() => {
    if (selectedMonthKey) {
      if (selectedMonthKey === 'ALL' || selectedMonthKey === `ALL_${activeYear}`) return selectedMonthKey;
      if (visibleMonthBuckets.some((b) => b.monthKey === selectedMonthKey)) return selectedMonthKey;
    }
    const currentMonthInYear = visibleMonthBuckets.find((b) => b.monthKey === currentMonthKey);
    if (currentMonthInYear) return currentMonthInYear.monthKey;
    return visibleMonthBuckets[0]?.monthKey || 'ALL';
  }, [selectedMonthKey, visibleMonthBuckets, currentMonthKey, activeYear]);

  const activeMonthBucket = useMemo(() => {
    if (activeMonthKey === 'ALL' || activeMonthKey.startsWith('ALL_')) return null;
    return monthBuckets.find((b) => b.monthKey === activeMonthKey) || null;
  }, [monthBuckets, activeMonthKey]);

  // Year summary info
  const activeYearBucket = useMemo(() => {
    if (activeYear === 'ALL') return null;
    return yearBuckets.find((y) => y.year === activeYear) || null;
  }, [yearBuckets, activeYear]);

  // List of employees who took leaves in the active month or active year
  const activeMonthEmployees = useMemo(() => {
    if (activeMonthBucket) {
      return Array.from(activeMonthBucket.employees.values());
    }
    // If viewing all months of a specific year
    if (activeYearBucket) {
      return Array.from(activeYearBucket.employees.values());
    }
    // If viewing ALL years, ALL months
    const map = new Map<
      string,
      {
        employeeId: string;
        employeeName: string;
        employeeNumber?: string | null;
        employeeRole?: string | null;
        totalDays: number;
        leaves: TeamCalendarLeave[];
      }
    >();
    for (const l of calendarLeaves) {
      if (!map.has(l.employeeId)) {
        map.set(l.employeeId, {
          employeeId: l.employeeId,
          employeeName: l.employeeName,
          employeeNumber: l.employeeNumber,
          employeeRole: l.employeeRole,
          totalDays: 0,
          leaves: [],
        });
      }
      const emp = map.get(l.employeeId)!;
      emp.totalDays += Number(l.days) || 1;
      emp.leaves.push(l);
    }
    return Array.from(map.values());
  }, [activeMonthBucket, activeYearBucket, calendarLeaves]);

  const filteredActiveMonthEmployees = useMemo(() => {
    let list = activeMonthEmployees;
    if (calendarSearch.trim()) {
      const q = calendarSearch.toLowerCase();
      list = activeMonthEmployees.filter(
        (e) =>
          e.employeeName.toLowerCase().includes(q) ||
          (e.employeeNumber && e.employeeNumber.toLowerCase().includes(q)) ||
          (e.employeeRole && e.employeeRole.toLowerCase().includes(q)),
      );
    }
    // Always surface employees who are on leave today at the top of the list
    return [...list].sort((a, b) => {
      const aOnLeave = a.leaves.some((l) => l.from <= todayStr && l.to >= todayStr);
      const bOnLeave = b.leaves.some((l) => l.from <= todayStr && l.to >= todayStr);
      if (aOnLeave && !bOnLeave) return -1;
      if (!aOnLeave && bOnLeave) return 1;
      return b.totalDays - a.totalDays || a.employeeName.localeCompare(b.employeeName);
    });
  }, [activeMonthEmployees, calendarSearch, todayStr]);

  const activeMonthLeaves = useMemo(() => {
    if (activeMonthBucket) return activeMonthBucket.leaves;
    if (activeYearBucket) return activeYearBucket.leaves;
    return calendarLeaves;
  }, [activeMonthBucket, activeYearBucket, calendarLeaves]);

  const filteredActiveMonthLeaves = useMemo(() => {
    let list = activeMonthLeaves;
    if (calendarSearch.trim()) {
      const q = calendarSearch.toLowerCase();
      list = activeMonthLeaves.filter(
        (l) =>
          l.employeeName.toLowerCase().includes(q) ||
          (l.employeeNumber && l.employeeNumber.toLowerCase().includes(q)) ||
          (l.employeeRole && l.employeeRole.toLowerCase().includes(q)) ||
          l.type.toLowerCase().includes(q) ||
          (l.reason && l.reason.toLowerCase().includes(q)),
      );
    }
    return [...list].sort((a, b) => {
      const aToday = a.from <= todayStr && a.to >= todayStr;
      const bToday = b.from <= todayStr && b.to >= todayStr;
      if (aToday && !bToday) return -1;
      if (!aToday && bToday) return 1;
      return b.from.localeCompare(a.from);
    });
  }, [activeMonthLeaves, calendarSearch, todayStr]);

  const filteredBalances = balances.filter((b) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      b.employeeName.toLowerCase().includes(q) ||
      (b.employeeNumber && b.employeeNumber.toLowerCase().includes(q)) ||
      b.role.toLowerCase().includes(q)
    );
  });

  const filteredHistory = allRequests.filter((r) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      r.employeeName.toLowerCase().includes(q) ||
      (r.employeeNumber && r.employeeNumber.toLowerCase().includes(q)) ||
      (r.employeeRole && r.employeeRole.toLowerCase().includes(q)) ||
      r.type.toLowerCase().includes(q)
    );
  });

  const filteredAbsences = absences.filter((a) => {
    if (absenceStatusFilter !== 'ALL' && a.status !== absenceStatusFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      a.employeeName.toLowerCase().includes(q) ||
      (a.employeeNumber && a.employeeNumber.toLowerCase().includes(q)) ||
      (a.role && a.role.toLowerCase().includes(q)) ||
      a.absenceType.toLowerCase().includes(q) ||
      (a.reason && a.reason.toLowerCase().includes(q))
    );
  });

  const loadYearHolidays = async (year: number) => {
    setHolidayYear(year);
    try {
      const res = await api.fetchBankHolidays(year);
      setBankHolidays(res.holidays || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch bank holidays.');
    }
  };

  const openHolidayConfigModal = () => {
    if (bankHolidays.length > 0) {
      setEditingHolidays(bankHolidays.map((h) => ({ id: h.id, date: h.date, name: h.name, notes: h.notes || '' })));
    } else {
      setEditingHolidays([
        { date: `${holidayYear}-01-01`, name: "New Year's Day", notes: 'Designated Organisation Bank Holiday' },
        { date: `${holidayYear}-05-04`, name: 'Early May Bank Holiday', notes: 'Designated Organisation Bank Holiday' },
        { date: `${holidayYear}-05-25`, name: 'Spring Bank Holiday', notes: 'Designated Organisation Bank Holiday' },
        { date: `${holidayYear}-08-31`, name: 'Summer Bank Holiday', notes: 'Designated Organisation Bank Holiday' },
        { date: `${holidayYear}-12-25`, name: 'Christmas Day', notes: 'Designated Organisation Bank Holiday' },
      ]);
    }
    setHolidayModalError(null);
    setShowHolidayModal(true);
  };

  const handleSaveHolidays = async () => {
    setHolidayModalError(null);
    if (editingHolidays.length === 0) {
      setHolidayModalError('At least 1 holiday must be provided.');
      return;
    }
    for (const h of editingHolidays) {
      if (!h.date || !/^\d{4}-\d{2}-\d{2}$/.test(h.date)) {
        setHolidayModalError(`Invalid date format for "${h.name || 'unnamed'}". Must be YYYY-MM-DD.`);
        return;
      }
      if (!h.name.trim()) {
        setHolidayModalError(`Holiday title cannot be empty for date ${h.date}.`);
        return;
      }
    }
    setHolidaySaving(true);
    try {
      const res = await api.saveYearBankHolidays(holidayYear, editingHolidays);
      setBankHolidays(res.holidays || []);
      setHolidaySuccessMsg(`Successfully saved ${res.holidays.length} approved bank holidays for ${holidayYear}.`);
      setShowHolidayModal(false);
      setTimeout(() => setHolidaySuccessMsg(null), 5000);
      refresh(true);
    } catch (err: unknown) {
      setHolidayModalError(err instanceof Error ? err.message : 'Failed to save bank holidays.');
    } finally {
      setHolidaySaving(false);
    }
  };

  return (
    <Panel
      title="Annual Leave & Leave Management (Spec 13, 14 & 15)"
      note="Anniversary accruals (1.67d/mo), team calendar, shortfall checks, and approval lifecycle"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={activeTab === 'pending' ? 'primary' : 'ghost'}
            onClick={() => openPending(false)}
            className="py-1 px-3 text-xs"
          >
            Pending Approvals ({pendingCount})
          </Button>
          <Button
            variant={activeTab === 'absences' ? 'primary' : 'ghost'}
            onClick={() => setActiveTab('absences')}
            className="py-1 px-3 text-xs"
          >
            Sickness & Absences ({pendingAbsencesCount})
          </Button>
          <Button
            variant={activeTab === 'calendar' ? 'primary' : 'ghost'}
            onClick={() => {
              setActiveTab('calendar');
              if (selectedYear === null) setSelectedYear(currentYearNum);
              if (!selectedMonthKey) setSelectedMonthKey(currentMonthKey);
            }}
            className="py-1 px-3 text-xs"
          >
            Team Calendar ({calendarLeaves.length})
          </Button>
          <Button
            variant={activeTab === 'holidays' ? 'primary' : 'ghost'}
            onClick={() => setActiveTab('holidays')}
            className="py-1 px-3 text-xs flex items-center gap-1.5"
          >
            Public Holidays
            <span className="rounded-full bg-indigo-500/20 px-1.5 py-0.2 text-[10px] font-bold text-indigo-400 border border-indigo-500/30">
              5 Days
            </span>
          </Button>
          <Button
            variant={activeTab === 'balances' ? 'primary' : 'ghost'}
            onClick={() => setActiveTab('balances')}
            className="py-1 px-3 text-xs"
          >
            Workforce Balances
          </Button>
          <Button
            variant={activeTab === 'carry_forward' ? 'primary' : 'ghost'}
            onClick={() => setActiveTab('carry_forward')}
            className="py-1 px-3 text-xs flex items-center gap-1.5"
          >
            Carry-Forward & Rollovers
            {approachingEmployees.length > 0 && (
              <span className="rounded-full bg-warn/20 px-1.5 py-0.2 text-[10px] font-bold text-warn border border-warn/30">
                {approachingEmployees.length}
              </span>
            )}
          </Button>
          <Button
            variant={activeTab === 'all' ? 'primary' : 'ghost'}
            onClick={() => setActiveTab('all')}
            className="py-1 px-3 text-xs"
          >
            Request History
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setRecordStartDate(todayStr);
              setRecordEndDate(todayStr);
              setRecordReason('');
              setRecordOverdraftReason('');
              setRecordError(null);
              setShowRecordLeaveModal(true);
            }}
            className="py-1 px-3 text-xs bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm shadow-indigo-600/30"
          >
            + Record Leave
          </Button>
          <Button
            variant="ghost"
            onClick={() => setShowAdjustModal(true)}
            className="py-1 px-3 text-xs border border-white/10"
          >
            + Adjust Balance
          </Button>
          <Button onClick={() => refresh()} disabled={loading} className="py-1 px-3 text-xs">
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      }
    >
      {error && (
        <div className="mb-4 rounded-lg bg-danger-dim p-3 text-xs text-danger">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Summary KPI Cards (Spec 14.1 & 15.1) */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-6">
        <div
          onClick={() => openPending(false)}
          className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
            activeTab === 'pending' && !shortfallOnly
              ? 'border-brand bg-brand-dim/30 ring-1 ring-brand'
              : 'border-line bg-surface hover:bg-raised'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-text">Pending Approvals</span>
            {pendingCount > 0 && <span className="h-2 w-2 rounded-full bg-warn animate-pulse" />}
          </div>
          <div className="mt-2 text-2xl font-extrabold text-warn">{pendingCount}</div>
          <div className="mt-0.5 text-[10px] text-muted">Awaiting HR decision</div>
        </div>

        <div
          onClick={() => setActiveTab('absences')}
          className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
            activeTab === 'absences'
              ? 'border-brand bg-brand-dim/30 ring-1 ring-brand'
              : 'border-line bg-surface hover:bg-raised'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-text">Sickness & Absences</span>
            {pendingAbsencesCount > 0 && <span className="h-2 w-2 rounded-full bg-danger animate-pulse" />}
          </div>
          <div className="mt-2 text-2xl font-extrabold text-danger">{pendingAbsencesCount}</div>
          <div className="mt-0.5 text-[10px] text-muted">Self-reported / no-shows</div>
        </div>

        <div
          onClick={() => {
            setActiveTab('calendar');
            setSelectedYear(currentYearNum);
            setSelectedMonthKey(currentMonthKey);
            setCalendarSearch('');
            setCalendarViewMode('EMPLOYEES');
          }}
          className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
            activeTab === 'calendar'
              ? 'border-brand bg-brand-dim/30 ring-1 ring-brand'
              : 'border-line bg-surface hover:bg-raised'
          }`}
          title="Click to open Leave Calendar for today"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-text">On Leave Today</span>
            <span className="h-2 w-2 rounded-full bg-brand" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-text">{onLeaveToday.length}</div>
          <div className="mt-0.5 text-[10px] text-muted">Active approved coverage</div>
        </div>

        <div
          onClick={() => openPending(true)}
          className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
            activeTab === 'pending' && shortfallOnly
              ? 'border-danger bg-danger-dim/30 ring-1 ring-danger'
              : 'border-line bg-surface hover:bg-raised'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-text">Shortfall Warnings</span>
            {shortfallCount > 0 && <span className="h-2 w-2 rounded-full bg-danger" />}
          </div>
          <div className="mt-2 text-2xl font-extrabold text-danger">{shortfallCount}</div>
          <div className="mt-0.5 text-[10px] text-muted">Exceeds accrued balance</div>
        </div>

        <div
          onClick={() => setActiveTab('carry_forward')}
          className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
            activeTab === 'carry_forward'
              ? 'border-brand bg-brand-dim/30 ring-1 ring-brand'
              : 'border-line bg-surface hover:bg-raised'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-text">Anniversaries (30d)</span>
            {approachingEmployees.length > 0 && <span className="h-2 w-2 rounded-full bg-warn animate-pulse" />}
          </div>
          <div className="mt-2 text-2xl font-extrabold text-warn">{approachingEmployees.length}</div>
          <div className="mt-0.5 text-[10px] text-muted">Carry-forward reviews</div>
        </div>

        <div
          onClick={() => setActiveTab('balances')}
          className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
            activeTab === 'balances'
              ? 'border-brand bg-brand-dim/30 ring-1 ring-brand'
              : 'border-line bg-surface hover:bg-raised'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-text">Active Employees</span>
            <span className="h-2 w-2 rounded-full bg-line" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-text">{balances.length}</div>
          <div className="mt-0.5 text-[10px] text-muted">Tracked leave profiles</div>
        </div>
      </div>

      {/* Tab 1: Pending Approvals Queue (Spec 15) */}
      {activeTab === 'pending' && (
        <div>
          {shortfallOnly && (
            <div className="mb-3 flex items-center justify-between rounded-lg border border-danger/30 bg-danger-dim/20 px-3 py-2 text-xs">
              <span className="text-text">
                Showing only requests that exceed the accrued balance ({shortfallCount})
              </span>
              <button onClick={() => setShortfallOnly(false)} className="font-semibold text-brand hover:underline">
                Show all pending
              </button>
            </div>
          )}
          {visiblePending.length === 0 ? (
            <Empty>
              {shortfallOnly ? 'No pending requests exceed the accrued balance.' : 'No leave requests awaiting approval.'}
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-line bg-raised text-dim">
                    <th className="px-3 py-2.5 font-semibold">Employee</th>
                    <th className="px-3 py-2.5 font-semibold">Leave Type</th>
                    <th className="px-3 py-2.5 font-semibold">Date Range</th>
                    <th className="px-3 py-2.5 font-semibold">Working Days</th>
                    <th className="px-3 py-2.5 font-semibold">Accrual & Balance Check</th>
                    <th className="px-3 py-2.5 font-semibold">Submitted</th>
                    <th className="px-3 py-2.5 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {visiblePending.map((r) => {
                    const hasShortfall =
                      r.exceedsBalance || (r.shortfallDays && r.shortfallDays > 0);

                    return (
                      <tr
                        key={r.id}
                        onClick={() => openReviewModal(r)}
                        className="hover:bg-white/[0.04] cursor-pointer transition-colors group select-none"
                        title="Click to view full employee leave details, reason & remaining balance"
                      >
                        <td className="px-3 py-3 align-top">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-text group-hover:text-brand transition-colors">
                              {r.employeeName}
                            </span>
                            {r.employeeNumber && (
                              <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                                {r.employeeNumber}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted">{r.employeeRole ?? ''}</div>
                          {r.reason && (
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                openReviewModal(r);
                              }}
                              className="mt-1 text-[11px] text-indigo-300 font-medium bg-indigo-950/50 border border-indigo-500/30 px-2 py-0.5 rounded-md max-w-[280px] truncate inline-flex items-center gap-1 group-hover:border-indigo-400/60 hover:bg-indigo-900/60 transition-colors cursor-pointer shadow-sm"
                              title={`Reason: "${r.reason}" — Click to open full details`}
                            >
                              <span className="text-indigo-400 text-[10px] font-bold">Reason:</span>
                              <span className="truncate">&ldquo;{r.reason}&rdquo;</span>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge tone={r.reducesEntitlement ? 'brand' : 'muted'}>{r.type}</Badge>
                            {r.defaultIsPaid ? (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-950/40 text-emerald-400 border border-emerald-800/40">
                                Paid
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-950/40 text-amber-400 border border-amber-800/40">
                                Unpaid
                              </span>
                            )}
                          </div>
                          {r.requiresEvidence && (
                            <div className="text-[10px] text-warn mt-0.5">Evidence Required</div>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top font-mono text-[11px]">
                          <div>{r.from}</div>
                          <div className="text-dim">to {r.to}</div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <span className="font-bold text-sm text-brand">{r.days}d</span>
                          <div className="text-[10px] text-dim">working days</div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          {r.balance ? (
                            <div>
                              <div className="text-[11px] text-text font-medium">
                                Available: {r.balance.available}d (Accrued: {r.balance.accrued}d)
                              </div>
                              {hasShortfall ? (
                                <div className="mt-1 flex items-center gap-1">
                                  <Badge tone="danger">
                                    Shortfall: {r.shortfallDays ? `${r.shortfallDays}d` : 'Exceeds'}
                                  </Badge>
                                </div>
                              ) : (
                                <div className="text-[10px] text-brand mt-0.5">
                                  <CheckIcon className="inline-block h-3 w-3" /> Within accrued balance
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-dim">Balance uncomputable</span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top text-dim text-[11px]">{r.submittedAt}</td>
                        <td className="px-3 py-3 align-top text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              onClick={() => openReviewModal(r)}
                              className="py-1 px-2.5 text-[11px] font-semibold text-brand hover:text-white hover:bg-brand/20 border border-brand/40 shadow-sm inline-flex items-center gap-1"
                              title="Open full leave request review window with remaining leaves and reason"
                            >
                              <FileTextIcon className="h-3 w-3" />
                              <span>Review</span>
                            </Button>
                            <Button
                              variant="primary"
                              onClick={() => openReviewModal(r, 'APPROVED')}
                              className="py-1 px-3 text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm inline-flex items-center gap-1"
                              title="Review details & approve this request"
                            >
                              <CheckIcon className="h-3 w-3" />
                              <span>Approve</span>
                            </Button>
                            <Button
                              onClick={() => openReviewModal(r, 'REJECTED')}
                              className="py-1 px-2.5 text-[11px] font-semibold text-rose-300 hover:text-white hover:bg-rose-950/60 border border-rose-500/30 inline-flex items-center gap-1"
                              title="Review details & reject this request"
                            >
                              <XIcon className="h-3 w-3" />
                              <span>Reject</span>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Team Holiday Calendar & Coverage View (Spec 15.3) */}
      {activeTab === 'calendar' && (
        <div className="space-y-4">
          {/* Active Leaves Today Highlight Banner */}
          {onLeaveToday.length > 0 && (
            <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-emerald-950/30 via-surface/90 to-surface/80 p-3.5 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse shadow-sm shadow-emerald-400/50" />
                  <span className="text-xs font-extrabold text-emerald-300 tracking-wide uppercase">
                    On Leave Today ({onLeaveToday.length})
                  </span>
                  <div className="flex items-center gap-2 flex-wrap">
                    {onLeaveToday.map((l) => (
                      <span
                        key={l.id}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-surface/90 border border-emerald-500/30 px-2.5 py-1 text-xs text-text font-bold shadow-sm"
                      >
                        <span>{l.employeeName}</span>
                        {l.employeeNumber && (
                          <span className="font-mono text-[10px] text-emerald-300 font-semibold">
                            [{l.employeeNumber}]
                          </span>
                        )}
                        <span className="rounded bg-emerald-500/20 px-1 py-0.2 text-[9px] font-mono text-emerald-300">
                          {l.type}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-[11px] text-muted font-medium">
                  {todayStr} · Active Approved Leave Coverage
                </div>
              </div>
            </div>
          )}

          {/* Annual & Monthly Breakdown Controls & Header */}
          <div className="rounded-2xl border border-line bg-surface/80 p-4 space-y-4">
            {/* Top Bar: Title, Search, View Mode, Record Leave */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-bold text-text">
                    Annual & Monthly Breakdown
                  </h3>
                  <Badge tone="brand">
                    {activeMonthBucket
                      ? activeMonthBucket.label
                      : activeYear !== 'ALL'
                      ? `Full Year ${activeYear}`
                      : 'All Years & Months'}
                  </Badge>
                  {activeYear !== 'ALL' && (
                    <span className="rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-2 py-0.5 text-[10px] font-bold">
                      Year {activeYear}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  Step 1: Select a Year &rarr; Step 2: Select a Month to inspect employees who took leaves.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* Search in Month / Year */}
                <div className="relative">
                  <input
                    type="text"
                    value={calendarSearch}
                    onChange={(e) => setCalendarSearch(e.target.value)}
                    placeholder="Search employee, ID, role..."
                    className="w-48 sm:w-56 rounded-xl border border-line bg-raised px-3 py-1.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
                  />
                  {calendarSearch && (
                    <button
                      type="button"
                      onClick={() => setCalendarSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-text cursor-pointer"
                    >
                      ×
                    </button>
                  )}
                </div>

                {/* View Mode Toggle */}
                <div className="flex items-center rounded-xl border border-line bg-raised p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setCalendarViewMode('EMPLOYEES')}
                    className={`rounded-lg px-2.5 py-1 font-semibold transition cursor-pointer ${
                      calendarViewMode === 'EMPLOYEES'
                        ? 'bg-brand text-on-accent shadow-sm'
                        : 'text-muted hover:text-text'
                    }`}
                  >
                    By Employee ({filteredActiveMonthEmployees.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setCalendarViewMode('CARDS')}
                    className={`rounded-lg px-2.5 py-1 font-semibold transition cursor-pointer ${
                      calendarViewMode === 'CARDS'
                        ? 'bg-brand text-on-accent shadow-sm'
                        : 'text-muted hover:text-text'
                    }`}
                  >
                    All Bookings ({filteredActiveMonthLeaves.length})
                  </button>
                </div>

                {/* + Record Leave Button */}
                <Button
                  variant="primary"
                  onClick={() => {
                    setRecordStartDate(todayStr);
                    setRecordEndDate(todayStr);
                    setRecordReason('');
                    setRecordOverdraftReason('');
                    setRecordError(null);
                    setShowRecordLeaveModal(true);
                  }}
                  className="py-1 px-3 text-xs bg-indigo-600 hover:bg-indigo-500 text-white"
                >
                  + Record Leave
                </Button>
              </div>
            </div>

            {/* TIER 1: YEAR SELECTOR TABS */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 border-t border-b border-line py-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-bold uppercase tracking-wider text-dim">
                  Select Year:
                </span>
                <div className="flex items-center gap-1.5 flex-wrap rounded-xl border border-line bg-raised p-1">
                  {yearBuckets.map((y) => {
                    const isYearActive = activeYear === y.year;
                    const isCurrentYear = y.year === currentYearNum;

                    return (
                      <button
                        key={y.year}
                        type="button"
                        onClick={() => {
                          setSelectedYear(y.year);
                          // Default to current month if in this year, or first available month
                          const matchingMonth = monthBuckets.find(
                            (m) => m.year === y.year && m.monthKey === currentMonthKey,
                          );
                          const firstMonth =
                            matchingMonth?.monthKey ||
                            monthBuckets.find((m) => m.year === y.year)?.monthKey ||
                            `ALL_${y.year}`;
                          setSelectedMonthKey(firstMonth);
                        }}
                        className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
                          isYearActive
                            ? 'bg-accent-gradient text-on-accent shadow-accent'
                            : 'text-muted hover:text-text hover:bg-white/5'
                        }`}
                      >
                        <span>{y.year}</span>
                        <span
                          className={`rounded px-1.5 py-0.2 text-[10px] font-mono ${
                            isYearActive ? 'bg-black/25 text-white' : 'bg-white/5 text-dim'
                          }`}
                        >
                          {y.totalDays}d
                        </span>
                        {isCurrentYear && (
                          <span
                            className="h-2 w-2 rounded-full bg-emerald-400 shadow-sm animate-pulse"
                            title="Current Year"
                          />
                        )}
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedYear('ALL');
                      setSelectedMonthKey('ALL');
                    }}
                    className={`rounded-lg px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
                      activeYear === 'ALL'
                        ? 'bg-accent-gradient text-on-accent shadow-accent'
                        : 'text-muted hover:text-text hover:bg-white/5'
                    }`}
                  >
                    All Years
                  </button>
                </div>
              </div>

              {/* Year Stats Indicator */}
              <div className="text-xs text-muted flex items-center gap-2">
                {activeYearBucket ? (
                  <span>
                    Year <strong className="text-text">{activeYear}</strong>:{' '}
                    <strong className="font-mono text-indigo-300">{activeYearBucket.totalDays}d leave</strong> taken by{' '}
                    <strong className="text-text">{activeYearBucket.employees.size} employees</strong> across{' '}
                    <strong className="text-text">{activeYearBucket.monthsCount} months</strong>
                  </span>
                ) : (
                  <span>
                    Total Across All Years:{' '}
                    <strong className="font-mono text-indigo-300">
                      {calendarLeaves.reduce((acc, c) => acc + (Number(c.days) || 1), 0)}d
                    </strong>{' '}
                    across <strong className="text-text">{calendarLeaves.length} bookings</strong>
                  </span>
                )}
              </div>
            </div>

            {/* TIER 2: MONTH CARDS FOR SELECTED YEAR */}
            <div>
              <div className="mb-2 flex items-center justify-between text-[11px] text-muted">
                <span>
                  Months in <strong className="text-text">{activeYear === 'ALL' ? 'All Years' : activeYear}</strong> ({visibleMonthBuckets.length} months with leave activity):
                </span>
                <span className="text-[10px] text-dim">
                  Click a month card to view employee breakdown
                </span>
              </div>

              <div className="flex items-center gap-2 overflow-x-auto pb-1 pt-0.5 no-scrollbar">
                {/* All Months for Year Button */}
                <button
                  type="button"
                  onClick={() =>
                    setSelectedMonthKey(activeYear === 'ALL' ? 'ALL' : `ALL_${activeYear}`)
                  }
                  className={`shrink-0 rounded-xl border px-3.5 py-2.5 text-left transition-all cursor-pointer ${
                    activeMonthKey === 'ALL' || activeMonthKey === `ALL_${activeYear}`
                      ? 'border-indigo-500 bg-gradient-to-br from-indigo-950/60 to-surface ring-2 ring-indigo-500/50 shadow-md shadow-indigo-500/10'
                      : 'border-line bg-surface hover:bg-raised hover:border-white/20'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-xs text-text">
                      {activeYear === 'ALL' ? 'All Records' : `Full ${activeYear}`}
                    </span>
                    <span className="rounded bg-white/10 px-1.5 py-0.2 text-[9px] font-mono text-dim">
                      {activeMonthLeaves.length}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    {activeMonthEmployees.length} employees on leave
                  </div>
                </button>

                {/* Month Cards for Selected Year */}
                {visibleMonthBuckets.map((b) => {
                  const isSelected = activeMonthKey === b.monthKey;
                  const isCurrent = b.monthKey === currentMonthKey;

                  return (
                    <button
                      key={b.monthKey}
                      type="button"
                      onClick={() => setSelectedMonthKey(b.monthKey)}
                      className={`shrink-0 rounded-xl border px-3.5 py-2.5 text-left transition-all cursor-pointer min-w-[140px] ${
                        isSelected
                          ? 'border-indigo-500 bg-gradient-to-br from-indigo-950/60 to-surface ring-2 ring-indigo-500/50 shadow-md shadow-indigo-500/10'
                          : 'border-line bg-surface hover:bg-raised hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <span className={`font-bold text-xs ${isSelected ? 'text-indigo-200' : 'text-text'}`}>
                          {b.label}
                        </span>
                        {isCurrent && (
                          <span className="rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.2 text-[8px] font-bold">
                            Current
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-[11px]">
                        <span className="text-muted font-medium">
                          {b.employees.size} {b.employees.size === 1 ? 'person' : 'people'}
                        </span>
                        <span className="font-mono font-bold text-indigo-400">
                          {b.totalDays}d
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Leave Content for the selected month */}
          {calendarLeaves.length === 0 ? (
            <Empty>No scheduled leaves found in the calendar range.</Empty>
          ) : filteredActiveMonthEmployees.length === 0 ? (
            <div className="rounded-2xl border border-line bg-surface p-8 text-center">
              <p className="font-semibold text-text">No employees on leave found for this filter</p>
              <p className="mt-1 text-xs text-muted">
                Try selecting a different month card above, or clear your search query.
              </p>
            </div>
          ) : calendarViewMode === 'EMPLOYEES' ? (
            /* EMPLOYEES VIEW: Grouped by Person who took leave in this month */
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredActiveMonthEmployees.map((emp) => {
                const isEmpOnLeaveToday = emp.leaves.some(
                  (l) => l.from <= todayStr && l.to >= todayStr,
                );
                const initials = emp.employeeName
                  .split(' ')
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join('')
                  .toUpperCase();

                return (
                  <div
                    key={emp.employeeId}
                    className={`rounded-2xl border p-4 transition-all ${
                      isEmpOnLeaveToday
                        ? 'border-indigo-500/40 bg-gradient-to-br from-indigo-950/20 to-surface ring-1 ring-indigo-500/30 shadow-md'
                        : 'border-line bg-surface hover:bg-raised hover:border-white/20'
                    }`}
                  >
                    {/* Employee Profile Header */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-gradient font-extrabold text-xs text-on-accent shadow-accent">
                          {initials}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h4 className="font-bold text-sm text-text truncate">
                              {emp.employeeName}
                            </h4>
                            {emp.employeeNumber && (
                              <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[9px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                                {emp.employeeNumber}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted truncate mt-0.5">
                            {emp.employeeRole || 'Employee'}
                          </div>
                        </div>
                      </div>

                      {/* Header Badge */}
                      {isEmpOnLeaveToday ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/20 border border-indigo-500/40 px-2 py-0.5 text-[10px] font-bold text-indigo-300 shadow-sm animate-pulse">
                          <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
                          <span>On Leave Today</span>
                        </span>
                      ) : (
                        <span className="rounded-lg bg-white/5 border border-white/10 px-2 py-0.5 text-[11px] font-mono font-bold text-text">
                          {emp.totalDays}d leave
                        </span>
                      )}
                    </div>

                    {/* Employee's Leaves in this Month */}
                    <div className="mt-3 space-y-2 pt-3 border-t border-line">
                      <div className="text-[10px] uppercase font-bold text-dim tracking-wider">
                        Leave Bookings ({emp.leaves.length})
                      </div>
                      {emp.leaves.map((l) => {
                        const isLeaveToday = l.from <= todayStr && l.to >= todayStr;
                        const isHrManual =
                          l.source === 'HR_MANUAL' ||
                          l.sourceLabel === 'HR Added' ||
                          l.id?.startsWith('lr_hrwb_') ||
                          l.id?.startsWith('lr_hr_');

                        return (
                          <div
                            key={l.id}
                            className={`rounded-xl border p-2.5 text-xs transition-colors ${
                              isLeaveToday
                                ? 'border-indigo-500/30 bg-indigo-500/10'
                                : 'border-line/70 bg-raised/50'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="font-bold text-text truncate">
                                {l.type}
                              </span>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {l.isPaid === 1 ? (
                                  <span className="text-[10px] font-semibold text-emerald-400">
                                    Paid
                                  </span>
                                ) : l.isPaid === 0 ? (
                                  <span className="text-[10px] font-semibold text-amber-400">
                                    Unpaid
                                  </span>
                                ) : null}
                                <span className="font-mono font-bold text-brand bg-brand-dim/30 px-1.5 py-0.2 rounded text-[11px]">
                                  {l.days}d
                                </span>
                              </div>
                            </div>

                            <div className="mt-1 flex items-center justify-between text-[11px] font-mono text-dim">
                              <span>
                                {l.from === l.to ? l.from : `${l.from} → ${l.to}`}
                              </span>
                              {isLeaveToday && (
                                <span className="text-[9px] font-bold text-indigo-400">
                                  ● Active Today
                                </span>
                              )}
                            </div>

                            {/* SOURCE BADGE: HR Manual vs Requested & Approved */}
                            <div className="mt-2 flex items-center justify-between gap-1 flex-wrap pt-1.5 border-t border-white/5">
                              {isHrManual ? (
                                <span
                                  className="inline-flex items-center gap-1 rounded-md bg-purple-500/15 border border-purple-500/30 px-2 py-0.5 text-[10px] font-bold text-purple-300"
                                  title="This leave was manually recorded by HR"
                                >
                                  <ShieldCheckIcon className="h-3 w-3 text-purple-400" />
                                  <span>HR Added Leave</span>
                                </span>
                              ) : (
                                <span
                                  className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-300"
                                  title="This leave was requested by employee and approved"
                                >
                                  <CheckIcon className="h-3 w-3 text-emerald-400" />
                                  <span>Requested & Approved</span>
                                </span>
                              )}
                            </div>

                            {/* Reason / HR Notes */}
                            {l.reason && (
                              <div className="mt-1.5 rounded-lg bg-surface/70 border border-white/5 p-1.5 text-[10px] text-muted leading-tight">
                                <span className="font-semibold text-dim">Note: </span>
                                <span>{l.reason}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* CARDS VIEW: Individual Booking Cards */
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {filteredActiveMonthLeaves.map((l) => {
                const isTodayActive = l.from <= todayStr && l.to >= todayStr;
                const isHrManual =
                  l.source === 'HR_MANUAL' ||
                  l.sourceLabel === 'HR Added' ||
                  l.id?.startsWith('lr_hrwb_') ||
                  l.id?.startsWith('lr_hr_');

                return (
                  <div
                    key={l.id}
                    className={`rounded-xl border p-3.5 transition-all ${
                      isTodayActive
                        ? 'border-indigo-500/40 bg-indigo-950/20 shadow-md ring-1 ring-indigo-500/30'
                        : 'border-line bg-surface hover:bg-raised'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-bold text-sm text-text">{l.employeeName}</span>
                        {l.employeeNumber && (
                          <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                            {l.employeeNumber}
                          </span>
                        )}
                      </div>
                      <Badge tone={isTodayActive ? 'brand' : 'muted'}>
                        {isTodayActive ? 'Away Today' : `${l.days}d`}
                      </Badge>
                    </div>

                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className="text-brand font-medium">{l.type}</span>
                      {l.isPaid === 1 ? (
                        <span className="text-[10px] text-emerald-400 font-semibold">Paid</span>
                      ) : l.isPaid === 0 ? (
                        <span className="text-[10px] text-amber-400 font-semibold">Unpaid</span>
                      ) : null}
                    </div>

                    <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-dim">
                      <span>{l.from}</span>
                      <span>&rarr;</span>
                      <span>{l.to}</span>
                    </div>

                    {/* SOURCE BADGE */}
                    <div className="mt-2.5 flex items-center justify-between gap-1 flex-wrap pt-2 border-t border-line">
                      {isHrManual ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-purple-500/15 border border-purple-500/30 px-2 py-0.5 text-[10px] font-bold text-purple-300">
                          <ShieldCheckIcon className="h-3 w-3 text-purple-400" />
                          <span>HR Added Leave</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                          <CheckIcon className="h-3 w-3 text-emerald-400" />
                          <span>Requested & Approved</span>
                        </span>
                      )}
                    </div>

                    {l.reason && (
                      <div className="mt-1.5 rounded-lg bg-raised/50 border border-white/5 p-1.5 text-[10px] text-muted truncate">
                        <span className="text-dim font-medium">Note: </span>{l.reason}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab: Designated Bank Holidays / Public Holidays (Organisation Policy) */}
      {activeTab === 'holidays' && (
        <div className="space-y-4">
          {/* Policy Banner */}
          <div className="rounded-2xl border border-indigo-500/30 bg-gradient-to-r from-indigo-950/40 via-purple-950/30 to-background p-4 sm:p-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-extrabold text-text tracking-tight">
                    Designated Organisation Bank Holidays
                  </h3>
                  <span className="rounded-full bg-indigo-500/20 px-2.5 py-0.5 text-xs font-bold text-indigo-300 border border-indigo-500/40">
                    5 Approved Days / Year
                  </span>
                  <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-bold text-amber-300 border border-amber-500/40">
                    HR Managed Only
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted leading-relaxed max-w-3xl">
                  Under the organisation's annual entitlement policy, exactly 5 designated bank holidays are approved per calendar year.
                  These days appear automatically in the company calendar, are <strong>not counted as employee annual leave</strong>,
                  do <strong>not reduce paid leave entitlement</strong>, are <strong>excluded from normal absence calculations</strong>, and
                  are <strong>included in monthly required working hours</strong> as paid non-working days (7.5h credit).
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <div className="flex items-center rounded-lg bg-surface border border-line p-1">
                  {[holidayYear - 1, holidayYear, holidayYear + 1].map((y) => (
                    <button
                      key={y}
                      onClick={() => loadYearHolidays(y)}
                      className={`px-3 py-1 text-xs font-bold rounded transition-colors ${
                        holidayYear === y
                          ? 'bg-brand text-brand-contrast'
                          : 'text-muted hover:text-text'
                      }`}
                    >
                      {y}
                    </button>
                  ))}
                </div>
                <Button
                  variant="primary"
                  onClick={openHolidayConfigModal}
                  className="py-1.5 px-3.5 text-xs font-bold flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                  </svg>
                  Configure Holidays (HR)
                </Button>
              </div>
            </div>

            {holidaySuccessMsg && (
              <div className="mt-3 rounded-lg bg-emerald-500/20 border border-emerald-500/40 p-2.5 text-xs font-semibold text-emerald-300 flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 shrink-0" />
                <span>{holidaySuccessMsg}</span>
              </div>
            )}
          </div>

          {/* 5 Designated Holidays List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-muted">
              <span>Showing {bankHolidays.length} designated bank holidays for calendar year <strong>{holidayYear}</strong></span>
              <span className="text-[11px] text-dim">Visible to all employees in advance on mobile & web</span>
            </div>

            {bankHolidays.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line p-8 text-center">
                <p className="text-sm font-semibold text-muted">No bank holidays configured for {holidayYear}.</p>
                <p className="text-xs text-dim mt-1">Configure the 5 approved organisation holidays for this year.</p>
                <Button
                  variant="primary"
                  onClick={openHolidayConfigModal}
                  className="mt-3 py-1.5 px-3 text-xs"
                >
                  Configure {holidayYear} Holidays
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {bankHolidays.map((h, idx) => (
                  <div
                    key={h.id}
                    className="relative rounded-2xl border border-indigo-500/20 bg-surface/90 hover:bg-raised p-4 transition-all shadow-sm flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="rounded bg-indigo-500/20 px-2 py-0.5 text-[10px] font-bold text-indigo-300 border border-indigo-500/30">
                          Holiday #{idx + 1}
                        </span>
                        <span className="text-[10px] font-semibold text-emerald-400">
                          Approved Paid
                        </span>
                      </div>

                      <div className="mt-3">
                        <span className="text-lg font-extrabold text-text block tracking-tight">
                          {h.name}
                        </span>
                        <div className="mt-1 flex items-center gap-2 text-xs font-mono font-semibold text-indigo-400">
                          <span>{h.date}</span>
                          <span>·</span>
                          <span className="text-dim font-sans">{h.weekday}</span>
                        </div>
                      </div>

                      {h.notes && (
                        <p className="mt-2 text-[11px] text-muted line-clamp-2">
                          {h.notes}
                        </p>
                      )}
                    </div>

                    <div className="mt-4 pt-3 border-t border-line/60 flex items-center justify-between text-[10px] text-dim">
                      <span>No Leave Deduction</span>
                      <span className="text-indigo-300 font-medium">7.5h Target Met</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Policy Rules Quick Summary */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 pt-2">
            <div className="rounded-xl border border-line bg-surface/60 p-3">
              <div className="text-xs font-bold text-text"><CalendarIcon className="inline-block h-3.5 w-3.5" /> Company Calendar</div>
              <div className="text-[11px] text-muted mt-1">Appears automatically on the team schedule and calendar views.</div>
            </div>
            <div className="rounded-xl border border-line bg-surface/60 p-3">
              <div className="text-xs font-bold text-emerald-400"><ShieldCheckIcon className="inline-block h-3.5 w-3.5" /> 0 Annual Leave Loss</div>
              <div className="text-[11px] text-muted mt-1">Leave requests overlapping this date skip it—balance is preserved.</div>
            </div>
            <div className="rounded-xl border border-line bg-surface/60 p-3">
              <div className="text-xs font-bold text-indigo-400"><TimerIcon className="inline-block h-3.5 w-3.5" /> Working Hours Credit</div>
              <div className="text-[11px] text-muted mt-1">Monthly target is reduced by 7.5h per holiday to prevent deficit.</div>
            </div>
            <div className="rounded-xl border border-line bg-surface/60 p-3">
              <div className="text-xs font-bold text-amber-400"><LockIcon className="inline-block h-3.5 w-3.5" /> HR Exclusive Edit</div>
              <div className="text-[11px] text-muted mt-1">Only HR administrators hold permission to alter approved holiday dates.</div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Workforce Balances & Entitlements (Spec 14.1) */}
      {activeTab === 'balances' && (
        <div>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="w-full sm:w-64">
              <Input
                type="text"
                placeholder="Search employee or role…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full text-xs py-1.5"
              />
            </div>
            <span className="text-xs text-muted">
              Accrual rate: <strong>1.6667 days/month</strong> (20 days/year)
            </span>
          </div>

          {filteredBalances.length === 0 ? (
            <Empty>No employee leave balances match your search.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-line bg-raised text-dim">
                    <th className="px-3 py-2.5 font-semibold">Employee</th>
                    <th className="px-3 py-2.5 font-semibold">Official Joining Date & Cycle</th>
                    <th className="px-3 py-2.5 font-semibold">Entitlement</th>
                    <th className="px-3 py-2.5 font-semibold">Accrued</th>
                    <th className="px-3 py-2.5 font-semibold">Taken</th>
                    <th className="px-3 py-2.5 font-semibold">Carried In</th>
                    <th className="px-3 py-2.5 font-semibold">Remaining (Cycle)</th>
                    <th className="px-3 py-2.5 font-semibold">Expiring / Lapsed</th>
                    <th className="px-3 py-2.5 font-semibold">Net Available</th>
                    <th className="px-3 py-2.5 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filteredBalances.map((b) => {
                    const bal = b.balance;
                    if (bal.blocked) {
                      return (
                        <tr key={b.employeeId} className="hover:bg-white/[0.02]">
                          <td className="px-3 py-3 align-middle">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-semibold text-text">{b.employeeName}</span>
                              {b.employeeNumber && (
                                <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                                  {b.employeeNumber}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-muted">{b.role}</div>
                          </td>
                          <td colSpan={8} className="px-3 py-3 align-middle text-dim italic">
                            Blocked: {bal.message ?? 'No official joining date on record'}
                          </td>
                          <td className="px-3 py-3 align-middle text-right">
                            <Button
                              onClick={() => {
                                setAdjustEmployeeId(b.employeeId);
                                setShowAdjustModal(true);
                              }}
                              className="py-1 px-2.5 text-[11px]"
                            >
                              Adjust
                            </Button>
                          </td>
                        </tr>
                      );
                    }

                    const cycleStart = bal.cycleStartDate || bal.holidayYear?.from || '—';
                    const cycleEnd = bal.cycleEndDate || bal.holidayYear?.to || '—';
                    const renewal = bal.nextRenewalDate || bal.renewalDate || bal.holidayYear?.anniversaryDate || '—';
                    const carriedIn = bal.approvedCarryForwardDays ?? bal.approvedCarryForward ?? 0;
                    const dueExpire = bal.leaveDueToExpire ?? bal.dueToExpire ?? 0;
                    const lapsed = bal.leaveAlreadyLapsed ?? bal.alreadyLapsed ?? 0;
                    const remainingCycle = bal.remainingCurrentCycleDays ?? bal.remainingCurrentCycle ?? bal.available;

                    return (
                      <tr key={b.employeeId} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-3 align-middle">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-text">{b.employeeName}</span>
                            {b.employeeNumber && (
                              <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                                {b.employeeNumber}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted">{b.role}</div>
                        </td>
                        <td className="px-3 py-3 align-middle font-mono text-[11px] text-dim">
                          <div className="font-semibold text-text">
                            Joined: {formatFullDate(bal.officialJoiningDate)}
                          </div>
                          <div className="text-[10px] text-dim">
                            Cycle: {cycleStart} &rarr; {cycleEnd}
                          </div>
                          <div className="text-[10px] text-indigo-400">
                            Renews: {renewal}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-middle font-semibold text-text">
                          {bal.annualEntitlementDays ?? bal.annualEntitlement}d
                        </td>
                        <td className="px-3 py-3 align-middle font-semibold text-brand">
                          {bal.accruedDays ?? bal.accrued}d
                        </td>
                        <td className="px-3 py-3 align-middle text-dim">
                          {bal.takenDays ?? bal.taken}d
                        </td>
                        <td className="px-3 py-3 align-middle text-teal-400 font-semibold">
                          {carriedIn > 0 ? `+${carriedIn}d` : '0d'}
                        </td>
                        <td className="px-3 py-3 align-middle text-text font-medium">
                          {remainingCycle}d
                        </td>
                        <td className="px-3 py-3 align-middle text-[11px]">
                          {dueExpire > 0 && (
                            <div className="text-warn font-semibold">
                              Due: {dueExpire}d
                            </div>
                          )}
                          {lapsed > 0 && (
                            <div className="text-dim">
                              Lapsed: {lapsed}d
                            </div>
                          )}
                          {dueExpire === 0 && lapsed === 0 && (
                            <span className="text-dim">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <span
                            className={`font-extrabold text-sm ${
                              bal.available < 0 ? 'text-danger' : 'text-brand'
                            }`}
                          >
                            {bal.available}d
                          </span>
                        </td>
                        <td className="px-3 py-3 align-middle text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              onClick={() => openMonthlyModal(b.employeeId, b.employeeName)}
                              className="py-1 px-2 text-[10px]"
                            >
                              <FileTextIcon className="h-3 w-3 shrink-0" /> Statement
                            </Button>
                            <Button
                              onClick={() => openCyclesModal(b.employeeId, b.employeeName)}
                              className="py-1 px-2 text-[10px]"
                            >
                              <HistoryIcon className="h-3 w-3 shrink-0" /> Cycles
                            </Button>
                            <Button
                              onClick={() => {
                                setAdjustEmployeeId(b.employeeId);
                                setShowAdjustModal(true);
                              }}
                              className="py-1 px-2 text-[10px]"
                            >
                              Adjust
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab: Carry-Forward & Work Anniversary Rollovers */}
      {activeTab === 'carry_forward' && (
        <div>
          <div className="mb-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
            <div className="flex items-start gap-3">
              <RefreshIcon className="h-5 w-5 shrink-0" />
              <div>
                <h3 className="text-sm font-bold text-text">
                  Work Anniversary Leave Rollovers & Carry-Forward (Max 5 Days)
                </h3>
                <p className="mt-1 text-xs text-muted leading-relaxed">
                  Each employee's annual leave entitlement is tied strictly to their <strong>Official Joining Date</strong>.
                  Upon their work anniversary, management can review and approve unused leave to carry forward into the new 12-month cycle (usually up to <strong>5.0 days</strong>; more with management approval).
                  Any unused balance that is not approved automatically lapses upon rollover.
                  Employees approaching their anniversary receive automated 14-day cycle-end notifications.
                </p>
              </div>
            </div>
          </div>

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs font-semibold text-text">
              Employees Approaching Anniversary (Next 30 Days): {approachingEmployees.length}
            </div>
            <Button onClick={() => refresh()} disabled={loading} className="py-1 px-3 text-xs">
              {loading ? 'Refreshing…' : 'Scan Renewals'}
            </Button>
          </div>

          {approachingEmployees.length === 0 ? (
            <Empty>
              No employees have upcoming work anniversaries within the next 30 days. All active leave cycles are up to date.
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-line bg-raised text-dim">
                    <th className="px-3 py-2.5 font-semibold">Employee</th>
                    <th className="px-3 py-2.5 font-semibold">Official Joining Date</th>
                    <th className="px-3 py-2.5 font-semibold">Current Cycle Range</th>
                    <th className="px-3 py-2.5 font-semibold">Renewal Date</th>
                    <th className="px-3 py-2.5 font-semibold">Available Unused</th>
                    <th className="px-3 py-2.5 font-semibold">Max Eligible Carry-Over</th>
                    <th className="px-3 py-2.5 font-semibold">Decision / Status</th>
                    <th className="px-3 py-2.5 font-semibold text-right">Management Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {approachingEmployees.map((emp) => {
                    const dec = emp.carryForwardDecision;
                    return (
                      <tr key={emp.employeeId} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-3 align-middle">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-text">{emp.name}</span>
                            {emp.employeeNumber && (
                              <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                                {emp.employeeNumber}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted">{emp.role}</div>
                        </td>
                        <td className="px-3 py-3 align-middle text-text font-medium">
                          {formatFullDate(emp.officialJoiningDate)}
                        </td>
                        <td className="px-3 py-3 align-middle font-mono text-[11px] text-dim">
                          {emp.cycleStartDate} &rarr; {emp.cycleEndDate}
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <div className="font-semibold text-text">{emp.nextRenewalDate}</div>
                          <div className="text-[10px] text-warn font-medium">
                            {emp.daysUntilAnniversary === 0
                              ? 'Due today!'
                              : `In ${emp.daysUntilAnniversary} days`}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <span className="font-extrabold text-sm text-text">
                            {emp.availableDays}d
                          </span>
                        </td>
                        <td className="px-3 py-3 align-middle font-semibold text-teal-400">
                          {emp.maxEligibleCarryForward}d
                        </td>
                        <td className="px-3 py-3 align-middle">
                          {dec ? (
                            dec.decision === 'APPROVED' ? (
                              <div>
                                <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-400 border border-emerald-500/20">
                                  <CheckIcon className="h-3.5 w-3.5 shrink-0" /> Approved: {dec.approvedDays}d
                                </span>
                                <div className="text-[10px] text-muted mt-0.5">
                                  {dec.appliedAt ? 'Added to the new cycle' : `Added on ${emp.nextRenewalDate}`}
                                </div>
                                {dec.lapsedDays > 0 && (
                                  <div className="text-[10px] text-muted mt-0.5">
                                    {dec.lapsedDays}d will lapse
                                  </div>
                                )}
                                {dec.approvedBy && (
                                  <div className="text-[9px] text-dim">By {dec.approvedBy}</div>
                                )}
                              </div>
                            ) : (
                              <div>
                                <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 px-2 py-0.5 text-[11px] font-bold text-rose-400 border border-rose-500/20">
                                  <XIcon className="h-3.5 w-3.5 shrink-0" /> Rejected (0d)
                                </span>
                                <div className="text-[10px] text-dim mt-0.5">All unused will lapse</div>
                              </div>
                            )
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-[11px] font-bold text-amber-400 border border-amber-500/20 animate-pulse">
                              <HourglassIcon className="h-3.5 w-3.5 shrink-0" /> Awaiting Decision
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              onClick={() => openMonthlyModal(emp.employeeId, emp.name)}
                              className="py-1 px-2 text-[10px]"
                            >
                              <FileTextIcon className="h-3 w-3 shrink-0" /> Statement
                            </Button>
                            <Button
                              onClick={() => openCarryModal(emp)}
                              variant="primary"
                              className="py-1 px-2.5 text-[11px]"
                            >
                              Review Carry-Forward
                            </Button>
                            <Button
                              onClick={() => openCyclesModal(emp.employeeId, emp.name)}
                              className="py-1 px-2.5 text-[11px]"
                            >
                              <HistoryIcon className="h-3 w-3 shrink-0" /> Cycles
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab 4: Request History */}
      {activeTab === 'all' && (
        <div>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted">Status:</span>
              {(['ALL', 'APPROVED', 'REJECTED', 'CANCELLED'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setHistoryFilter(s)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-all ${
                    historyFilter === s
                      ? 'bg-raised text-text border border-line'
                      : 'text-dim hover:text-text'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>

            <div className="w-full sm:w-64">
              <Input
                type="text"
                placeholder="Search history…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full text-xs py-1.5"
              />
            </div>
          </div>

          {filteredHistory.length === 0 ? (
            <Empty>No requests matching the selected filter.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-line bg-raised text-dim">
                    <th className="px-3 py-2.5 font-semibold">Employee</th>
                    <th className="px-3 py-2.5 font-semibold">Leave Type</th>
                    <th className="px-3 py-2.5 font-semibold">Dates</th>
                    <th className="px-3 py-2.5 font-semibold">Days</th>
                    <th className="px-3 py-2.5 font-semibold">Status</th>
                    <th className="px-3 py-2.5 font-semibold">Decision Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filteredHistory.map((r) => {
                    const statusTone =
                      r.status === 'APPROVED'
                        ? 'brand'
                        : r.status === 'REJECTED'
                        ? 'danger'
                        : 'muted';

                    return (
                      <tr key={r.id} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-3 align-middle">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-text">{r.employeeName}</span>
                            {r.employeeNumber && (
                              <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                                {r.employeeNumber}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted">{r.employeeRole ?? ''}</div>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge tone={r.reducesEntitlement ? 'brand' : 'muted'}>{r.type}</Badge>
                            {r.status === 'APPROVED' && (
                              r.isPaid ? (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-950/40 text-emerald-400 border border-emerald-800/40">
                                  Paid
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-950/40 text-amber-400 border border-amber-800/40">
                                  Unpaid
                                </span>
                              )
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-middle font-mono text-[11px]">
                          {r.from} &rarr; {r.to}
                        </td>
                        <td className="px-3 py-3 align-middle font-bold text-brand">{r.days}d</td>
                        <td className="px-3 py-3 align-middle">
                          <Badge tone={statusTone}>{r.status}</Badge>
                        </td>
                        <td className="px-3 py-3 align-middle max-w-[260px]">
                          {r.decidedAt ? (
                            <div className="text-[11px] text-text">
                              <span className="text-dim">Decided {r.decidedAt}</span>
                              {r.notes && <div className="italic text-muted mt-0.5">&quot;{r.notes}&quot;</div>}
                            </div>
                          ) : (
                            <span className="text-dim">Submitted {r.submittedAt}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab: Self-Reported Absences & Sickness (Spec 10 & 2.2) */}
      {activeTab === 'absences' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-raised/50 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-text mr-1">Filter Status:</span>
              {(['ALL', 'PENDING_REVIEW', 'CONFIRMED', 'DISMISSED'] as const).map((st) => (
                <Button
                  key={st}
                  variant={absenceStatusFilter === st ? 'primary' : 'ghost'}
                  onClick={() => setAbsenceStatusFilter(st)}
                  className="py-1 px-2.5 text-xs"
                >
                  {st === 'PENDING_REVIEW'
                    ? `Pending Review (${pendingAbsencesCount})`
                    : st === 'CONFIRMED'
                    ? 'Confirmed'
                    : st === 'DISMISSED'
                    ? 'Dismissed / Excused'
                    : 'All'}
                </Button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <Input
                type="text"
                placeholder="Search sickness/absence..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="py-1 text-xs w-48"
              />
            </div>
          </div>

          {filteredAbsences.length === 0 ? (
            <Empty>No self-reported sickness or absence records found.</Empty>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-line bg-surface">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-line bg-raised text-[11px] text-dim uppercase">
                  <tr>
                    <th className="px-3 py-2.5 font-semibold">Employee</th>
                    <th className="px-3 py-2.5 font-semibold">Date</th>
                    <th className="px-3 py-2.5 font-semibold">Absence Type</th>
                    <th className="px-3 py-2.5 font-semibold">Reported Reason</th>
                    <th className="px-3 py-2.5 font-semibold">Consequence Decision</th>
                    <th className="px-3 py-2.5 font-semibold">Status</th>
                    <th className="px-3 py-2.5 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filteredAbsences.map((abs) => {
                    const isNoShow = abs.absenceType === 'SUSPECTED_NO_SHOW';
                    const isSick = abs.absenceType === 'SICK' || abs.absenceType === 'MEDICAL';

                    return (
                      <tr key={abs.id} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-3 align-middle">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-text">{abs.employeeName}</span>
                            {abs.employeeNumber && (
                              <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                                {abs.employeeNumber}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted">{abs.role || ''}</div>
                        </td>
                        <td className="px-3 py-3 align-middle font-mono font-medium text-slate-200">
                          {abs.date}
                          <div className="text-[10px] text-dim">Detected: {abs.detectedAt}</div>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <Badge tone={isNoShow ? 'danger' : isSick ? 'warn' : 'muted'}>
                            {isNoShow ? <><SirenIcon className="h-3.5 w-3.5 shrink-0" /> NO-SHOW</> : <><ThermometerIcon className="h-3.5 w-3.5 shrink-0" /> {abs.absenceType}</>}
                          </Badge>
                        </td>
                        <td className="px-3 py-3 align-middle max-w-[260px]">
                          <div className="text-xs text-text">{abs.reason || 'Self-reported absence'}</div>
                          {abs.documentTitle && (
                            <div className="mt-1 text-[11px] text-brand font-medium">
                              <PaperclipIcon className="inline-block h-3.5 w-3.5" /> Attached Doc: {abs.documentTitle}
                            </div>
                          )}
                          {abs.reviewNotes && (
                            <div className="mt-1 text-[11px] italic text-muted">
                              Review Note: {abs.reviewNotes}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle text-[11px]">
                          {abs.status === 'CONFIRMED' ? (
                            <div className="space-y-0.5">
                              <div className={abs.deductAnnualLeave ? 'text-amber-400 font-medium' : 'text-dim'}>
                                • Deduct Annual Leave: {abs.deductAnnualLeave ? 'YES' : 'NO'}
                              </div>
                              <div className={abs.treatAsUnpaid ? 'text-danger font-medium' : 'text-dim'}>
                                • Treat as Unpaid: {abs.treatAsUnpaid ? 'YES' : 'NO'}
                              </div>
                              <div className={abs.createWarningTrigger ? 'text-danger font-medium' : 'text-dim'}>
                                • Disciplinary Trigger: {abs.createWarningTrigger ? 'YES' : 'NO'}
                              </div>
                            </div>
                          ) : (
                            <span className="text-dim">Decision Pending</span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <Badge
                            tone={
                              abs.status === 'CONFIRMED'
                                ? 'danger'
                                : abs.status === 'DISMISSED'
                                ? 'ok'
                                : 'warn'
                            }
                          >
                            {abs.status === 'PENDING_REVIEW'
                              ? 'Pending Review'
                              : abs.status === 'CONFIRMED'
                              ? 'Confirmed'
                              : 'Dismissed / Excused'}
                          </Badge>
                        </td>
                        <td className="px-3 py-3 align-middle text-right">
                          {abs.status === 'PENDING_REVIEW' && (
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                variant="primary"
                                onClick={() => {
                                  setSelectedAbsence(abs);
                                  setAbsenceAction('CONFIRMED');
                                  setDeductAnnualLeave(false);
                                  setTreatAsUnpaid(true);
                                  setCreateWarningTrigger(false);
                                  setAbsenceNotes('');
                                }}
                                className="py-1 px-2.5 text-[11px]"
                              >
                                Review & Decide
                              </Button>
                              <Button
                                onClick={() => {
                                  setSelectedAbsence(abs);
                                  setAbsenceAction('DISMISSED');
                                  setAbsenceNotes('Excused with management approval.');
                                }}
                                className="py-1 px-2.5 text-[11px] text-muted hover:text-text"
                              >
                                Dismiss / Excuse
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Review Absence Modal */}
      {selectedAbsence && absenceAction && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6">
            <h2 className="text-base font-bold text-text">
              {absenceAction === 'CONFIRMED'
                ? `Decide Absence Consequences: ${selectedAbsence.employeeName}`
                : `Dismiss / Excuse Absence: ${selectedAbsence.employeeName}`}
            </h2>
            <p className="mt-1 text-xs text-muted">
              Date: {selectedAbsence.date} · Type: {selectedAbsence.absenceType}
            </p>

            {selectedAbsence.reason && (
              <div className="my-3 rounded-lg bg-raised p-3 text-xs text-text">
                <div className="font-semibold text-dim mb-0.5">Reported Reason:</div>
                {selectedAbsence.reason}
              </div>
            )}

            {absenceAction === 'CONFIRMED' && (
              <div className="my-4 space-y-3 rounded-xl border border-line bg-raised/60 p-4 text-xs">
                <div className="font-semibold text-text text-sm">
                  Independent Policy Consequences (Spec 10.2):
                </div>

                <label className="flex items-start gap-3 p-2.5 rounded-lg bg-surface border border-line cursor-pointer hover:border-brand transition">
                  <input
                    type="checkbox"
                    checked={deductAnnualLeave}
                    onChange={(e) => setDeductAnnualLeave(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-line text-brand focus:ring-brand"
                  />
                  <div>
                    <div className="font-semibold text-text">Deduct from Annual Leave Balance</div>
                    <div className="text-[11px] text-muted">
                      Subtract 1 day from accrued annual leave entitlement.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-2.5 rounded-lg bg-surface border border-line cursor-pointer hover:border-brand transition">
                  <input
                    type="checkbox"
                    checked={paidSickness}
                    onChange={(e) => setPaidSickness(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-line text-brand focus:ring-brand"
                  />
                  <div>
                    <div className="font-semibold text-text">Grant Paid Sick Leave</div>
                    <div className="text-[11px] text-muted">
                      Cover as paid statutory sickness absence without wage deduction.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-2.5 rounded-lg bg-surface border border-line cursor-pointer hover:border-brand transition">
                  <input
                    type="checkbox"
                    checked={treatAsUnpaid}
                    onChange={(e) => setTreatAsUnpaid(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-line text-brand focus:ring-brand"
                  />
                  <div>
                    <div className="font-semibold text-text">Flag for Unpaid Payroll Deduction</div>
                    <div className="text-[11px] text-muted">
                      Mark as unpaid absence to be deducted in monthly payroll calculation.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-2.5 rounded-lg bg-surface border border-line cursor-pointer hover:border-brand transition">
                  <input
                    type="checkbox"
                    checked={createWarningTrigger}
                    onChange={(e) => setCreateWarningTrigger(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-line text-brand focus:ring-brand"
                  />
                  <div>
                    <div className="font-semibold text-text">Generate Disciplinary Trigger</div>
                    <div className="text-[11px] text-muted">
                      Forward unexcused absence to Warning Board for formal disciplinary progression.
                    </div>
                  </div>
                </label>
              </div>
            )}

            <div className="my-4">
              <label className="block text-xs font-semibold text-text mb-1">
                Review Notes (Required)
              </label>
              <textarea
                value={absenceNotes}
                onChange={(e) => setAbsenceNotes(e.target.value)}
                placeholder="Explain the HR review rationale..."
                rows={3}
                className="w-full rounded-lg border border-line bg-raised p-2.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  setSelectedAbsence(null);
                  setAbsenceAction(null);
                  setAbsenceNotes('');
                }}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                variant={absenceAction === 'DISMISSED' ? 'ghost' : 'primary'}
                onClick={handleReviewAbsence}
                disabled={submitting}
                className={
                  absenceAction === 'DISMISSED' ? 'bg-brand text-white hover:bg-brand/90' : ''
                }
              >
                {submitting ? 'Submitting…' : 'Submit Decision'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Leave Request Review & Decision Modal */}
      {selectedRequest && (() => {
        const empOverview = balances.find((b) => b.employeeId === selectedRequest.employeeId);
        const bal = selectedRequest.balance || empOverview?.balance;
        const reqDays = selectedRequest.days || 0;
        const currentAvailable = bal?.availableDays ?? bal?.available ?? 0;
        const currentAccrued = bal?.accruedDays ?? bal?.accrued ?? 0;
        const currentTaken = bal?.takenDays ?? bal?.taken ?? 0;
        const entitlementNumber = bal?.annualEntitlementDays ?? bal?.annualEntitlement ?? (bal?.blocked ? 0 : 20);
        const currentEntitlement = bal?.annualEntitlementDays ?? bal?.annualEntitlement ?? (bal?.blocked ? '—' : 20);
        const calculatedShortfall = Math.max(0, Math.round((reqDays - currentAvailable) * 100) / 100);
        const hasShortfall = decisionIsPaid && (calculatedShortfall > 0);
        const projectedAvailable = Math.round((currentAvailable - (decisionIsPaid ? reqDays : 0)) * 100) / 100;
        const unaccruedRemainder = Math.max(0, Math.round((entitlementNumber - currentAccrued) * 100) / 100);
        const initials = selectedRequest.employeeName
          .split(' ')
          .map((n) => n[0])
          .slice(0, 2)
          .join('')
          .toUpperCase() || 'EMP';

        return (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 sm:p-6 backdrop-blur-md overflow-y-auto">
            <div className="relative w-full max-w-3xl rounded-3xl border border-white/10 bg-surface shadow-[0_25px_60px_-15px_rgba(0,0,0,0.9)] p-6 sm:p-8 my-auto max-h-[92vh] overflow-y-auto space-y-5 text-text">
              {/* Top ambient glow */}
              <div className="absolute -top-24 -right-24 w-72 h-72 bg-brand/10 rounded-full blur-3xl pointer-events-none" />

              {/* Modal Header */}
              <div className="flex items-start justify-between gap-3 pb-4 border-b border-line">
                <div className="flex items-center gap-3.5">
                  <div className="w-11 h-11 rounded-2xl bg-brand/15 border border-brand/30 flex items-center justify-center text-brand shadow-sm">
                    <FileTextIcon className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <h2 className="text-base sm:text-lg font-bold text-text">
                        Employee Leave Request & Standing
                      </h2>
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                        Pending HR Decision
                      </span>
                    </div>
                    <p className="text-xs text-muted mt-0.5 font-mono">
                      Request #{selectedRequest.id.slice(0, 8)} • Submitted on {selectedRequest.submittedAt}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedRequest(null)}
                  disabled={submitting}
                  className="p-2 rounded-xl text-muted hover:text-text hover:bg-raised transition-colors"
                  aria-label="Close review modal"
                  title="Close modal"
                >
                  <XIcon className="w-5 h-5" />
                </button>
              </div>

              {/* Employee Dossier Banner */}
              <div className="rounded-2xl border border-line bg-raised/50 p-4 sm:p-5 shadow-sm">
                <div className="flex items-center gap-3.5">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-brand to-indigo-600 flex items-center justify-center font-extrabold text-base text-white shadow-md shrink-0">
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-bold text-text">{selectedRequest.employeeName}</span>
                      {selectedRequest.employeeNumber && (
                        <span className="rounded-md bg-indigo-500/20 px-2 py-0.5 text-[11px] font-mono font-bold text-indigo-300 border border-indigo-500/30">
                          {selectedRequest.employeeNumber}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted truncate mt-0.5">
                      {selectedRequest.employeeRole || empOverview?.role || 'Staff Member'}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-line/60 text-xs">
                  <div className="p-2 rounded-lg bg-surface/50 border border-line/40">
                    <span className="text-[10px] text-muted block uppercase tracking-wider font-semibold">Joining Date</span>
                    <span className="font-semibold text-text mt-0.5 block">{bal?.officialJoiningDate || 'On file'}</span>
                  </div>
                  <div className="p-2 rounded-lg bg-surface/50 border border-line/40">
                    <span className="text-[10px] text-muted block uppercase tracking-wider font-semibold">Leave Cycle</span>
                    <span className="font-semibold text-text font-mono text-[11px] mt-0.5 block truncate">
                      {bal?.cycleStartDate || bal?.holidayYear?.from || '—'} &rarr; {bal?.cycleEndDate || bal?.holidayYear?.to || '—'}
                    </span>
                  </div>
                  <div className="p-2 rounded-lg bg-surface/50 border border-line/40">
                    <span className="text-[10px] text-muted block uppercase tracking-wider font-semibold">Cycle Renews</span>
                    <span className="font-semibold text-text mt-0.5 block">{bal?.nextRenewalDate || bal?.renewalDate || '—'}</span>
                  </div>
                  <div className="p-2 rounded-lg bg-surface/50 border border-line/40">
                    <span className="text-[10px] text-muted block uppercase tracking-wider font-semibold">Service Completed</span>
                    <span className="font-semibold text-text mt-0.5 block">{bal?.holidayYear?.monthsCompleted ?? 0} month(s) (1.67d/mo)</span>
                  </div>
                </div>
              </div>

              {/* Stated Reason for Leave (Prominent Hero Card) */}
              <div className="rounded-2xl border border-indigo-500/30 bg-gradient-to-br from-indigo-950/40 via-purple-950/20 to-surface p-4 sm:p-5 shadow-lg relative overflow-hidden">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded-lg bg-indigo-500/20 text-indigo-300">
                      <FileTextIcon className="w-4 h-4" />
                    </span>
                    <span className="text-xs font-bold uppercase tracking-wider text-indigo-300">
                      Reason For Leave Request
                    </span>
                  </div>
                  <span className="text-[11px] font-semibold text-indigo-300 bg-indigo-950/60 px-2.5 py-0.5 rounded-full border border-indigo-500/30">
                    Employee Submission
                  </span>
                </div>

                <div className="rounded-xl bg-black/40 border border-indigo-500/20 p-4 mt-2">
                  {selectedRequest.reason ? (
                    <div className="flex items-start gap-2">
                      <span className="text-2xl font-serif text-indigo-400 select-none leading-none">&ldquo;</span>
                      <p className="text-sm sm:text-base font-semibold text-white tracking-wide leading-relaxed">
                        {selectedRequest.reason}
                      </p>
                      <span className="text-2xl font-serif text-indigo-400 select-none leading-none">&rdquo;</span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted italic">
                      No specific reason was provided by the employee for this leave request.
                    </p>
                  )}

                  {selectedRequest.notes && (
                    <div className="mt-3 pt-2.5 border-t border-indigo-500/20 text-xs text-indigo-200/90 flex items-start gap-1.5">
                      <span className="font-bold text-indigo-300 shrink-0">Additional Notes:</span>
                      <span className="text-text">{selectedRequest.notes}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Request Details Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-xl border border-line bg-raised/40 p-3.5">
                  <span className="text-[10px] text-muted block uppercase tracking-wider font-semibold mb-1">Leave Category</span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-bold text-text">{selectedRequest.type}</span>
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                      selectedRequest.defaultIsPaid
                        ? 'bg-emerald-950/40 text-emerald-400 border-emerald-800/40'
                        : 'bg-amber-950/40 text-amber-400 border-amber-800/40'
                    }`}>
                      {selectedRequest.defaultIsPaid ? 'Paid Allowance' : 'Unpaid'}
                    </span>
                  </div>
                  {selectedRequest.requiresEvidence && (
                    <div className="text-[10px] text-warn mt-1 font-medium">Evidence Required</div>
                  )}
                </div>

                <div className="rounded-xl border border-line bg-raised/40 p-3.5">
                  <span className="text-[10px] text-muted block uppercase tracking-wider font-semibold mb-1">Requested Dates</span>
                  <div className="text-xs font-bold font-mono text-text">
                    {selectedRequest.from} &rarr; {selectedRequest.to}
                  </div>
                  <div className="text-[11px] text-muted mt-0.5">
                    Continuous absence
                  </div>
                </div>

                <div className="rounded-xl border border-line bg-raised/40 p-3.5">
                  <span className="text-[10px] text-muted block uppercase tracking-wider font-semibold mb-1">Duration</span>
                  <div className="text-base font-extrabold text-brand">
                    {selectedRequest.days} Working Day(s)
                  </div>
                  <div className="text-[11px] text-muted">
                    Excludes standard off days
                  </div>
                </div>
              </div>

              {/* Person's Remaining Leaves & Accrual Balance Impact */}
              <div className="rounded-2xl border border-line bg-raised/30 p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="p-1 rounded-lg bg-emerald-500/20 text-emerald-400">
                      <ShieldCheckIcon className="w-4 h-4" />
                    </span>
                    <span className="text-xs font-bold text-text uppercase tracking-wider">
                      Employee Allowance & Remaining Leaves Breakdown
                    </span>
                  </div>
                  <span className="text-[11px] text-muted font-mono">
                    Yearly Entitlement: {currentEntitlement}d
                  </span>
                </div>

                {/* 4 Stat Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center">
                  <div className="p-2.5 rounded-xl bg-surface border border-line">
                    <span className="text-[10px] text-muted uppercase block font-semibold">Annual Entitlement</span>
                    <span className="text-sm font-bold text-text mt-0.5 block">{currentEntitlement}d</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-surface border border-line">
                    <span className="text-[10px] text-muted uppercase block font-semibold">Accrued To Date</span>
                    <span className="text-sm font-bold text-emerald-400 mt-0.5 block">{currentAccrued}d</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-surface border border-line">
                    <span className="text-[10px] text-muted uppercase block font-semibold">Already Taken</span>
                    <span className="text-sm font-bold text-muted mt-0.5 block">{currentTaken}d</span>
                  </div>
                  <div className="p-2.5 rounded-xl bg-emerald-950/30 border border-emerald-500/40 shadow-sm">
                    <span className="text-[10px] text-emerald-400 uppercase block font-bold">Remaining Leaves</span>
                    <span className={`text-sm font-extrabold mt-0.5 block ${currentAvailable < 0 ? 'text-danger' : 'text-emerald-300'}`}>
                      {currentAvailable}d
                    </span>
                  </div>
                </div>

                {/* Calculation Equation Card */}
                <div className="rounded-xl border border-line bg-surface/70 p-3.5 space-y-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-muted">
                    <span className="uppercase tracking-wider text-[11px]">Leave Balance Impact Equation</span>
                    <span className="font-mono text-[11px] text-text font-medium">
                      {decisionIsPaid ? 'Paid Deduction Applied' : 'Unpaid (No Balance Deduction)'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 items-center text-center">
                    <div className="p-2.5 rounded-xl bg-raised border border-line">
                      <span className="text-[10px] text-muted uppercase block font-semibold">Current Remaining Leaves</span>
                      <span className="text-base font-extrabold text-emerald-400">{currentAvailable}d</span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-raised border border-line">
                      <span className="text-[10px] text-muted uppercase block font-semibold">
                        {decisionIsPaid ? 'Requested Leave' : 'Requested (Unpaid)'}
                      </span>
                      <span className="text-base font-extrabold text-brand">
                        {decisionIsPaid ? `− ${reqDays}d` : '0d (Unpaid)'}
                      </span>
                    </div>
                    <div className="p-2.5 rounded-xl bg-brand/10 border border-brand/30 shadow-sm">
                      <span className="text-[10px] text-brand uppercase block font-bold">Remaining Leaves After Approval</span>
                      <span className="text-lg font-black text-brand">
                        {projectedAvailable}d
                      </span>
                    </div>
                  </div>

                  {/* Segmented Progress Bar */}
                  <div className="space-y-1.5 pt-1">
                    <div className="flex justify-between text-[10px] text-muted font-medium">
                      <span>Taken ({currentTaken}d)</span>
                      <span>This Request ({decisionIsPaid ? reqDays : 0}d)</span>
                      <span className="text-emerald-400 font-semibold">Remaining ({projectedAvailable}d)</span>
                      <span>Unaccrued ({unaccruedRemainder}d)</span>
                    </div>
                    <div className="h-2.5 w-full rounded-full bg-raised overflow-hidden flex border border-line/60">
                      <div
                        style={{ width: `${Math.min(100, (currentTaken / Math.max(1, entitlementNumber)) * 100)}%` }}
                        className="bg-slate-500 transition-all"
                        title={`Taken: ${currentTaken}d`}
                      />
                      {decisionIsPaid && (
                        <div
                          style={{ width: `${Math.min(100, (reqDays / Math.max(1, entitlementNumber)) * 100)}%` }}
                          className="bg-indigo-500 transition-all"
                          title={`This Request: ${reqDays}d`}
                        />
                      )}
                      <div
                        style={{ width: `${Math.min(100, (Math.max(0, projectedAvailable) / Math.max(1, entitlementNumber)) * 100)}%` }}
                        className="bg-emerald-500 transition-all"
                        title={`Remaining Leaves: ${projectedAvailable}d`}
                      />
                    </div>
                  </div>

                  {/* Status Banner */}
                  {hasShortfall ? (
                    <div className="rounded-xl bg-amber-950/40 border border-amber-500/40 p-3 text-xs text-amber-200 flex items-start gap-2.5">
                      <AlertTriangleIcon className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
                      <div>
                        <div className="font-bold text-amber-300">
                          Shortfall Warning: Exceeds Accrued Balance by {calculatedShortfall} day(s)
                        </div>
                        <div className="mt-0.5 text-[11px] text-amber-200/90 leading-relaxed">
                          Employee has {currentAvailable}d remaining leaves, but requested {reqDays}d. Approving as Paid Leave requires an overdraft justification below.
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl bg-emerald-950/30 border border-emerald-500/30 p-3 text-xs text-emerald-300 flex items-center gap-2.5">
                      <CheckIcon className="h-4 w-4 shrink-0 text-emerald-400" />
                      <div>
                        <span className="font-bold">Within Accrued Balance: </span>
                        <span>
                          Request of {reqDays}d is fully covered by accrued leave. After approval, the employee will retain <strong>{projectedAvailable}d</strong> in remaining leaves.
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Leave Payment Type Decision */}
              <div className="rounded-2xl border border-line bg-raised/40 p-4 sm:p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-text uppercase tracking-wider">
                    Payment Type Decision
                  </label>
                  <span className="text-[10px] text-muted font-mono">
                    System Default: {selectedRequest.defaultIsPaid ? 'Paid' : 'Unpaid'}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setDecisionIsPaid(true)}
                    className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                      decisionIsPaid
                        ? 'border-emerald-500/60 bg-emerald-950/40 text-emerald-300 ring-1 ring-emerald-500/40'
                        : 'border-line bg-surface text-muted hover:border-line-hover'
                    }`}
                  >
                    <div className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                      decisionIsPaid ? 'border-emerald-400 bg-emerald-400' : 'border-dim'
                    }`}>
                      {decisionIsPaid && <div className="w-1.5 h-1.5 rounded-full bg-slate-950" />}
                    </div>
                    <div>
                      <div className="text-xs font-bold text-text">Paid Leave</div>
                      <div className="text-[11px] text-muted">Deducts {reqDays}d from remaining leaves; regular salary maintained</div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDecisionIsPaid(false)}
                    className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                      !decisionIsPaid
                        ? 'border-amber-500/60 bg-amber-950/40 text-amber-300 ring-1 ring-amber-500/40'
                        : 'border-line bg-surface text-muted hover:border-line-hover'
                    }`}
                  >
                    <div className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                      !decisionIsPaid ? 'border-amber-400 bg-amber-400' : 'border-dim'
                    }`}>
                      {!decisionIsPaid && <div className="w-1.5 h-1.5 rounded-full bg-slate-950" />}
                    </div>
                    <div>
                      <div className="text-xs font-bold text-text">Unpaid Leave</div>
                      <div className="text-[11px] text-muted">Preserves remaining leaves ({currentAvailable}d); payroll salary deduction applied</div>
                    </div>
                  </button>
                </div>

                {/* Overdraft justification if paid and has shortfall */}
                {decisionIsPaid && hasShortfall && (
                  <div className="mt-3 pt-3 border-t border-line/60">
                    <label className="block text-xs font-bold text-warn mb-1">
                      Overdraft Approval Justification (Required)
                    </label>
                    <textarea
                      value={overdraftReason}
                      onChange={(e) => setOverdraftReason(e.target.value)}
                      placeholder="e.g. Authorized by HR to borrow against upcoming month's accrual..."
                      rows={2}
                      className="w-full rounded-xl border border-warn/40 bg-surface p-2.5 text-xs text-text placeholder-dim focus:border-warn focus:outline-none"
                    />
                  </div>
                )}
              </div>

              {/* Decision Notes */}
              <div>
                <label className="block text-xs font-bold text-text mb-1 uppercase tracking-wider">
                  HR Decision Notes / Audit Trail <span className="text-muted font-normal normal-case">(Required if rejecting, optional if approving)</span>
                </label>
                <textarea
                  value={decisionNotes}
                  onChange={(e) => setDecisionNotes(e.target.value)}
                  placeholder="Explain rationale for employee and audit record..."
                  rows={2}
                  className="w-full rounded-xl border border-line bg-surface p-3 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
                />
              </div>

              {/* Actions Footer */}
              <div className="flex items-center justify-between gap-3 pt-4 border-t border-line">
                <Button
                  onClick={() => setSelectedRequest(null)}
                  disabled={submitting}
                  className="text-xs px-4 py-2"
                >
                  Cancel / Close
                </Button>

                <div className="flex items-center gap-2.5">
                  <Button
                    onClick={() => handleDecision('REJECTED')}
                    disabled={submitting}
                    className="py-2 px-4 text-xs bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-xl inline-flex items-center gap-1.5 shadow-sm"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                    <span>Reject Request</span>
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => handleDecision('APPROVED')}
                    disabled={submitting}
                    className="py-2 px-5 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl inline-flex items-center gap-1.5 shadow-md"
                  >
                    <CheckIcon className="h-4 w-4" />
                    <span>
                      {submitting
                        ? 'Processing…'
                        : decisionIsPaid
                          ? `Approve (${reqDays}d Paid)`
                          : `Approve (${reqDays}d Unpaid)`}
                    </span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Manual Leave Adjustment Modal (Spec 13.5) */}
      {showAdjustModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6">
            <h2 className="text-base font-bold text-text">Manual Leave Adjustment (Spec 13.5)</h2>
            <p className="mt-1 text-xs text-muted">
              Add or deduct leave days with an attributed audit trail.
            </p>

            <div className="my-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-text mb-1">Select Employee</label>
                <select
                  value={adjustEmployeeId}
                  onChange={(e) => setAdjustEmployeeId(e.target.value)}
                  className="w-full rounded-lg border border-line bg-raised p-2 text-xs text-text focus:border-brand focus:outline-none"
                >
                  <option value="">-- Choose Employee --</option>
                  {balances.map((b) => (
                    <option key={b.employeeId} value={b.employeeId}>
                      {b.employeeNumber ? `[${b.employeeNumber}] ` : ''}{b.employeeName} ({b.role}) - Available: {b.balance.available}d
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-text mb-1">
                    Days Delta (+/-)
                  </label>
                  <Input
                    type="number"
                    step="0.5"
                    value={adjustDays}
                    onChange={(e) => setAdjustDays(parseFloat(e.target.value) || 0)}
                    className="w-full text-xs py-1.5"
                  />
                  <span className="text-[10px] text-dim">Use positive for grant, negative for deduction</span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text mb-1">
                    Effective Date (Optional)
                  </label>
                  <Input
                    type="date"
                    value={adjustDate}
                    onChange={(e) => setAdjustDate(e.target.value)}
                    className="w-full text-xs py-1.5"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-text mb-1">
                  Reason for Adjustment (Required)
                </label>
                <textarea
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="e.g. Contractual entitlement amendment, Goodwill award, Disputed unrecorded leave..."
                  rows={3}
                  className="w-full rounded-lg border border-line bg-raised p-2.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button onClick={() => setShowAdjustModal(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleAdjustBalance} disabled={submitting}>
                {submitting ? 'Applying…' : 'Apply Adjustment'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Record Leave Modal (HR Direct Entry) */}
      {showRecordLeaveModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h2 className="text-base font-bold text-text">
                  Record Employee Leave (HR Entry)
                </h2>
                <p className="mt-0.5 text-xs text-muted">
                  Directly record and approve leave. Stamped as <strong>HR Added</strong> and immediately reflected on the calendar.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowRecordLeaveModal(false)}
                className="text-muted hover:text-text text-sm font-bold cursor-pointer"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            {recordError && (
              <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                <strong>Error:</strong> {recordError}
              </div>
            )}

            {(() => {
              const selectedEmp = balances.find((b) => b.employeeId === recordEmployeeId);
              let reqDays = 1;
              if (recordStartDate) {
                const s = new Date(recordStartDate);
                const e = new Date(recordEndDate || recordStartDate);
                if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e >= s) {
                  let cnt = 0;
                  const c = new Date(s);
                  while (c <= e) {
                    const d = c.getDay();
                    if (d !== 0 && d !== 6) cnt++;
                    c.setDate(c.getDate() + 1);
                  }
                  reqDays = Math.max(1, cnt);
                }
              }
              const avail = selectedEmp?.balance?.available ?? 0;
              const hasShortfall = recordIsPaid && selectedEmp && (reqDays > avail);
              const shortfall = hasShortfall ? Math.max(0, Math.round((reqDays - avail) * 100) / 100) : 0;

              return (
                <div className="my-4 space-y-3.5 text-xs">
                  <div>
                    <label className="block text-xs font-semibold text-text mb-1">
                      Select Employee <span className="text-rose-400">*</span>
                    </label>
                    <select
                      value={recordEmployeeId}
                      onChange={(e) => setRecordEmployeeId(e.target.value)}
                      className="w-full rounded-lg border border-line bg-raised p-2 text-xs text-text focus:border-brand focus:outline-none"
                    >
                      <option value="">-- Choose Employee --</option>
                      {balances.map((b) => {
                        const bAvail = b.balance.available;
                        const availStr = bAvail > 0 ? `+${bAvail}d` : `${bAvail}d`;
                        return (
                          <option key={b.employeeId} value={b.employeeId}>
                            {b.employeeNumber ? `[${b.employeeNumber}] ` : ''}{b.employeeName} ({b.role}) — Available: {availStr}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  {/* Live Balance Summary Card */}
                  {selectedEmp && (
                    <div className="rounded-xl border border-line bg-raised/50 p-2.5 grid grid-cols-4 gap-2 text-center">
                      <div>
                        <div className="text-[10px] text-muted font-medium">Entitlement</div>
                        <div className="text-xs font-bold text-text font-mono">
                          {selectedEmp.balance.annualEntitlement}d
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted font-medium">Accrued to Date</div>
                        <div className="text-xs font-bold text-text font-mono">
                          {selectedEmp.balance.accrued}d
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted font-medium">Taken / Used</div>
                        <div className="text-xs font-bold text-text font-mono">
                          {selectedEmp.balance.taken}d
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted font-medium">Available Balance</div>
                        <div
                          className={`text-xs font-extrabold font-mono ${
                            selectedEmp.balance.available < 0 ? 'text-rose-400' : 'text-emerald-400'
                          }`}
                        >
                          {selectedEmp.balance.available > 0
                            ? `+${selectedEmp.balance.available}d`
                            : `${selectedEmp.balance.available}d`}
                        </div>
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-semibold text-text mb-1">
                      Leave Type <span className="text-rose-400">*</span>
                    </label>
                    <select
                      value={recordLeaveTypeId}
                      onChange={(e) => setRecordLeaveTypeId(e.target.value)}
                      className="w-full rounded-lg border border-line bg-raised p-2 text-xs text-text focus:border-brand focus:outline-none"
                    >
                      <option value="annual">Paid annual leave (Annual Entitlement)</option>
                      <option value="sick">Sick leave</option>
                      <option value="authorised">Authorised absence</option>
                      <option value="unpaid">Unpaid leave</option>
                      <option value="compassionate">Compassionate leave</option>
                      <option value="emergency">Emergency leave</option>
                      <option value="wfh">Work from home</option>
                      <option value="other">Other</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-text mb-1">
                        Start Date <span className="text-rose-400">*</span>
                      </label>
                      <Input
                        type="date"
                        value={recordStartDate}
                        onChange={(e) => {
                          setRecordStartDate(e.target.value);
                          if (!recordEndDate || recordEndDate < e.target.value) {
                            setRecordEndDate(e.target.value);
                          }
                        }}
                        className="w-full text-xs py-1.5"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-text mb-1">
                        End Date <span className="text-rose-400">*</span>
                      </label>
                      <Input
                        type="date"
                        value={recordEndDate}
                        onChange={(e) => setRecordEndDate(e.target.value)}
                        className="w-full text-xs py-1.5"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 rounded-xl border border-line bg-raised p-3">
                    <input
                      type="checkbox"
                      id="recordIsPaidCheckbox"
                      checked={recordIsPaid}
                      onChange={(e) => setRecordIsPaid(e.target.checked)}
                      className="h-4 w-4 rounded border-line text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    />
                    <label htmlFor="recordIsPaidCheckbox" className="text-xs font-semibold text-text cursor-pointer">
                      Paid Leave (Counts as paid salary for this duration)
                    </label>
                  </div>

                  {/* Overdraft Alert & Justification (Spec 15.2) */}
                  {hasShortfall && (
                    <div className="rounded-xl border border-amber-500/40 bg-amber-950/25 p-3 space-y-2">
                      <div className="flex items-center gap-2 text-amber-300 font-bold text-xs">
                        <AlertTriangleIcon className="h-4 w-4 shrink-0 text-amber-400" />
                        <span>
                          Overdraft Authorization: Exceeds accrued balance by {shortfall} day(s)
                        </span>
                      </div>
                      <p className="text-[11px] text-muted leading-relaxed">
                        Company policy allows HR to approve paid leave in advance of monthly accrual. An explicit reason for allowing the overdraft will be permanently logged in the audit trail.
                      </p>
                      <div>
                        <label className="block text-[11px] font-semibold text-text mb-1">
                          Overdraft Justification for Audit Trail (Optional — defaults to audit note below):
                        </label>
                        <input
                          type="text"
                          value={recordOverdraftReason}
                          onChange={(e) => setRecordOverdraftReason(e.target.value)}
                          placeholder="e.g. Approved in advance of upcoming monthly accrual..."
                          className="w-full rounded-lg border border-amber-500/40 bg-raised px-2.5 py-1.5 text-xs text-text placeholder-dim focus:border-amber-400 focus:outline-none"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-semibold text-text mb-1">
                      Reason / Notes for Audit Trail
                    </label>
                    <textarea
                      value={recordReason}
                      onChange={(e) => setRecordReason(e.target.value)}
                      placeholder="e.g. Leave recorded directly by HR / Approved personal day / Travel leave..."
                      rows={3}
                      className="w-full rounded-lg border border-line bg-raised p-2.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
                    />
                  </div>
                </div>
              );
            })()}

            <div className="flex justify-end gap-2 border-t border-line pt-3">
              <Button
                onClick={() => setShowRecordLeaveModal(false)}
                disabled={recordSubmitting}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleRecordLeave}
                disabled={recordSubmitting}
                className="bg-indigo-600 hover:bg-indigo-500 text-white"
              >
                {recordSubmitting ? 'Recording…' : 'Record & Approve Leave'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Carry-Forward Management Approval Modal */}
      {carryModalEmployee && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h2 className="text-base font-bold text-text">
                  Review Leave Carry-Forward
                </h2>
                <p className="text-xs text-muted">
                  Employee: <strong>{carryModalEmployee.name}</strong> · Official Joining Date: {formatFullDate(carryModalEmployee.officialJoiningDate)}
                </p>
              </div>
              <button
                onClick={() => setCarryModalEmployee(null)}
                className="text-muted hover:text-text text-sm font-bold"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="my-4 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-line bg-raised p-3">
                <div>
                  <span className="text-muted block text-[10px] uppercase font-semibold">Current Cycle</span>
                  <span className="font-mono text-text">
                    {carryModalEmployee.cycleStartDate} &rarr; {carryModalEmployee.cycleEndDate}
                  </span>
                </div>
                <div>
                  <span className="text-muted block text-[10px] uppercase font-semibold">Work Anniversary Renewal</span>
                  <span className="font-semibold text-brand">
                    {carryModalEmployee.nextRenewalDate} ({carryModalEmployee.daysUntilAnniversary === 0 ? 'Today' : `in ${carryModalEmployee.daysUntilAnniversary}d`})
                  </span>
                </div>
                <div>
                  <span className="text-muted block text-[10px] uppercase font-semibold">Available Unused Leave</span>
                  <span className="text-base font-extrabold text-text">
                    {carryModalEmployee.availableDays} days
                  </span>
                  {carryModalEmployee.maxEligibleCarryForward != null && carryModalEmployee.maxEligibleCarryForward !== carryModalEmployee.availableDays && (
                    <span className="block text-[10px] text-muted">
                      {carryModalEmployee.maxEligibleCarryForward} days once the cycle&apos;s last accrual is added
                    </span>
                  )}
                </div>
                <div>
                  <span className="text-muted block text-[10px] uppercase font-semibold">Company Policy Cap</span>
                  <span className="text-base font-extrabold text-teal-400">
                    Max 5.0 days
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-text mb-1.5">
                  Approved Days to Carry Forward (usually up to 5; more with management approval)
                </label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min="0"
                    max={Math.max(0, carryMax)}
                    step="0.5"
                    value={carryApprovedDays}
                    onChange={(e) => setCarryApprovedDays(Math.min(Math.max(0, carryMax), Math.max(0, parseFloat(e.target.value) || 0)))}
                    className="w-32 text-sm font-bold py-1.5 text-center"
                  />
                  <div className="flex gap-1.5 flex-wrap">
                    {[0, 1, 2, 3, 4, 5]
                      .filter((d) => d <= carryMax)
                      .map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setCarryApprovedDays(d)}
                          className={`rounded px-2.5 py-1 font-mono font-bold text-xs transition-colors ${
                            carryApprovedDays === d
                              ? 'bg-brand text-white'
                              : 'bg-raised text-muted hover:text-text border border-line'
                          }`}
                        >
                          {d}d
                        </button>
                      ))}
                  </div>
                </div>

                <div className="mt-2 text-[11px] text-muted flex items-center gap-4">
                  <span>
                    Will Carry Forward: <strong className="text-emerald-400">{carryApprovedDays} days</strong>
                  </span>
                  <span>
                    Will Automatically Lapse: <strong className="text-rose-400">{Math.max(0, Math.round((carryMax - carryApprovedDays) * 100) / 100)} days</strong>
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  Approved days are added to the new cycle on its renewal date ({carryModalEmployee.nextRenewalDate}); the balance changes then, not now.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-text mb-1">
                  Management Decision Notes & Justification (Optional)
                </label>
                <textarea
                  value={carryNotes}
                  onChange={(e) => setCarryNotes(e.target.value)}
                  placeholder="e.g. Approved 5 days due to operational project delivery in Q4..."
                  rows={3}
                  className="w-full rounded-lg border border-line bg-raised p-2.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
                />
              </div>

              <div className="rounded-lg bg-white/[0.03] border border-line p-2.5 text-[11px] text-dim">
                <InfoIcon className="inline-block h-3.5 w-3.5" /> <strong>Audit Trail:</strong> Approver identity and timestamp will be permanently saved to the ledger and cycle record.
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-line pt-3">
              <Button onClick={() => setCarryModalEmployee(null)} disabled={carrySaving}>
                Cancel
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCarryApprovedDays(0);
                  setTimeout(() => handleSaveCarryForward(), 50);
                }}
                disabled={carrySaving}
                className="text-rose-400 hover:bg-rose-500/10"
              >
                Reject (All Lapse)
              </Button>
              <Button
                variant="primary"
                onClick={handleSaveCarryForward}
                disabled={carrySaving}
              >
                {carrySaving ? 'Saving…' : `Confirm ${carryApprovedDays}d Carry-Forward`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Historical Leave Cycles Audit Modal */}
      {showCyclesModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-6">
          <div className="w-full max-w-2xl rounded-2xl border border-line bg-surface p-6 shadow-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h2 className="text-base font-bold text-text">
                  <HistoryIcon className="inline-block h-4 w-4" /> Historical Leave Cycles & Audit Record
                </h2>
                <p className="text-xs text-muted">
                  Employee: <strong>{cyclesEmployeeName}</strong>
                </p>
              </div>
              <button
                onClick={() => setShowCyclesModal(false)}
                className="text-muted hover:text-text text-sm font-bold"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="my-4 overflow-y-auto pr-1 flex-1 space-y-4">
              {cyclesLoading ? (
                <div className="py-12 text-center text-xs text-muted">
                  Loading historical cycle records…
                </div>
              ) : historicalCycles.length === 0 ? (
                <Empty>No completed or recorded leave cycles found for this employee.</Empty>
              ) : (
                historicalCycles.map((c) => (
                  <div
                    key={c.cycleIndex}
                    className={`rounded-xl border p-4 transition-all ${
                      c.status === 'ACTIVE'
                        ? 'border-brand/40 bg-brand-dim/10'
                        : 'border-line bg-raised'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-text">
                          Cycle #{c.cycleIndex}: {c.cycleStartDate} &rarr; {c.cycleEndDate}
                        </span>
                        <span
                          className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                            c.status === 'ACTIVE'
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                          }`}
                        >
                          {c.status}
                        </span>
                      </div>
                      <span className="text-[11px] text-muted">
                        Renewal: <strong>{c.renewalDate}</strong>
                      </span>
                    </div>

                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 my-2 text-center">
                      <div className="rounded-lg bg-surface/60 p-2 border border-line">
                        <div className="text-[10px] text-muted">Entitlement</div>
                        <div className="text-xs font-bold text-text">{c.entitlementDays}d</div>
                      </div>
                      <div className="rounded-lg bg-surface/60 p-2 border border-line">
                        <div className="text-[10px] text-muted">Accrued</div>
                        <div className="text-xs font-bold text-brand">{c.accruedDays}d</div>
                      </div>
                      <div className="rounded-lg bg-surface/60 p-2 border border-line">
                        <div className="text-[10px] text-muted">Taken</div>
                        <div className="text-xs font-bold text-dim">{c.takenDays}d</div>
                      </div>
                      <div className="rounded-lg bg-surface/60 p-2 border border-line">
                        <div className="text-[10px] text-muted">Carried In</div>
                        <div className="text-xs font-bold text-teal-400">+{c.carriedForwardIn}d</div>
                      </div>
                      <div className="rounded-lg bg-surface/60 p-2 border border-line">
                        <div className="text-[10px] text-muted">Lapsed</div>
                        <div className="text-xs font-bold text-rose-400">-{c.lapsedDays}d</div>
                      </div>
                      <div className="rounded-lg bg-surface/60 p-2 border border-line">
                        <div className="text-[10px] text-muted">
                          {c.status === 'ACTIVE' ? 'Net Available' : 'Closing Net'}
                        </div>
                        <div className="text-xs font-extrabold text-brand">{c.netClosingBalance}d</div>
                      </div>
                    </div>

                    {c.carryForwardRecord ? (
                      <div className="mt-2 rounded-lg bg-white/[0.03] border border-line p-2 text-[11px] text-dim">
                        <span className="font-semibold text-text">Carry-Forward Decision:</span>{' '}
                        <strong className="text-teal-400">{c.carryForwardRecord.decision}</strong> · Approved: {c.carryForwardRecord.approvedDays}d · Lapsed: {c.carryForwardRecord.lapsedDays}d
                        {c.carryForwardRecord.approvedBy && (
                          <span> · By: <strong className="text-text">{c.carryForwardRecord.approvedBy}</strong></span>
                        )}
                        {c.carryForwardRecord.notes && (
                          <div className="text-[10px] text-muted italic mt-0.5">Notes: "{c.carryForwardRecord.notes}"</div>
                        )}
                      </div>
                    ) : (
                      <div className="mt-1 text-[10px] text-dim">
                        No carry-forward record filed for this cycle.
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="flex justify-end border-t border-line pt-3">
              <Button onClick={() => setShowCyclesModal(false)}>
                Close Audit Record
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Monthly Leave Entitlement Statement Modal */}
      {showMonthlyModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-6">
          <div className="w-full max-w-2xl rounded-2xl border border-line bg-surface p-6 shadow-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h2 className="text-base font-bold text-text flex items-center gap-2">
                  <FileTextIcon className="h-4 w-4 shrink-0" /> Monthly Leave Entitlement Statement
                </h2>
                <p className="text-xs text-muted">
                  Employee: <strong>{monthlyEmployeeName}</strong>
                  {monthlyReport?.role ? ` · ${monthlyReport.role}` : ''}
                  {monthlyReport?.employeeNumber ? ` · ID: ${monthlyReport.employeeNumber}` : ''}
                </p>
              </div>
              <button
                onClick={() => setShowMonthlyModal(false)}
                className="text-muted hover:text-text text-sm font-bold p-1 rounded"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="my-4 overflow-y-auto pr-1 flex-1 space-y-4">
              {monthlyLoading ? (
                <div className="py-12 text-center text-xs text-muted">
                  Loading monthly entitlement statement…
                </div>
              ) : !monthlyReport ? (
                <Empty>No monthly report available for this employee.</Empty>
              ) : (
                <>
                  {/* Month Selection Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-raised/60 p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-text">Statement Period:</span>
                      <select
                        value={monthlyReport.monthKey}
                        onChange={(e) => handleSelectMonth(e.target.value)}
                        className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-text focus:outline-none focus:ring-1 focus:ring-brand"
                      >
                        {monthlyReport.monthOptions.map((opt) => (
                          <option key={opt.monthKey} value={opt.monthKey}>
                            {opt.monthLabel} {opt.isCurrentMonth ? '(Current)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="text-[11px] text-muted font-mono">
                      Cycle Month {monthlyReport.monthIndex} of {monthlyReport.totalMonthsInCycle}
                    </div>
                  </div>

                  {/* Plain English Banner */}
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3.5">
                    <div className="flex items-start gap-2.5">
                      <LightbulbIcon className="h-4 w-4 shrink-0" />
                      <div>
                        <div className="text-xs font-bold text-emerald-300">
                          {monthlyReport.plainEnglishSummary}
                        </div>
                        <div className="text-[11px] text-muted mt-1 leading-relaxed">
                          {monthlyReport.plainEnglishDetail}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Core Metrics Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div className="rounded-xl border border-line bg-surface/60 p-3 text-center">
                      <div className="text-[10px] uppercase font-semibold tracking-wider text-muted">Annual Entitlement</div>
                      <div className="mt-1 text-lg font-bold text-text">{monthlyReport.totalAnnualEntitlement}d</div>
                      <div className="text-[10px] text-dim">Total holiday year</div>
                    </div>
                    <div className="rounded-xl border border-line bg-surface/60 p-3 text-center">
                      <div className="text-[10px] uppercase font-semibold tracking-wider text-muted">Remaining Balance</div>
                      <div className="mt-1 text-lg font-extrabold text-brand">{monthlyReport.remainingLeaveBalance}d</div>
                      <div className="text-[10px] text-dim">Annual net remaining</div>
                    </div>
                    <div className="rounded-xl border border-line bg-surface/60 p-3 text-center">
                      <div className="text-[10px] uppercase font-semibold tracking-wider text-muted">Accrued to Date</div>
                      <div className="mt-1 text-lg font-bold text-indigo-400">{monthlyReport.leaveAccruedToDate}d</div>
                      <div className="text-[10px] text-dim">Earned so far</div>
                    </div>
                    <div className="rounded-xl border border-line bg-surface/60 p-3 text-center">
                      <div className="text-[10px] uppercase font-semibold tracking-wider text-muted">Currently Entitled</div>
                      <div className="mt-1 text-lg font-extrabold text-teal-400">{monthlyReport.currentlyEntitledPaidLeave}d</div>
                      <div className="text-[10px] text-dim">Available to take now</div>
                    </div>
                  </div>

                  {/* Usage Breakdown Card */}
                  <div className="rounded-xl border border-line bg-raised/40 p-3.5 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-text">Leave Usage Breakdown</span>
                      <span className="text-[11px] text-muted font-mono">{monthlyReport.cycleStartDate} &rarr; {monthlyReport.cycleEndDate}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                      <div className="rounded-lg bg-surface/80 p-2 border border-line">
                        <div className="text-[10px] text-muted">Total Leave Taken</div>
                        <div className="text-sm font-bold text-text mt-0.5">{monthlyReport.leaveTakenAnnual}d</div>
                      </div>
                      <div className="rounded-lg bg-surface/80 p-2 border border-line">
                        <div className="text-[10px] text-muted">Paid Leave Used</div>
                        <div className="text-sm font-bold text-brand mt-0.5">{monthlyReport.paidLeaveUsedAnnual}d</div>
                      </div>
                      <div className="rounded-lg bg-surface/80 p-2 border border-line">
                        <div className="text-[10px] text-muted">Unpaid Leave Taken</div>
                        <div className="text-sm font-bold text-amber-400 mt-0.5">{monthlyReport.unpaidLeaveTakenAnnual}d</div>
                      </div>
                    </div>
                    <div className="text-[10px] text-dim">
                      Month Window: {monthlyReport.monthWindow.startDate} to {monthlyReport.monthWindow.endDate} · Taken this month: <strong>{monthlyReport.monthWindow.leaveTakenInMonth}d</strong> (Paid: {monthlyReport.monthWindow.paidLeaveInMonth}d, Unpaid: {monthlyReport.monthWindow.unpaidLeaveInMonth}d)
                    </div>
                  </div>

                  {/* Sufficiency Status Card */}
                  <div className="rounded-xl border border-line bg-raised/40 p-3.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-text">Requested Leave Sufficiency</span>
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                          monthlyReport.requestedLeaveSufficiency.status === 'SUFFICIENT'
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : monthlyReport.requestedLeaveSufficiency.status === 'INSUFFICIENT'
                            ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                            : 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                        }`}
                      >
                        {monthlyReport.requestedLeaveSufficiency.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted leading-relaxed">
                      {monthlyReport.requestedLeaveSufficiency.message}
                    </p>
                    {monthlyReport.requestedLeaveSufficiency.pendingRequests.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {monthlyReport.requestedLeaveSufficiency.pendingRequests.map((pr) => (
                          <div key={pr.id} className="flex items-center justify-between text-[11px] rounded bg-surface/60 px-2.5 py-1.5 border border-line">
                            <span className="font-medium text-text">{pr.leaveType}: {pr.startDate} &rarr; {pr.endDate}</span>
                            <span className="font-bold text-brand">{pr.totalDays}d ({pr.reducesEntitlement ? 'Paid' : 'Unpaid'})</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Month Adjustments Card */}
                  <div className="rounded-xl border border-line bg-raised/40 p-3.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-text">Adjustments in Month</span>
                      <span className="text-[11px] text-dim">{monthlyReport.monthAdjustments.length} logged</span>
                    </div>
                    {monthlyReport.monthAdjustments.length === 0 ? (
                      <div className="text-[11px] text-muted italic">No leave adjustments made during this month.</div>
                    ) : (
                      <div className="space-y-1.5">
                        {monthlyReport.monthAdjustments.map((adj) => (
                          <div key={adj.id} className="flex items-center justify-between text-xs rounded-lg bg-surface/80 p-2 border border-line">
                            <div>
                              <span className="font-semibold text-text">{adj.reason}</span>
                              <div className="text-[10px] text-dim">{adj.adjustmentDate}</div>
                            </div>
                            <span className={`font-bold ${adj.days >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {adj.days >= 0 ? `+${adj.days}d` : `${adj.days}d`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end border-t border-line pt-3">
              <Button onClick={() => setShowMonthlyModal(false)}>
                Close Statement
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: HR Configure Designated Bank Holidays */}
      {showHolidayModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-2xl border border-line bg-surface p-5 shadow-2xl space-y-4 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h3 className="text-base font-extrabold text-text flex items-center gap-2">
                  Configure Designated Bank Holidays ({holidayYear})
                  <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-500/30">
                    HR Only
                  </span>
                </h3>
                <p className="text-xs text-muted mt-0.5">
                  Configure the 5 approved annual bank holiday dates and titles according to company policy.
                </p>
              </div>
              <Button variant="ghost" onClick={() => setShowHolidayModal(false)} className="text-muted hover:text-text py-1 px-2 text-xs">
                <XIcon className="h-4 w-4" />
              </Button>
            </div>

            {holidayModalError && (
              <div className="rounded-lg bg-rose-500/20 border border-rose-500/40 p-2.5 text-xs text-rose-300">
                {holidayModalError}
              </div>
            )}

            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              <div className="flex items-center justify-between text-xs text-muted">
                <span>Designated Holidays ({editingHolidays.length} / 5 recommended)</span>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (editingHolidays.length >= 5) return;
                    setEditingHolidays([
                      ...editingHolidays,
                      { date: `${holidayYear}-01-01`, name: '', notes: 'Designated Organisation Bank Holiday' },
                    ]);
                  }}
                  disabled={editingHolidays.length >= 5}
                  className="py-0.5 px-2 text-[11px]"
                >
                  + Add Holiday
                </Button>
              </div>

              <div className="space-y-2.5">
                {editingHolidays.map((h, index) => (
                  <div key={index} className="flex items-center gap-2 rounded-xl border border-line bg-raised/50 p-3">
                    <span className="text-xs font-bold text-dim w-6 text-center">#{index + 1}</span>
                    <div className="w-40 shrink-0">
                      <label className="text-[10px] font-bold text-dim block mb-1">Holiday Date</label>
                      <Input
                        type="date"
                        value={h.date}
                        onChange={(e) => {
                          const updated = [...editingHolidays];
                          updated[index] = { ...updated[index], date: e.target.value };
                          setEditingHolidays(updated);
                        }}
                        className="w-full text-xs py-1"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-[10px] font-bold text-dim block mb-1">Holiday Title / Name</label>
                      <Input
                        type="text"
                        placeholder="e.g. New Year's Day"
                        value={h.name}
                        onChange={(e) => {
                          const updated = [...editingHolidays];
                          updated[index] = { ...updated[index], name: e.target.value };
                          setEditingHolidays(updated);
                        }}
                        className="w-full text-xs py-1"
                      />
                    </div>
                    <div className="w-48 hidden sm:block">
                      <label className="text-[10px] font-bold text-dim block mb-1">Notes (Optional)</label>
                      <Input
                        type="text"
                        placeholder="Notes"
                        value={h.notes || ''}
                        onChange={(e) => {
                          const updated = [...editingHolidays];
                          updated[index] = { ...updated[index], notes: e.target.value };
                          setEditingHolidays(updated);
                        }}
                        className="w-full text-xs py-1"
                      />
                    </div>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        const updated = editingHolidays.filter((_, i) => i !== index);
                        setEditingHolidays(updated);
                      }}
                      className="text-rose-400 hover:text-rose-300 py-1 px-2 text-xs mt-4"
                      title="Remove Holiday"
                    >
                      <XIcon className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-line pt-3">
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingHolidays([
                    { date: `${holidayYear}-01-01`, name: "New Year's Day", notes: 'Designated Organisation Bank Holiday' },
                    { date: `${holidayYear}-05-04`, name: 'Early May Bank Holiday', notes: 'Designated Organisation Bank Holiday' },
                    { date: `${holidayYear}-05-25`, name: 'Spring Bank Holiday', notes: 'Designated Organisation Bank Holiday' },
                    { date: `${holidayYear}-08-31`, name: 'Summer Bank Holiday', notes: 'Designated Organisation Bank Holiday' },
                    { date: `${holidayYear}-12-25`, name: 'Christmas Day', notes: 'Designated Organisation Bank Holiday' },
                  ]);
                }}
                className="text-xs text-muted"
              >
                Reset to Standard 5
              </Button>

              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => setShowHolidayModal(false)} className="text-xs">
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleSaveHolidays}
                  disabled={holidaySaving}
                  className="text-xs font-bold bg-indigo-600 hover:bg-indigo-500"
                >
                  {holidaySaving ? 'Saving…' : 'Save Changes (HR Only)'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
