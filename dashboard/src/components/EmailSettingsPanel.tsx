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

  // Delivery Method: 'oauth' (1-click Microsoft 365) vs 'smtp'
  const [deliveryMethod, setDeliveryMethod] = useState<'oauth' | 'smtp'>('oauth');
  const [emailEnabled, setEmailEnabled] = useState(false);

  // Microsoft OAuth 2.0 (Azure AD / Entra ID)
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [oauthTenantId, setOauthTenantId] = useState('common');
  const [oauthAccountEmail, setOauthAccountEmail] = useState('');
  const [oauthAccountName, setOauthAccountName] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [copiedRedirect, setCopiedRedirect] = useState(false);

  // Standard SMTP Configuration
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

  const redirectUri = 'https://api.fwtracker.tech/api/admin/email/microsoft/callback';

  const loadData = async () => {
    setLoading(true);
    setSaveError(null);
    try {
      const [settingsRes, empsRes] = await Promise.all([
        api.getSettings(),
        api.employees(),
      ]);

      const s = settingsRes.settings || {};
      const method = (s['email_delivery_method'] || (s['email_oauth_refresh_token'] ? 'oauth' : 'smtp')) as 'oauth' | 'smtp';
      setDeliveryMethod(method);
      setEmailEnabled(s['email_notifications_enabled'] === '1');

      // OAuth
      setOauthClientId(s['email_oauth_client_id'] || '');
      setOauthClientSecret(s['email_oauth_client_secret'] || '');
      setOauthTenantId(s['email_oauth_tenant_id'] || 'common');
      setOauthAccountEmail(s['email_oauth_account_email'] || '');
      setOauthAccountName(s['email_oauth_account_name'] || '');

      // SMTP
      setSmtpHost(s['email_smtp_host'] || 'smtp.office365.com');
      setSmtpPort(s['email_smtp_port'] || '587');
      setSmtpSecure(s['email_smtp_secure'] === '1');
      setSmtpUser(s['email_smtp_user'] || '');
      setSmtpPass(s['email_smtp_pass'] || '');
      setFromName(s['email_from_name'] || 'Forgotten Women HR');
      setFromAddress(s['email_from_address'] || s['email_oauth_account_email'] || s['email_smtp_user'] || 'hr@forgottenwomen.org');

      // Toggles
      setNotifFormalWarnings(s['email_notif_formal_warnings'] !== '0');
      setNotifLateWarnings(s['email_notif_late_warnings'] !== '0');
      setNotifLeaveDecisions(s['email_notif_leave_decisions'] !== '0');
      setNotifLeaveRecorded(s['email_notif_leave_recorded'] !== '0');
      setNotifCorrections(s['email_notif_corrections'] !== '0');
      setNotifDocuments(s['email_notif_documents'] !== '0');
      setNotifAbsences(s['email_notif_absences'] !== '0');

      if (!testRecipient) {
        setTestRecipient(s['email_oauth_account_email'] || s['email_smtp_user'] || 'hr@forgottenwomen.org');
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

    // Check URL parameters for OAuth redirect outcomes
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const oauthStatus = params.get('ms_oauth');
      const email = params.get('email');
      const err = params.get('error');

      if (oauthStatus === 'success') {
        setSaveSuccess(`Microsoft 365 connected successfully as ${email || 'authorized user'}! 1-click email delivery is active.`);
        window.history.replaceState({}, document.title, window.location.pathname + '?tab=settings');
      } else if (oauthStatus === 'error') {
        setSaveError(`Microsoft 365 connection failed: ${err || 'Authentication cancelled or refused.'}`);
        window.history.replaceState({}, document.title, window.location.pathname + '?tab=settings');
      }
    }
  }, []);

  const handleCopyRedirect = () => {
    navigator.clipboard.writeText(redirectUri);
    setCopiedRedirect(true);
    setTimeout(() => setCopiedRedirect(false), 2500);
  };

  const handleSignInWithMicrosoft = async () => {
    if (!oauthClientId.trim()) {
      alert('Please enter your Azure Application (Client) ID before connecting.');
      return;
    }
    if (!oauthClientSecret.trim()) {
      alert('Please enter your Azure Client Secret before connecting.');
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      // 1. Save Azure credentials
      await api.updateSettingsBatch({
        email_oauth_client_id: oauthClientId.trim(),
        email_oauth_client_secret: oauthClientSecret.trim(),
        email_oauth_tenant_id: oauthTenantId.trim() || 'common',
      });

      // 2. Fetch Microsoft OAuth authorization URL
      const res = await api.getMicrosoftAuthUrl(redirectUri);
      if (res.url) {
        // 3. Redirect to Microsoft Single Sign-On
        window.location.href = res.url;
      } else {
        throw new Error('Server did not return a valid Microsoft OAuth URL.');
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not initialize Microsoft login.');
      setSaving(false);
    }
  };

  const handleDisconnectMicrosoft = async () => {
    if (!window.confirm(`Disconnect Microsoft 365 account (${oauthAccountEmail})? Automated emails will pause until reconnected.`)) {
      return;
    }
    setSaving(true);
    try {
      await api.disconnectMicrosoftOAuth();
      setOauthAccountEmail('');
      setOauthAccountName('');
      setSaveSuccess('Microsoft 365 account disconnected.');
      await loadData();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to disconnect account.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const payload: Record<string, string> = {
        email_notifications_enabled: emailEnabled ? '1' : '0',
        email_delivery_method: deliveryMethod,
        email_oauth_client_id: oauthClientId.trim(),
        email_oauth_client_secret: oauthClientSecret.trim(),
        email_oauth_tenant_id: oauthTenantId.trim() || 'common',
        email_smtp_host: smtpHost.trim(),
        email_smtp_port: smtpPort.trim(),
        email_smtp_secure: smtpSecure ? '1' : '0',
        email_smtp_user: smtpUser.trim(),
        email_smtp_pass: smtpPass.trim(),
        email_from_name: fromName.trim(),
        email_from_address: fromAddress.trim() || oauthAccountEmail.trim() || smtpUser.trim(),
        email_notif_formal_warnings: notifFormalWarnings ? '1' : '0',
        email_notif_late_warnings: notifLateWarnings ? '1' : '0',
        email_notif_leave_decisions: notifLeaveDecisions ? '1' : '0',
        email_notif_leave_recorded: notifLeaveRecorded ? '1' : '0',
        email_notif_corrections: notifCorrections ? '1' : '0',
        email_notif_documents: notifDocuments ? '1' : '0',
        email_notif_absences: notifAbsences ? '1' : '0',
      };

      await api.updateSettingsBatch(payload);
      setSaveSuccess('Email notification configuration saved successfully!');
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
        deliveryMethod,
        smtpHost: smtpHost.trim(),
        smtpPort: smtpPort.trim(),
        smtpSecure: smtpSecure,
        smtpUser: smtpUser.trim(),
        smtpPass: smtpPass.trim(),
        fromName: fromName.trim(),
        fromAddress: fromAddress.trim() || oauthAccountEmail.trim() || smtpUser.trim(),
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
  const isOauthConnected = Boolean(oauthAccountEmail);

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
                <Badge tone={emailEnabled ? 'brand' : 'muted'}>
                  {emailEnabled ? 'Notifications Active' : 'Notifications Paused'}
                </Badge>
                {isOauthConnected && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                    Microsoft 365 Connected
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">
                One-click Microsoft 365 Single Sign-On, automated email dispatches for HR updates, warnings, and directory management.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={loadData}
              disabled={loading || saving}
              className="text-xs"
            >
              Refresh
            </Button>
            <Button
              onClick={handleSaveSettings}
              disabled={saving}
              className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4"
            >
              {saving ? 'Saving…' : 'Save Settings'}
            </Button>
          </div>
        </div>
      </div>

      {/* Status Banners */}
      {saveSuccess && (
        <div className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs text-emerald-300">
          <div className="flex items-center gap-2">
            <CheckCircleIcon className="h-4 w-4 shrink-0" />
            <span>{saveSuccess}</span>
          </div>
          <button onClick={() => setSaveSuccess(null)} className="text-emerald-400 hover:text-white">
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {saveError && (
        <div className="flex items-center justify-between rounded-xl border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-300">
          <div className="flex items-center gap-2">
            <AlertTriangleIcon className="h-4 w-4 shrink-0" />
            <span>{saveError}</span>
          </div>
          <button onClick={() => setSaveError(null)} className="text-rose-400 hover:text-white">
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Main Grid: Auth Method on Left, Toggles & Test on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Integration Cards */}
        <div className="lg:col-span-7 space-y-6">
          {/* Master Switch & Delivery Mode Selector */}
          <Panel title="Email Delivery Method">
            <div className="space-y-4">
              {/* Master Enabled Switch */}
              <div className="flex items-center justify-between rounded-xl border border-line bg-surface/50 p-3.5">
                <div>
                  <div className="text-sm font-bold text-text">Send Outbound Email Notifications</div>
                  <div className="text-xs text-muted">
                    When enabled, employees will receive email alerts for approved leaves, warnings, and notices.
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={emailEnabled}
                    onChange={(e) => setEmailEnabled(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                </label>
              </div>

              {/* Delivery Tabs */}
              <div className="flex items-center gap-2 p-1 rounded-xl bg-raised border border-line">
                <button
                  type="button"
                  onClick={() => setDeliveryMethod('oauth')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-bold transition ${
                    deliveryMethod === 'oauth'
                      ? 'bg-accent-gradient text-on-accent shadow-accent'
                      : 'text-muted hover:text-text hover:bg-white/5'
                  }`}
                >
                  {/* Official Microsoft 4-square icon */}
                  <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 21 21">
                    <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                    <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                  </svg>
                  <span>1-Click Microsoft 365 (OAuth)</span>
                  {isOauthConnected && (
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setDeliveryMethod('smtp')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-bold transition ${
                    deliveryMethod === 'smtp'
                      ? 'bg-accent-gradient text-on-accent shadow-accent'
                      : 'text-muted hover:text-text hover:bg-white/5'
                  }`}
                >
                  <MailIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>Standard SMTP Gateway</span>
                </button>
              </div>
            </div>
          </Panel>

          {/* METHOD 1: Microsoft 365 OAuth 2.0 (1-Click Login) */}
          {deliveryMethod === 'oauth' && (
            <Panel title="Microsoft 365 Single Sign-On (OAuth 2.0)">
              <div className="space-y-4">
                {isOauthConnected ? (
                  /* Connected State */
                  <div className="rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-950/20 via-surface to-surface p-5 space-y-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/5 border border-emerald-500/30 p-2.5">
                          <svg className="h-full w-full" viewBox="0 0 21 21">
                            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                          </svg>
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-extrabold text-sm text-text">{oauthAccountName || 'Microsoft 365 Mailbox'}</h3>
                            <span className="rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.2 text-[10px] font-bold">
                              Connected
                            </span>
                          </div>
                          <div className="font-mono text-xs text-indigo-300 font-semibold mt-0.5">
                            {oauthAccountEmail}
                          </div>
                          <div className="text-[11px] text-muted mt-1">
                            Authorized via official Microsoft Graph API. Outbound emails are sent directly through your Microsoft 365 mailbox with zero passwords stored.
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 pt-2 border-t border-line">
                      <Button
                        variant="secondary"
                        onClick={handleSignInWithMicrosoft}
                        disabled={saving}
                        className="text-xs"
                      >
                        Re-authenticate / Switch Account
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={handleDisconnectMicrosoft}
                        disabled={saving}
                        className="text-xs border-rose-500/40 text-rose-300 hover:bg-rose-500/10 hover:text-white"
                      >
                        Disconnect Account
                      </Button>
                    </div>
                  </div>
                ) : (
                  /* Not Connected State - 1-Click Login CTA */
                  <div className="rounded-2xl border border-indigo-500/30 bg-raised/40 p-5 space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 border border-white/10 p-2">
                        <svg className="h-full w-full" viewBox="0 0 21 21">
                          <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                          <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                          <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                          <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                        </svg>
                      </div>
                      <div>
                        <h3 className="font-bold text-sm text-text">Connect Microsoft 365 Account</h3>
                        <p className="text-xs text-muted">
                          Log in directly with your current Microsoft 365 browser session. No App Password needed.
                        </p>
                      </div>
                    </div>

                    {/* Azure App Registration Credentials */}
                    <div className="space-y-3 pt-2">
                      <div>
                        <label className="text-xs font-semibold text-text block mb-1">
                          Azure Application (Client) ID <span className="text-rose-400">*</span>
                        </label>
                        <input
                          type="text"
                          value={oauthClientId}
                          onChange={(e) => setOauthClientId(e.target.value)}
                          placeholder="e.g. 11111111-2222-3333-4444-555555555555"
                          className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs font-mono text-text focus:border-indigo-500 focus:outline-none"
                        />
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="text-xs font-semibold text-text">
                            Azure Client Secret <span className="text-rose-400">*</span>
                          </label>
                          <button
                            type="button"
                            onClick={() => setShowSecret(!showSecret)}
                            className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
                          >
                            {showSecret ? 'Hide Secret' : 'Show Secret'}
                          </button>
                        </div>
                        <input
                          type={showSecret ? 'text' : 'password'}
                          value={oauthClientSecret}
                          onChange={(e) => setOauthClientSecret(e.target.value)}
                          placeholder="Paste client secret value from Azure Certificates & secrets"
                          className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs font-mono text-text focus:border-indigo-500 focus:outline-none"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="text-xs font-semibold text-text">
                              Directory (Tenant) ID
                            </label>
                            <span className="text-[10px] text-amber-300 font-medium">
                              Required for Single-Tenant
                            </span>
                          </div>
                          <input
                            type="text"
                            value={oauthTenantId}
                            onChange={(e) => setOauthTenantId(e.target.value)}
                            placeholder="e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx or domain"
                            className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs font-mono text-text focus:border-indigo-500 focus:outline-none"
                          />
                          <p className="text-[10px] text-muted mt-1">
                            Found directly beneath Client ID on your Azure App Overview page.
                          </p>
                        </div>

                        <div>
                          <label className="text-xs font-semibold text-text block mb-1">
                            Sender Display Name
                          </label>
                          <input
                            type="text"
                            value={fromName}
                            onChange={(e) => setFromName(e.target.value)}
                            placeholder="Forgotten Women HR"
                            className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs text-text focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                      </div>

                      {oauthTenantId === 'common' && (
                        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] text-amber-300 flex items-start gap-2">
                          <AlertTriangleIcon className="h-4 w-4 shrink-0 mt-0.5" />
                          <span>
                            If your Azure app was created as <em>Single Tenant</em>, replace <code>common</code> with your <strong>Directory (tenant) ID</strong> (found on your Azure App Overview page) to avoid Microsoft error AADSTS50194.
                          </span>
                        </div>
                      )}

                      {/* Callback URL Card */}
                      <div className="rounded-xl border border-line bg-surface/70 p-3 text-xs space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-dim text-[11px] uppercase tracking-wider">
                            Redirect URI in Azure App:
                          </span>
                          <button
                            type="button"
                            onClick={handleCopyRedirect}
                            className="text-indigo-400 hover:text-white font-medium text-[11px]"
                          >
                            {copiedRedirect ? '✓ Copied' : 'Copy URL'}
                          </button>
                        </div>
                        <div className="font-mono text-[11px] text-indigo-300 break-all select-all">
                          {redirectUri}
                        </div>
                        <div className="text-[10px] text-dim">
                          Paste this exact Web redirect URI into Azure Portal &gt; App registrations &gt; Authentication.
                        </div>
                      </div>
                    </div>

                    {/* Official Big Sign In Button */}
                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={handleSignInWithMicrosoft}
                        disabled={saving}
                        className="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl font-bold text-sm bg-[#2f2f2f] hover:bg-[#1f1f1f] border border-white/20 text-white shadow-lg transition cursor-pointer"
                      >
                        <svg className="h-5 w-5 shrink-0" viewBox="0 0 21 21">
                          <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                          <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                          <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                          <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                        </svg>
                        <span>{saving ? 'Opening Microsoft Login…' : 'Sign in with Microsoft'}</span>
                      </button>
                      <p className="mt-2 text-center text-[11px] text-muted">
                        Connects with your currently logged-in account in one click. No password typing required.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </Panel>
          )}

          {/* METHOD 2: Standard SMTP Gateway */}
          {deliveryMethod === 'smtp' && (
            <Panel title="Microsoft 365 / Standard SMTP Gateway">
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <label className="text-xs font-semibold text-text block mb-1">
                      SMTP Host
                    </label>
                    <input
                      type="text"
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                      placeholder="smtp.office365.com"
                      className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs font-mono text-text focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-text block mb-1">
                      Port
                    </label>
                    <input
                      type="text"
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(e.target.value)}
                      placeholder="587"
                      className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs font-mono text-text focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="smtpSecure"
                    checked={smtpSecure}
                    onChange={(e) => setSmtpSecure(e.target.checked)}
                    className="rounded border-line bg-surface text-indigo-600 focus:ring-0"
                  />
                  <label htmlFor="smtpSecure" className="text-xs text-text cursor-pointer">
                    Use Direct SSL (Port 465). Leave unchecked for Port 587 (STARTTLS, recommended for Microsoft 365).
                  </label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-text block mb-1">
                      SMTP Username / Email
                    </label>
                    <input
                      type="text"
                      value={smtpUser}
                      onChange={(e) => setSmtpUser(e.target.value)}
                      placeholder="hr@forgottenwomen.org"
                      className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs text-text focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-text">
                        SMTP Password / App Password
                      </label>
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={smtpPass}
                      onChange={(e) => setSmtpPass(e.target.value)}
                      placeholder="••••••••••••••••"
                      className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs font-mono text-text focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-text block mb-1">
                      From Display Name
                    </label>
                    <input
                      type="text"
                      value={fromName}
                      onChange={(e) => setFromName(e.target.value)}
                      placeholder="Forgotten Women HR"
                      className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs text-text focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-text block mb-1">
                      From Email Address
                    </label>
                    <input
                      type="text"
                      value={fromAddress}
                      onChange={(e) => setFromAddress(e.target.value)}
                      placeholder="hr@forgottenwomen.org"
                      className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs text-text focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            </Panel>
          )}

          {/* Test Connection Card */}
          <Panel title="Test Connection & Verify Delivery">
            <div className="space-y-3">
              <p className="text-xs text-muted">
                Send a real test email to verify credentials and ensure deliverability before turning on automated notifications.
              </p>

              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <input
                  type="email"
                  value={testRecipient}
                  onChange={(e) => setTestRecipient(e.target.value)}
                  placeholder="Enter recipient email (e.g. your email address)"
                  className="flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-xs text-text focus:border-indigo-500 focus:outline-none"
                />
                <Button
                  onClick={handleTestEmail}
                  disabled={testing}
                  className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-2 px-4 shrink-0"
                >
                  {testing ? 'Testing…' : 'Send Test Email'}
                </Button>
              </div>

              {testResult && (
                <div
                  className={`rounded-xl border p-3 text-xs ${
                    testResult.status === 'SUCCESS'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {testResult.status === 'SUCCESS' ? (
                      <CheckCircleIcon className="h-4 w-4 shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangleIcon className="h-4 w-4 shrink-0 mt-0.5" />
                    )}
                    <div className="space-y-1">
                      <div className="font-bold">
                        {testResult.status === 'SUCCESS' ? 'Connection Succeeded' : 'Connection Failed'}
                      </div>
                      <div className="text-[11px] leading-relaxed break-all font-mono">
                        {testResult.message}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Panel>
        </div>

        {/* Right Column: Notification Category Toggles */}
        <div className="lg:col-span-5 space-y-6">
          <Panel title="Automated Event Toggles">
            <div className="space-y-3">
              <p className="text-xs text-muted">
                Choose which system events automatically trigger an email to the affected employee.
              </p>

              <div className="space-y-2">
                {/* 1. Formal Warnings */}
                <div className="flex items-center justify-between rounded-xl border border-line bg-surface/50 p-3">
                  <div>
                    <div className="text-xs font-bold text-text">Formal Warnings</div>
                    <div className="text-[10px] text-muted">Written warnings, escalations &amp; review triggers</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={notifFormalWarnings}
                    onChange={(e) => setNotifFormalWarnings(e.target.checked)}
                    className="rounded border-line bg-surface text-indigo-600 focus:ring-0"
                  />
                </div>

                {/* 2. Late Warnings */}
                <div className="flex items-center justify-between rounded-xl border border-line bg-surface/50 p-3">
                  <div>
                    <div className="text-xs font-bold text-text">Late Attendance Warnings</div>
                    <div className="text-[10px] text-muted">Exceeded monthly late allowances &amp; triggers</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={notifLateWarnings}
                    onChange={(e) => setNotifLateWarnings(e.target.checked)}
                    className="rounded border-line bg-surface text-indigo-600 focus:ring-0"
                  />
                </div>

                {/* 3. Leave Approvals & Rejections */}
                <div className="flex items-center justify-between rounded-xl border border-line bg-surface/50 p-3">
                  <div>
                    <div className="text-xs font-bold text-text">Leave Decisions</div>
                    <div className="text-[10px] text-muted">Approved or rejected employee leave requests</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={notifLeaveDecisions}
                    onChange={(e) => setNotifLeaveDecisions(e.target.checked)}
                    className="rounded border-line bg-surface text-indigo-600 focus:ring-0"
                  />
                </div>

                {/* 4. HR Direct Leave Recorded */}
                <div className="flex items-center justify-between rounded-xl border border-line bg-surface/50 p-3">
                  <div>
                    <div className="text-xs font-bold text-text">HR Direct Leave</div>
                    <div className="text-[10px] text-muted">When HR registers leave directly on an employee profile</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={notifLeaveRecorded}
                    onChange={(e) => setNotifLeaveRecorded(e.target.checked)}
                    className="rounded border-line bg-surface text-indigo-600 focus:ring-0"
                  />
                </div>

                {/* 5. Attendance Corrections */}
                <div className="flex items-center justify-between rounded-xl border border-line bg-surface/50 p-3">
                  <div>
                    <div className="text-xs font-bold text-text">Attendance Corrections</div>
                    <div className="text-[10px] text-muted">Manual timesheet fixes &amp; approved disputes</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={notifCorrections}
                    onChange={(e) => setNotifCorrections(e.target.checked)}
                    className="rounded border-line bg-surface text-indigo-600 focus:ring-0"
                  />
                </div>

                {/* 6. Document Expiry Alerts */}
                <div className="flex items-center justify-between rounded-xl border border-line bg-surface/50 p-3">
                  <div>
                    <div className="text-xs font-bold text-text">Employee Documents / KYC</div>
                    <div className="text-[10px] text-muted">Expiring ID, contracts &amp; probation reviews</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={notifDocuments}
                    onChange={(e) => setNotifDocuments(e.target.checked)}
                    className="rounded border-line bg-surface text-indigo-600 focus:ring-0"
                  />
                </div>

                {/* 7. Absence Reviews */}
                <div className="flex items-center justify-between rounded-xl border border-line bg-surface/50 p-3">
                  <div>
                    <div className="text-xs font-bold text-text">Absence Reviews</div>
                    <div className="text-[10px] text-muted">Self-reported sickness &amp; HR determinations</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={notifAbsences}
                    onChange={(e) => setNotifAbsences(e.target.checked)}
                    className="rounded border-line bg-surface text-indigo-600 focus:ring-0"
                  />
                </div>
              </div>
            </div>
          </Panel>
        </div>
      </div>

      {/* Bottom Section: Employee Email Directory */}
      <Panel title={`Employee Email Directory (${configuredCount}/${employees.length} Configured)`}>
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <p className="text-xs text-muted">
              Notifications are delivered to the employee&apos;s official work email, with personal email used as fallback.
            </p>
            <div className="w-full sm:w-72">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search employee by name, code or email…"
                className="w-full rounded-xl border border-line bg-surface px-3 py-1.5 text-xs text-text focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-line bg-surface/40">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line bg-raised/50 text-[11px] font-bold uppercase tracking-wider text-dim">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Work Email (Primary)</th>
                  <th className="px-4 py-3">Personal Email (Backup)</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {filteredEmployees.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-muted">
                      No employees matched your search.
                    </td>
                  </tr>
                ) : (
                  filteredEmployees.map((emp) => (
                    <tr key={emp.id} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-3 font-semibold text-text">
                        <div className="flex items-center gap-2">
                          <span>{emp.name}</span>
                          {emp.employeeNumber && (
                            <span className="rounded bg-indigo-500/20 px-1.5 py-0.2 font-mono text-[10px] font-bold text-indigo-300 border border-indigo-500/30">
                              {emp.employeeNumber}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-dim">{emp.role}</td>
                      <td className="px-4 py-3 font-mono">
                        {emp.workEmail ? (
                          <span className="text-indigo-300 font-medium">{emp.workEmail}</span>
                        ) : (
                          <span className="text-rose-400 italic text-[11px]">No work email</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-dim">
                        {emp.personalEmail || '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="secondary"
                          onClick={() => openEditEmployee(emp)}
                          className="py-1 px-2.5 text-[11px]"
                        >
                          Edit Email
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>

      {/* Edit Employee Email Modal */}
      {editingEmployee && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl space-y-4 text-text">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h3 className="font-bold text-sm">Edit Employee Email</h3>
                <p className="text-xs text-muted">
                  {editingEmployee.name} ({editingEmployee.employeeNumber || editingEmployee.id})
                </p>
              </div>
              <button
                onClick={() => setEditingEmployee(null)}
                className="text-muted hover:text-white"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            {editEmpError && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                {editEmpError}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-text block mb-1">
                  Work Email (Primary notification inbox)
                </label>
                <input
                  type="email"
                  value={editWorkEmail}
                  onChange={(e) => setEditWorkEmail(e.target.value)}
                  placeholder="e.g. employee@forgottenwomen.org"
                  className="w-full rounded-xl border border-line bg-raised px-3 py-2 text-xs font-mono text-text focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-text block mb-1">
                  Personal Email (Backup notification inbox)
                </label>
                <input
                  type="email"
                  value={editPersonalEmail}
                  onChange={(e) => setEditPersonalEmail(e.target.value)}
                  placeholder="e.g. personal@gmail.com"
                  className="w-full rounded-xl border border-line bg-raised px-3 py-2 text-xs font-mono text-text focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
              <Button
                variant="secondary"
                onClick={() => setEditingEmployee(null)}
                disabled={savingEmployee}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveEmployeeEmail}
                disabled={savingEmployee}
                className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4"
              >
                {savingEmployee ? 'Saving…' : 'Save Changes'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
