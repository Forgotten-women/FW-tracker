// Seeding script for historical payroll periods (Jan 2025 - Aug 2026)
// Keeps September 2026 & October 2026 in Current Runs (OPEN for HR review)
require('../src/config');
const crypto = require('crypto');
const { db } = require('../src/db');
const PR = require('../src/domain/payroll');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

async function seedPayrollHistory() {
  console.log('=== SEEDING PAYROLL HISTORY ===');

  // 1. Rename existing 'sept' to 'September 2026' and set cut-off/pay dates
  const sept = await db.prepare("SELECT * FROM payroll_periods WHERE (name = 'sept' OR name = 'September 2026') AND start_date = '2026-09-01'").get();
  if (sept) {
    await db.prepare(`
      UPDATE payroll_periods
      SET name = 'September 2026', cutoff_date = '2026-09-25', pay_date = '2026-09-30'
      WHERE id = ?
    `).run(sept.id);
    console.log(`Updated period ${sept.id} name to 'September 2026' with cutoff 2026-09-25, pay date 2026-09-30`);
  }

  // 2. Build list of historical months: 2025-01 through 2026-08
  const historicalMonths = [];
  // 2025: months 1 to 12
  for (let m = 1; m <= 12; m++) {
    historicalMonths.push({ year: 2025, month: m });
  }
  // 2026: months 1 to 8
  for (let m = 1; m <= 8; m++) {
    historicalMonths.push({ year: 2026, month: m });
  }

  for (const { year, month } of historicalMonths) {
    const name = `${MONTH_NAMES[month - 1]} ${year}`;
    const lastDay = daysInMonth(year, month);
    const startDate = `${year}-${pad(month)}-01`;
    const endDate = `${year}-${pad(month)}-${pad(lastDay)}`;
    const cutoffDate = `${year}-${pad(month)}-25`;
    const payDate = endDate;
    const epochMs = new Date(`${payDate}T17:00:00Z`).getTime();

    // Check if period already exists
    let period = await db.prepare('SELECT * FROM payroll_periods WHERE start_date = ? AND end_date = ?').get(startDate, endDate);
    if (!period) {
      const id = 'pp_' + crypto.randomBytes(6).toString('hex');
      await db.prepare(`
        INSERT INTO payroll_periods
          (id, name, start_date, end_date, cutoff_date, pay_date, exchange_rate,
           processing_fee, processing_fee_type, processing_fee_basis,
           status, auto_created, created_at, generated_at, published_at, published_by, paid_at,
           approved_by, approved_at, approval_note)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'system', ?, 'system', ?, 'Historical payroll month seeded from attendance & employment records')
      `).run(
        id, name, startDate, endDate, cutoffDate, payDate, 350.0,
        0, 'DEDUCTION', 'PERCENT',
        'PAID', epochMs, epochMs, epochMs, epochMs, epochMs
      );
      period = await db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(id);
      console.log(`Created historical period: ${name} (${id})`);
    } else {
      console.log(`Period ${name} already exists (${period.id}, status: ${period.status})`);
    }

    // Write payslips for employees employed during this historical month if none exist
    const slipCount = (await db.prepare('SELECT COUNT(*) AS c FROM payslips WHERE period_id = ?').get(period.id)).c;
    if (Number(slipCount) === 0) {
      const { run } = await PR.runMembers(period);
      let written = 0;
      for (const member of run) {
        try {
          await PR.writePayslip(period, member, {
            actor: 'system',
            nowMs: epochMs,
            approvalNote: 'Historical run seeded',
          });
          written++;
        } catch (err) {
          // If already exists or error, continue
        }
      }
      // Ensure payslips are stamped paid
      await db.prepare("UPDATE payslips SET status = 'PUBLISHED', paid_at = ? WHERE period_id = ?").run(epochMs, period.id);
      console.log(`  -> Wrote and stamped ${written} payslips for ${name}`);
    } else {
      console.log(`  -> Already has ${slipCount} payslips`);
    }
  }

  // 3. For September 2026 and October 2026: generate real-time deductions
  const activePeriods = await db.prepare("SELECT * FROM payroll_periods WHERE start_date IN ('2026-09-01', '2026-10-01')").all();
  for (const ap of activePeriods) {
    try {
      const res = await PR.generatePeriodDeductions({ periodId: ap.id, actor: 'system' });
      console.log(`Synced real-time deductions for ${ap.name} (${ap.id}): ${res.createdCount} new lines, ${res.employees} employees`);
    } catch (err) {
      console.warn(`Could not sync deductions for ${ap.name}:`, err.message);
    }
  }

  // Clear cache so all fresh periods are visible immediately
  await PR.invalidatePayrollCache();
  console.log('=== SEEDING COMPLETED SUCCESSFULLY ===');
}

if (require.main === module) {
  seedPayrollHistory()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exit(1);
    });
}

module.exports = { seedPayrollHistory };
