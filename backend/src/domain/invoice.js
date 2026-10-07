// Monthly employee invoices, generated on demand.
//
// No invoice document is ever stored. The one stored artefact is the Word
// template HR uploads (invoice_templates). Every view - the .docx download,
// the dashboard's on-screen invoice, the phone's screen and its PDF - is
// filled from buildStatement(), so they can never disagree with each other.
//
// Two kinds of invoice:
//   - FINAL (the period is PUBLISHED or PAID): the money comes from the frozen
//     payslip row, and everything else from the statement snapshot sealed onto
//     it at approval. A later correction to attendance, leave, salary or bank
//     details cannot change an invoice someone was paid on.
//   - DRAFT (OPEN or IN_REVIEW): live, from the same figures the payroll run
//     uses, marked provisional.
//
// Money invariant: gross earnings - total deductions = net, and for a final
// invoice net must equal the payslip's net_payable to the penny, or the
// invoice is refused rather than shown wrong.

const crypto = require('crypto');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { db, audit, withReadMemo } = require('../db');
const schedule = require('./schedule');
const T = require('../util/time');

// Lazy: payroll.js requires this module (to seal the snapshot at approval).
const payroll = () => require('./payroll');

// Every placeholder a template may use. An upload using anything else is
// refused, so a typo can't silently print a blank.
const FIELDS = [
  'company_name', 'company_email', 'company_phone', 'company_address',
  'employee_name', 'employee_id', 'job_title', 'department', 'working_arrangement',
  'payroll_month', 'period_start', 'period_end', 'statement_reference',
  'currency', 'monthly_salary', 'addition_amount', 'overtime_amount', 'gross_earnings', 'total_deductions',
  'scheduled_days', 'present_days', 'paid_leave_days', 'unpaid_leave_days', 'sick_leave_days',
  'unauthorised_days', 'worked_hours', 'extra_hours', 'shortfall_hours',
  'unpaid_leave_deduction', 'shortfall_deduction', 'adjustment_amount',
  'net_salary', 'bank_name', 'account_title', 'account_number', 'iban',
  'payroll_note', 'prepared_by', 'generated_date',
];
const REQUIRED_FIELDS = ['employee_name', 'payroll_month', 'net_salary'];

const DRAFT_NOTE = 'Provisional - this invoice will change until HR approves the month.';
const SNAPSHOT_VERSION = 1;

class InvoiceError extends Error {
  constructor(message, { code = 'INVOICE_ERROR', httpStatus = 400 } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const moneyFmt = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const fmtMoney = n => moneyFmt.format(round2(n));
const fmtDays = n => {
  const v = Math.round((Number(n) || 0) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};
function fmtHours(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function fmtDate(dateKey) {
  if (!dateKey) return '';
  const [y, mo, d] = String(dateKey).split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, mo - 1, d)));
}
const WORK_MODES = { IN_OFFICE: 'In office', REMOTE: 'Remote', HYBRID: 'Hybrid' };

function mask(value) {
  const s = String(value || '');
  if (!s) return '';
  return s.length <= 4 ? '****' : `${'*'.repeat(Math.min(8, s.length - 4))}${s.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Settings (company details printed on every invoice)
// ---------------------------------------------------------------------------

const COMPANY_KEYS = {
  company_name: 'invoice_company_name',
  company_email: 'invoice_company_email',
  company_phone: 'invoice_company_phone',
  company_address: 'invoice_company_address',
  reference_prefix: 'invoice_reference_prefix',
  prepared_by_default: 'invoice_prepared_by',
};
const SETTING_KEYS = Object.values(COMPANY_KEYS);

async function companySettings() {
  const rows = await db.prepare(
    `SELECT key, value FROM org_settings WHERE key IN (${SETTING_KEYS.map(() => '?').join(',')})`
  ).all(...SETTING_KEYS);
  const v = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    company_name: v.invoice_company_name || '',
    company_email: v.invoice_company_email || '',
    company_phone: v.invoice_company_phone || '',
    company_address: v.invoice_company_address || '',
    reference_prefix: (v.invoice_reference_prefix || 'INV').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'INV',
    prepared_by_default: v.invoice_prepared_by || 'HR Department',
  };
}

// ---------------------------------------------------------------------------
// The attendance summary: period start (or the starter's first day) to the
// deduction window's end, the same days the deductions count.
// ---------------------------------------------------------------------------

async function attendanceSummary(employeeId, fromDate, toDate) {
  const empty = {
    from: fromDate, to: toDate, scheduledDays: 0, presentDays: 0, paidLeaveDays: 0, unpaidLeaveDays: 0,
    sickLeaveDays: 0, unauthorisedDays: 0, workedMinutes: 0, extraMinutes: 0, shortfallMinutes: 0,
  };
  if (!fromDate || !toDate || toDate < fromDate) return empty;

  const scheduled = await payroll().eligibleWorkingDays(employeeId, fromDate, toDate);
  const dayEquivalent = (await schedule.resolve(employeeId, toDate)).dayEquivalentMinutes || 480;

  const [days, leaveRows, unauthorised] = await Promise.all([
    db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE is_working_day = 1 AND attendance_status IN ('PRESENT','LATE','RECOVERED')) AS present,
        COALESCE(SUM(worked_minutes), 0) AS worked,
        COALESCE(SUM(CASE WHEN is_working_day = 1 THEN GREATEST(0, worked_minutes - ?) ELSE worked_minutes END), 0) AS extra,
        COALESCE(SUM(daily_deficit_minutes), 0) AS shortfall
      FROM attendance_daily_summary
      WHERE employee_id = ? AND date_key >= ? AND date_key <= ?
    `).get(dayEquivalent, employeeId, fromDate, toDate),
    db.prepare(`
      SELECT r.start_date, r.end_date, r.day_portion, r.leave_type_id,
             COALESCE(r.is_paid, t.is_paid) AS is_paid -- a request can override its type
      FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
      WHERE r.employee_id = ? AND r.status = 'APPROVED' AND r.cancelled_at IS NULL
        AND r.leave_type_id <> 'wfh'
        AND r.start_date <= ? AND r.end_date >= ?
    `).all(employeeId, toDate, fromDate),
    db.prepare(`
      SELECT COUNT(*) AS c FROM absence_records
      WHERE employee_id = ? AND status = 'CONFIRMED' AND treat_as_unpaid = 1
        AND date_key >= ? AND date_key <= ?
    `).get(employeeId, fromDate, toDate),
  ]);

  // Leave counts working days only, clipped to the window; a half-day
  // request counts half.
  let paid = 0, unpaid = 0, sick = 0;
  for (const r of leaveRows) {
    const a = r.start_date > fromDate ? r.start_date : fromDate;
    const b = r.end_date < toDate ? r.end_date : toDate;
    let n = (await payroll().eligibleWorkingDays(employeeId, a, b)).length;
    if (r.day_portion && r.day_portion !== 'FULL_DAY') n *= 0.5;
    if (r.leave_type_id === 'sick') sick += n;
    else if (Number(r.is_paid) === 1) paid += n;
    else unpaid += n;
  }

  return {
    from: fromDate,
    to: toDate,
    scheduledDays: scheduled.length,
    presentDays: Number(days.present) || 0,
    paidLeaveDays: paid,
    unpaidLeaveDays: unpaid,
    sickLeaveDays: sick,
    unauthorisedDays: Number(unauthorised.c) || 0,
    workedMinutes: Number(days.worked) || 0,
    extraMinutes: Number(days.extra) || 0,
    shortfallMinutes: Number(days.shortfall) || 0,
  };
}

// ---------------------------------------------------------------------------
// Employee details, and the snapshot sealed onto a payslip at approval
// ---------------------------------------------------------------------------

async function employeeDetails(employeeId) {
  const e = await db.prepare(`
    SELECT e.id, e.name, e.employee_number, e.work_mode, d.name AS department_name
    FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    WHERE e.id = ?
  `).get(employeeId);
  if (!e) return null;
  const er = await require('./people').currentEmployment(employeeId);
  const bank = await db.prepare('SELECT * FROM employee_bank_details WHERE employee_id = ?').get(employeeId);
  return {
    id: e.id,
    name: e.name,
    employeeNumber: e.employee_number || null,
    jobTitle: er?.job_title || null,
    department: e.department_name || null,
    workMode: e.work_mode || 'IN_OFFICE',
    employmentType: er?.employment_type || null,
    bank: bank ? {
      bankName: bank.bank_name || null,
      accountTitle: bank.account_name || null,
      accountNumber: bank.account_number || null,
      iban: bank.iban || null,
    } : null,
  };
}

/** Everything an invoice needs beyond the payslip's money, as of approval. */
async function buildSnapshot(period, employeeId, { fromDate, toDate }) {
  return {
    v: SNAPSHOT_VERSION,
    employee: await employeeDetails(employeeId),
    attendance: await attendanceSummary(employeeId, fromDate, toDate),
    approvalNote: period.approval_note || null,
    // As printed when it was issued: editing the company details later must
    // not change an invoice already approved.
    company: await companySettings(),
  };
}

function snapshotHash(data, contentHash) {
  return crypto.createHash('sha256')
    .update(`${contentHash || ''}|${JSON.stringify(data)}`).digest('hex');
}

/** Sealed to the payslip's own content hash: altering either breaks it. */
function sealSnapshot(data, contentHash) {
  return JSON.stringify({ data, hash: snapshotHash(data, contentHash) });
}

function openSnapshot(json, contentHash) {
  if (!json) return null;
  try {
    const { data, hash } = JSON.parse(json);
    return { data, integrityOk: snapshotHash(data, contentHash) === hash };
  } catch (_) {
    return { data: null, integrityOk: false };
  }
}

// ---------------------------------------------------------------------------
// Lines to template fields
// ---------------------------------------------------------------------------

const ADDITION_TYPES = new Set(['BONUS', 'ALLOWANCE', 'SPECIAL_ADDITION']);
const UNPAID_TYPES = new Set(['UNPAID_LEAVE_DEDUCTION', 'UNAUTHORISED_ABSENCE_UNPAID']);

function categorise(lines) {
  const out = { additions: 0, overtime: 0, unpaidLeave: 0, shortfall: 0, adjustments: 0 };
  for (const l of lines) {
    const amt = Number(l.amount) || 0;
    if (amt >= 0) {
      if (l.type === 'OVERTIME') out.overtime += amt;
      else out.additions += amt; // bonus, allowance and any positive HR line
      continue;
    }
    const d = -amt;
    if (UNPAID_TYPES.has(l.type)) out.unpaidLeave += d;
    else if (l.type === 'ATTENDANCE_DEFICIT_DAY') out.shortfall += d;
    else out.adjustments += d; // processing fee, manual and other deductions
  }
  for (const k of Object.keys(out)) out[k] = round2(out[k]);
  return out;
}

async function preparedByName(actor, fallback) {
  const m = /^user:(.+)$/.exec(String(actor || ''));
  if (m) {
    const u = await db.prepare('SELECT display_name FROM users WHERE id = ?').get(m[1]);
    if (u?.display_name) return u.display_name;
  }
  return fallback;
}

function statementReference(prefix, period, employee, { draft, version }) {
  const ym = String(period.start_date || '').slice(0, 7).replace('-', '');
  const who = employee?.employeeNumber || employee?.id || 'EMP';
  const ref = `${prefix}-${ym}-${who}${version > 1 ? `-v${version}` : ''}`;
  return draft ? `DRAFT-${ref}` : ref;
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

const selectPeriod = db.prepare('SELECT * FROM payroll_periods WHERE id = ?');
const selectPayslip = db.prepare(`
  SELECT * FROM payslips WHERE period_id = ? AND employee_id = ? AND status = 'PUBLISHED'
  ORDER BY version DESC LIMIT 1
`);
const FINAL = new Set(['PUBLISHED', 'PAID', 'CLOSED']);

function linesOf(payslip) {
  try { return JSON.parse(payslip.lines_json || '[]'); } catch (_) { return []; }
}

/**
 * A payslip published before invoices existed has no snapshot. Build it once,
 * for the period's own window, and seal it on the row, so the invoice is
 * stable from its first view onwards.
 */
async function ensureSnapshot(period, payslip) {
  const opened = openSnapshot(payslip.statement_json, payslip.content_hash);
  if (opened) return opened;
  const from = period.start_date;
  const to = payslip.cutoff_date || period.cutoff_date || period.end_date;
  const data = await buildSnapshot(period, payslip.employee_id, { fromDate: from, toDate: to });
  const sealed = sealSnapshot(data, payslip.content_hash);
  const r = await db.prepare(
    'UPDATE payslips SET statement_json = ? WHERE id = ? AND statement_json IS NULL'
  ).run(sealed, payslip.id);
  if (r.changes) {
    await audit({
      actor: 'system', action: 'INVOICE_SNAPSHOT_BACKFILLED', targetType: 'payslip', targetId: payslip.id,
      after: { periodId: period.id, employeeId: payslip.employee_id },
    });
    return { data, integrityOk: true };
  }
  // Another request sealed it first: use theirs.
  const fresh = await db.prepare('SELECT statement_json FROM payslips WHERE id = ?').get(payslip.id);
  return openSnapshot(fresh.statement_json, payslip.content_hash);
}

/** The live figures of an open month, as the run would compute them now. */
async function draftFigures(period, employeeId, throughDate) {
  const e = await db.prepare('SELECT id, name, employee_number FROM employees WHERE id = ?').get(employeeId);
  if (!e) throw new InvoiceError('No such employee.', { code: 'NOT_FOUND', httpStatus: 404 });
  const pos = await payroll().employeePosition(period, e, { throughDate, detail: false });
  if (pos.blocked) {
    throw new InvoiceError(pos.blocked.message || 'No salary on record for this employee.', { code: 'NO_SALARY', httpStatus: 409 });
  }
  const { basis, unpaid, existing } = pos;
  if (!basis.inPeriod) throw new InvoiceError('This employee is not employed in this period.', { code: 'NOT_IN_PERIOD', httpStatus: 404 });

  const standing = a => (a.status === 'APPROVED' ? Number(a.approved_amount) : Number(a.calculated_amount)) || 0;
  const lines = existing
    .filter(a => a.status !== 'REJECTED')
    .map(a => ({ type: a.adjustment_type, amount: round2(standing(a)), days: a.approved_days ?? a.calculated_days }));

  // What the run would still propose: sources with no adjustment row yet.
  const daily = basis.salary.dailyPrecise;
  const hasDeficitRow = existing.some(a => a.adjustment_type === 'ATTENDANCE_DEFICIT_DAY');
  if (!hasDeficitRow && unpaid.deficitDays > 0) {
    lines.push({ type: 'ATTENDANCE_DEFICIT_DAY', amount: -round2(daily * unpaid.deficitDays), days: unpaid.deficitDays });
  }
  if (unpaid.absenceDays > 0) {
    lines.push({ type: 'UNAUTHORISED_ABSENCE_UNPAID', amount: -round2(daily * unpaid.absenceDays), days: unpaid.absenceDays });
  }
  if (unpaid.leaveDays > 0) {
    lines.push({ type: 'UNPAID_LEAVE_DEDUCTION', amount: -round2(daily * unpaid.leaveDays), days: unpaid.leaveDays });
  }

  const adjustmentsTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  return {
    basis,
    lines,
    currency: basis.salary.currency || require('../config').config.payroll.currency,
    monthlySalary: basis.salary.monthly,
    grossBaseline: basis.grossBaseline,
    netPayable: round2(basis.grossBaseline + adjustmentsTotal),
  };
}

/**
 * The invoice for one employee and one period, as template fields.
 *
 * options:
 *   maskBank   - staff without employee.bank.read see only the last 4 digits
 *   throughDate - for a draft, count data only up to this day (the phone's
 *                 "so far this month"); defaults to today
 */
function buildStatement(opts) {
  return withReadMemo(() => buildStatementUncached(opts));
}

async function buildStatementUncached({ periodId, employeeId, maskBank = false, throughDate = null }) {
  const period = await selectPeriod.get(periodId);
  if (!period) throw new InvoiceError('No such payroll period.', { code: 'NOT_FOUND', httpStatus: 404 });
  const final = FINAL.has(period.status);

  let money, snapshot, draft, templateId = null, publishedAt = null, publishedBy = null, version = 1, integrityOk = true;

  if (final) {
    const payslip = await selectPayslip.get(periodId, employeeId);
    if (!payslip) throw new InvoiceError('No published payslip for this employee in this period.', { code: 'NOT_FOUND', httpStatus: 404 });
    const opened = await ensureSnapshot(period, payslip);
    snapshot = opened.data;
    integrityOk = opened.integrityOk && payroll().payslipIntegrityOk(payslip);
    money = {
      lines: linesOf(payslip),
      currency: payslip.currency,
      monthlySalary: payslip.monthly_salary,
      grossBaseline: payslip.gross_baseline,
      netPayable: payslip.net_payable,
    };
    templateId = payslip.template_id || null;
    publishedAt = payslip.published_at;
    publishedBy = payslip.published_by;
    version = payslip.version || 1;
    draft = false;
  } else {
    const through = throughDate || T.dateKey();
    const d = await draftFigures(period, employeeId, through);
    money = d;
    const from = d.basis.effectiveStart || period.start_date;
    snapshot = await buildSnapshot(period, employeeId, { fromDate: from, toDate: d.basis.windowEnd });
    draft = true;
  }

  const c = categorise(money.lines);
  const gross = round2(money.grossBaseline + c.additions + c.overtime);
  const deductions = round2(c.unpaidLeave + c.shortfall + c.adjustments);
  const net = round2(gross - deductions);
  if (Math.abs(net - round2(money.netPayable)) > 0.005) {
    console.error(`[invoice] ${periodId}/${employeeId}: fields give ${net}, payslip says ${money.netPayable}`);
    throw new InvoiceError('This invoice does not add up to the approved net pay, so it has not been shown. HR has been told.', {
      code: 'INVOICE_MISMATCH', httpStatus: 500,
    });
  }

  // A final invoice prints the company details it was issued with; a draft,
  // and a snapshot from before they were frozen, use today's.
  const settings = (!draft && snapshot?.company) || await companySettings();
  const emp = snapshot?.employee || {};
  const a = snapshot?.attendance || {};
  const bank = emp.bank || {};
  const preparedBy = draft ? settings.prepared_by_default : await preparedByName(publishedBy, settings.prepared_by_default);

  const fields = {
    company_name: settings.company_name,
    company_email: settings.company_email,
    company_phone: settings.company_phone,
    company_address: settings.company_address,
    employee_name: emp.name || '',
    employee_id: emp.employeeNumber || emp.id || '',
    job_title: emp.jobTitle || '',
    department: emp.department || '',
    working_arrangement: WORK_MODES[emp.workMode] || emp.workMode || '',
    payroll_month: period.name,
    period_start: fmtDate(period.start_date),
    period_end: fmtDate(period.end_date),
    statement_reference: statementReference(settings.reference_prefix, period, emp, { draft, version }),
    currency: money.currency || '',
    monthly_salary: fmtMoney(money.monthlySalary),
    addition_amount: fmtMoney(c.additions),
    overtime_amount: fmtMoney(c.overtime),
    gross_earnings: fmtMoney(gross),
    total_deductions: fmtMoney(deductions),
    scheduled_days: fmtDays(a.scheduledDays),
    present_days: fmtDays(a.presentDays),
    paid_leave_days: fmtDays(a.paidLeaveDays),
    unpaid_leave_days: fmtDays(a.unpaidLeaveDays),
    sick_leave_days: fmtDays(a.sickLeaveDays),
    unauthorised_days: fmtDays(a.unauthorisedDays),
    worked_hours: fmtHours(a.workedMinutes),
    extra_hours: fmtHours(a.extraMinutes),
    shortfall_hours: fmtHours(a.shortfallMinutes),
    unpaid_leave_deduction: fmtMoney(c.unpaidLeave),
    shortfall_deduction: fmtMoney(c.shortfall),
    adjustment_amount: fmtMoney(c.adjustments),
    net_salary: fmtMoney(net),
    bank_name: bank.bankName || '',
    account_title: bank.accountTitle || '',
    account_number: maskBank ? mask(bank.accountNumber) : (bank.accountNumber || ''),
    iban: maskBank ? mask(bank.iban) : (bank.iban || ''),
    payroll_note: draft ? DRAFT_NOTE : (snapshot?.approvalNote || period.approval_note || ''),
    prepared_by: preparedBy,
    generated_date: fmtDate(T.dateKey(draft ? T.now() : publishedAt)),
  };

  return {
    periodId,
    employeeId,
    periodStatus: period.status,
    draft,
    integrityOk,
    templateId,
    currency: money.currency,
    fields,
    // Raw numbers alongside the formatted fields, for clients that lay the
    // invoice out themselves.
    totals: {
      monthlySalary: money.monthlySalary, grossBaseline: money.grossBaseline,
      additions: c.additions, overtime: c.overtime, grossEarnings: gross,
      unpaidLeave: c.unpaidLeave, shortfall: c.shortfall, adjustments: c.adjustments,
      totalDeductions: deductions, net,
    },
    attendance: a,
    window: { from: a.from || null, to: a.to || null },
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const templateFileCache = new Map(); // id -> Buffer (versions are immutable)

/** Fill a template buffer; unknown or missing values print as "-". */
function fill(buffer, fields) {
  const doc = new Docxtemplater(new PizZip(buffer), {
    delimiters: { start: '{{', end: '}}' },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '-',
  });
  doc.render(fields);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Which placeholders a template uses, or a readable reason it can't be used. */
function inspectTemplate(buffer) {
  let zip;
  try { zip = new PizZip(buffer); } catch (_) {
    throw new InvoiceError('That file is not a Word (.docx) document.', { code: 'BAD_TEMPLATE' });
  }
  if (!zip.file('word/document.xml')) {
    throw new InvoiceError('That file is not a Word (.docx) document.', { code: 'BAD_TEMPLATE' });
  }
  const used = new Set();
  try {
    const doc = new Docxtemplater(zip, {
      delimiters: { start: '{{', end: '}}' },
      paragraphLoop: true,
      parser: tag => ({ get: () => { used.add(tag.trim()); return ''; } }),
    });
    doc.render({});
  } catch (err) {
    const detail = (err.properties?.errors || []).map(e => e.properties?.explanation).filter(Boolean);
    throw new InvoiceError(
      `The template has a broken placeholder: ${detail.slice(0, 3).join('; ') || err.message}`,
      { code: 'BAD_TEMPLATE' },
    );
  }
  const unknown = [...used].filter(f => !FIELDS.includes(f));
  const missing = REQUIRED_FIELDS.filter(f => !used.has(f));
  return {
    used: [...used].sort(),
    unknown,
    missingRequired: missing,
    unused: FIELDS.filter(f => !used.has(f)),
  };
}

function presentTemplate(r) {
  let placeholders = [];
  try { placeholders = JSON.parse(r.placeholders || '[]'); } catch (_) {}
  return {
    id: r.id, version: Number(r.version), name: r.name, sha256: r.sha256,
    placeholders, active: !!r.active, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
    unused: FIELDS.filter(f => !placeholders.includes(f)),
  };
}

async function uploadTemplate({ buffer, name, actor }) {
  if (!buffer || !buffer.length) throw new InvoiceError('Choose a .docx file to upload.', { code: 'BAD_TEMPLATE' });
  // Vercel caps a request body at 4.5 MB; stay clear of it.
  if (buffer.length > 4 * 1024 * 1024) throw new InvoiceError('The template must be under 4 MB.', { code: 'BAD_TEMPLATE' });
  const report = inspectTemplate(buffer);
  if (report.unknown.length) {
    throw new InvoiceError(
      `Unknown placeholder(s): ${report.unknown.map(f => `{{${f}}}`).join(', ')}. Use only: ${FIELDS.join(', ')}.`,
      { code: 'UNKNOWN_PLACEHOLDER' },
    );
  }
  if (report.missingRequired.length) {
    throw new InvoiceError(
      `The template must include ${report.missingRequired.map(f => `{{${f}}}`).join(', ')}.`,
      { code: 'MISSING_PLACEHOLDER' },
    );
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const next = Number((await db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM invoice_templates').get()).v) + 1;
  const id = 'itpl_' + crypto.randomBytes(8).toString('hex');
  const nowMs = T.now();
  const cleanName = String(name || 'Invoice template').slice(0, 120);

  await require('../db').tx(async () => {
    await db.prepare('UPDATE invoice_templates SET active = 0 WHERE active = 1').run();
    await db.prepare(`
      INSERT INTO invoice_templates (id, version, name, file, sha256, placeholders, active, uploaded_by, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, next, cleanName, buffer, sha256, JSON.stringify(report.used), actor || null, nowMs);
  });
  templateFileCache.set(id, buffer);
  await audit({
    actor: actor || 'admin', action: 'INVOICE_TEMPLATE_UPLOADED', targetType: 'invoice_template', targetId: id,
    after: { version: next, name: cleanName, sha256, placeholders: report.used.length },
  });
  return { template: presentTemplate({ id, version: next, name: cleanName, sha256, placeholders: JSON.stringify(report.used), active: 1, uploaded_by: actor, uploaded_at: nowMs }), report };
}

async function activeTemplate() {
  const r = await db.prepare(
    'SELECT id, version, name, sha256, placeholders, active, uploaded_by, uploaded_at FROM invoice_templates WHERE active = 1 LIMIT 1'
  ).get();
  return r ? presentTemplate(r) : null;
}

async function listTemplates() {
  const rows = await db.prepare(
    'SELECT id, version, name, sha256, placeholders, active, uploaded_by, uploaded_at FROM invoice_templates ORDER BY version DESC'
  ).all();
  return rows.map(presentTemplate);
}

/** The template file, read from Postgres at most once per instance. */
async function templateFile(id) {
  if (templateFileCache.has(id)) return templateFileCache.get(id);
  const r = await db.prepare('SELECT file FROM invoice_templates WHERE id = ?').get(id);
  if (!r) return null;
  const buf = Buffer.isBuffer(r.file) ? r.file : Buffer.from(r.file);
  templateFileCache.set(id, buf);
  return buf;
}

/** The template id to publish a payslip with: the active one, if any. */
async function activeTemplateId() {
  const r = await db.prepare('SELECT id FROM invoice_templates WHERE active = 1 LIMIT 1').get();
  return r ? r.id : null;
}

function fileNameFor(statement) {
  const f = statement.fields;
  const safe = s => String(s || '').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '_');
  return `${safe(f.statement_reference) || 'invoice'}_${safe(f.employee_name)}.docx`;
}

/** The .docx for a statement, in the template it was published with. */
async function renderDocx(statement) {
  const id = statement.templateId || await activeTemplateId();
  if (!id) {
    throw new InvoiceError('No invoice template has been uploaded yet. HR can upload one under Payroll > Invoice settings.', { code: 'NO_TEMPLATE', httpStatus: 409 });
  }
  const buf = await templateFile(id);
  if (!buf) throw new InvoiceError('The invoice template is missing.', { code: 'NO_TEMPLATE', httpStatus: 409 });
  return { buffer: fill(buf, statement.fields), fileName: fileNameFor(statement) };
}

/** Every visible employee's invoice for a period, as one zip. */
async function renderPeriodZip({ periodId, employeeIds, maskBank }) {
  const zip = new PizZip();
  const skipped = [];
  for (const employeeId of employeeIds) {
    try {
      const st = await buildStatement({ periodId, employeeId, maskBank });
      const { buffer, fileName } = await renderDocx(st);
      zip.file(fileName, buffer);
    } catch (err) {
      if (err.code === 'NO_TEMPLATE') throw err;
      skipped.push({ employeeId, reason: err.message });
    }
  }
  return { buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }), skipped };
}

module.exports = {
  FIELDS, REQUIRED_FIELDS, SETTING_KEYS, COMPANY_KEYS, InvoiceError,
  buildStatement, attendanceSummary, buildSnapshot, sealSnapshot, openSnapshot, categorise,
  uploadTemplate, inspectTemplate, activeTemplate, listTemplates, activeTemplateId,
  renderDocx, renderPeriodZip, fill,
};
