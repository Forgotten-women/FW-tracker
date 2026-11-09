// Automated Email & Microsoft 365 Notification Dispatcher.
//
// Sends targeted, branded emails to employees for HR updates, formal warnings,
// attendance/lateness notices, leave approvals/rejections, and KYC documents.
// Supports both Microsoft 365 OAuth 2.0 (Microsoft Graph API) and standard SMTP.

const nodemailer = require('nodemailer');
const { db, tx } = require('../db');

/**
 * Retrieves the current email configuration from org_settings.
 */
async function getEmailConfig() {
  try {
    const rows = await db.prepare("SELECT key, value FROM org_settings WHERE key LIKE 'email_%'").all();
    const map = {};
    for (const r of rows) map[r.key] = r.value;

    return {
      enabled: map['email_notifications_enabled'] === '1' || process.env.EMAIL_NOTIFICATIONS_ENABLED === '1',
      deliveryMethod: map['email_delivery_method'] || process.env.EMAIL_DELIVERY_METHOD || 'smtp', // 'oauth' | 'smtp'
      
      // Microsoft OAuth 2.0 / Graph API
      oauthClientId: map['email_oauth_client_id'] || process.env.AZURE_CLIENT_ID || '',
      oauthClientSecret: map['email_oauth_client_secret'] || process.env.AZURE_CLIENT_SECRET || '',
      oauthTenantId: map['email_oauth_tenant_id'] || process.env.AZURE_TENANT_ID || 'common',
      oauthRefreshToken: map['email_oauth_refresh_token'] || '',
      oauthAccessToken: map['email_oauth_access_token'] || '',
      oauthTokenExpiry: parseInt(map['email_oauth_token_expiry'] || '0', 10),
      oauthAccountEmail: map['email_oauth_account_email'] || '',
      oauthAccountName: map['email_oauth_account_name'] || '',

      // Standard SMTP
      smtpHost: map['email_smtp_host'] || process.env.SMTP_HOST || 'smtp.office365.com',
      smtpPort: parseInt(map['email_smtp_port'] || process.env.SMTP_PORT || '587', 10),
      smtpSecure: map['email_smtp_secure'] === '1' || process.env.SMTP_SECURE === '1',
      smtpUser: map['email_smtp_user'] || process.env.SMTP_USER || '',
      smtpPass: map['email_smtp_pass'] || process.env.SMTP_PASS || '',
      fromName: map['email_from_name'] || process.env.EMAIL_FROM_NAME || 'Forgotten Women HR',
      fromAddress: map['email_from_address'] || map['email_oauth_account_email'] || map['email_smtp_user'] || process.env.SMTP_FROM || 'hr@forgottenwomen.org',
      
      // Category Toggles
      notifFormalWarnings: map['email_notif_formal_warnings'] !== '0',
      notifLateWarnings: map['email_notif_late_warnings'] !== '0',
      notifLeaveDecisions: map['email_notif_leave_decisions'] !== '0',
      notifLeaveRecorded: map['email_notif_leave_recorded'] !== '0',
      notifCorrections: map['email_notif_corrections'] !== '0',
      notifDocuments: map['email_notif_documents'] !== '0',
      notifAbsences: map['email_notif_absences'] !== '0',
    };
  } catch (err) {
    console.warn('[mailer] Error loading email config from DB, using fallback:', err.message);
    return {
      enabled: process.env.EMAIL_NOTIFICATIONS_ENABLED === '1',
      deliveryMethod: 'smtp',
      oauthClientId: process.env.AZURE_CLIENT_ID || '',
      oauthClientSecret: process.env.AZURE_CLIENT_SECRET || '',
      oauthTenantId: process.env.AZURE_TENANT_ID || 'common',
      oauthRefreshToken: '',
      oauthAccessToken: '',
      oauthTokenExpiry: 0,
      oauthAccountEmail: '',
      oauthAccountName: '',
      smtpHost: process.env.SMTP_HOST || 'smtp.office365.com',
      smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
      smtpSecure: process.env.SMTP_SECURE === '1',
      smtpUser: process.env.SMTP_USER || '',
      smtpPass: process.env.SMTP_PASS || '',
      fromName: process.env.EMAIL_FROM_NAME || 'Forgotten Women HR',
      fromAddress: process.env.SMTP_FROM || 'hr@forgottenwomen.org',
      notifFormalWarnings: true,
      notifLateWarnings: true,
      notifLeaveDecisions: true,
      notifLeaveRecorded: true,
      notifCorrections: true,
      notifDocuments: true,
      notifAbsences: true,
    };
  }
}

/**
 * Creates a nodemailer transport instance given configuration.
 */
function createTransporter(cfg) {
  if (!cfg.smtpUser || !cfg.smtpPass) {
    return null;
  }

  const isExplicitPort465 = cfg.smtpPort === 465;
  const isSecure = cfg.smtpSecure || isExplicitPort465;

  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: isSecure,
    auth: {
      user: cfg.smtpUser,
      pass: cfg.smtpPass,
    },
    tls: {
      ciphers: 'SSLv3',
      rejectUnauthorized: false,
    },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
  });
}

/**
 * Generates Microsoft OAuth 2.0 authorization URL.
 */
async function getMicrosoftAuthUrl(redirectUri, state) {
  const cfg = await getEmailConfig();
  if (!cfg.oauthClientId) {
    throw new Error('Azure Application (Client) ID is required. Please enter it in the settings panel.');
  }

  const tenant = cfg.oauthTenantId || 'common';
  const scopes = 'offline_access User.Read Mail.Send';
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?client_id=${encodeURIComponent(cfg.oauthClientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&response_mode=query&scope=${encodeURIComponent(scopes)}&prompt=select_account&state=${encodeURIComponent(state)}`;

  return url;
}

/**
 * Exchanges Microsoft OAuth authorization code for tokens and user profile.
 */
async function handleMicrosoftOAuthCallback(code, redirectUri) {
  const cfg = await getEmailConfig();
  if (!cfg.oauthClientId) {
    throw new Error('Azure Application (Client) ID is not configured.');
  }
  if (!cfg.oauthClientSecret) {
    throw new Error('Azure Client Secret is not configured.');
  }

  const tenant = cfg.oauthTenantId || 'common';
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id: cfg.oauthClientId,
    client_secret: cfg.oauthClientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    scope: 'offline_access User.Read Mail.Send',
  });

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text();
    let errMsg = `Token exchange failed (HTTP ${tokenRes.status})`;
    try {
      const parsed = JSON.parse(errBody);
      errMsg = parsed.error_description || parsed.error || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;
  const expiresIn = tokenData.expires_in || 3600;
  const expiryMs = Date.now() + Math.max(0, (expiresIn - 120) * 1000);

  // Fetch signed in user profile from Microsoft Graph
  let accountEmail = '';
  let accountName = '';
  try {
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (meRes.ok) {
      const meData = await meRes.json();
      accountEmail = meData.mail || meData.userPrincipalName || '';
      accountName = meData.displayName || '';
    }
  } catch (err) {
    console.warn('[mailer] Could not fetch Graph profile:', err.message);
  }

  if (!accountEmail) {
    accountEmail = cfg.fromAddress || 'hr@forgottenwomen.org';
  }

  // Persist tokens and settings in org_settings
  const nowMs = Date.now();
  const updates = {
    email_delivery_method: 'oauth',
    email_oauth_refresh_token: refreshToken || '',
    email_oauth_access_token: accessToken || '',
    email_oauth_token_expiry: String(expiryMs),
    email_oauth_account_email: accountEmail,
    email_oauth_account_name: accountName,
    email_notifications_enabled: '1',
    email_from_address: accountEmail,
    email_from_name: accountName || cfg.fromName || 'Forgotten Women HR',
  };

  for (const [k, v] of Object.entries(updates)) {
    await db.prepare(`
      INSERT INTO org_settings (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, 'microsoft_oauth')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(k, String(v), nowMs);
  }

  return {
    ok: true,
    accountEmail,
    accountName,
  };
}

/**
 * Returns a valid Microsoft Graph access token, refreshing with refresh_token if needed.
 */
async function getFreshMicrosoftAccessToken() {
  const cfg = await getEmailConfig();

  if (!cfg.oauthRefreshToken) {
    throw new Error('Microsoft 365 account is not connected. Please click "Sign in with Microsoft" in Settings.');
  }

  // If token is still valid for at least 2 minutes, return it
  if (cfg.oauthAccessToken && cfg.oauthTokenExpiry && Date.now() < cfg.oauthTokenExpiry) {
    return cfg.oauthAccessToken;
  }

  // Refresh token
  const tenant = cfg.oauthTenantId || 'common';
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id: cfg.oauthClientId,
    client_secret: cfg.oauthClientSecret,
    refresh_token: cfg.oauthRefreshToken,
    grant_type: 'refresh_token',
    scope: 'offline_access User.Read Mail.Send',
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const errBody = await res.text();
    let errMsg = `Microsoft token refresh failed (HTTP ${res.status})`;
    try {
      const parsed = JSON.parse(errBody);
      errMsg = parsed.error_description || parsed.error || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const tokenData = await res.json();
  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token || cfg.oauthRefreshToken;
  const expiresIn = tokenData.expires_in || 3600;
  const expiryMs = Date.now() + Math.max(0, (expiresIn - 120) * 1000);

  const nowMs = Date.now();
  await db.prepare("UPDATE org_settings SET value = ?, updated_at = ? WHERE key = 'email_oauth_access_token'").run(accessToken, nowMs);
  await db.prepare("UPDATE org_settings SET value = ?, updated_at = ? WHERE key = 'email_oauth_token_expiry'").run(String(expiryMs), nowMs);
  if (tokenData.refresh_token) {
    await db.prepare("UPDATE org_settings SET value = ?, updated_at = ? WHERE key = 'email_oauth_refresh_token'").run(refreshToken, nowMs);
  }

  return accessToken;
}

/**
 * Dispatches an email via Microsoft Graph API (/me/sendMail).
 */
async function sendEmailViaGraph({ to, subject, html, text }) {
  const token = await getFreshMicrosoftAccessToken();

  const payload = {
    message: {
      subject,
      body: {
        contentType: 'HTML',
        content: html || `<p>${text || subject}</p>`,
      },
      toRecipients: [
        {
          emailAddress: {
            address: to,
          },
        },
      ],
    },
    saveToSentItems: true,
  };

  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok && res.status !== 202) {
    const errBody = await res.text();
    let errMsg = `Microsoft Graph sendMail failed (HTTP ${res.status})`;
    try {
      const parsed = JSON.parse(errBody);
      errMsg = parsed.error?.message || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }

  return { sent: true, messageId: `ms_graph_${Date.now()}` };
}

/**
 * Disconnects Microsoft 365 OAuth account.
 */
async function disconnectMicrosoftOAuth() {
  const nowMs = Date.now();
  const keysToClear = [
    'email_oauth_refresh_token',
    'email_oauth_access_token',
    'email_oauth_token_expiry',
    'email_oauth_account_email',
    'email_oauth_account_name',
  ];

  for (const k of keysToClear) {
    await db.prepare("UPDATE org_settings SET value = '', updated_at = ? WHERE key = ?").run(nowMs, k);
  }
  await db.prepare("UPDATE org_settings SET value = 'smtp', updated_at = ? WHERE key = 'email_delivery_method'").run(nowMs);

  return { status: 'SUCCESS' };
}

/**
 * Professional responsive HTML email template generator.
 */
function renderEmailHtml({ title, body, severity = 'info', employeeName = '', details = [] }) {
  const accentColor = severity === 'urgent'
    ? '#e11d48' // rose-600
    : severity === 'warning'
    ? '#d97706' // amber-600
    : '#4f46e5'; // indigo-600

  const badgeBg = severity === 'urgent'
    ? '#ffe4e6'
    : severity === 'warning'
    ? '#fef3c7'
    : '#e0e7ff';

  const badgeText = severity === 'urgent'
    ? '#9f1239'
    : severity === 'warning'
    ? '#92400e'
    : '#3730a3';

  const detailsRows = details && details.length > 0
    ? `
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 20px 0; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #f8fafc; font-size: 13px;">
        ${details.map(d => `
          <tr>
            <td style="padding: 10px 14px; font-weight: 600; color: #475569; width: 35%; border-bottom: 1px solid #edf2f7;">${d.label}</td>
            <td style="padding: 10px 14px; color: #0f172a; font-family: monospace; border-bottom: 1px solid #edf2f7;">${d.value}</td>
          </tr>
        `).join('')}
      </table>
    `
    : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #f1f5f9; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);">
          <!-- Header Bar -->
          <tr>
            <td style="padding: 24px 32px; background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); border-bottom: 3px solid ${accentColor};">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td valign="middle">
                    <div style="font-size: 18px; font-weight: 800; color: #ffffff; letter-spacing: -0.02em;">
                      FORGOTTEN WOMEN
                    </div>
                    <div style="font-size: 11px; font-weight: 500; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 2px;">
                      Workforce & HR Operations
                    </div>
                  </td>
                  <td align="right" valign="top">
                    <span style="display: inline-block; padding: 4px 10px; font-size: 11px; font-weight: 700; border-radius: 9999px; background-color: ${badgeBg}; color: ${badgeText}; text-transform: uppercase; letter-spacing: 0.04em;">
                      ${severity}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 28px 32px;">
              ${employeeName ? `<p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">Dear <strong>${employeeName}</strong>,</p>` : ''}
              
              <h1 style="margin: 0 0 14px 0; font-size: 18px; font-weight: 700; color: #0f172a; line-height: 1.4;">
                ${title}
              </h1>

              <div style="font-size: 14px; line-height: 1.6; color: #334155; white-space: pre-line;">
                ${body}
              </div>

              ${detailsRows}

              <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #f1f5f9; font-size: 13px; color: #64748b; line-height: 1.5;">
                Please log into your Forgotten Women employee portal or mobile app to view full details or acknowledge this update.
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 32px; background-color: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center;">
              <p style="margin: 0 0 4px 0; font-size: 11px; color: #94a3b8; font-weight: 500;">
                © ${new Date().getFullYear()} Forgotten Women / Rethink Charity. All rights reserved.
              </p>
              <p style="margin: 0; font-size: 11px; color: #cbd5e1;">
                This is an automated operational notification. Replies to this email address are routed to HR Administration.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * Sends a generic email using either Microsoft Graph API (OAuth) or SMTP transport.
 */
async function sendEmail({ to, subject, html, text }) {
  const cfg = await getEmailConfig();
  if (!cfg.enabled) {
    return { sent: false, reason: 'email_notifications_disabled' };
  }

  if (cfg.deliveryMethod === 'oauth' && cfg.oauthRefreshToken) {
    return sendEmailViaGraph({ to, subject, html, text });
  }

  const transporter = createTransporter(cfg);
  if (!transporter) {
    return { sent: false, reason: 'smtp_credentials_not_configured' };
  }

  const info = await transporter.sendMail({
    from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
    to,
    subject,
    text: text || subject,
    html: html || `<p>${text || subject}</p>`,
  });

  return { sent: true, messageId: info.messageId };
}

/**
 * Handles targeted employee notification dispatch.
 * Checks category configuration and looks up recipient work/personal email.
 */
async function sendNotificationEmail({ employeeId, category, title, body, severity = 'info' }) {
  if (!employeeId) return { sent: false, reason: 'no_employee_id' };

  const cfg = await getEmailConfig();
  if (!cfg.enabled) {
    return { sent: false, reason: 'email_notifications_disabled' };
  }

  // Check category filter
  if (category === 'WARNING') {
    const isLate = title.toLowerCase().includes('late') || title.toLowerCase().includes('lateness');
    if (isLate && !cfg.notifLateWarnings) return { sent: false, reason: 'late_warnings_email_disabled' };
    if (!isLate && !cfg.notifFormalWarnings) return { sent: false, reason: 'formal_warnings_email_disabled' };
  } else if (category === 'LEAVE') {
    const isRecorded = body.toLowerCase().includes('direct') || body.toLowerCase().includes('recorded by hr');
    if (isRecorded && !cfg.notifLeaveRecorded) return { sent: false, reason: 'leave_recorded_email_disabled' };
    if (!isRecorded && !cfg.notifLeaveDecisions) return { sent: false, reason: 'leave_decisions_email_disabled' };
  } else if (category === 'CORRECTION' && !cfg.notifCorrections) {
    return { sent: false, reason: 'corrections_email_disabled' };
  } else if (category === 'DOCUMENT' && !cfg.notifDocuments) {
    return { sent: false, reason: 'documents_email_disabled' };
  } else if (category === 'ABSENCE' && !cfg.notifAbsences) {
    return { sent: false, reason: 'absences_email_disabled' };
  }

  // Look up employee email
  const emp = await db.prepare(`
    SELECT e.id, e.name, e.employee_number, e.work_email, ep.personal_email
    FROM employees e
    LEFT JOIN employee_personal ep ON ep.employee_id = e.id
    WHERE e.id = ?
  `).get(employeeId);

  if (!emp) {
    return { sent: false, reason: 'employee_not_found' };
  }

  const recipientEmail = emp.work_email || emp.personal_email;
  if (!recipientEmail || !recipientEmail.includes('@')) {
    return { sent: false, reason: 'no_valid_email_on_file' };
  }

  const subject = `[FW HR] ${title}`;
  const details = [
    { label: 'Employee', value: `${emp.name} (${emp.employee_number || emp.id})` },
    { label: 'Category', value: category },
    { label: 'Timestamp', value: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Karachi' }) },
  ];

  const html = renderEmailHtml({
    title,
    body,
    severity,
    employeeName: emp.name,
    details,
  });

  return sendEmail({
    to: recipientEmail,
    subject,
    html,
    text: `${title}\n\n${body}\n\nEmployee: ${emp.name} (${emp.employee_number || ''})`,
  });
}

/**
 * Tests connection with custom or stored credentials and sends a test email.
 */
async function testConnection({
  to,
  deliveryMethod,
  smtpHost,
  smtpPort,
  smtpSecure,
  smtpUser,
  smtpPass,
  fromName,
  fromAddress,
}) {
  if (!to || !to.includes('@')) {
    throw new Error('A valid recipient email address is required for the test email.');
  }

  const stored = await getEmailConfig();
  const method = deliveryMethod || stored.deliveryMethod;

  // Test via Microsoft Graph API (OAuth 2.0)
  if (method === 'oauth') {
    if (!stored.oauthRefreshToken) {
      throw new Error('Microsoft 365 account is not connected yet. Please click "Sign in with Microsoft" first.');
    }

    const testSubject = '[FW Tracker] Microsoft 365 OAuth Connection Test Succeeded';
    const testHtml = renderEmailHtml({
      title: 'Microsoft 365 OAuth Connection Test Succeeded',
      body: 'Your Microsoft 365 account has been verified via OAuth 2.0 / Microsoft Graph API and is ready to send automated workforce updates, warnings, and leave notifications without passwords.',
      severity: 'info',
      employeeName: 'HR Administrator',
      details: [
        { label: 'Delivery Mode', value: 'Microsoft Graph API (OAuth 2.0)' },
        { label: 'Connected Account', value: stored.oauthAccountEmail || stored.fromAddress },
        { label: 'Account Name', value: stored.oauthAccountName || 'Microsoft 365 User' },
        { label: 'Test Delivered To', value: to },
        { label: 'Verification Time', value: new Date().toLocaleString('en-GB') },
      ],
    });

    const graphResult = await sendEmailViaGraph({
      to,
      subject: testSubject,
      html: testHtml,
      text: `Microsoft 365 OAuth Test Succeeded.\nAccount: ${stored.oauthAccountEmail}\nDelivered To: ${to}\nTime: ${new Date().toISOString()}`,
    });

    return {
      status: 'SUCCESS',
      message: `Test email successfully sent via Microsoft Graph API to ${to}. Connected account: ${stored.oauthAccountEmail}`,
      deliveryMethod: 'oauth',
      messageId: graphResult.messageId,
    };
  }

  // Otherwise, test via standard SMTP
  const cfg = {
    smtpHost: smtpHost || stored.smtpHost || 'smtp.office365.com',
    smtpPort: parseInt(smtpPort || stored.smtpPort || '587', 10),
    smtpSecure: smtpSecure !== undefined ? (smtpSecure === '1' || smtpSecure === true) : stored.smtpSecure,
    smtpUser: smtpUser !== undefined ? smtpUser : stored.smtpUser,
    smtpPass: smtpPass !== undefined ? smtpPass : stored.smtpPass,
    fromName: fromName || stored.fromName || 'Forgotten Women HR',
    fromAddress: fromAddress || stored.fromAddress || 'hr@forgottenwomen.org',
  };

  if (!cfg.smtpUser || !cfg.smtpPass) {
    throw new Error('Microsoft 365 / SMTP username and password must be configured before testing.');
  }

  const transporter = createTransporter(cfg);
  if (!transporter) {
    throw new Error('Could not initialize mail transporter with the provided credentials.');
  }

  // 1. Verify connection credentials
  await transporter.verify();

  // 2. Dispatch test email
  const info = await transporter.sendMail({
    from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
    to,
    subject: '[FW Tracker] Microsoft 365 SMTP Email Connection Test Succeeded',
    text: `Your Microsoft 365 email configuration is working successfully.\n\nHost: ${cfg.smtpHost}:${cfg.smtpPort}\nUser: ${cfg.smtpUser}\nTime: ${new Date().toISOString()}`,
    html: renderEmailHtml({
      title: 'Microsoft 365 SMTP Connection Test Succeeded',
      body: 'Your Microsoft 365 email service has been verified via SMTP and is ready to send automated workforce updates, warnings, and leave notifications.',
      severity: 'info',
      employeeName: 'HR Administrator',
      details: [
        { label: 'SMTP Host', value: `${cfg.smtpHost}:${cfg.smtpPort}` },
        { label: 'Authenticated Account', value: cfg.smtpUser },
        { label: 'Sender Address', value: cfg.fromAddress },
        { label: 'Test Delivered To', value: to },
        { label: 'Verification Time', value: new Date().toLocaleString('en-GB') },
      ],
    }),
  });

  return {
    status: 'SUCCESS',
    message: `Test email successfully sent to ${to}. Message ID: ${info.messageId}`,
    deliveryMethod: 'smtp',
    messageId: info.messageId,
  };
}

module.exports = {
  getEmailConfig,
  createTransporter,
  getMicrosoftAuthUrl,
  handleMicrosoftOAuthCallback,
  getFreshMicrosoftAccessToken,
  sendEmailViaGraph,
  disconnectMicrosoftOAuth,
  renderEmailHtml,
  sendEmail,
  sendNotificationEmail,
  testConnection,
};
