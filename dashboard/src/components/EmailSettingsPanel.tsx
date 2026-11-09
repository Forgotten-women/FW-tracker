'use client';

import { useEffect, useState, useMemo } from 'react';
import { api } from '@/lib/api';
import type { AdminEmployee } from '@/lib/types';
import { Badge, Button, Empty, Panel } from './primitives';
import {
  AlertTriangleIcon,
  CheckIcon,
  CheckCircleIcon,
  ClockIcon,
  FileTextIcon,
  MailIcon,
  SettingsIcon,
  ShieldCheckIcon,
  XIcon,
} from './icons';

export function EmailSettingsPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Settings form state
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [smtpHost, setSmtpHost] = useState('smtp.office365.com');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fromName, setFromName] = useState('Forgotten Women HR');
  const [fromAddress, setFromAddress] = useState('hr@forgottenwomen.org');

  // Event toggles
  const [notifFormalWarnings, setNotifFormalWarnings] = useState(true);
  const [notifLateWarnings, setNotifLateWarnings] = useState(true);
  const [notifLeaveDecisions, setNotifLeaveDecisions] = useState(true);
  const [notifLeaveRecorded, setNotifLeaveRecorded] = useState(true);
  const [notifCorrections, setNotifCorrections] = useState(true);
  const [notifDocuments, setNotifDocuments] = useState(true);
  const [notifAbsences, setNotifAbsences] = useState(true);

  // Test email state
  const [testRecipient, setTestRecipient] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ status: 'SUCCESS' | 'ERROR'; message: string } | null>(null);

  // Employee directory state
  const [employees, setEmployees] = useState<AdminEmployee[]>([]);
  const [search, setSearch] = useState('');
  const [editingEmployee, setEditingEmployee] = useState<AdminEmployee | null>(null);
  const [editWorkEmail, setEditWorkEmail] = useState('');
  const [editPersonalEmail, setEditPersonalEmail] = useState('');
  const [savingEmployee, setSavingEmployee] = useState(false);
  const [editEmpError, setEditEmpError] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    setSaveError(null);
    try {
      const [settingsRes, empsRes] = await Promise.all([
        api.getSettings(),
        api.employees(),
      ]);

      const s = settingsRes.settings || {};
      setEmailEnabled(s['email_notifications_enabled'] === '1');
      setSmtpHost(s['email_smtp_host'] || 'smtp.office365.com');
      setSmtpPort(s['email_smtp_port'] || '587');
      setSmtpSecure(s['email_smtp_secure'] === '1');
      setSmtpUser(s['email_smtp_user'] || '');
      setSmtpPass(s['email_smtp_pass'] || '');
      setFromName(s['email_from_name'] || 'Forgotten Women HR');
      setFromAddress(s['email_from_address'] || 'hr@forgottenwomen.org');

      setNotifFormalWarnings(s['email_notif_formal_warnings'] !== '0');
      setNotifLateWarnings(s['email_notif_late_warnings'] !== '0');
      setNotifLeaveDecisions(s['email_notif_leave_decisions'] !== '0');
      setNotifLeaveRecorded(s['email_notif_leave_recorded'] !== '0');
      setNotifCorrections(s['email_notif_corrections'] !== '0');
      setNotifDocuments(s['email_notif_documents'] !== '0');
      setNotifAbsences(s['email_notif_absences'] !== '0');

      if (!testRecipient && s['email_smtp_user']) {
        setTestRecipient(s['email_smtp_user']);
      }

      setEmployees(empsRes.employees || []);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to load configuration.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleApplyM365Preset = () => {
    setSmtpHost('smtp.office365.com');
    setSmtpPort('587');
    setSmtpSecure(false);
    setFromName('Forgotten Women HR');
    setSaveSuccess('Applied Microsoft 365 recommended defaults (smtp.office365.com:587 STARTTLS).');
    setTimeout(() => setSaveSuccess(null), 4000);
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const payload: Record<string, string> = {
        email_notifications_enabled: emailEnabled ? '1' : '0',
        email_smtp_host: smtpHost.trim(),
        email_smtp_port: smtpPort.trim(),
        email_smtp_secure: smtpSecure ? '1' : '0',
        email_smtp_user: smtpUser.trim(),
        email_smtp_pass: smtpPass.trim(),
        email_from_name: fromName.trim(),
        email_from_address: fromAddress.trim() || smtpUser.trim(),
        email_notif_formal_warnings: notifFormalWarnings ? '1' : '0',
        email_notif_late_warnings: notifLateWarnings ? '1' : '0',
        email_notif_leave_decisions: notifLeaveDecisions ? '1' : '0',
        email_notif_leave_recorded: notifLeaveRecorded ? '1' : '0',
        email_notif_corrections: notifCorrections ? '1' : '0',
        email_notif_documents: notifDocuments ? '1' : '0',
        email_notif_absences: notifAbsences ? '1' : '0',
      };

      await api.updateSettingsBatch(payload);
      setSaveSuccess('Microsoft 365 & email notification configuration saved successfully!');
      setTimeout(() => setSaveSuccess(null), 4000);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save email settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleTestEmail = async () => {
    if (!testRecipient.trim()) {
      alert('Please enter a recipient email address to receive the test message.');
      return;
    }

    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testEmailConnection({
        to: testRecipient.trim(),
        smtpHost: smtpHost.trim(),
        smtpPort: smtpPort.trim(),
        smtpSecure: smtpSecure,
        smtpUser: smtpUser.trim(),
        smtpPass: smtpPass.trim(),
        fromName: fromName.trim(),
        fromAddress: fromAddress.trim() || smtpUser.trim(),
      });

      setTestResult({
        status: 'SUCCESS',
        message: res.message || `Test email dispatched to ${testRecipient.trim()}!`,
      });
    } catch (err: unknown) {
      setTestResult({
        status: 'ERROR',
        message: err instanceof Error ? err.message : 'Connection test failed.',
      });
    } finally {
      setTesting(false);
    }
  };

  const openEditEmployee = (emp: AdminEmployee) => {
    setEditingEmployee(emp);
    setEditWorkEmail(emp.workEmail || '');
    setEditPersonalEmail(emp.personalEmail || '');
    setEditEmpError(null);
  };

  const handleSaveEmployeeEmail = async () => {
    if (!editingEmployee) return;
    setSavingEmployee(true);
    setEditEmpError(null);
    try {
      await api.updateEmployee(editingEmployee.id, {
        workEmail: editWorkEmail.trim() || null,
        personalEmail: editPersonalEmail.trim() || null,
      });

      setEmployees((prev) =>
        prev.map((e) =>
          e.id === editingEmployee.id
            ? {
                ...e,
                workEmail: editWorkEmail.trim() || null,
                personalEmail: editPersonalEmail.trim() || null,
              }
            : e,
        ),
      );
      setEditingEmployee(null);
    } catch (err: unknown) {
      setEditEmpError(err instanceof Error ? err.message : 'Failed to update employee email.');
    } finally {
      setSavingEmployee(false);
    }
  };

  const filteredEmployees = useMemo(() => {
    if (!search.trim()) return employees;
    const q = search.toLowerCase();
    return employees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        (e.employeeNumber && e.employeeNumber.toLowerCase().includes(q)) ||
        (e.workEmail && e.workEmail.toLowerCase().includes(q)) ||
        (e.personalEmail && e.personalEmail.toLowerCase().includes(q)) ||
        e.role.toLowerCase().includes(q),
    );
  }, [employees, search]);

  const configuredCount = employees.filter((e) => e.workEmail && e.workEmail.includes('@')).length;

  if (loading) {
    return (
      <div className="flex min-h-[300px] flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        <p className="text-xs text-muted">Loading email settings…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Top Banner */}
      <div className="rounded-2xl border border-indigo-500/30 bg-gradient-to-r from-indigo-950/40 via-surface/90 to-surface/80 p-5 shadow-lg">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-gradient text-on-accent shadow-accent">
              <SettingsIcon className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-extrabold text-text tracking-tight">
                  Email Notifications & Microsoft 365 Integration
                </h1>
                <Badge tone={emailEnabled ? 'brand' : 'muted'} size="sm">
                  {emailEnabled ? 'Live Active' : 'Disabled'}
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted max-w-2xl">
                Configure Microsoft 365 / Exchange SMTP credentials to automatically email employees regarding formal warnings, lateness occurrences, leave approvals, and attendance dispute outcomes.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              onClick={handleSaveSettings}
              disabled={saving}
              className="py-2 px-4 text-xs font-bold"
            >
              {saving ? 'Saving Settings…' : 'Save Configuration'}
            </Button>
          </div>
        </div>

        {saveSuccess && (
          <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300 font-semibold flex items-center gap-2">
            <CheckCircleIcon className="h-4 w-4" />
            <span>{saveSuccess}</span>
          </div>
        )}

        {saveError && (
          <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300 font-semibold flex items-center gap-2">
            <AlertTriangleIcon className="h-4 w-4" />
            <span>{saveError}</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Microsoft 365 Server Configuration & Testing (7 cols) */}
        <div className="lg:col-span-7 space-y-6">
          {/* Main SMTP Settings Card */}
          <div className="glass-panel rounded-2xl p-5 border border-line space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h2 className="text-sm font-bold text-text flex items-center gap-2">
                  <MailIcon className="h-4 w-4 text-indigo-400" />
                  <span>Microsoft 365 / SMTP Gateway</span>
                </h2>
                <p className="text-xs text-muted mt-0.5">
                  Outgoing mail transport credentials for notifications.
                </p>
              </div>
              <Button
                variant="ghost"
                onClick={handleApplyM365Preset}
                className="text-[11px] text-indigo-300 hover:text-white"
                title="Fill in Microsoft 365 standard SMTP host and port"
              >
                Use Microsoft 365 Preset
              </Button>
            </div>

            {/* Master Toggle */}
            <div className="flex items-center justify-between p-3.5 rounded-xl border border-line bg-raised/50">
              <div>
                <div className="text-xs font-bold text-text">
                  Dispatch Automated Email Notifications
                </div>
                <div className="text-[11px] text-muted">
                  When enabled, targeted emails will be sent out as events trigger in the system.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEmailEnabled(!emailEnabled)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  emailEnabled ? 'bg-indigo-600' : 'bg-line'
                }`}
                role="switch"
                aria-checked={emailEnabled}
              >
                <span
                  aria-hidden="true"
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    emailEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Inputs */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 text-xs">
              <div>
                <label className="block text-muted font-semibold mb-1">
                  SMTP Host Server
                </label>
                <input
                  type="text"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="smtp.office365.com"
                  className="w-full rounded-xl border border-line bg-raised px-3 py-2 text-text font-mono placeholder-dim focus:border-brand focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-muted font-semibold mb-1">
                  SMTP Port
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(e.target.value)}
                    placeholder="587"
                    className="w-24 rounded-xl border border-line bg-raised px-3 py-2 text-text font-mono placeholder-dim focus:border-brand focus:outline-none"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={smtpSecure}
                      onChange={(e) => setSmtpSecure(e.target.checked)}
                      className="rounded border-line bg-raised text-indigo-600 focus:ring-0"
                    />
                    <span>Direct SSL (465)</span>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-muted font-semibold mb-1">
                  Microsoft 365 Account (Email / Username)
                </label>
                <input
                  type="email"
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                  placeholder="hr@forgottenwomen.org"
                  className="w-full rounded-xl border border-line bg-raised px-3 py-2 text-text placeholder-dim focus:border-brand focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-muted font-semibold mb-1">
                  Password / Microsoft App Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={smtpPass}
                    onChange={(e) => setSmtpPass(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full rounded-xl border border-line bg-raised px-3 py-2 text-text placeholder-dim focus:border-brand focus:outline-none pr-14"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted hover:text-text cursor-pointer uppercase font-bold"
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-muted font-semibold mb-1">
                  Sender Display Name
                </label>
                <input
                  type="text"
                  value={fromName}
                  onChange={(e) => setFromName(e.target.value)}
                  placeholder="Forgotten Women HR"
                  className="w-full rounded-xl border border-line bg-raised px-3 py-2 text-text placeholder-dim focus:border-brand focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-muted font-semibold mb-1">
                  From Email Address
                </label>
                <input
                  type="email"
                  value={fromAddress}
                  onChange={(e) => setFromAddress(e.target.value)}
                  placeholder="hr@forgottenwomen.org"
                  className="w-full rounded-xl border border-line bg-raised px-3 py-2 text-text placeholder-dim focus:border-brand focus:outline-none"
                />
              </div>
            </div>

            {/* Microsoft 365 Guidance */}
            <div className="rounded-xl border border-sky-500/20 bg-sky-950/20 p-3.5 text-xs text-sky-200/90 leading-relaxed space-y-1.5">
              <div className="font-bold text-sky-300 flex items-center gap-1.5">
                <span>💡 Microsoft 365 Configuration Guidance</span>
              </div>
              <ul className="list-disc list-inside space-y-1 text-[11px] text-sky-300/80">
                <li>
                  <strong>MFA / 2-Step Verification:</strong> If your Microsoft 365 account has Two-Factor Authentication enabled, generate an <em>App Password</em> from your Microsoft Account Portal (Security Info &rarr; Add method &rarr; App password) and paste it above.
                </li>
                <li>
                  <strong>SMTP AUTH Enabled:</strong> In Microsoft 365 Admin Center, verify that Authenticated SMTP is enabled on this mailbox (Active users &rarr; Select User &rarr; Mail &rarr; Manage email apps &rarr; Check Authenticated SMTP).
                </li>
              </ul>
            </div>
          </div>

          {/* Test Connection Card */}
          <div className="glass-panel rounded-2xl p-5 border border-line space-y-3.5">
            <div>
              <h3 className="text-sm font-bold text-text flex items-center gap-2">
                <CheckIcon className="h-4 w-4 text-emerald-400" />
                <span>Test Microsoft 365 Connection</span>
              </h3>
              <p className="text-xs text-muted mt-0.5">
                Dispatch an immediate test email to verify credentials, encryption, and connectivity.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <input
                type="email"
                value={testRecipient}
                onChange={(e) => setTestRecipient(e.target.value)}
                placeholder="Enter recipient email (e.g. hr@forgottenwomen.org)"
                className="flex-1 rounded-xl border border-line bg-raised px-3 py-2 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
              />
              <Button
                variant="accent"
                onClick={handleTestEmail}
                disabled={testing || !testRecipient}
                className="shrink-0 py-2 px-4 text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white"
              >
                {testing ? 'Connecting…' : 'Send Test Email'}
              </Button>
            </div>

            {testResult && (
              <div
                className={`rounded-xl border p-3 text-xs leading-relaxed ${
                  testResult.status === 'SUCCESS'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                }`}
              >
                <div className="font-bold flex items-center gap-1.5 mb-1">
                  {testResult.status === 'SUCCESS' ? (
                    <>
                      <CheckCircleIcon className="h-4 w-4" />
                      <span>Verification Succeeded!</span>
                    </>
                  ) : (
                    <>
                      <AlertTriangleIcon className="h-4 w-4" />
                      <span>Connection Error</span>
                    </>
                  )}
                </div>
                <div className="font-mono text-[11px] break-all">{testResult.message}</div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Event Toggles (5 cols) */}
        <div className="lg:col-span-5 space-y-6">
          <div className="glass-panel rounded-2xl p-5 border border-line space-y-4">
            <div className="border-b border-line pb-3">
              <h2 className="text-sm font-bold text-text flex items-center gap-2">
                <ClockIcon className="h-4 w-4 text-amber-400" />
                <span>Notification Event Rules</span>
              </h2>
              <p className="text-xs text-muted mt-0.5">
                Select which event categories trigger employee emails.
              </p>
            </div>

            <div className="space-y-2.5">
              {/* Formal Disciplinary Warnings */}
              <label className="flex items-start justify-between gap-3 p-3 rounded-xl border border-line bg-raised/40 hover:bg-raised cursor-pointer transition">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-text flex items-center gap-1.5">
                    <ShieldCheckIcon className="h-3.5 w-3.5 text-rose-400" />
                    <span>Formal Disciplinary Warnings</span>
                  </div>
                  <div className="text-[11px] text-muted">
                    First Written, Final Written, and Dismissal formal warning notices.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={notifFormalWarnings}
                  onChange={(e) => setNotifFormalWarnings(e.target.checked)}
                  className="mt-0.5 rounded border-line bg-surface text-indigo-600 focus:ring-0"
                />
              </label>

              {/* Lateness & Attendance Triggers */}
              <label className="flex items-start justify-between gap-3 p-3 rounded-xl border border-line bg-raised/40 hover:bg-raised cursor-pointer transition">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-text flex items-center gap-1.5">
                    <ClockIcon className="h-3.5 w-3.5 text-amber-400" />
                    <span>Late Attendance Triggers</span>
                  </div>
                  <div className="text-[11px] text-muted">
                    Notices when employee crosses monthly lateness occurrence thresholds.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={notifLateWarnings}
                  onChange={(e) => setNotifLateWarnings(e.target.checked)}
                  className="mt-0.5 rounded border-line bg-surface text-indigo-600 focus:ring-0"
                />
              </label>

              {/* Leave Approvals & Decisions */}
              <label className="flex items-start justify-between gap-3 p-3 rounded-xl border border-line bg-raised/40 hover:bg-raised cursor-pointer transition">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-text flex items-center gap-1.5">
                    <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Leave Approvals & Decisions</span>
                  </div>
                  <div className="text-[11px] text-muted">
                    Updates when an employee leave booking is approved or rejected.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={notifLeaveDecisions}
                  onChange={(e) => setNotifLeaveDecisions(e.target.checked)}
                  className="mt-0.5 rounded border-line bg-surface text-indigo-600 focus:ring-0"
                />
              </label>

              {/* HR Direct Leave Entry */}
              <label className="flex items-start justify-between gap-3 p-3 rounded-xl border border-line bg-raised/40 hover:bg-raised cursor-pointer transition">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-text flex items-center gap-1.5">
                    <FileTextIcon className="h-3.5 w-3.5 text-purple-400" />
                    <span>HR Direct Leave Entry</span>
                  </div>
                  <div className="text-[11px] text-muted">
                    Notifies employee when HR manually registers a leave or hourly adjustment.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={notifLeaveRecorded}
                  onChange={(e) => setNotifLeaveRecorded(e.target.checked)}
                  className="mt-0.5 rounded border-line bg-surface text-indigo-600 focus:ring-0"
                />
              </label>

              {/* Attendance Dispute Reviews */}
              <label className="flex items-start justify-between gap-3 p-3 rounded-xl border border-line bg-raised/40 hover:bg-raised cursor-pointer transition">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-text flex items-center gap-1.5">
                    <ClockIcon className="h-3.5 w-3.5 text-sky-400" />
                    <span>Attendance Correction Decisions</span>
                  </div>
                  <div className="text-[11px] text-muted">
                    Outcomes when clock-in / out adjustment requests are decided.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={notifCorrections}
                  onChange={(e) => setNotifCorrections(e.target.checked)}
                  className="mt-0.5 rounded border-line bg-surface text-indigo-600 focus:ring-0"
                />
              </label>

              {/* KYC Document Alerts */}
              <label className="flex items-start justify-between gap-3 p-3 rounded-xl border border-line bg-raised/40 hover:bg-raised cursor-pointer transition">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-text flex items-center gap-1.5">
                    <FileTextIcon className="h-3.5 w-3.5 text-indigo-400" />
                    <span>Document & KYC Alerts</span>
                  </div>
                  <div className="text-[11px] text-muted">
                    When mandatory documents are verified, rejected, or approaching expiry.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={notifDocuments}
                  onChange={(e) => setNotifDocuments(e.target.checked)}
                  className="mt-0.5 rounded border-line bg-surface text-indigo-600 focus:ring-0"
                />
              </label>

              {/* Absence & Sickness Reviews */}
              <label className="flex items-start justify-between gap-3 p-3 rounded-xl border border-line bg-raised/40 hover:bg-raised cursor-pointer transition">
                <div className="space-y-0.5">
                  <div className="text-xs font-bold text-text flex items-center gap-1.5">
                    <AlertTriangleIcon className="h-3.5 w-3.5 text-orange-400" />
                    <span>Absence & Sickness Reviews</span>
                  </div>
                  <div className="text-[11px] text-muted">
                    Outcomes when unauthorized absence or sickness reports are reviewed.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={notifAbsences}
                  onChange={(e) => setNotifAbsences(e.target.checked)}
                  className="mt-0.5 rounded border-line bg-surface text-indigo-600 focus:ring-0"
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Section: Employee Email Directory */}
      <div className="glass-panel rounded-2xl p-5 border border-line space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-line pb-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-text">
                Employee Email Directory
              </h2>
              <Badge tone={configuredCount === employees.length ? 'brand' : 'muted'} size="sm">
                {configuredCount} / {employees.length} Configured
              </Badge>
            </div>
            <p className="text-xs text-muted mt-0.5">
              Verified work and personal email records for outgoing HR notifications.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, ID (PK001), email..."
              className="w-56 sm:w-64 rounded-xl border border-line bg-raised px-3 py-1.5 text-xs text-text placeholder-dim focus:border-brand focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="text-xs text-muted hover:text-text cursor-pointer p-1"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {filteredEmployees.length === 0 ? (
          <Empty>No employees found matching &quot;{search}&quot;</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wider text-muted font-bold">
                  <th className="py-2.5 px-3">Employee ID</th>
                  <th className="py-2.5 px-3">Employee Name</th>
                  <th className="py-2.5 px-3">Role</th>
                  <th className="py-2.5 px-3">Official Work Email</th>
                  <th className="py-2.5 px-3">Personal Email</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {filteredEmployees.map((emp) => {
                  const hasWorkEmail = Boolean(emp.workEmail && emp.workEmail.includes('@'));

                  return (
                    <tr key={emp.id} className="hover:bg-raised/40 transition">
                      <td className="py-2.5 px-3 font-mono font-bold text-indigo-300">
                        {emp.employeeNumber || '—'}
                      </td>
                      <td className="py-2.5 px-3 font-bold text-text">
                        {emp.name}
                      </td>
                      <td className="py-2.5 px-3 text-muted">
                        {emp.role}
                      </td>
                      <td className="py-2.5 px-3">
                        {hasWorkEmail ? (
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-emerald-400 font-medium">
                              {emp.workEmail}
                            </span>
                            <span className="rounded bg-emerald-500/20 px-1.5 py-0.2 text-[9px] font-bold text-emerald-300 border border-emerald-500/30">
                              Active
                            </span>
                          </div>
                        ) : (
                          <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-500/30">
                            Missing Work Email
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-muted text-[11px]">
                        {emp.personalEmail || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <button
                          type="button"
                          onClick={() => openEditEmployee(emp)}
                          className="text-[11px] font-bold text-indigo-400 hover:text-indigo-300 hover:underline cursor-pointer"
                        >
                          Edit Email
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

      {/* Edit Employee Email Modal */}
      {editingEmployee && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6 overflow-y-auto">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h3 className="text-base font-bold text-text flex items-center gap-2">
                  <span>Update Employee Email</span>
                  {editingEmployee.employeeNumber && (
                    <Badge tone="brand" size="sm">
                      {editingEmployee.employeeNumber}
                    </Badge>
                  )}
                </h3>
                <p className="mt-0.5 text-xs text-muted">
                  {editingEmployee.name} · {editingEmployee.role}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingEmployee(null)}
                className="text-muted hover:text-text cursor-pointer p-1"
                aria-label="Close modal"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            {editEmpError && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                {editEmpError}
              </div>
            )}

            <div className="space-y-3.5 text-xs">
              <div>
                <label className="block text-muted font-semibold mb-1">
                  Official Work Email (Used for Notifications)
                </label>
                <input
                  type="email"
                  value={editWorkEmail}
                  onChange={(e) => setEditWorkEmail(e.target.value)}
                  placeholder="name@forgottenwomen.org"
                  className="w-full rounded-xl border border-line bg-raised px-3 py-2 text-text font-mono placeholder-dim focus:border-brand focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-muted font-semibold mb-1">
                  Personal Backup Email
                </label>
                <input
                  type="email"
                  value={editPersonalEmail}
                  onChange={(e) => setEditPersonalEmail(e.target.value)}
                  placeholder="personal@gmail.com"
                  className="w-full rounded-xl border border-line bg-raised px-3 py-2 text-text font-mono placeholder-dim focus:border-brand focus:outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-line pt-3">
              <Button
                variant="ghost"
                onClick={() => setEditingEmployee(null)}
                disabled={savingEmployee}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSaveEmployeeEmail}
                disabled={savingEmployee}
                className="text-xs font-bold"
              >
                {savingEmployee ? 'Saving…' : 'Save Email Changes'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
