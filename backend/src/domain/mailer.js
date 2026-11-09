// Automated Email & Microsoft 365 Notification Dispatcher.
//
// Sends targeted, branded emails to employees for HR updates, formal warnings,
// attendance/lateness notices, leave approvals/rejections, and KYC documents.
// Configured via org_settings (or environment variables) for Microsoft 365 / standard SMTP.

const nodemailer = require('nodemailer');
const { db } = require('../db');

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
      smtpHost: map['email_smtp_host'] || process.env.SMTP_HOST || 'smtp.office365.com',
      smtpPort: parseInt(map['email_smtp_port'] || process.env.SMTP_PORT || '587', 10),
      smtpSecure: map['email_smtp_secure'] === '1' || process.env.SMTP_SECURE === '1',
      smtpUser: map['email_smtp_user'] || process.env.SMTP_USER || '',
      smtpPass: map['email_smtp_pass'] || process.env.SMTP_PASS || '',
      fromName: map['email_from_name'] || process.env.EMAIL_FROM_NAME || 'Forgotten Women HR',
      fromAddress: map['email_from_address'] || map['email_smtp_user'] || process.env.SMTP_FROM || 'hr@forgottenwomen.org',
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

  const detailsRows = details.length > 0
    ? `
      <table style="width: 100%; border-collapse: collapse; margin-top: 18px; margin-bottom: 18px; background-color: #f8fafc; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0;">
        ${details.map(d => `
          <tr style="border-bottom: 1px solid #e2e8f0;">
            <td style="padding: 10px 14px; font-weight: 600; color: #475569; font-size: 13px; width: 35%;">${d.label}</td>
            <td style="padding: 10px 14px; color: #0f172a; font-size: 13px; font-weight: 500;">${d.value}</td>
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
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f1f5f9; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 580px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.06); border: 1px solid #e2e8f0;">
          <!-- Top Accent Bar -->
          <tr>
            <td style="background-color: ${accentColor}; height: 6px; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>
          
          <!-- Header -->
          <tr>
            <td style="padding: 28px 32px 20px 32px; border-bottom: 1px solid #f1f5f9;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <div style="font-size: 18px; font-weight: 800; color: #0f172a; letter-spacing: -0.02em;">
                      Forgotten Women
                    </div>
                    <div style="font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px;">
                      Human Resources & Workforce Management
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
 * Sends a generic email using configured transport.
 */
async function sendEmail({ to, subject, html, text }) {
  const cfg = await getEmailConfig();
  if (!cfg.enabled) {
    return { sent: false, reason: 'email_notifications_disabled' };
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

  // Look up employee record
  const emp = await db.prepare('SELECT id, name, employee_number, work_email FROM employees WHERE id = ?').get(employeeId);
  if (!emp) return { sent: false, reason: 'employee_not_found' };

  // Fallback to personal email if work email is missing
  let recipientEmail = emp.work_email;
  if (!recipientEmail) {
    const personal = await db.prepare('SELECT personal_email FROM employee_personal WHERE employee_id = ?').get(employeeId);
    recipientEmail = personal?.personal_email;
  }

  if (!recipientEmail || !recipientEmail.includes('@')) {
    return { sent: false, reason: 'no_valid_email_for_employee', employeeId: emp.id, name: emp.name };
  }

  const subject = `[FW HR] ${title}`;
  const details = [];
  if (emp.employee_number) details.push({ label: 'Employee ID', value: emp.employee_number });
  details.push({ label: 'Date Issued', value: new Date().toLocaleDateString('en-GB') });
  details.push({ label: 'Category', value: category });

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
    subject: '[FW Tracker] Microsoft 365 Email Connection Test Succeeded',
    text: `Your Microsoft 365 email configuration is working successfully.\n\nHost: ${cfg.smtpHost}:${cfg.smtpPort}\nUser: ${cfg.smtpUser}\nTime: ${new Date().toISOString()}`,
    html: renderEmailHtml({
      title: 'Microsoft 365 Connection Test Succeeded',
      body: 'Your Microsoft 365 email service has been verified and is ready to send automated workforce updates, warnings, and leave notifications.',
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
    messageId: info.messageId,
  };
}

module.exports = {
  getEmailConfig,
  createTransporter,
  sendEmail,
  sendNotificationEmail,
  testConnection,
};
