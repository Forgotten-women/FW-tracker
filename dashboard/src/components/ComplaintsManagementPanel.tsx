'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { ComplaintRecord, ComplaintStatus } from '@/lib/types';

const CATEGORY_COLORS: Record<string, string> = {
  'Salary or payroll deductions': 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  'Incorrect attendance records': 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  'Leave entitlement': 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  'Working hours': 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300',
  'Workplace issues': 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  'Behaviour or treatment in the office': 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  'Problems involving another employee': 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  'Problems involving a manager': 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  'Harassment, bullying, or inappropriate behaviour': 'border-red-500/40 bg-red-500/15 text-red-300 font-bold',
  'Health and safety concerns': 'border-yellow-500/40 bg-yellow-500/15 text-yellow-300 font-bold',
  'Any other HR or workplace-related issue': 'border-slate-500/30 bg-slate-500/10 text-slate-300',
};

const STATUS_BADGES: Record<ComplaintStatus, { label: string; bg: string; border: string; text: string }> = {
  SUBMITTED: { label: 'Submitted', bg: 'bg-purple-500/15', border: 'border-purple-500/30', text: 'text-purple-300' },
  UNDER_REVIEW: { label: 'Under Review', bg: 'bg-amber-500/15', border: 'border-amber-500/30', text: 'text-amber-300' },
  IN_PROGRESS: { label: 'In Progress', bg: 'bg-sky-500/15', border: 'border-sky-500/30', text: 'text-sky-300' },
  RESOLVED: { label: 'Resolved', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30', text: 'text-emerald-300' },
  CLOSED: { label: 'Closed', bg: 'bg-slate-500/15', border: 'border-slate-500/30', text: 'text-slate-400' },
};

export function ComplaintsManagementPanel() {
  const [complaints, setComplaints] = useState<ComplaintRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [search, setSearch] = useState<string>('');
  const [categories, setCategories] = useState<string[]>([]);

  // Selected complaint for review modal
  const [selectedComplaint, setSelectedComplaint] = useState<ComplaintRecord | null>(null);
  const [modalStatus, setModalStatus] = useState<ComplaintStatus>('SUBMITTED');
  const [modalHrNotes, setModalHrNotes] = useState<string>('');
  const [modalResolutionNotes, setModalResolutionNotes] = useState<string>('');
  const [updating, setUpdating] = useState(false);
  const [updateSuccess, setUpdateSuccess] = useState<string | null>(null);

  const loadCategories = useCallback(async () => {
    try {
      const res = await api.fetchComplaintCategories();
      if (res.categories) {
        setCategories(res.categories);
      }
    } catch (_) {}
  }, []);

  const loadComplaints = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await api.fetchComplaints({
        status: statusFilter,
        category: categoryFilter,
        search,
      });
      setComplaints(res.complaints || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load employee complaints.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [statusFilter, categoryFilter, search]);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    loadComplaints();
  }, [loadComplaints]);

  // Real-time SSE listener
  useEffect(() => {
    const handleSse = () => {
      loadComplaints(true);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('office-tracker-sse', handleSse);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('office-tracker-sse', handleSse);
      }
    };
  }, [loadComplaints]);

  const openReviewModal = (complaint: ComplaintRecord) => {
    setSelectedComplaint(complaint);
    setModalStatus(complaint.status);
    setModalHrNotes(complaint.hrNotes || '');
    setModalResolutionNotes(complaint.resolutionNotes || '');
    setUpdateSuccess(null);
  };

  const handleUpdateComplaint = async (markResolved = false) => {
    if (!selectedComplaint) return;
    setUpdating(true);
    setUpdateSuccess(null);
    try {
      const targetStatus = markResolved ? 'RESOLVED' : modalStatus;
      const res = await api.updateComplaintStatus(selectedComplaint.id, {
        status: targetStatus,
        hrNotes: modalHrNotes,
        resolutionNotes: modalResolutionNotes,
      });

      setUpdateSuccess(
        targetStatus === 'RESOLVED'
          ? 'Concern successfully resolved and employee notified.'
          : 'Status and response notes successfully updated.'
      );

      // Update local item
      const updatedItem: ComplaintRecord = {
        ...selectedComplaint,
        status: res.complaintStatus,
        hrNotes: res.hrNotes,
        resolutionNotes: res.resolutionNotes,
        resolvedAt: res.resolvedAt,
        resolvedAtFormatted: res.resolvedAtFormatted,
        resolvedBy: res.resolvedBy,
      };
      setSelectedComplaint(updatedItem);
      setModalStatus(res.complaintStatus);

      // Refresh list
      loadComplaints(true);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to update complaint.');
    } finally {
      setUpdating(false);
    }
  };

  // Metrics
  const totalCount = complaints.length;
  const submittedCount = complaints.filter((c) => c.status === 'SUBMITTED').length;
  const underReviewCount = complaints.filter((c) => c.status === 'UNDER_REVIEW').length;
  const inProgressCount = complaints.filter((c) => c.status === 'IN_PROGRESS').length;
  const resolvedCount = complaints.filter((c) => c.status === 'RESOLVED' || c.status === 'CLOSED').length;

  return (
    <div className="flex flex-col gap-6">
      {/* Top Header & Overview */}
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </span>
            <h2 className="text-xl font-bold tracking-tight text-white">Employee Concerns & Confidential Complaints</h2>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Strictly confidential workspace grievances, payroll questions, and conduct reports. Accessible only to authorised HR and Management personnel.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => loadComplaints()}
            className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <svg className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <div className="glass-panel rounded-2xl p-4 border border-white/8 bg-slate-950/40">
          <div className="text-[11px] font-medium text-slate-400">Total Concerns</div>
          <div className="mt-1 text-2xl font-black text-white">{totalCount}</div>
        </div>

        <div className="glass-panel rounded-2xl p-4 border border-purple-500/20 bg-purple-500/5">
          <div className="text-[11px] font-medium text-purple-400">New Submitted</div>
          <div className="mt-1 text-2xl font-black text-purple-300">{submittedCount}</div>
        </div>

        <div className="glass-panel rounded-2xl p-4 border border-amber-500/20 bg-amber-500/5">
          <div className="text-[11px] font-medium text-amber-400">Under Review</div>
          <div className="mt-1 text-2xl font-black text-amber-300">{underReviewCount}</div>
        </div>

        <div className="glass-panel rounded-2xl p-4 border border-sky-500/20 bg-sky-500/5">
          <div className="text-[11px] font-medium text-sky-400">In Progress</div>
          <div className="mt-1 text-2xl font-black text-sky-300">{inProgressCount}</div>
        </div>

        <div className="glass-panel rounded-2xl p-4 border border-emerald-500/20 bg-emerald-500/5">
          <div className="text-[11px] font-medium text-emerald-400">Resolved / Closed</div>
          <div className="mt-1 text-2xl font-black text-emerald-300">{resolvedCount}</div>
        </div>
      </div>

      {/* Filter & Search Toolbar */}
      <div className="glass-panel flex flex-col gap-3 rounded-2xl p-4 border border-white/8 bg-slate-950/60 md:flex-row md:items-center md:justify-between">
        {/* Status Filters */}
        <div className="flex flex-wrap items-center gap-1.5">
          {(['ALL', 'SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const).map((st) => {
            const isActive = statusFilter === st;
            const label = st === 'ALL' ? 'All Statuses' : STATUS_BADGES[st]?.label || st;
            return (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                    : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Category Filter and Search */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-xl border border-white/10 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="ALL">All Categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>

          <div className="relative">
            <input
              type="text"
              placeholder="Search reference, employee, subject..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-64 rounded-xl border border-white/10 bg-slate-900 pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <svg
              className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
          <svg className="h-4 w-4 shrink-0 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{error}</span>
        </div>
      )}

      {/* Complaints List / Table */}
      <div className="glass-panel overflow-hidden rounded-2xl border border-white/8 bg-slate-950/40">
        {loading && complaints.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
            <p className="text-xs text-slate-400">Loading confidential employee concerns...</p>
          </div>
        ) : complaints.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-center px-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800 text-slate-400">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-white">No Employee Concerns Found</h3>
            <p className="max-w-md text-xs text-slate-400">
              {search || statusFilter !== 'ALL' || categoryFilter !== 'ALL'
                ? 'No complaints match the selected filter criteria.'
                : 'No employee concerns have been submitted yet. When an employee logs a concern, it will appear here confidentially.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/8 bg-white/3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3.5">Reference & Date</th>
                  <th className="px-5 py-3.5">Employee</th>
                  <th className="px-5 py-3.5">Category</th>
                  <th className="px-5 py-3.5">Subject & Preview</th>
                  <th className="px-5 py-3.5">Attachments</th>
                  <th className="px-5 py-3.5">Status</th>
                  <th className="px-5 py-3.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-medium">
                {complaints.map((c) => {
                  const statusInfo = STATUS_BADGES[c.status] || STATUS_BADGES.SUBMITTED;
                  const categoryBadgeColor = CATEGORY_COLORS[c.category] || 'border-slate-500/30 bg-slate-500/10 text-slate-300';

                  return (
                    <tr key={c.id} className="transition-colors hover:bg-white/2">
                      {/* Reference & Date */}
                      <td className="px-5 py-4 whitespace-nowrap">
                        <div className="font-mono text-xs font-bold text-indigo-400">{c.referenceNumber}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">{c.createdAtFormatted}</div>
                      </td>

                      {/* Employee */}
                      <td className="px-5 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-slate-200">
                            {c.employeeName.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className="font-semibold text-white">{c.employeeName}</div>
                            <div className="text-[10px] text-slate-400 flex items-center gap-1.5">
                              {c.employeeNumber && (
                                <span className="rounded bg-slate-800 px-1 py-0.2 font-mono text-[9px] text-slate-300">
                                  {c.employeeNumber}
                                </span>
                              )}
                              <span>{c.employeeRole || 'Employee'}</span>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Category */}
                      <td className="px-5 py-4">
                        <span className={`inline-flex items-center rounded-lg border px-2 py-0.8 text-[10px] ${categoryBadgeColor}`}>
                          {c.category}
                        </span>
                      </td>

                      {/* Subject & Preview */}
                      <td className="px-5 py-4 max-w-xs">
                        <div className="truncate font-semibold text-slate-200">{c.subject}</div>
                        <div className="truncate text-[11px] text-slate-400 mt-0.5">{c.description}</div>
                      </td>

                      {/* Attachments */}
                      <td className="px-5 py-4 whitespace-nowrap">
                        {c.attachments && c.attachments.length > 0 ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-slate-300 bg-slate-800/80 rounded-md px-2 py-0.5 border border-white/10">
                            <svg className="h-3.5 w-3.5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                            </svg>
                            {c.attachments.length} {c.attachments.length === 1 ? 'file' : 'files'}
                          </span>
                        ) : (
                          <span className="text-[11px] text-slate-600">—</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="px-5 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${statusInfo.bg} ${statusInfo.border} ${statusInfo.text}`}>
                          <span className="h-1.5 w-1.5 rounded-full bg-current" />
                          {statusInfo.label}
                        </span>
                      </td>

                      {/* Action */}
                      <td className="px-5 py-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => openReviewModal(c)}
                          className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-semibold text-indigo-300 transition-colors hover:bg-indigo-600 hover:text-white cursor-pointer"
                        >
                          Review Concern
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detailed Review & Resolution Modal */}
      {selectedComplaint && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md overflow-y-auto">
          <div className="relative w-full max-w-2xl rounded-3xl border border-white/10 bg-slate-950 p-6 shadow-2xl my-8">
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b border-white/8 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-bold text-indigo-400">
                    {selectedComplaint.referenceNumber}
                  </span>
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_BADGES[selectedComplaint.status]?.bg} ${STATUS_BADGES[selectedComplaint.status]?.border} ${STATUS_BADGES[selectedComplaint.status]?.text}`}>
                    {STATUS_BADGES[selectedComplaint.status]?.label}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[10px] text-slate-400 bg-white/5 rounded px-1.5 py-0.5">
                    <svg className="h-3 w-3 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    Confidential
                  </span>
                </div>
                <h3 className="mt-1.5 text-lg font-bold text-white">{selectedComplaint.subject}</h3>
              </div>

              <button
                type="button"
                onClick={() => setSelectedComplaint(null)}
                className="rounded-full p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Submitting Employee Banner */}
            <div className="mt-4 flex items-center justify-between rounded-xl bg-slate-900/80 p-3 border border-white/5">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-500/20 text-indigo-300 font-bold text-sm">
                  {selectedComplaint.employeeName.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="font-bold text-white text-xs">{selectedComplaint.employeeName}</div>
                  <div className="text-[11px] text-slate-400">
                    Employee ID:{' '}
                    <span className="font-mono text-slate-300">
                      {selectedComplaint.employeeNumber || selectedComplaint.employeeId}
                    </span>{' '}
                    • {selectedComplaint.employeeRole || 'Employee'}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-slate-400">Date Submitted</div>
                <div className="text-xs font-semibold text-slate-300">{selectedComplaint.createdAtFormatted}</div>
              </div>
            </div>

            {/* Category Banner */}
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[11px] text-slate-400">Category:</span>
              <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${CATEGORY_COLORS[selectedComplaint.category] || 'bg-slate-800 text-slate-300'}`}>
                {selectedComplaint.category}
              </span>
            </div>

            {/* Description Body */}
            <div className="mt-4">
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Detailed Description</div>
              <div className="mt-1.5 rounded-xl border border-white/5 bg-slate-900/60 p-4 text-xs leading-relaxed text-slate-200 whitespace-pre-wrap">
                {selectedComplaint.description}
              </div>
            </div>

            {/* Attachments Section */}
            {selectedComplaint.attachments && selectedComplaint.attachments.length > 0 && (
              <div className="mt-4">
                <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  Supporting Documents & Screenshots ({selectedComplaint.attachments.length})
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {selectedComplaint.attachments.map((att) => (
                    <div
                      key={att.id}
                      className="flex items-center justify-between rounded-xl border border-white/10 bg-slate-900/90 p-3"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <svg className="h-5 w-5 shrink-0 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold text-white">{att.fileName}</div>
                          <div className="text-[10px] text-slate-400">{(att.fileSize / 1024).toFixed(1)} KB</div>
                        </div>
                      </div>
                      <a
                        href={`/api/complaints/${selectedComplaint.id}/attachments/${att.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg bg-indigo-500/10 px-2.5 py-1 text-[11px] font-semibold text-indigo-300 hover:bg-indigo-600 hover:text-white"
                      >
                        View / Download
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Resolution History Banner if Resolved */}
            {selectedComplaint.resolvedAt && (
              <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs text-emerald-300">
                <div className="flex items-center justify-between font-bold">
                  <span className="flex items-center gap-1.5">
                    <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Resolved on {selectedComplaint.resolvedAtFormatted}
                  </span>
                  {selectedComplaint.resolvedBy && (
                    <span className="text-[11px] text-emerald-400">By: {selectedComplaint.resolvedBy}</span>
                  )}
                </div>
                {selectedComplaint.resolutionNotes && (
                  <p className="mt-1.5 text-[11px] text-emerald-200/90 leading-relaxed">
                    {selectedComplaint.resolutionNotes}
                  </p>
                )}
              </div>
            )}

            {/* HR / Management Action Form */}
            <div className="mt-5 border-t border-white/8 pt-4">
              <div className="text-xs font-bold text-white mb-3">HR & Management Response Workflow</div>

              {updateSuccess && (
                <div className="mb-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                  {updateSuccess}
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">Update Status</label>
                  <select
                    value={modalStatus}
                    onChange={(e) => setModalStatus(e.target.value as ComplaintStatus)}
                    className="w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="SUBMITTED">Submitted</option>
                    <option value="UNDER_REVIEW">Under Review</option>
                    <option value="IN_PROGRESS">In Progress</option>
                    <option value="RESOLVED">Resolved</option>
                    <option value="CLOSED">Closed</option>
                  </select>
                </div>
              </div>

              <div className="mt-3">
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  HR / Management Notes & Response (Visible to Employee)
                </label>
                <textarea
                  rows={3}
                  value={modalHrNotes}
                  onChange={(e) => setModalHrNotes(e.target.value)}
                  placeholder="Enter response or notes regarding actions taken..."
                  className="w-full rounded-xl border border-white/10 bg-slate-900 p-3 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              {(modalStatus === 'RESOLVED' || modalStatus === 'CLOSED') && (
                <div className="mt-3">
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                    Formal Resolution Summary & Actions Taken
                  </label>
                  <textarea
                    rows={2}
                    value={modalResolutionNotes}
                    onChange={(e) => setModalResolutionNotes(e.target.value)}
                    placeholder="Document the resolution agreed with the employee..."
                    className="w-full rounded-xl border border-emerald-500/30 bg-slate-900 p-3 text-xs text-slate-200 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              )}

              {/* Action Buttons */}
              <div className="mt-5 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setSelectedComplaint(null)}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10 hover:text-white"
                >
                  Close
                </button>

                <button
                  type="button"
                  disabled={updating}
                  onClick={() => handleUpdateComplaint(false)}
                  className="rounded-xl border border-indigo-500/30 bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500 disabled:opacity-50"
                >
                  {updating ? 'Saving...' : 'Save & Update'}
                </button>

                {selectedComplaint.status !== 'RESOLVED' && selectedComplaint.status !== 'CLOSED' && (
                  <button
                    type="button"
                    disabled={updating}
                    onClick={() => handleUpdateComplaint(true)}
                    className="rounded-xl border border-emerald-500/30 bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-600/30 hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {updating ? 'Resolving...' : 'Mark as Resolved'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
