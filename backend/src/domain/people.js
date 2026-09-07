// Employee master record and organisation structure. Spec sections 4, 16 (org
// side) and 37.
//
// The spec's final objective (section 37) is that HR can open one profile and
// see the whole person: employment, salary, attendance, leave, warnings,
// documents, and who changed what. This module assembles that, and is the write
// path for the parts of the record that had no API yet - employment records
// (crucially the start date, which leave and payroll both need), personal
// details, bank details, emergency contacts, departments, offices and manager
// assignments.
//
// Two rules run through it, both from earlier phases:
//   - Sensitive fields live behind their own permissions, so a profile is
//     assembled field-group by field-group and each group is included only if
//     the caller may see it. Spec 3.2.
//   - Anything historical is append-only. Employment terms and status are
//     versioned, never overwritten. Spec 31.

const crypto = require('crypto');
const { db, tx, audit } = require('../db');
const T = require('../util/time');

const id = (p) => p + '_' + crypto.randomBytes(8).toString('hex');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Departments and offices
// ---------------------------------------------------------------------------

async function createOffice({ name, timeZone, country = null, address = null, actor }) {
  if (!name || !timeZone) throw new Error('An office needs a name and a time zone.');
  const oid = id('off');
  await db.prepare(`
    INSERT INTO office_locations (id, name, time_zone, country, address, active, created_at)
    VALUES (?,?,?,?,?,1,?)
  `).run(oid, String(name).trim(), timeZone, country, address, T.now());
  await audit({ actor, action: 'OFFICE_CREATED', targetType: 'office', targetId: oid, after: { name, timeZone } });
  return { id: oid, name, timeZone };
}

async function listOffices() {
  return (await db.prepare('SELECT * FROM office_locations ORDER BY name').all()).map(o => ({
    id: o.id, name: o.name, timeZone: o.time_zone, country: o.country,
    address: o.address, active: !!o.active,
  }));
}

async function createDepartment({ name, parentId = null, headEmployeeId = null, actor }) {
  if (!name) throw new Error('A department needs a name.');
  const did = id('dept');
  await db.prepare(`
    INSERT INTO departments (id, name, parent_id, head_employee_id, active, created_at)
    VALUES (?,?,?,?,1,?)
  `).run(did, String(name).trim(), parentId, headEmployeeId, T.now());
  await audit({ actor, action: 'DEPARTMENT_CREATED', targetType: 'department', targetId: did, after: { name } });
  return { id: did, name };
}

async function listDepartments() {
  return (await db.prepare(`
    SELECT d.*, e.name AS head_name,
      (SELECT COUNT(*) FROM employees x WHERE x.department_id = d.id AND x.active = 1) AS member_count
    FROM departments d
    LEFT JOIN employees e ON e.id = d.head_employee_id
    ORDER BY d.name
  `).all()).map(d => ({
    id: d.id, name: d.name, parentId: d.parent_id,
    headEmployeeId: d.head_employee_id, headName: d.head_name,
    memberCount: d.member_count, active: !!d.active,
  }));
}

// ---------------------------------------------------------------------------
// Manager assignments (spec 3.2)
// ---------------------------------------------------------------------------

async function assignManager({ managerEmployeeId, employeeId, actor }) {
  if (managerEmployeeId === employeeId) throw new Error('An employee cannot manage themselves.');
  for (const x of [managerEmployeeId, employeeId]) {
    if (!await db.prepare('SELECT 1 FROM employees WHERE id = ?').get(x)) throw new Error(`No such employee: ${x}`);
  }
  await db.prepare(`
    INSERT INTO manager_assignments (manager_employee_id, employee_id, assigned_at, assigned_by)
    VALUES (?,?,?,?)
    ON CONFLICT(manager_employee_id, employee_id) DO UPDATE SET ended_at = NULL, assigned_at = excluded.assigned_at
  `).run(managerEmployeeId, employeeId, T.now(), actor);
  await audit({ actor, action: 'MANAGER_ASSIGNED', targetType: 'employee', targetId: employeeId,
          after: { managerEmployeeId } });
  return { assigned: true };
}

async function endManagerAssignment({ managerEmployeeId, employeeId, actor }) {
  await db.prepare('UPDATE manager_assignments SET ended_at = ? WHERE manager_employee_id = ? AND employee_id = ? AND ended_at IS NULL')
    .run(T.now(), managerEmployeeId, employeeId);
  await audit({ actor, action: 'MANAGER_UNASSIGNED', targetType: 'employee', targetId: employeeId, after: { managerEmployeeId } });
  return { ended: true };
}

// ---------------------------------------------------------------------------
// Employment records (versioned) - spec 4.2
// ---------------------------------------------------------------------------

const VALID_TYPES = ['Full-time', 'Part-time', 'Temporary', 'Contractor', 'Volunteer'];

/**
 * Opens a new set of employment terms.
 *
 * The first record for an employee sets their start date, which leave accrual
 * and payroll both depend on - so this is the write that unblocks those. A
 * later change (promotion, contract renewal, department move) closes the
 * current record and opens a new one, preserving history.
 */
async function setEmployment({
  employeeId, jobTitle, departmentId = null, managerEmployeeId = null, officeId = null,
  employmentType = 'Full-time', workingPatternId = null,
  startDate, probationStartDate = null, probationReviewDate = null,
  contractStartDate = null, contractEndDate = null, noticePeriodDays = null,
  holidayEntitlementDays = 20, effectiveFrom = null, changeReason, actor,
}) {
  if (!await db.prepare('SELECT 1 FROM employees WHERE id = ?').get(employeeId)) throw new Error('No such employee.');
  if (!jobTitle || !String(jobTitle).trim()) throw new Error('A job title is required.');
  if (!DATE_RE.test(String(startDate || ''))) throw new Error('startDate must be YYYY-MM-DD.');
  if (employmentType && !VALID_TYPES.includes(employmentType)) {
    throw new Error(`employmentType must be one of ${VALID_TYPES.join(', ')}.`);
  }
  for (const [label, v] of [
    ['probationReviewDate', probationReviewDate], ['contractEndDate', contractEndDate],
    ['probationStartDate', probationStartDate], ['contractStartDate', contractStartDate],
    ['effectiveFrom', effectiveFrom],
  ]) {
    if (v && !DATE_RE.test(String(v))) throw new Error(`${label} must be YYYY-MM-DD.`);
  }

  const eid = id('er');
  const nowMs = T.now();
  const from = effectiveFrom || startDate;
  const previous = await db.prepare(
    'SELECT * FROM employment_records WHERE employee_id = ? AND effective_to IS NULL'
  ).get(employeeId);

  if (!changeReason || !String(changeReason).trim()) {
    throw new Error('A reason is required, so a change to employment terms is always explainable.');
  }

  await tx(async () => {
    if (previous) {
      const dayBefore = T.dateKey(T.startOfDay(from) - 1);
      await db.prepare('UPDATE employment_records SET effective_to = ? WHERE id = ?').run(dayBefore, previous.id);
    }
    await db.prepare(`
      INSERT INTO employment_records
        (id, employee_id, job_title, department_id, manager_employee_id, office_id,
         employment_type, working_pattern_id, start_date, probation_start_date,
         probation_review_date, contract_start_date, contract_end_date, notice_period_days,
         holiday_entitlement_days, effective_from, created_at, created_by, change_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(eid, employeeId, String(jobTitle).trim(), departmentId, managerEmployeeId, officeId,
           employmentType, workingPatternId, startDate, probationStartDate, probationReviewDate,
           contractStartDate, contractEndDate, noticePeriodDays, holidayEntitlementDays,
           from, nowMs, actor, String(changeReason).trim());

    // Denormalised onto the employee for fast filtering; the record is the
    // source of truth.
    await db.prepare('UPDATE employees SET department_id = ?, office_id = ?, updated_at = ? WHERE id = ?')
      .run(departmentId, officeId, nowMs, employeeId);

    if (managerEmployeeId) {
      await db.prepare(`
        INSERT INTO manager_assignments (manager_employee_id, employee_id, assigned_at, assigned_by)
        VALUES (?,?,?,?)
        ON CONFLICT(manager_employee_id, employee_id) DO UPDATE SET ended_at = NULL
      `).run(managerEmployeeId, employeeId, nowMs, actor);
    }

    await audit({
      actor, action: previous ? 'EMPLOYMENT_UPDATED' : 'EMPLOYMENT_CREATED',
      targetType: 'employee', targetId: employeeId,
      before: previous ? { jobTitle: previous.job_title, startDate: previous.start_date } : null,
      after: { jobTitle, startDate, contractEndDate, probationReviewDate },
      note: String(changeReason).trim(),
    });
  });

  return { id: eid, employeeId, startDate };
}

async function currentEmployment(employeeId) {
  return await db.prepare(
    'SELECT * FROM employment_records WHERE employee_id = ? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1'
  ).get(employeeId);
}

async function employmentHistory(employeeId) {
  return await db.prepare(
    'SELECT * FROM employment_records WHERE employee_id = ? ORDER BY effective_from DESC'
  ).all(employeeId);
}

// ---------------------------------------------------------------------------
// Employment status (spec 4.3)
// ---------------------------------------------------------------------------

const VALID_STATUS = ['Pre-start', 'Active', 'Probation', 'Probation extended',
  'Notice period', 'Suspended', 'Long-term leave', 'Left employment'];

async function setStatus({ employeeId, status, effectiveDate = null, reason, actor }) {
  if (!VALID_STATUS.includes(status)) throw new Error(`status must be one of ${VALID_STATUS.join(', ')}.`);
  const emp = await db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!emp) throw new Error('No such employee.');
  if (!reason || !String(reason).trim()) throw new Error('A reason is required.');

  const nowMs = T.now();
  const effDate = effectiveDate || T.dateKey(nowMs);

  await tx(async () => {
    await db.prepare(`
      INSERT INTO employment_status_history (employee_id, from_status, to_status, effective_date, reason, changed_at, changed_by)
      VALUES (?,?,?,?,?,?,?)
    `).run(employeeId, emp.employment_status, status, effDate, String(reason).trim(), nowMs, actor);
    await db.prepare('UPDATE employees SET employment_status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowMs, employeeId);

    // A leaver loses access at once. Spec 27.
    if (status === 'Left employment') {
      await db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(employeeId);
      await db.prepare('UPDATE devices SET revoked_at = ? WHERE employee_id = ? AND revoked_at IS NULL').run(nowMs, employeeId);
      await db.prepare(`
        UPDATE device_tokens SET revoked_at = ?
        WHERE device_id IN (SELECT id FROM devices WHERE employee_id = ?) AND revoked_at IS NULL
      `).run(nowMs, employeeId);
      await require('./bindings').revokeForEmployee(employeeId, 'Employee left');
    }

    await audit({
      actor, action: 'STATUS_CHANGED', targetType: 'employee', targetId: employeeId,
      before: { status: emp.employment_status }, after: { status }, note: String(reason).trim(),
    });
  });

  return { status, effectiveDate: effDate };
}

// ---------------------------------------------------------------------------
// Sensitive detail groups (each behind its own permission at the route)
// ---------------------------------------------------------------------------

async function setPersonal({ employeeId, fields, actor }) {
  const cols = ['date_of_birth', 'personal_email', 'mobile_phone', 'address_line1',
    'address_line2', 'city', 'postcode', 'country', 'national_id'];
  const map = {
    dateOfBirth: 'date_of_birth', personalEmail: 'personal_email', mobilePhone: 'mobile_phone',
    addressLine1: 'address_line1', addressLine2: 'address_line2', city: 'city',
    postcode: 'postcode', country: 'country', nationalId: 'national_id',
  };
  const existing = await db.prepare('SELECT * FROM employee_personal WHERE employee_id = ?').get(employeeId) || {};
  const values = {};
  for (const [k, col] of Object.entries(map)) {
    values[col] = fields[k] !== undefined ? fields[k] : (existing[col] ?? null);
  }
  await db.prepare(`
    INSERT INTO employee_personal
      (employee_id, ${cols.join(', ')}, updated_at, updated_by)
    VALUES (@employee_id, ${cols.map(c => '@' + c).join(', ')}, @updated_at, @updated_by)
    ON CONFLICT(employee_id) DO UPDATE SET
      ${cols.map(c => `${c} = excluded.${c}`).join(', ')},
      updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run({ employee_id: employeeId, ...values, updated_at: T.now(), updated_by: actor });

  await audit({ actor, action: 'PERSONAL_UPDATED', targetType: 'employee', targetId: employeeId,
          note: 'Personal details changed' });
  return { updated: true };
}

async function setBank({ employeeId, fields, actor }) {
  const map = { accountName: 'account_name', accountNumber: 'account_number', sortCode: 'sort_code',
    iban: 'iban', bankName: 'bank_name' };
  const cols = Object.values(map);
  const existing = await db.prepare('SELECT * FROM employee_bank_details WHERE employee_id = ?').get(employeeId) || {};
  const values = {};
  for (const [k, col] of Object.entries(map)) {
    values[col] = fields[k] !== undefined ? fields[k] : (existing[col] ?? null);
  }
  await db.prepare(`
    INSERT INTO employee_bank_details
      (employee_id, ${cols.join(', ')}, updated_at, updated_by)
    VALUES (@employee_id, ${cols.map(c => '@' + c).join(', ')}, @updated_at, @updated_by)
    ON CONFLICT(employee_id) DO UPDATE SET
      ${cols.map(c => `${c} = excluded.${c}`).join(', ')},
      updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run({ employee_id: employeeId, ...values, updated_at: T.now(), updated_by: actor });

  // The change is audited; the values themselves are never written to the log.
  await audit({ actor, action: 'BANK_UPDATED', targetType: 'employee', targetId: employeeId,
          note: 'Bank details changed' });
  return { updated: true };
}

async function addEmergencyContact({ employeeId, name, relationship = null, phone = null, email = null, isPrimary = false, actor }) {
  if (!name || !String(name).trim()) throw new Error('A contact name is required.');
  const cid = id('ec');
  if (isPrimary) {
    await db.prepare('UPDATE emergency_contacts SET is_primary = 0 WHERE employee_id = ?').run(employeeId);
  }
  await db.prepare(`
    INSERT INTO emergency_contacts (id, employee_id, name, relationship, phone, email, is_primary, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(cid, employeeId, String(name).trim(), relationship, phone, email, isPrimary ? 1 : 0, T.now());
  await audit({ actor, action: 'EMERGENCY_CONTACT_ADDED', targetType: 'employee', targetId: employeeId });
  return { id: cid };
}

async function updateEmergencyContact({ contactId, employeeId, name, relationship = null, phone = null, email = null, isPrimary = false, actor }) {
  if (!name || !String(name).trim()) throw new Error('A contact name is required.');
  if (isPrimary) {
    await db.prepare('UPDATE emergency_contacts SET is_primary = 0 WHERE employee_id = ?').run(employeeId);
  }
  await db.prepare(`
    UPDATE emergency_contacts
    SET name = ?, relationship = ?, phone = ?, email = ?, is_primary = ?
    WHERE id = ? AND employee_id = ?
  `).run(String(name).trim(), relationship, phone, email, isPrimary ? 1 : 0, contactId, employeeId);
  await audit({ actor, action: 'EMERGENCY_CONTACT_UPDATED', targetType: 'employee', targetId: employeeId });
  return { id: contactId, updated: true };
}

async function deleteEmergencyContact({ contactId, employeeId, actor }) {
  await db.prepare('DELETE FROM emergency_contacts WHERE id = ? AND employee_id = ?').run(contactId, employeeId);
  await audit({ actor, action: 'EMERGENCY_CONTACT_DELETED', targetType: 'employee', targetId: employeeId });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Consolidated profile (spec 37)
// ---------------------------------------------------------------------------

/**
 * Assembles a whole-person profile, including only the field groups the caller
 * is permitted to see. `permissions` is the Set from req.auth; each sensitive
 * group is gated on its own permission, so a manager viewing a report gets
 * employment and attendance but not bank, medical or salary.
 */
async function profile(employeeId, { permissions = new Set(), includeSensitive = true } = {}) {
  const emp = await db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!emp) return null;

  const has = (p) => includeSensitive && permissions.has(p);
  const er = await currentEmployment(employeeId);

  const out = {
    id: emp.id,
    name: emp.name,
    preferredName: emp.preferred_name,
    role: emp.role,
    employeeNumber: emp.employee_number,
    workEmail: emp.work_email,
    employmentStatus: emp.employment_status,
    active: !!emp.active,

    employment: er ? {
      jobTitle: er.job_title,
      departmentId: er.department_id,
      officeId: er.office_id,
      managerEmployeeId: er.manager_employee_id,
      employmentType: er.employment_type,
      startDate: er.start_date,
      probationStartDate: er.probation_start_date,
      probationReviewDate: er.probation_review_date,
      probationOutcome: er.probation_outcome,
      contractStartDate: er.contract_start_date,
      contractEndDate: er.contract_end_date,
      noticePeriodDays: er.notice_period_days,
      holidayEntitlementDays: er.holiday_entitlement_days,
    } : null,

    emergencyContacts: has('employee.nextofkin.read')
      ? (await db.prepare('SELECT * FROM emergency_contacts WHERE employee_id = ?').all(employeeId))
          .map(c => ({ name: c.name, relationship: c.relationship, phone: c.phone, email: c.email, isPrimary: !!c.is_primary }))
      : undefined,

    personal: has('employee.personal.read')
      ? await (async () => {
          const p = await db.prepare('SELECT * FROM employee_personal WHERE employee_id = ?').get(employeeId);
          return p ? {
            dateOfBirth: p.date_of_birth, personalEmail: p.personal_email, mobilePhone: p.mobile_phone,
            addressLine1: p.address_line1, addressLine2: p.address_line2, city: p.city,
            postcode: p.postcode, country: p.country, nationalId: p.national_id,
          } : null;
        })()
      : undefined,

    bank: has('employee.bank.read')
      ? await (async () => {
          const b = await db.prepare('SELECT * FROM employee_bank_details WHERE employee_id = ?').get(employeeId);
          return b ? { accountName: b.account_name, accountNumber: b.account_number,
            sortCode: b.sort_code, iban: b.iban, bankName: b.bank_name } : null;
        })()
      : undefined,

    // The whole-person view names what it is NOT showing, so a gap reads as
    // "you don't have access" rather than "no data".
    restricted: [
      !has('employee.personal.read') && 'personal details',
      !has('employee.bank.read') && 'bank details',
      !has('employee.salary.read') && 'salary',
      !has('employee.nextofkin.read') && 'emergency contacts',
      !has('employee.medical.read') && 'medical documents',
    ].filter(Boolean),
  };

  return out;
}

/**
 * Assembles the employee's own self-service profile for the mobile app.
 * Returns personal details, employment terms, working schedule, emergency contacts,
 * KYC document checklist stats, and salary (ONLY if enabled by HR policy in org_settings).
 */
async function myEmployeeProfile(employeeId) {
  const emp = await db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!emp) return null;

  const er = await currentEmployment(employeeId);
  const dept = emp.department_id ? await db.prepare('SELECT name FROM departments WHERE id = ?').get(emp.department_id) : null;
  const office = (er && er.office_id) ? await db.prepare('SELECT name, time_zone FROM office_locations WHERE id = ?').get(er.office_id) : null;

  const wpId = (er && er.working_pattern_id) || null;
  const wp = wpId
    ? await db.prepare('SELECT * FROM working_patterns WHERE id = ?').get(wpId)
    : (await db.prepare('SELECT * FROM working_patterns WHERE is_default = 1').get() ||
       await db.prepare('SELECT * FROM working_patterns ORDER BY created_at ASC LIMIT 1').get());
  const p = await db.prepare('SELECT * FROM employee_personal WHERE employee_id = ?').get(employeeId);

  const contacts = (await db.prepare('SELECT * FROM emergency_contacts WHERE employee_id = ? ORDER BY is_primary DESC, created_at ASC').all(employeeId))
    .map(c => ({ id: c.id, name: c.name, relationship: c.relationship, phone: c.phone, email: c.email, isPrimary: !!c.is_primary }));

  // Check HR salary visibility setting
  let showSalary = false;
  try {
    const row = await db.prepare("SELECT value FROM org_settings WHERE key = 'show_salary_to_employees'").get();
    if (row && (row.value === '1' || row.value === 'true')) {
      showSalary = true;
    }
  } catch {
    showSalary = false;
  }

  let salary = null;
  if (showSalary) {
    const PR = require('./payroll');
    const s = await PR.salaryAt(employeeId, T.dateKey());
    if (s && !s.blocked) {
      salary = {
        enabled: true,
        monthly: s.monthly,
        daily: s.daily,
        annual: s.annual,
        baseAmount: s.monthly,
        dailyRate: s.daily,
        currency: s.currency || 'PKR',
        effectiveFrom: s.effectiveFrom,
      };
    } else {
      salary = {
        enabled: true,
        blocked: true,
        reason: s ? s.reason : 'NO_SALARY_ON_RECORD',
        message: s ? s.message : 'No salary record on file.',
      };
    }
  } else {
    salary = {
      enabled: false,
      message: 'Salary visibility is disabled by HR policy.',
    };
  }

  const kycDocs = await db.prepare('SELECT verification_status, document_type_id FROM employee_documents WHERE employee_id = ? AND archived_at IS NULL').all(employeeId);
  const kycVerified = kycDocs.filter(d => d.verification_status === 'VERIFIED').length;

  return {
    id: emp.id,
    name: emp.name,
    preferredName: emp.preferred_name,
    role: emp.role,
    employeeNumber: emp.employee_number,
    workEmail: emp.work_email,
    departmentName: dept?.name || null,
    officeName: office?.name || null,
    timeZone: office?.time_zone || 'Asia/Karachi',
    active: !!emp.active,
    employment: er ? {
      jobTitle: er.job_title,
      employmentType: er.employment_type,
      startDate: er.start_date,
      contractStartDate: er.contract_start_date,
      contractEndDate: er.contract_end_date,
      noticePeriodDays: er.notice_period_days,
      holidayEntitlementDays: er.holiday_entitlement_days,
    } : null,
    schedule: {
      startTime: wp?.start_time || '11:00',
      endTime: wp?.end_time || '19:00',
      graceMinutes: wp?.grace_minutes ?? 10,
      breakMinutes: wp?.break_minutes ?? 30,
      workDays: wp?.work_days || 'MON,TUE,WED,THU,FRI',
    },
    personal: p ? {
      dateOfBirth: p.date_of_birth,
      personalEmail: p.personal_email,
      mobilePhone: p.mobile_phone,
      addressLine1: p.address_line1,
      addressLine2: p.address_line2,
      city: p.city,
      postcode: p.postcode,
      country: p.country,
      nationalId: p.national_id,
    } : null,
    emergencyContacts: contacts,
    salary,
    kyc: {
      verifiedCount: kycVerified,
      totalCount: kycDocs.length,
    },
  };
}

/**
 * Generates the next sequential permanent Employee ID (e.g. FW001, FW002, FW003...).
 * Queries all historical employees (including inactive and former employees).
 * IDs are permanent and never reused.
 */
async function nextEmployeeNumber() {
  const rows = await db.prepare('SELECT employee_number FROM employees WHERE employee_number IS NOT NULL').all();
  let maxNum = 0;
  for (const r of rows) {
    if (r.employee_number) {
      const match = /^FW(\d+)$/i.exec(String(r.employee_number).trim());
      if (match) {
        const n = parseInt(match[1], 10);
        if (Number.isFinite(n) && n > maxNum) {
          maxNum = n;
        }
      }
    }
  }
  return 'FW' + String(maxNum + 1).padStart(3, '0');
}

/**
 * Unpairs/revokes all active devices associated with an employee.
 * Disconnects the mobile app without deleting or modifying any historical records.
 */
async function unpairEmployeeDevices({ employeeId, actor }) {
  const employee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!employee) throw new Error('No such employee.');

  const activeDevices = await db.prepare('SELECT id, model FROM devices WHERE employee_id = ? AND revoked_at IS NULL').all(employeeId);
  if (!activeDevices || activeDevices.length === 0) {
    return { ok: true, count: 0, message: 'No active devices paired with this employee.' };
  }

  const nowMs = T.now();
  const bindings = require('./bindings');

  await tx(async () => {
    for (const d of activeDevices) {
      await db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(nowMs, d.id);
      await db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE device_id = ?').run(nowMs, d.id);
      await bindings.revokeForDevice(d.id, `Unpaired by ${actor || 'admin'}`);
    }
    await audit({
      actor: actor || 'admin',
      action: 'EMPLOYEE_DEVICES_UNPAIRED',
      targetType: 'employee',
      targetId: employeeId,
      before: { activeDevicesCount: activeDevices.length },
      after: { activeDevicesCount: 0 },
      note: `Unpaired ${activeDevices.length} device(s) for ${employee.name}`,
    });
  });

  return { ok: true, count: activeDevices.length, message: `Successfully unpaired ${activeDevices.length} device(s).` };
}

module.exports = {
  createOffice, listOffices, createDepartment, listDepartments,
  assignManager, endManagerAssignment,
  setEmployment, currentEmployment, employmentHistory,
  setStatus, setPersonal, setBank, addEmergencyContact,
  updateEmergencyContact, deleteEmergencyContact,
  profile, myEmployeeProfile, nextEmployeeNumber, unpairEmployeeDevices,
  VALID_TYPES, VALID_STATUS,
};

