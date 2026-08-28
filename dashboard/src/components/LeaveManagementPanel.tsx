'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type {
  EmployeeLeaveOverview,
  LeaveRequestItem,
  TeamCalendarLeave,
} from '@/lib/types';
import { Badge, Button, Empty, Input, Panel } from './primitives';

export function LeaveManagementPanel() {
  const [pendingRequests, setPendingRequests] = useState<LeaveRequestItem[]>([]);
  const [allRequests, setAllRequests] = useState<LeaveRequestItem[]>([]);
  const [balances, setBalances] = useState<EmployeeLeaveOverview[]>([]);
  const [calendarLeaves, setCalendarLeaves] = useState<TeamCalendarLeave[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tabs: 'pending' | 'calendar' | 'all' | 'balances'
  const [activeTab, setActiveTab] = useState<'pending' | 'calendar' | 'all' | 'balances'>('pending');

  // Filters
  const [historyFilter, setHistoryFilter] = useState<'ALL' | 'APPROVED' | 'REJECTED' | 'CANCELLED'>('ALL');
  const [search, setSearch] = useState('');

  // Modals & Action states
  const [selectedRequest, setSelectedRequest] = useState<LeaveRequestItem | null>(null);
  const [decisionAction, setDecisionAction] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [decisionNotes, setDecisionNotes] = useState('');
  const [overdraftReason, setOverdraftReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Manual Adjustment Modal
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [adjustEmployeeId, setAdjustEmployeeId] = useState('');
  const [adjustDays, setAdjustDays] = useState<number>(1);
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustDate, setAdjustDate] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [pData, rData, bData, cData] = await Promise.all([
        api.pendingLeaveRequests(),
        api.leaveRequests(historyFilter),
        api.leaveBalances(),
        api.teamLeaveCalendar(),
      ]);
      setPendingRequests(pData.requests || []);
      setAllRequests(rData.requests || []);
      setBalances(bData.employees || []);
      setCalendarLeaves(cData.leaves || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load leave data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [historyFilter]);

  const handleDecision = async () => {
    if (!selectedRequest || !decisionAction) return;

    if (decisionAction === 'REJECTED' && !decisionNotes.trim()) {
      alert('A rejection reason is required for the employee.');
      return;
    }

    if (
      decisionAction === 'APPROVED' &&
      (selectedRequest.exceedsBalance || (selectedRequest.shortfallDays && selectedRequest.shortfallDays > 0)) &&
      !overdraftReason.trim()
    ) {
      alert('An overdraft justification is required when approving leave beyond the accrued balance.');
      return;
    }

    setSubmitting(true);
    try {
      await api.decideLeaveRequest(
        selectedRequest.id,
        decisionAction,
        decisionNotes.trim(),
        overdraftReason.trim() || undefined,
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

  // Derive summary metrics
  const pendingCount = pendingRequests.length;
  const shortfallCount = pendingRequests.filter(
    (r) => r.exceedsBalance || (r.shortfallDays && r.shortfallDays > 0),
  ).length;

  const todayStr = new Date().toISOString().slice(0, 10);
  const onLeaveToday = calendarLeaves.filter(
    (l) => l.from <= todayStr && l.to >= todayStr,
  );

  const filteredBalances = balances.filter((b) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return b.employeeName.toLowerCase().includes(q) || b.role.toLowerCase().includes(q);
  });

  const filteredHistory = allRequests.filter((r) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      r.employeeName.toLowerCase().includes(q) ||
      (r.employeeRole && r.employeeRole.toLowerCase().includes(q)) ||
      r.type.toLowerCase().includes(q)
    );
  });

  return (
    <Panel
      title="Annual Leave & Leave Management (Spec 13, 14 & 15)"
      note="Anniversary accruals (1.67d/mo), team calendar, shortfall checks, and approval lifecycle"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={activeTab === 'pending' ? 'primary' : 'ghost'}
            onClick={() => setActiveTab('pending')}
            className="py-1 px-3 text-xs"
          >
            Pending Approvals ({pendingCount})
          </Button>
          <Button
            variant={activeTab === 'calendar' ? 'primary' : 'ghost'}
            onClick={() => setActiveTab('calendar')}
            className="py-1 px-3 text-xs"
          >
            Team Calendar ({calendarLeaves.length})
          </Button>
          <Button
            variant={activeTab === 'balances' ? 'primary' : 'ghost'}
            onClick={() => setActiveTab('balances')}
            className="py-1 px-3 text-xs"
          >
            Workforce Balances
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
            onClick={() => setShowAdjustModal(true)}
            className="py-1 px-3 text-xs"
          >
            + Adjust Balance
          </Button>
          <Button onClick={refresh} disabled={loading} className="py-1 px-3 text-xs">
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
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div
          onClick={() => setActiveTab('pending')}
          className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
            activeTab === 'pending'
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
          onClick={() => setActiveTab('calendar')}
          className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
            activeTab === 'calendar'
              ? 'border-brand bg-brand-dim/30 ring-1 ring-brand'
              : 'border-line bg-surface hover:bg-raised'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-text">On Leave Today</span>
            <span className="h-2 w-2 rounded-full bg-brand" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-text">{onLeaveToday.length}</div>
          <div className="mt-0.5 text-[10px] text-muted">Active approved coverage</div>
        </div>

        <div className="rounded-xl border border-line bg-surface p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-text">Shortfall Warnings</span>
            {shortfallCount > 0 && <span className="h-2 w-2 rounded-full bg-danger" />}
          </div>
          <div className="mt-2 text-2xl font-extrabold text-danger">{shortfallCount}</div>
          <div className="mt-0.5 text-[10px] text-muted">Exceeds accrued balance</div>
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
          {pendingRequests.length === 0 ? (
            <Empty>No leave requests awaiting approval.</Empty>
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
                  {pendingRequests.map((r) => {
                    const hasShortfall =
                      r.exceedsBalance || (r.shortfallDays && r.shortfallDays > 0);

                    return (
                      <tr key={r.id} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-3 align-top">
                          <div className="font-semibold text-text">{r.employeeName}</div>
                          <div className="text-[11px] text-muted">{r.employeeRole ?? ''}</div>
                          {r.reason && (
                            <div className="mt-1 text-[11px] text-dim max-w-[200px] truncate">
                              &quot;{r.reason}&quot;
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top">
                          <Badge tone={r.reducesEntitlement ? 'brand' : 'muted'}>{r.type}</Badge>
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
                                  ✓ Within accrued balance
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-dim">Balance uncomputable</span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top text-dim text-[11px]">{r.submittedAt}</td>
                        <td className="px-3 py-3 align-top text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              variant="primary"
                              onClick={() => {
                                setSelectedRequest(r);
                                setDecisionAction('APPROVED');
                                setDecisionNotes('Approved by HR.');
                                setOverdraftReason(
                                  hasShortfall
                                    ? `Approved in advance of monthly accrual (Shortfall: ${r.shortfallDays}d).`
                                    : '',
                                );
                              }}
                              className="py-1 px-2.5 text-[11px]"
                            >
                              Approve
                            </Button>
                            <Button
                              onClick={() => {
                                setSelectedRequest(r);
                                setDecisionAction('REJECTED');
                                setDecisionNotes('');
                                setOverdraftReason('');
                              }}
                              className="py-1 px-2.5 text-[11px] text-danger hover:bg-danger-dim"
                            >
                              Reject
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
        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-muted">
              Scheduled and active approved leaves across the workforce.
            </span>
            <Badge tone="brand">{calendarLeaves.length} Approved Bookings</Badge>
          </div>

          {calendarLeaves.length === 0 ? (
            <Empty>No scheduled leaves found in the calendar range.</Empty>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {calendarLeaves.map((l) => {
                const isTodayActive = l.from <= todayStr && l.to >= todayStr;

                return (
                  <div
                    key={l.id}
                    className={`rounded-xl border p-3.5 transition-all ${
                      isTodayActive
                        ? 'border-brand/40 bg-brand-dim/20'
                        : 'border-line bg-surface hover:bg-raised'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-text">{l.employeeName}</span>
                      <Badge tone={isTodayActive ? 'brand' : 'muted'}>
                        {isTodayActive ? 'Away Today' : `${l.days}d`}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-brand font-medium">{l.type}</div>
                    <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-dim">
                      <span>{l.from}</span>
                      <span>&rarr;</span>
                      <span>{l.to}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
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
                    <th className="px-3 py-2.5 font-semibold">Holiday Year (Anniversary)</th>
                    <th className="px-3 py-2.5 font-semibold">Annual Entitlement</th>
                    <th className="px-3 py-2.5 font-semibold">Accrued to Date</th>
                    <th className="px-3 py-2.5 font-semibold">Taken</th>
                    <th className="px-3 py-2.5 font-semibold">Booked</th>
                    <th className="px-3 py-2.5 font-semibold">Available Balance</th>
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
                            <div className="font-semibold text-text">{b.employeeName}</div>
                            <div className="text-[11px] text-muted">{b.role}</div>
                          </td>
                          <td colSpan={6} className="px-3 py-3 align-middle text-dim italic">
                            Blocked: {bal.message ?? 'No start date on record'}
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

                    return (
                      <tr key={b.employeeId} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-3 align-middle">
                          <div className="font-semibold text-text">{b.employeeName}</div>
                          <div className="text-[11px] text-muted">{b.role}</div>
                        </td>
                        <td className="px-3 py-3 align-middle font-mono text-[11px] text-dim">
                          {bal.holidayYear ? `${bal.holidayYear.from} → ${bal.holidayYear.to}` : '—'}
                          <div className="text-[10px]">
                            {bal.holidayYear?.monthsCompleted ?? 0} mos completed
                          </div>
                        </td>
                        <td className="px-3 py-3 align-middle font-semibold text-text">
                          {bal.annualEntitlement}d
                        </td>
                        <td className="px-3 py-3 align-middle font-semibold text-brand">
                          {bal.accrued}d
                        </td>
                        <td className="px-3 py-3 align-middle text-dim">{bal.taken}d</td>
                        <td className="px-3 py-3 align-middle text-dim">{bal.booked}d</td>
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
                          <div className="font-semibold text-text">{r.employeeName}</div>
                          <div className="text-[11px] text-muted">{r.employeeRole ?? ''}</div>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <Badge tone={r.reducesEntitlement ? 'brand' : 'muted'}>{r.type}</Badge>
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

      {/* Decision Modal (Approve / Reject) */}
      {selectedRequest && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6">
            <h2 className="text-base font-bold text-text">
              {decisionAction === 'APPROVED'
                ? `Approve Leave Request: ${selectedRequest.employeeName}`
                : `Reject Leave Request: ${selectedRequest.employeeName}`}
            </h2>
            <p className="mt-1 text-xs text-muted">
              {selectedRequest.type} · {selectedRequest.from} &rarr; {selectedRequest.to} ({selectedRequest.days} working days)
            </p>

            {/* Overdraft Alert & Justification (Spec 15.2) */}
            {decisionAction === 'APPROVED' &&
              (selectedRequest.exceedsBalance ||
                (selectedRequest.shortfallDays && selectedRequest.shortfallDays > 0)) && (
                <div className="my-4 rounded-lg bg-warn-dim/30 border border-warn/40 p-3 text-xs">
                  <div className="font-semibold text-warn">
                    ⚠️ Shortfall Warning: Exceeds Accrued Entitlement by {selectedRequest.shortfallDays ?? 'unknown'} days
                  </div>
                  <div className="text-muted mt-0.5">
                    This request exceeds what the employee has accrued so far this holiday year. Approving requires an explicit HR overdraft reason.
                  </div>
                  <div className="mt-3">
                    <label className="block text-xs font-semibold text-text mb-1">
                      Overdraft Approval Justification (Required)
                    </label>
                    <textarea
                      value={overdraftReason}
                      onChange={(e) => setOverdraftReason(e.target.value)}
                      placeholder="e.g. Authorized to borrow against future accrual in upcoming quarter..."
                      rows={2}
                      className="w-full rounded-lg border border-line bg-raised p-2 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
                    />
                  </div>
                </div>
              )}

            <div className="my-4">
              <label className="block text-xs font-semibold text-text mb-1">
                Decision Notes {decisionAction === 'REJECTED' ? '(Required - explain rejection)' : '(Optional)'}
              </label>
              <textarea
                value={decisionNotes}
                onChange={(e) => setDecisionNotes(e.target.value)}
                placeholder="Explain the rationale for the employee and audit log..."
                rows={3}
                className="w-full rounded-lg border border-line bg-raised p-2.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  setSelectedRequest(null);
                  setDecisionAction(null);
                }}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                variant={decisionAction === 'REJECTED' ? 'ghost' : 'primary'}
                onClick={handleDecision}
                disabled={submitting}
                className={
                  decisionAction === 'REJECTED' ? 'bg-danger text-white hover:bg-danger/90' : ''
                }
              >
                {submitting
                  ? 'Submitting…'
                  : decisionAction === 'APPROVED'
                  ? 'Confirm Approval'
                  : 'Confirm Rejection'}
              </Button>
            </div>
          </div>
        </div>
      )}

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
                      {b.employeeName} ({b.role}) - Available: {b.balance.available}d
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
    </Panel>
  );
}
