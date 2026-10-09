// Monthly employee invoices (domain/invoice.js, migration 029).
//
// No invoice is stored: every view fills the template from the figures. An
// approved month is frozen as numbers on its payslip row, so later
// corrections cannot change it; the open month is a live draft.
//
// One schema, one employee's March 2025, driven by an explicit clock.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const PizZip = require('pizzip');

process.env.UPSTASH_REDIS_REST_URL = '';
process.env.UPSTASH_REDIS_REST_TOKEN = '';

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('invoice');

const { app } = require('../src/server');
const { db } = require('../src/db');
const PR = require('../src/domain/payroll');
const INV = require('../src/domain/invoice');
const T = require('../src/util/time');

const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
const at = (dateKey, hhmm = '12:00') => T.wallClockToEpoch(dateKey, hhmm);
const rand = () => crypto.randomBytes(6).toString('hex');
const DAILY = 2600 * 12 / 52 / 5; // 120.00
const EMP = 'emp_inv';

let server;
let base;
const ctx = {};

async function setSetting(key, value) {
  await db.prepare(
    'INSERT INTO org_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
  ).run(key, value, T.now());
  PR.invalidatePayrollCache();
}

async function makeEmployee(id, name) {
  await db.prepare(`
    INSERT INTO employees (id, name, role, employee_number, active, work_mode, department_id, created_at, updated_at)
    VALUES (?,?, 'Engineering', ?, 1, 'HYBRID', 'dep_inv', ?, ?)
  `).run(id, name, 'FW' + id.slice(-3).toUpperCase(), T.now(), T.now());
  await db.prepare(`
    INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
    VALUES (?,?, 'Software Engineer', 'Full-time', '2024-12-02', '2024-12-02', ?)
  `).run('er_' + id, id, T.now());
  await PR.setSalary({ employeeId: id, amount: 2600, effectiveFrom: '2024-12-02', reason: 'Start', actor: 'user:hr' });
}

async function leaveRequest(type, start, end, days) {
  await db.prepare(`
    INSERT INTO leave_requests
      (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days, status, submitted_at, decided_at, created_at)
    VALUES (?,?,?,?,?, 'FULL_DAY', ?, 'APPROVED', ?, ?, ?)
  `).run('lr_' + rand(), EMP, type, start, end, days, at(start), at(start), at(start));
}

async function unpaidAbsence(dateKey) {
  await db.prepare(`
    INSERT INTO absence_records
      (id, employee_id, date_key, absence_type, detected_at, status, treat_as_unpaid, deduct_annual_leave, create_warning_trigger)
    VALUES (?,?,?, 'NO_SHOW', ?, 'CONFIRMED', 1, 0, 0)
  `).run('abs_' + rand(), EMP, dateKey, at(dateKey));
}

async function dayWorked(dateKey, status, worked, deficit = 0) {
  await db.prepare(`
    INSERT INTO attendance_daily_summary
      (employee_id, date_key, is_working_day, worked_minutes, daily_deficit_minutes, attendance_status, finalised, derived_at)
    VALUES (?,?,1,?,?,?,1,?)
  `).run(EMP, dateKey, worked, deficit, status, at(dateKey));
}

function docx(bodyText) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const paras = bodyText.split('\n').map(t => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`);
  return zip.generate({ type: 'nodebuffer' });
}
const documentText = buf => new PizZip(buf).file('word/document.xml').asText().replace(/<[^>]+>/g, '');

const call = async (method, url, { headers = {}, body, raw = false } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: body instanceof FormData ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined),
  });
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  return { status: res.status, body: await res.json() };
};

async function enrolPhone(employeeId) {
  const code = await call('POST', `/api/admin/employees/${employeeId}/enrollment-code`, { headers: ADMIN });
  const phone = await call('POST', '/api/enroll', { body: { code: code.body.code, platform: 'android', model: 'Pixel' } });
  return { Authorization: `Bearer ${phone.body.token}` };
}

test.before(async () => {
  await prepareDatabase();
  await setSetting('show_salary_to_employees', '1');
  await setSetting('invoice_company_name', 'Urbane Network Ltd');
  await setSetting('invoice_reference_prefix', 'URB');
  await db.prepare("INSERT INTO departments (id, name, active, created_at) VALUES ('dep_inv', 'Operations', 1, ?)").run(T.now());
  await makeEmployee(EMP, 'Ayesha Invoice');
  await makeEmployee('emp_other', 'Bilal Other');
  await db.prepare(`
    INSERT INTO employee_bank_details (employee_id, account_name, account_number, iban, bank_name, updated_at)
    VALUES (?, 'Ayesha Invoice', '0123456789', 'PK36SCBL0000001123456702', 'Meezan Bank', ?)
  `).run(EMP, T.now());

  // March 2025 (cut-off 25th).
  await dayWorked('2025-03-03', 'PRESENT', 540);
  await dayWorked('2025-03-04', 'PRESENT', 540);
  await dayWorked('2025-03-12', 'LATE', 420, 60);
  await leaveRequest('unpaid', '2025-03-05', '2025-03-05', 1);
  await unpaidAbsence('2025-03-06');
  await leaveRequest('sick', '2025-03-07', '2025-03-07', 1);
  await leaveRequest('annual', '2025-03-10', '2025-03-11', 2);
  // 500 minutes of lateness: one whole unpaid day.
  await db.prepare(`
    INSERT INTO attendance_deficit_ledger
      (id, employee_id, date_key, entry_type, minutes_delta, balance_after, whole_days_after, carry_forward_after, description, created_at, created_by)
    VALUES (?,?, '2025-03-04', 'HR_ADJUSTMENT', 500, 500, 1, 20, 'Seeded', ?, 'test')
  `).run('def_' + rand(), EMP, at('2025-03-04'));

  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  await dropDatabase();
});

test('the open month is a live draft, and its fields add up', async () => {
  await PR.runPayrollAutomation({ nowMs: at('2025-03-05') });
  ctx.march = await db.prepare("SELECT * FROM payroll_periods WHERE start_date = '2025-03-01'").get();
  assert.equal(ctx.march.status, 'OPEN');
  await PR.addException({ periodId: ctx.march.id, employeeId: EMP, amount: 100, type: 'BONUS', explanation: 'Q1 bonus', actor: 'user:hr' });

  const st = await INV.buildStatement({ periodId: ctx.march.id, employeeId: EMP, throughDate: '2025-03-20' });
  assert.equal(st.draft, true);
  assert.match(st.fields.statement_reference, /^DRAFT-URB-202503-/);
  assert.match(st.fields.payroll_note, /Provisional/);
  assert.equal(st.totals.additions, 100);
  assert.equal(st.totals.unpaidLeave, 2 * DAILY, 'unpaid leave + unpaid absence');
  assert.equal(st.totals.shortfall, DAILY, 'one whole day of lateness');
  assert.equal(st.totals.net, st.totals.grossEarnings - st.totals.totalDeductions);
  assert.equal(st.totals.grossEarnings, 2700);
});

test('a salary deduction is taken off the month whichever sign HR typed', async () => {
  const before = await INV.buildStatement({ periodId: ctx.march.id, employeeId: EMP, throughDate: '2025-03-20' });
  const r = await PR.addException({ periodId: ctx.march.id, employeeId: EMP, amount: 50, type: 'SALARY_DEDUCTION', explanation: 'Equipment', actor: 'user:hr' });
  assert.equal(r.type, 'SALARY_DEDUCTION');
  assert.equal(r.amount, -50);
  const st = await INV.buildStatement({ periodId: ctx.march.id, employeeId: EMP, throughDate: '2025-03-20' });
  assert.equal(st.totals.net, before.totals.net - 50);
  assert.equal(st.totals.totalDeductions, before.totals.totalDeductions + 50);
  // Typed negative: still a deduction of the same size.
  const neg = await PR.addException({ periodId: ctx.march.id, employeeId: EMP, amount: -20, type: 'SALARY_DEDUCTION', explanation: 'Equipment', actor: 'user:hr' });
  assert.equal(neg.amount, -20);
  // Later steps check the March figures exactly: take both lines out again.
  await db.prepare('DELETE FROM payroll_adjustments WHERE id IN (?, ?)').run(r.id, neg.id);
  await PR.invalidatePayrollCache();
});

test('approval freezes the invoice: it matches the payslip to the penny', async () => {
  await PR.runPayrollAutomation({ nowMs: at('2025-03-26') });
  const proposed = await db.prepare(
    "SELECT id FROM payroll_adjustments WHERE period_id = ? AND status = 'PROPOSED' AND review_level = 'ATTENTION'"
  ).all(ctx.march.id);
  await PR.approveRun({
    periodId: ctx.march.id, note: 'March approved - thank you all', actor: 'admin-key', nowMs: at('2025-03-28'),
    decisions: proposed.map(p => ({ adjustmentId: p.id, decision: 'APPROVED', notes: 'ok' })),
    waiveBlockers: true, waiverNote: 'test',
  });

  const payslip = await db.prepare('SELECT * FROM payslips WHERE period_id = ? AND employee_id = ?').get(ctx.march.id, EMP);
  assert.ok(payslip.statement_json, 'the snapshot is sealed at approval');

  const st = await INV.buildStatement({ periodId: ctx.march.id, employeeId: EMP });
  ctx.final = st;
  assert.equal(st.draft, false);
  assert.equal(st.integrityOk, true);
  assert.equal(st.totals.net, payslip.net_payable);
  assert.equal(st.fields.statement_reference, 'URB-202503-FWINV');
  assert.equal(st.fields.employee_name, 'Ayesha Invoice');
  assert.equal(st.fields.job_title, 'Software Engineer');
  assert.equal(st.fields.department, 'Operations');
  assert.equal(st.fields.working_arrangement, 'Hybrid');
  assert.equal(st.fields.currency, payslip.currency);
  assert.equal(st.fields.addition_amount, '100.00');
  assert.equal(st.fields.unpaid_leave_deduction, '240.00');
  assert.equal(st.fields.shortfall_deduction, '120.00');
  assert.equal(st.fields.payroll_note, 'March approved - thank you all');
  assert.equal(st.fields.prepared_by, 'HR Department');
  assert.equal(st.fields.present_days, '3', 'PRESENT, PRESENT, LATE');
  assert.equal(st.fields.unpaid_leave_days, '1');
  assert.equal(st.fields.sick_leave_days, '1');
  assert.equal(st.fields.paid_leave_days, '2');
  assert.equal(st.fields.unauthorised_days, '1');
  assert.equal(st.fields.worked_hours, '25h 00m');
  assert.equal(st.fields.shortfall_hours, '1h 00m');
  assert.equal(st.fields.account_number, '0123456789');
});

test('a correction after approval does not change the frozen invoice', async () => {
  await unpaidAbsence('2025-03-13');
  await dayWorked('2025-03-14', 'PRESENT', 480);
  await db.prepare("UPDATE employee_bank_details SET account_number = '9999999999' WHERE employee_id = ?").run(EMP);
  await setSetting('invoice_company_name', 'Renamed Ltd');
  await setSetting('invoice_reference_prefix', 'NEW');

  const again = await INV.buildStatement({ periodId: ctx.march.id, employeeId: EMP });
  assert.deepEqual(again.fields, ctx.final.fields);
  assert.equal(again.fields.company_name, 'Urbane Network Ltd', 'company details as issued');

  // Restored for the tests below.
  await setSetting('invoice_company_name', 'Urbane Network Ltd');
  await setSetting('invoice_reference_prefix', 'URB');
});

test('staff without bank access see masked bank details', async () => {
  const st = await INV.buildStatement({ periodId: ctx.march.id, employeeId: EMP, maskBank: true });
  assert.equal(st.fields.account_number, '******6789');
  assert.match(st.fields.iban, /^\*+6702$/);
});

test('a payslip from before invoices existed gets its snapshot once, then keeps it', async () => {
  await db.prepare('UPDATE payslips SET statement_json = NULL WHERE period_id = ? AND employee_id = ?').run(ctx.march.id, EMP);
  const first = await INV.buildStatement({ periodId: ctx.march.id, employeeId: EMP });
  const second = await INV.buildStatement({ periodId: ctx.march.id, employeeId: EMP });
  assert.deepEqual(second.fields, first.fields);
  const audits = await db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'INVOICE_SNAPSHOT_BACKFILLED'").get();
  assert.equal(Number(audits.c), 1, 'written once');
  // Built from today's data, so it reflects the later absence.
  assert.equal(first.fields.unauthorised_days, '2');
});

test('an invoice that disagrees with the payslip is refused, never shown', async () => {
  await db.prepare('UPDATE payslips SET net_payable = net_payable + 1 WHERE period_id = ? AND employee_id = ?').run(ctx.march.id, EMP);
  await assert.rejects(INV.buildStatement({ periodId: ctx.march.id, employeeId: EMP }), err => err.code === 'INVOICE_MISMATCH');
  await db.prepare('UPDATE payslips SET net_payable = net_payable - 1 WHERE period_id = ? AND employee_id = ?').run(ctx.march.id, EMP);
});

test('templates: unknown or missing placeholders are refused; a good one renders with nothing left over', async () => {
  const unknown = await call('POST', '/api/payroll/invoice-template', {
    headers: ADMIN, body: (() => { const f = new FormData(); f.append('file', new Blob([docx('{{employee_name}} {{net_salary}} {{payroll_month}} {{salary_bonus}}')]), 't.docx'); return f; })(),
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'UNKNOWN_PLACEHOLDER');

  const missing = await call('POST', '/api/payroll/invoice-template', {
    headers: ADMIN, body: (() => { const f = new FormData(); f.append('file', new Blob([docx('{{employee_name}}')]), 't.docx'); return f; })(),
  });
  assert.equal(missing.body.code, 'MISSING_PLACEHOLDER');

  const good = docx('{{company_name}}\n{{employee_name}} {{payroll_month}}\nNet {{currency}} {{net_salary}}\n{{statement_reference}}');
  const up = await call('POST', '/api/payroll/invoice-template', {
    headers: ADMIN, body: (() => { const f = new FormData(); f.append('file', new Blob([good]), 'Invoice.docx'); return f; })(),
  });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.template.version, 1);

  const file = await call('GET', `/api/payroll/periods/${ctx.march.id}/invoices/${EMP}/docx`, { headers: ADMIN, raw: true });
  assert.equal(file.status, 200);
  const text = documentText(file.buffer);
  assert.ok(!text.includes('{{'), 'no placeholder left');
  assert.ok(text.includes('Ayesha Invoice') && text.includes(ctx.final.fields.net_salary) && text.includes('URB-202503-FWINV'));

  const zip = await call('GET', `/api/payroll/periods/${ctx.march.id}/invoices.zip`, { headers: ADMIN, raw: true });
  assert.equal(zip.status, 200);
  assert.ok(Object.keys(new PizZip(zip.buffer).files).length >= 1);
});

test('a phone reads only its own invoices, and only while HR allows it', async () => {
  const mine = await enrolPhone(EMP);
  const theirs = await enrolPhone('emp_other');

  const list = await call('GET', '/api/payroll/mine/invoices', { headers: mine });
  assert.equal(list.status, 200);
  assert.ok(list.body.invoices.some(i => i.periodId === ctx.march.id));

  const own = await call('GET', `/api/payroll/mine/invoices/${ctx.march.id}`, { headers: mine });
  assert.equal(own.status, 200);
  assert.equal(own.body.invoice.fields.employee_name, 'Ayesha Invoice');
  // Unmasked: their own details. (The backfill test above re-sealed the
  // snapshot after the bank number changed, so it holds the new one.)
  assert.equal(own.body.invoice.fields.account_number, '9999999999', 'their own bank details in full');

  // The same URL on another employee's phone is always their own invoice.
  const other = await call('GET', `/api/payroll/mine/invoices/${ctx.march.id}`, { headers: theirs });
  assert.equal(other.status, 200);
  assert.equal(other.body.invoice.fields.employee_name, 'Bilal Other');
  assert.equal(other.body.invoice.employeeId, 'emp_other');

  const docxFile = await call('GET', `/api/payroll/mine/invoices/${ctx.march.id}/docx`, { headers: mine, raw: true });
  assert.equal(docxFile.status, 200);

  await setSetting('show_salary_to_employees', '0');
  const hidden = await call('GET', `/api/payroll/mine/invoices/${ctx.march.id}`, { headers: mine });
  assert.equal(hidden.status, 403);
  await setSetting('show_salary_to_employees', '1');

  // Staff routes are not reachable with a device token.
  const staff = await call('GET', `/api/payroll/periods/${ctx.march.id}/invoices/${EMP}`, { headers: mine });
  assert.equal(staff.status, 401);
});
