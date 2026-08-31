'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type {
  AbsenceRecord,
  FormalWarningItem,
  WarningBoardEmployee,
  WarningBoardSummary,
  WarningTrigger,
} from '@/lib/types';
import { Badge, Button, Empty, Input, Panel } from './primitives';

export function WarningBoard() {
  const [board, setBoard] = useState<WarningBoardSummary | null>(null);
  const [triggers, setTriggers] = useState<WarningTrigger[]>([]);
  const [warnings, setWarnings] = useState<FormalWarningItem[]>([]);
  const [absences, setAbsences] = useState<AbsenceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tabs: 'triage' (workforce triage & triggers), 'formal' (issued formal warnings), 'absences' (no-shows & sickness)
  const [activeTab, setActiveTab] = useState<'triage' | 'formal' | 'absences'>('triage');

  // Filters
  const [bandFilter, setBandFilter] = useState<'ALL' | 'RED' | 'AMBER' | 'GREEN'>('ALL');
  const [absenceStatusFilter, setAbsenceStatusFilter] = useState<'ALL' | 'PENDING_REVIEW' | 'CONFIRMED' | 'DISMISSED'>('PENDING_REVIEW');
  const [search, setSearch] = useState('');

  // Modals & Action states (Triggers)
  const [selectedTrigger, setSelectedTrigger] = useState<WarningTrigger | null>(null);
  const [triggerAction, setTriggerAction] = useState<'CONFIRM' | 'WAIVE' | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewExplanation, setReviewExplanation] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Modals & Action states (Absences)
  const [selectedAbsence, setSelectedAbsence] = useState<AbsenceRecord | null>(null);
  const [absenceAction, setAbsenceAction] = useState<'CONFIRM' | 'DISMISS' | null>(null);
  const [deductAnnualLeave, setDeductAnnualLeave] = useState(true);
  const [treatAsUnpaid, setTreatAsUnpaid] = useState(true);
  const [createWarningTrigger, setCreateWarningTrigger] = useState(false);
  const [absenceNotes, setAbsenceNotes] = useState('');
  const [scanDate, setScanDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [scanning, setScanning] = useState(false);

  // Direct Issue Warning Modal
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [issueEmployeeId, setIssueEmployeeId] = useState('');
  const [issueLevel, setIssueLevel] = useState('INFORMAL');
  const [issueType, setIssueType] = useState('LATENESS');
  const [issueExplanation, setIssueExplanation] = useState('');

  // Withdraw Warning Modal
  const [selectedWithdrawWarning, setSelectedWithdrawWarning] = useState<FormalWarningItem | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');

  const refresh = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [bData, tData, wData, aData] = await Promise.all([
        api.warningBoard(),
        api.warningTriggers('PENDING_REVIEW'),
        api.formalWarnings(),
        api.absences('ALL'),
      ]);
      setBoard(bData);
      setTriggers(tData.triggers || []);
      setWarnings(wData.warnings || []);
      setAbsences(aData.absences || []);
    } catch (err: unknown) {
      if (!silent) setError(err instanceof Error ? err.message : 'Failed to load warning board data.');
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

    const interval = setInterval(() => {
      refresh(true);
    }, 4000);

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('office-tracker-sse', handleSse);
      }
      clearInterval(interval);
    };
  }, []);

  const handleReviewAbsence = async () => {
    if (!selectedAbsence || !absenceAction) return;
    if (!absenceNotes.trim()) {
      alert('A review note explaining the decision is required.');
      return;
    }

    setSubmitting(true);
    try {
      await api.reviewAbsence(selectedAbsence.id, {
        status: absenceAction === 'CONFIRM' ? 'CONFIRMED' : 'DISMISSED',
        deductAnnualLeave: absenceAction === 'CONFIRM' ? deductAnnualLeave : false,
        treatAsUnpaid: absenceAction === 'CONFIRM' ? treatAsUnpaid : false,
        createWarningTrigger: absenceAction === 'CONFIRM' ? createWarningTrigger : false,
        notes: absenceNotes.trim(),
      });
      setSelectedAbsence(null);
      setAbsenceAction(null);
      setAbsenceNotes('');
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to decide absence record.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleScanAbsences = async () => {
    setScanning(true);
    try {
      const res = await api.scanAbsences(scanDate);
      alert(`Absence Scan Complete for ${res.dateKey}:\n• Scanned: ${res.scannedCount} employees\n• Flagged: ${res.detectedCount} suspected absence(s)`);
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to scan absences.');
    } finally {
      setScanning(false);
    }
  };

  const handleReviewTrigger = async () => {
    if (!selectedTrigger || !triggerAction) return;
    if (!reviewNotes.trim()) {
      alert('A review note is required.');
      return;
    }
    if (triggerAction === 'CONFIRM' && !reviewExplanation.trim()) {
      alert('An explanation the employee will see is required when confirming a formal warning.');
      return;
    }

    setSubmitting(true);
    try {
      await api.reviewWarningTrigger(
        selectedTrigger.id,
        triggerAction === 'CONFIRM' ? 'CONFIRMED' : 'WAIVED',
        reviewNotes.trim(),
        triggerAction === 'CONFIRM' ? reviewExplanation.trim() : undefined,
      );
      setSelectedTrigger(null);
      setTriggerAction(null);
      setReviewNotes('');
      setReviewExplanation('');
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to decide warning trigger.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleIssueWarning = async () => {
    if (!issueEmployeeId) {
      alert('Please select an employee.');
      return;
    }
    if (!issueExplanation.trim()) {
      alert('An explanation is required.');
      return;
    }

    setSubmitting(true);
    try {
      await api.issueFormalWarning(
        issueEmployeeId,
        issueLevel,
        issueExplanation.trim(),
        issueType,
      );
      setShowIssueModal(false);
      setIssueEmployeeId('');
      setIssueExplanation('');
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to issue formal warning.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleWithdrawWarning = async () => {
    if (!selectedWithdrawWarning) return;
    if (!withdrawReason.trim()) {
      alert('A reason is required to withdraw a warning.');
      return;
    }

    setSubmitting(true);
    try {
      await api.withdrawFormalWarning(selectedWithdrawWarning.id, withdrawReason.trim());
      setSelectedWithdrawWarning(null);
      setWithdrawReason('');
      await refresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to withdraw warning.');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredEmployees = (board?.employees || []).filter((e) => {
    if (bandFilter !== 'ALL' && e.band !== bandFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return e.employeeName.toLowerCase().includes(q) || e.role.toLowerCase().includes(q);
    }
    return true;
  });

  const redCount = board?.counts.red || 0;
  const amberCount = board?.counts.amber || 0;
  const greenCount = board?.counts.green || 0;
  const pendingCount = triggers.length;
  const activeWarningsCount = warnings.filter((w) => w.status === 'ACTIVE').length;
  const pendingAbsencesCount = absences.filter((a) => a.status === 'PENDING_REVIEW').length;

  const filteredAbsences = absences.filter((a) => {
    if (absenceStatusFilter !== 'ALL' && a.status !== absenceStatusFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        a.employeeName.toLowerCase().includes(q) ||
        (a.role || '').toLowerCase().includes(q) ||
        a.absenceType.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <Panel
      title="Warning & Disciplinary Board (Spec 9, 10 & 21)"
      note="Lateness monitoring, unauthorised absence review, and formal escalation lifecycle"
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant={activeTab === 'triage' ? 'primary' : 'ghost'}
            onClick={() => setActiveTab('triage')}
            className="py-1 px-3 text-xs"
          >
            Workforce Triage
          </Button>
          <Button
            variant={activeTab === 'absences' ? 'primary' : 'ghost'}
            onClick={() => setActiveTab('absences')}
            className="py-1 px-3 text-xs"
          >
            No-Shows & Absences ({pendingAbsencesCount})
          </Button>
          <Button
            variant={activeTab === 'formal' ? 'primary' : 'ghost'}
            onClick={() => setActiveTab('formal')}
            className="py-1 px-3 text-xs"
          >
            Formal Warnings ({activeWarningsCount})
          </Button>
          <Button
            variant="primary"
            onClick={() => setShowIssueModal(true)}
            className="py-1 px-3 text-xs"
          >
            + Issue Warning
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

      {/* Summary Stat Cards (Spec 21.1) */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div
          onClick={() => setBandFilter(bandFilter === 'GREEN' ? 'ALL' : 'GREEN')}
          className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
            bandFilter === 'GREEN'
              ? 'border-brand bg-brand-dim/30 ring-1 ring-brand'
              : 'border-line bg-surface hover:bg-raised'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-brand">Good Standing (0–1)</span>
            <span className="h-2 w-2 rounded-full bg-brand" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-text">{greenCount}</div>
          <div className="mt-0.5 text-[10px] text-muted">Within normal bounds</div>
        </div>

        <div
          onClick={() => setBandFilter(bandFilter === 'AMBER' ? 'ALL' : 'AMBER')}
          className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
            bandFilter === 'AMBER'
              ? 'border-warn bg-warn-dim/30 ring-1 ring-warn'
              : 'border-line bg-surface hover:bg-raised'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-warn">Warning Band (2–3)</span>
            <span className="h-2 w-2 rounded-full bg-warn" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-text">{amberCount}</div>
          <div className="mt-0.5 text-[10px] text-muted">1 late away from referral</div>
        </div>

        <div
          onClick={() => setBandFilter(bandFilter === 'RED' ? 'ALL' : 'RED')}
          className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
            bandFilter === 'RED'
              ? 'border-danger bg-danger-dim/30 ring-1 ring-danger'
              : 'border-line bg-surface hover:bg-raised'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-danger">Referral Level (4+)</span>
            <span className="h-2 w-2 rounded-full bg-danger" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-text">{redCount}</div>
          <div className="mt-0.5 text-[10px] text-muted">4+ lates or active warnings</div>
        </div>

        <div className="rounded-xl border border-line bg-surface p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-text">Pending Triggers</span>
            {pendingCount > 0 && <span className="h-2 w-2 rounded-full bg-warn animate-pulse" />}
          </div>
          <div className="mt-2 text-2xl font-extrabold text-warn">{pendingCount}</div>
          <div className="mt-0.5 text-[10px] text-muted">Awaiting HR decision</div>
        </div>

        <div className="rounded-xl border border-line bg-surface p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-text">Active Warnings</span>
            <span className="h-2 w-2 rounded-full bg-line" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-text">{activeWarningsCount}</div>
          <div className="mt-0.5 text-[10px] text-muted">Formal disciplinary notices</div>
        </div>
      </div>

      {/* Pending Triggers Review Queue (Spec 9.3 & 21.2) */}
      {triggers.length > 0 && activeTab === 'triage' && (
        <div className="mb-6 rounded-xl border border-warn/40 bg-warn-dim/20 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-warn text-[10px] font-bold text-black">
                !
              </span>
              <h3 className="text-xs font-bold text-text uppercase tracking-wide">
                Pending Trigger Review Queue ({triggers.length}) — Spec 9.3
              </h3>
            </div>
            <span className="text-[11px] text-muted">
              Referrals raised automatically. A trigger is not a warning until confirmed.
            </span>
          </div>

          <div className="space-y-2.5">
            {triggers.map((t) => (
              <div
                key={t.id}
                className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-text">{t.employeeName}</span>
                    <Badge tone="danger">{t.occurrences} Lates</Badge>
                    <Badge tone="muted">{t.period}</Badge>
                  </div>
                  <div className="text-xs text-muted">
                    Rule: <span className="text-text font-medium">{t.reason}</span> · Raised on {t.raisedOn}
                  </div>
                  <div className="text-xs text-brand font-medium">
                    Proposed Escalation: {t.proposedLevelLabel ?? 'Formal Review'} (Prior Warnings:{' '}
                    {t.priorWarnings})
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-center">
                  <Button
                    variant="primary"
                    onClick={() => {
                      setSelectedTrigger(t);
                      setTriggerAction('CONFIRM');
                      setReviewNotes(`4th late occurrence reached in ${t.period}.`);
                      setReviewExplanation(
                        `You have exceeded the permitted 3 late arrivals for the period (${t.occurrences} recorded). A formal ${
                          t.proposedLevelLabel ?? 'warning'
                        } has been issued.`,
                      );
                    }}
                    className="py-1 px-3 text-xs"
                  >
                    Confirm Warning
                  </Button>
                  <Button
                    onClick={() => {
                      setSelectedTrigger(t);
                      setTriggerAction('WAIVE');
                      setReviewNotes('');
                      setReviewExplanation('');
                    }}
                    className="py-1 px-3 text-xs text-muted hover:text-text"
                  >
                    Waive Trigger
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Triage View */}
      {activeTab === 'triage' && (
        <div>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted">Filter Band:</span>
              {(['ALL', 'RED', 'AMBER', 'GREEN'] as const).map((b) => (
                <button
                  key={b}
                  onClick={() => setBandFilter(b)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-all ${
                    bandFilter === b
                      ? 'bg-raised text-text border border-line'
                      : 'text-dim hover:text-text'
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>

            <div className="w-full sm:w-64">
              <Input
                type="text"
                placeholder="Search employee or role…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full text-xs py-1.5"
              />
            </div>
          </div>

          {filteredEmployees.length === 0 ? (
            <Empty>No employees matching the selected band/search filter.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-line bg-raised text-dim">
                    <th className="px-3 py-2.5 font-semibold">Employee</th>
                    <th className="px-3 py-2.5 font-semibold">Lateness Standing</th>
                    <th className="px-3 py-2.5 font-semibold">Disciplinary Band</th>
                    <th className="px-3 py-2.5 font-semibold">Active Warnings</th>
                    <th className="px-3 py-2.5 font-semibold">Highest Level</th>
                    <th className="px-3 py-2.5 font-semibold">Next Level If Triggered</th>
                    <th className="px-3 py-2.5 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filteredEmployees.map((emp) => {
                    const badgeTone =
                      emp.band === 'GREEN' ? 'brand' : emp.band === 'AMBER' ? 'warn' : 'danger';

                    return (
                      <tr key={emp.employeeId} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-3 align-middle">
                          <div className="font-semibold text-text">{emp.employeeName}</div>
                          <div className="text-[11px] text-muted">{emp.role}</div>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-sm text-text">
                              {emp.lateOccurrences !== null ? emp.lateOccurrences : 0}
                            </span>
                            <span className="text-dim">/ {emp.allowed ?? 3} allowed</span>
                          </div>
                          {emp.pendingReview && (
                            <span className="mt-0.5 inline-block text-[10px] font-bold text-warn">
                              ● Pending HR Review
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <Badge tone={badgeTone}>{emp.bandLabel}</Badge>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          {emp.activeWarnings > 0 ? (
                            <Badge tone="danger">{emp.activeWarnings} Active</Badge>
                          ) : (
                            <span className="text-dim">0 Active</span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <span className="text-xs text-text font-medium">
                            {emp.highestLevel ?? 'None'}
                          </span>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          {emp.sequenceExhausted ? (
                            <span className="text-xs text-danger font-semibold">
                              Sequence Exhausted
                            </span>
                          ) : (
                            <span className="text-xs text-muted">
                              {emp.nextLevelIfConfirmed ?? 'Informal Notice'}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle text-right">
                          <Button
                            onClick={() => {
                              setIssueEmployeeId(emp.employeeId);
                              setIssueLevel(emp.nextLevelIfConfirmed ?? 'INFORMAL');
                              setShowIssueModal(true);
                            }}
                            className="py-1 px-2.5 text-[11px]"
                          >
                            Issue Warning
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

      {/* Formal Warnings List View */}
      {activeTab === 'formal' && (
        <div>
          {warnings.length === 0 ? (
            <Empty>No formal warnings on record.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-line bg-raised text-dim">
                    <th className="px-3 py-2.5 font-semibold">Employee</th>
                    <th className="px-3 py-2.5 font-semibold">Warning Level</th>
                    <th className="px-3 py-2.5 font-semibold">Reason / Explanation</th>
                    <th className="px-3 py-2.5 font-semibold">Issued Date</th>
                    <th className="px-3 py-2.5 font-semibold">Expiry Date</th>
                    <th className="px-3 py-2.5 font-semibold">Status</th>
                    <th className="px-3 py-2.5 font-semibold">Acknowledgement</th>
                    <th className="px-3 py-2.5 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {warnings.map((w) => {
                    const statusTone =
                      w.status === 'ACTIVE' ? 'danger' : w.status === 'EXPIRED' ? 'muted' : 'warn';

                    return (
                      <tr key={w.id} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-3 align-middle">
                          <div className="font-semibold text-text">{w.employeeName}</div>
                          <div className="text-[11px] text-muted">{w.employeeRole || ''}</div>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <Badge tone="danger">{w.levelLabel}</Badge>
                          <div className="text-[10px] text-dim mt-0.5">{w.warningType}</div>
                        </td>
                        <td className="px-3 py-3 align-middle max-w-[280px]">
                          <div className="text-xs leading-snug text-text">{w.explanation}</div>
                          {w.outcome && (
                            <div className="mt-1 text-[11px] italic text-muted">
                              Outcome / Note: {w.outcome}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle font-mono text-[11px]">
                          {w.issuedDate}
                        </td>
                        <td className="px-3 py-3 align-middle font-mono text-[11px]">
                          {w.expiryDate ?? 'None'}
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <Badge tone={statusTone}>{w.status}</Badge>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          {w.acknowledgedAt ? (
                            <div>
                              <span className="text-[11px] font-semibold text-brand">
                                ✓ Acknowledged
                              </span>
                              <div className="text-[10px] text-dim">{w.acknowledgedAt}</div>
                              {w.ackComments && (
                                <div className="text-[10px] italic text-muted mt-0.5">
                                  &quot;{w.ackComments}&quot;
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-[11px] text-warn font-medium">
                              Pending Receipt
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-middle text-right">
                          {w.status === 'ACTIVE' && (
                            <Button
                              onClick={() => {
                                setSelectedWithdrawWarning(w);
                                setWithdrawReason('');
                              }}
                              className="py-1 px-2.5 text-[11px] text-danger hover:bg-danger-dim"
                            >
                              Withdraw
                            </Button>
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

      {/* 3. Unauthorised Absences & Sickness Reporting Tab (Spec 10 & 2.2) */}
      {activeTab === 'absences' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-raised/50 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-text mr-1">Filter Status:</span>
              {(['PENDING_REVIEW', 'CONFIRMED', 'DISMISSED', 'ALL'] as const).map((st) => (
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
              <span className="text-xs text-dim">Scan Date:</span>
              <Input
                type="date"
                value={scanDate}
                onChange={(e) => setScanDate(e.target.value)}
                className="py-1 text-xs w-36"
              />
              <Button
                variant="primary"
                onClick={handleScanAbsences}
                disabled={scanning}
                className="py-1 px-3 text-xs"
              >
                {scanning ? 'Scanning…' : '🔍 Scan for No-Shows'}
              </Button>
            </div>
          </div>

          {filteredAbsences.length === 0 ? (
            <Empty>No absence or no-show records matching this filter.</Empty>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-line bg-surface">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-line bg-raised text-[11px] text-dim uppercase">
                  <tr>
                    <th className="px-3 py-2.5 font-semibold">Employee</th>
                    <th className="px-3 py-2.5 font-semibold">Date</th>
                    <th className="px-3 py-2.5 font-semibold">Absence Type</th>
                    <th className="px-3 py-2.5 font-semibold">Reason / Details</th>
                    <th className="px-3 py-2.5 font-semibold">Consequence Decisions</th>
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
                          <div className="font-semibold text-text">{abs.employeeName}</div>
                          <div className="text-[11px] text-muted">{abs.role || ''}</div>
                        </td>
                        <td className="px-3 py-3 align-middle font-mono font-medium text-slate-200">
                          {abs.date}
                          <div className="text-[10px] text-dim">Detected: {abs.detectedAt}</div>
                        </td>
                        <td className="px-3 py-3 align-middle">
                          <Badge tone={isNoShow ? 'danger' : isSick ? 'warn' : 'muted'}>
                            {isNoShow ? '🚨 SUSPECTED NO-SHOW' : `🤒 ${abs.absenceType}`}
                          </Badge>
                        </td>
                        <td className="px-3 py-3 align-middle max-w-[260px]">
                          <div className="text-xs text-text">{abs.reason || 'Auto-flagged scheduled no-show'}</div>
                          {abs.documentTitle && (
                            <div className="mt-1 text-[11px] text-brand font-medium">
                              📎 Attached Doc: {abs.documentTitle}
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
                              : 'Dismissed'}
                          </Badge>
                        </td>
                        <td className="px-3 py-3 align-middle text-right">
                          {abs.status === 'PENDING_REVIEW' && (
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                variant="primary"
                                onClick={() => {
                                  setSelectedAbsence(abs);
                                  setAbsenceAction('CONFIRM');
                                  setDeductAnnualLeave(true);
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
                                  setAbsenceAction('DISMISS');
                                  setAbsenceNotes('Excused with management approval.');
                                }}
                                className="py-1 px-2.5 text-[11px] text-muted hover:text-text"
                              >
                                Dismiss
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

      {/* Review Absence Modal (Spec 10.2 Independent Policy Switches) */}
      {selectedAbsence && absenceAction && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6">
            <h2 className="text-base font-bold text-text">
              {absenceAction === 'CONFIRM'
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

            {absenceAction === 'CONFIRM' && (
              <div className="my-4 space-y-3 rounded-xl border border-line bg-raised/60 p-4 text-xs">
                <div className="font-semibold text-text text-sm">
                  Independent Policy Consequences (Spec 10.2):
                </div>
                <p className="text-dim text-[11px] leading-relaxed">
                  Per the Forgotten Women HR policy, consequences must be decided separately case-by-case and not bundled automatically.
                </p>

                <label className="flex items-start gap-3 p-2.5 rounded-lg bg-surface border border-line cursor-pointer hover:border-brand transition">
                  <input
                    type="checkbox"
                    checked={deductAnnualLeave}
                    onChange={(e) => setDeductAnnualLeave(e.target.checked)}
                    className="mt-0.5 rounded border-line text-brand focus:ring-brand h-4 w-4"
                  />
                  <div>
                    <div className="font-semibold text-text">1. Deduct from Annual Leave Balance</div>
                    <div className="text-[11px] text-muted">Deducts 1 full day from the employee's available paid leave balance.</div>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-2.5 rounded-lg bg-surface border border-line cursor-pointer hover:border-brand transition">
                  <input
                    type="checkbox"
                    checked={treatAsUnpaid}
                    onChange={(e) => setTreatAsUnpaid(e.target.checked)}
                    className="mt-0.5 rounded border-line text-brand focus:ring-brand h-4 w-4"
                  />
                  <div>
                    <div className="font-semibold text-text">2. Treat Day as Unpaid (Salary Deduction)</div>
                    <div className="text-[11px] text-muted">Marks day as unpaid for payroll calculation (1/260th annual rate deduction).</div>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-2.5 rounded-lg bg-surface border border-line cursor-pointer hover:border-brand transition">
                  <input
                    type="checkbox"
                    checked={createWarningTrigger}
                    onChange={(e) => setCreateWarningTrigger(e.target.checked)}
                    className="mt-0.5 rounded border-line text-brand focus:ring-brand h-4 w-4"
                  />
                  <div>
                    <div className="font-semibold text-text">3. Create Disciplinary Warning Trigger</div>
                    <div className="text-[11px] text-muted">Escalates this unauthorised absence into the formal warning referral queue.</div>
                  </div>
                </label>
              </div>
            )}

            <div className="mb-5">
              <label className="block text-xs font-semibold text-text mb-1">
                Decision Notes (Required for Audit Trail)
              </label>
              <textarea
                value={absenceNotes}
                onChange={(e) => setAbsenceNotes(e.target.value)}
                placeholder="Explain the rationale for this decision (e.g. employee failed to contact manager, emergency confirmed)..."
                rows={3}
                className="w-full rounded-lg border border-line bg-raised p-2.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  setSelectedAbsence(null);
                  setAbsenceAction(null);
                }}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleReviewAbsence}
                disabled={submitting}
                className={absenceAction === 'DISMISS' ? 'bg-slate-700 text-white' : 'bg-brand text-white'}
              >
                {submitting ? 'Submitting…' : absenceAction === 'CONFIRM' ? 'Confirm Consequences' : 'Confirm Dismissal'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Review Trigger Modal (Confirm / Waive) */}
      {selectedTrigger && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6">
            <h2 className="text-base font-bold text-text">
              {triggerAction === 'CONFIRM'
                ? `Confirm Formal Warning: ${selectedTrigger.employeeName}`
                : `Waive Lateness Trigger: ${selectedTrigger.employeeName}`}
            </h2>
            <p className="mt-1 text-xs text-muted">
              {selectedTrigger.occurrences} late arrivals recorded in {selectedTrigger.period} (Rule:{' '}
              {selectedTrigger.reason})
            </p>

            {triggerAction === 'CONFIRM' && (
              <div className="my-4 rounded-lg bg-danger-dim/30 border border-danger/30 p-3 text-xs">
                <div className="font-semibold text-danger">
                  Next Formal Escalation Level: {selectedTrigger.proposedLevelLabel ?? 'Formal Warning'}
                </div>
                <div className="text-muted mt-0.5">
                  Confirming will issue a formal warning, notify the employee on their app, and require
                  receipt acknowledgement.
                </div>
              </div>
            )}

            {triggerAction === 'CONFIRM' && (
              <div className="mb-4">
                <label className="block text-xs font-semibold text-text mb-1">
                  Employee-Facing Explanation (Required)
                </label>
                <textarea
                  value={reviewExplanation}
                  onChange={(e) => setReviewExplanation(e.target.value)}
                  placeholder="Explain the warning reason that will be displayed to the employee on their mobile app..."
                  rows={3}
                  className="w-full rounded-lg border border-line bg-raised p-2.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
                />
              </div>
            )}

            <div className="mb-5">
              <label className="block text-xs font-semibold text-text mb-1">
                Internal HR / Audit Note (Required)
              </label>
              <textarea
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                placeholder={
                  triggerAction === 'WAIVE'
                    ? 'Explain why this trigger is being waived (e.g. transport disruption, authorised exception)...'
                    : 'Internal decision notes for the permanent audit trail...'
                }
                rows={3}
                className="w-full rounded-lg border border-line bg-raised p-2.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  setSelectedTrigger(null);
                  setTriggerAction(null);
                }}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                variant={triggerAction === 'CONFIRM' ? 'primary' : 'ghost'}
                onClick={handleReviewTrigger}
                disabled={submitting}
                className={
                  triggerAction === 'CONFIRM' ? 'bg-danger text-white hover:bg-danger/90' : ''
                }
              >
                {submitting
                  ? 'Submitting…'
                  : triggerAction === 'CONFIRM'
                  ? 'Confirm & Issue Warning'
                  : 'Waive Trigger'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Direct Issue Warning Modal */}
      {showIssueModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6">
            <h2 className="text-base font-bold text-text">Issue Formal Warning (Spec 21.3)</h2>
            <p className="mt-1 text-xs text-muted">
              Issue a formal disciplinary warning directly to an employee record.
            </p>

            <div className="my-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-text mb-1">Select Employee</label>
                <select
                  value={issueEmployeeId}
                  onChange={(e) => setIssueEmployeeId(e.target.value)}
                  className="w-full rounded-lg border border-line bg-raised p-2 text-xs text-text focus:border-brand focus:outline-none"
                >
                  <option value="">-- Choose Employee --</option>
                  {(board?.employees || []).map((e) => (
                    <option key={e.employeeId} value={e.employeeId}>
                      {e.employeeName} ({e.role}) - {e.bandLabel}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-text mb-1">Warning Level</label>
                  <select
                    value={issueLevel}
                    onChange={(e) => setIssueLevel(e.target.value)}
                    className="w-full rounded-lg border border-line bg-raised p-2 text-xs text-text focus:border-brand focus:outline-none"
                  >
                    <option value="INFORMAL">Informal Notice</option>
                    <option value="FIRST_WRITTEN">First Written</option>
                    <option value="FINAL_WRITTEN">Final Written</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text mb-1">Warning Type</label>
                  <select
                    value={issueType}
                    onChange={(e) => setIssueType(e.target.value)}
                    className="w-full rounded-lg border border-line bg-raised p-2 text-xs text-text focus:border-brand focus:outline-none"
                  >
                    <option value="LATENESS">Lateness</option>
                    <option value="CONDUCT">Conduct</option>
                    <option value="PERFORMANCE">Performance</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-text mb-1">
                  Explanation (Visible to Employee)
                </label>
                <textarea
                  value={issueExplanation}
                  onChange={(e) => setIssueExplanation(e.target.value)}
                  placeholder="Provide clear reasons and expectations for improvement..."
                  rows={3}
                  className="w-full rounded-lg border border-line bg-raised p-2.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button onClick={() => setShowIssueModal(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleIssueWarning} disabled={submitting}>
                {submitting ? 'Issuing…' : 'Issue Formal Warning'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Withdraw Warning Modal */}
      {selectedWithdrawWarning && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6">
            <h2 className="text-base font-bold text-text">Withdraw Formal Warning</h2>
            <p className="mt-1 text-xs text-muted">
              {selectedWithdrawWarning.employeeName} · {selectedWithdrawWarning.levelLabel}
            </p>

            <div className="my-4 rounded-lg bg-raised p-3 text-xs">
              <div className="text-dim">Original Explanation:</div>
              <div className="mt-0.5 text-text font-medium">
                {selectedWithdrawWarning.explanation}
              </div>
            </div>

            <div className="mb-5">
              <label className="block text-xs font-semibold text-text mb-1">
                Reason for Withdrawal (Required for Audit Trail)
              </label>
              <textarea
                value={withdrawReason}
                onChange={(e) => setWithdrawReason(e.target.value)}
                placeholder="Explain why this warning is being withdrawn (e.g. overturned on appeal, administrative correction)..."
                rows={3}
                className="w-full rounded-lg border border-line bg-raised p-2.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
              />
              <span className="text-[11px] text-muted mt-1 block">
                A withdrawn warning stops counting toward future escalation sequences.
              </span>
            </div>

            <div className="flex justify-end gap-2">
              <Button onClick={() => setSelectedWithdrawWarning(null)} disabled={submitting}>
                Cancel
              </Button>
              <Button
                variant="ghost"
                onClick={handleWithdrawWarning}
                disabled={submitting}
                className="bg-danger text-white hover:bg-danger/90"
              >
                {submitting ? 'Withdrawing…' : 'Confirm Withdrawal'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
