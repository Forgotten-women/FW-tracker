// Comprehensive Attendance, Timesheet, Leave & Payroll Export Engine
// Compliant with App Updates Specification (Sections 1-19, 429-436).
// Produces multi-tab styled Excel (.xlsx) workbooks and CSV files.

const ExcelJS = require('exceljs');
const { db } = require('../db');
const schedule = require('./schedule');
const attendance = require('./attendance');
const leave = require('./leave');
const PR = require('./payroll');
const T = require('../util/time');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatMins(mins) {
  if (!mins || mins <= 0) return '0m';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatDateDisplay(dateKey) {
  if (!dateKey) return '';
  const [y, m, d] = dateKey.split('-');
  return `${d}/${m}/${y}`;
}

function getDaysInRange(startDate, endDate) {
  const days = [];
  let curr = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (curr <= end) {
    days.push(curr.toISOString().slice(0, 10));
    curr.setUTCDate(curr.getUTCDate() + 1);
  }
  return days;
}

/**
 * Aggregates all workforce attendance, schedule, leave, and payroll data
 * for the requested date window.
 */
async function generateReportData({ from, to, employeeId = null, workStatus = null, departmentId = null }) {
  const nowMs = T.now();
  const startDate = from || T.dateKey(T.startOfMonth(nowMs));
  const endDate = to || T.dateKey(nowMs);
  const dateList = getDaysInRange(startDate, endDate);

  // 1. Fetch targeted employees
  let empQuery = 'SELECT * FROM employees WHERE active = 1';
  const empParams = [];
  if (employeeId) {
    empQuery += ' AND id = ?';
    empParams.push(employeeId);
  }
  if (workStatus) {
    empQuery += ' AND work_mode = ?';
    empParams.push(workStatus);
  }
  if (departmentId) {
    empQuery += ' AND department_id = ?';
    empParams.push(departmentId);
  }
  empQuery += ' ORDER BY employee_number ASC NULLS LAST, name ASC';
  const employees = await db.prepare(empQuery).all(...empParams);

  // 2. Fetch approved leave requests overlapping this window
  const leaveRows = await db.prepare(`
    SELECT * FROM leave_requests
    WHERE status = 'APPROVED'
      AND start_date <= ? AND end_date >= ?
  `).all(endDate, startDate);

  const leaveByEmpDate = {};
  for (const lr of leaveRows) {
    const lDays = getDaysInRange(
      lr.start_date < startDate ? startDate : lr.start_date,
      lr.end_date > endDate ? endDate : lr.end_date
    );
    for (const d of lDays) {
      if (!leaveByEmpDate[lr.employee_id]) leaveByEmpDate[lr.employee_id] = {};
      leaveByEmpDate[lr.employee_id][d] = lr;
    }
  }

  // 3. Process each employee
  const employeeReports = [];

  for (const emp of employees) {
    const empId = emp.id;
    const empSched = await schedule.resolve(empId, endDate);
    const empSalary = await PR.salaryAt(empId, endDate).catch(() => null);
    const periodAdjustments = await attendance.listPeriodAdjustments(empId, startDate, endDate);
    const totalPeriodCreditMins = periodAdjustments.reduce((sum, a) => sum + (a.credit_minutes || 0), 0);

    const dailyRows = [];
    let expectedWorkingDays = 0;
    let completeWorkingDays = 0;
    let incompleteWorkingDays = 0;
    let scheduledDaysOff = 0;
    let missingDays = 0;
    let wfhDaysCount = 0;
    let remoteDaysCount = 0;
    let paidLeaveDaysCount = 0;
    let unpaidLeaveDaysCount = 0;
    let sickLeaveDaysCount = 0;
    let compassionateLeaveDaysCount = 0;
    let unauthorisedAbsenceDaysCount = 0;

    let totalWorkedMinutes = 0;
    let totalPayrollMinutes = 0;
    let totalLateMinutes = 0;
    let totalEarlyMinutes = 0;
    let totalExtraBreakMinutes = 0;
    let grossShortfallMinutes = 0;
    let totalDailyApprovedCredit = 0;

    for (const dKey of dateList) {
      const dt = new Date(dKey + 'T00:00:00Z');
      const dayName = DAY_NAMES[dt.getUTCDay()];
      const daySched = await schedule.resolve(empId, dKey);
      const isWorkDay = daySched.isWorkingDay;

      // Check leave for this day
      const leaveForDay = leaveByEmpDate[empId] && leaveByEmpDate[empId][dKey];

      // Derive daily attendance figures
      const derived = await attendance.deriveDay(empId, dKey, nowMs).catch(() => ({}));
      const workedMins = Number(derived.workedMinutes) || 0;
      const firstIn = derived.firstInAt ? T.displayTime(derived.firstInAt) : null;
      const lastOut = derived.lastSeenAt ? T.displayTime(derived.lastSeenAt) : null;
      const totalBreaksMins = (derived.breaks || []).reduce((sum, b) => sum + (b.actualMinutes || 0), 0);
      const allowedBreakMins = daySched.permittedBreakMinutes || 30;
      const excessBreakMins = Number(derived.excessBreakMinutes) || 0;
      const lateMins = Number(derived.lateMinutes) || 0;
      const earlyMins = Number(derived.earlyDepartureMinutes) || 0;
      const dailyDeficitMins = Number(derived.dailyDeficitMinutes) || 0;
      const dailyCreditMins = Math.abs(Number(derived.approvedAdjustmentMinutes) || 0);
      const dailyNetShortfall = Math.max(0, dailyDeficitMins - dailyCreditMins);

      // Determine Work Status & Daily Status Label
      let workStatusLabel = emp.work_mode || 'Office';
      if (workStatusLabel === 'IN_OFFICE') workStatusLabel = 'Office';
      if (workStatusLabel === 'REMOTE') workStatusLabel = 'Remote';
      if (workStatusLabel === 'HYBRID') workStatusLabel = 'Hybrid';

      let dailyStatus = 'Present';
      let payrollMins = workedMins;

      if (!isWorkDay) {
        scheduledDaysOff++;
        dailyStatus = daySched.nonWorkingReason || 'Scheduled Day Off';
        workStatusLabel = 'Rest Day';
      } else if (leaveForDay) {
        const lType = String(leaveForDay.type || '').toUpperCase();
        if (lType.includes('SICK')) {
          dailyStatus = 'Sick Leave';
          sickLeaveDaysCount++;
        } else if (lType.includes('UNPAID')) {
          dailyStatus = 'Unpaid Leave';
          unpaidLeaveDaysCount++;
        } else if (lType.includes('COMPASSIONATE')) {
          dailyStatus = 'Compassionate Leave';
          compassionateLeaveDaysCount++;
        } else {
          dailyStatus = 'Paid Leave';
          paidLeaveDaysCount++;
          payrollMins = daySched.dayEquivalentMinutes || 480;
        }
        workStatusLabel = 'Leave';
      } else {
        expectedWorkingDays++;
        if (workStatusLabel === 'WFH') wfhDaysCount++;
        if (workStatusLabel === 'Remote') remoteDaysCount++;

        if (workedMins >= (daySched.dayEquivalentMinutes || 450)) {
          dailyStatus = 'Complete Day';
          completeWorkingDays++;
        } else if (workedMins > 0) {
          dailyStatus = lateMins > 0 ? 'Late / Incomplete' : 'Incomplete Day';
          incompleteWorkingDays++;
        } else {
          // 0 minutes worked on a regular working day
          dailyStatus = 'Unauthorised Absence';
          unauthorisedAbsenceDaysCount++;
          missingDays++;
        }
      }

      totalWorkedMinutes += workedMins;
      totalPayrollMinutes += payrollMins;
      totalLateMinutes += lateMins;
      totalEarlyMinutes += earlyMins;
      totalExtraBreakMinutes += excessBreakMins;
      grossShortfallMinutes += dailyDeficitMins;
      totalDailyApprovedCredit += dailyCreditMins;

      dailyRows.push({
        dateKey: dKey,
        dateFormatted: formatDateDisplay(dKey),
        dayName,
        workStatus: workStatusLabel,
        scheduledShift: isWorkDay ? `${daySched.startTime} - ${daySched.endTime}` : '—',
        payrollHoursFormatted: formatMins(payrollMins),
        payrollMinutes: payrollMins,
        regularHoursFormatted: formatMins(workedMins),
        regularMinutes: workedMins,
        checkIn: firstIn || '--:--',
        checkOut: lastOut || '--:--',
        breakDurationFormatted: totalBreaksMins > 0 ? `${totalBreaksMins}m` : '0m',
        breakMinutes: totalBreaksMins,
        allowedBreakFormatted: `${allowedBreakMins}m`,
        allowedBreakMinutes: allowedBreakMins,
        dailyStatus,
        grossShortfallFormatted: dailyDeficitMins > 0 ? `${dailyDeficitMins}m` : '0m',
        grossShortfallMinutes: dailyDeficitMins,
        creditFormatted: dailyCreditMins > 0 ? `${dailyCreditMins}m` : '0m',
        creditMinutes: dailyCreditMins,
        netShortfallFormatted: dailyNetShortfall > 0 ? `${dailyNetShortfall}m` : '0m',
        netShortfallMinutes: dailyNetShortfall,
      });
    }

    // Roll up monthly figures
    const totalApprovedCreditMinutes = totalDailyApprovedCredit + totalPeriodCreditMins;
    const netShortfallMinutes = Math.max(0, grossShortfallMinutes - totalApprovedCreditMinutes);
    const surplusCreditMinutes = Math.max(0, totalApprovedCreditMinutes - grossShortfallMinutes);

    // Leave Summary
    const leaveBal = await leave.balanceFor(empId, endDate).catch(() => null);
    const annualLeaveOpening = leaveBal ? Number(leaveBal.annualEntitlementDays || 20) : 20;
    const annualLeaveClosing = leaveBal ? Number(leaveBal.availableDays || 0) : 0;
    const annualLeaveUsed = Math.max(0, paidLeaveDaysCount);

    // Payroll Summary
    const monthlyWage = empSalary && !empSalary.blocked ? Number(empSalary.monthly) : 0;
    const dailyWageRate = empSalary && !empSalary.blocked ? Number(empSalary.daily) : (monthlyWage / 22);
    const currency = empSalary?.currency || 'PKR';

    // Shortfall deduction: net deficit converted to day fraction
    const deficitDaysEquivalent = (netShortfallMinutes / (empSched.dayEquivalentMinutes || 480));
    const attendanceDeduction = Math.round(deficitDaysEquivalent * dailyWageRate);
    const unpaidLeaveDeduction = Math.round(unpaidLeaveDaysCount * dailyWageRate);
    const finalPayrollAmount = Math.max(0, Math.round(monthlyWage - attendanceDeduction - unpaidLeaveDeduction));

    employeeReports.push({
      employee: {
        id: emp.id,
        name: emp.name,
        employeeNumber: emp.employee_number || 'N/A',
        role: emp.role || 'Team Member',
        workStatus: emp.work_mode || 'IN_OFFICE',
        departmentId: emp.department_id || null,
        scheduleSummary: `${empSched.startTime} - ${empSched.endTime}`,
        permittedBreakMinutes: empSched.permittedBreakMinutes || 30,
        dayEquivalentMinutes: empSched.dayEquivalentMinutes || 480,
        overtimeCounted: Boolean(emp.overtime_counted),
      },
      period: {
        startDate,
        endDate,
        dateCount: dateList.length,
      },
      attendanceSummary: {
        expectedWorkingDays,
        completeWorkingDays,
        incompleteWorkingDays,
        scheduledDaysOff,
        missingDays,
        wfhDays: wfhDaysCount,
        remoteDays: remoteDaysCount,
        totalWorkedMinutes,
        totalWorkedFormatted: formatMins(totalWorkedMinutes),
        totalPayrollMinutes,
        totalPayrollFormatted: formatMins(totalPayrollMinutes),
        totalLateMinutes,
        totalLateFormatted: formatMins(totalLateMinutes),
        totalEarlyMinutes,
        totalEarlyFormatted: formatMins(totalEarlyMinutes),
        totalExtraBreakMinutes,
        totalExtraBreakFormatted: formatMins(totalExtraBreakMinutes),
        grossShortfallMinutes,
        grossShortfallFormatted: formatMins(grossShortfallMinutes),
        approvedCreditMinutes: totalApprovedCreditMinutes,
        approvedCreditFormatted: formatMins(totalApprovedCreditMinutes),
        periodCreditMinutes: totalPeriodCreditMins,
        periodCreditFormatted: formatMins(totalPeriodCreditMins),
        netShortfallMinutes,
        netShortfallFormatted: formatMins(netShortfallMinutes),
        surplusCreditMinutes,
        surplusCreditFormatted: formatMins(surplusCreditMinutes),
      },
      leaveSummary: {
        paidLeaveDays: paidLeaveDaysCount,
        unpaidLeaveDays: unpaidLeaveDaysCount,
        sickLeaveDays: sickLeaveDaysCount,
        compassionateLeaveDays: compassionateLeaveDaysCount,
        unauthorisedAbsenceDays: unauthorisedAbsenceDaysCount,
        annualLeaveOpening,
        annualLeaveUsed,
        annualLeaveClosing,
      },
      payrollSummary: {
        currency,
        monthlyWage,
        dailyWageRate,
        attendanceDeduction,
        unpaidLeaveDeduction,
        manualAdjustment: 0,
        finalPayrollAmount,
      },
      dailyRecords: dailyRows,
      periodAdjustments,
    });
  }

  return {
    meta: {
      generatedAt: T.displayTime(nowMs),
      generatedAtMs: nowMs,
      startDate,
      endDate,
      formattedPeriod: `${formatDateDisplay(startDate)} – ${formatDateDisplay(endDate)}`,
      totalEmployees: employeeReports.length,
    },
    employees: employeeReports,
  };
}

/**
 * Builds an Excel Workbook (.xlsx) with:
 * - Sheet 1: "Overall Summary" (All Employees)
 * - Sheets 2..N: Individual Employee Tabs with Top Setup & Daily Records
 */
async function buildExcelWorkbook(reportData) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Forgotten Women Office Tracker';
  wb.created = new Date();

  const brandNavy = '1E1B4B';
  const brandIndigo = '4338CA';
  const softHeaderBg = 'EEF2FF';
  const zebraBg = 'F8FAFC';
  const borderGrey = 'CBD5E1';

  // ---------------------------------------------------------------------------
  // SHEET 1: Overall Summary
  // ---------------------------------------------------------------------------
  const summarySheet = wb.addWorksheet('Overall Summary', {
    views: [{ showGridLines: true }],
  });

  // Title Banner
  summarySheet.mergeCells('A1:X1');
  const titleCell = summarySheet.getCell('A1');
  titleCell.value = 'OFFICE TRACKER — WORKFORCE ATTENDANCE & PAYROLL SUMMARY';
  titleCell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandNavy } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  summarySheet.getRow(1).height = 40;

  // Metadata Row
  summarySheet.mergeCells('A2:X2');
  const metaCell = summarySheet.getCell('A2');
  metaCell.value = `Payroll & Attendance Period: ${reportData.meta.formattedPeriod}  |  Total Workforce: ${reportData.meta.totalEmployees} Employees  |  Generated: ${reportData.meta.generatedAt}`;
  metaCell.font = { name: 'Calibri', size: 11, italic: true, color: { argb: 'FFFFFFFF' } };
  metaCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandIndigo } };
  metaCell.alignment = { vertical: 'middle', horizontal: 'center' };
  summarySheet.getRow(2).height = 24;

  summarySheet.addRow([]); // Blank line

  // Summary Table Header
  const summaryHeaders = [
    'Employee ID', 'Employee Name', 'Role', 'Work Status', 'Main Schedule', 'Break Allowance',
    'Expected Days', 'Complete Days', 'Days Off', 'WFH Days', 'Paid Leave', 'Unpaid Leave',
    'Sick Leave', 'Compassionate', 'Unauth. Absence', 'Missing Days',
    'Total Worked (Reg)', 'Payroll Hours', 'Late Arrival', 'Early Leave', 'Extra Break',
    'Gross Shortfall', 'Approved Credit', 'Net Shortfall', 'Monthly Wage', 'Deduction', 'Final Pay'
  ];

  const headerRow = summarySheet.addRow(summaryHeaders);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandNavy } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: borderGrey } },
      left: { style: 'thin', color: { argb: borderGrey } },
      bottom: { style: 'medium', color: { argb: brandNavy } },
      right: { style: 'thin', color: { argb: borderGrey } },
    };
  });

  // Summary Table Rows
  reportData.employees.forEach((er, idx) => {
    const e = er.employee;
    const a = er.attendanceSummary;
    const l = er.leaveSummary;
    const p = er.payrollSummary;

    const row = summarySheet.addRow([
      e.employeeNumber,
      e.name,
      e.role,
      e.workStatus,
      e.scheduleSummary,
      `${e.permittedBreakMinutes}m`,
      a.expectedWorkingDays,
      a.completeWorkingDays,
      a.scheduledDaysOff,
      a.wfhDays,
      l.paidLeaveDays,
      l.unpaidLeaveDays,
      l.sickLeaveDays,
      l.compassionateLeaveDays,
      l.unauthorisedAbsenceDays,
      a.missingDays,
      a.totalWorkedFormatted,
      a.totalPayrollFormatted,
      a.totalLateFormatted,
      a.totalEarlyFormatted,
      a.totalExtraBreakFormatted,
      a.grossShortfallFormatted,
      a.approvedCreditFormatted,
      a.netShortfallFormatted,
      p.monthlyWage,
      p.attendanceDeduction + p.unpaidLeaveDeduction,
      p.finalPayrollAmount,
    ]);

    row.height = 22;
    const isEven = idx % 2 === 0;

    row.eachCell((cell, colNum) => {
      cell.font = { name: 'Calibri', size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isEven ? 'FFFFFFFF' : zebraBg } };
      cell.border = {
        top: { style: 'thin', color: { argb: borderGrey } },
        left: { style: 'thin', color: { argb: borderGrey } },
        bottom: { style: 'thin', color: { argb: borderGrey } },
        right: { style: 'thin', color: { argb: borderGrey } },
      };

      // Alignment
      if (colNum <= 3) {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      } else if (colNum >= summaryHeaders.length - 2) {
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        cell.numFmt = '#,##0';
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }

      // Highlight Net Shortfall
      if (colNum === 24 && a.netShortfallMinutes > 0) {
        cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFB91C1C' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      }
    });
  });

  // Adjust column widths for summary sheet
  summarySheet.columns.forEach((col, idx) => {
    const headerLen = summaryHeaders[idx] ? summaryHeaders[idx].length : 12;
    col.width = Math.max(headerLen + 4, 13);
  });
  summarySheet.getColumn(2).width = 24; // Name
  summarySheet.getColumn(3).width = 24; // Role

  // ---------------------------------------------------------------------------
  // SHEETS 2..N: Individual Employee Tabs
  // ---------------------------------------------------------------------------
  for (const er of reportData.employees) {
    const e = er.employee;
    const a = er.attendanceSummary;
    const l = er.leaveSummary;
    const p = er.payrollSummary;

    // Excel sheet name limit is 31 chars
    const rawSheetName = `${e.employeeNumber} - ${e.name.split(' ')[0]}`.replace(/[\\/*?:[\]]/g, '');
    const tabName = rawSheetName.slice(0, 30);

    const ws = wb.addWorksheet(tabName, {
      views: [{ showGridLines: true }],
    });

    // 1. Employee Header Banner
    ws.mergeCells('A1:N1');
    const empBanner = ws.getCell('A1');
    empBanner.value = `${e.name} (${e.employeeNumber}) — ATTENDANCE & PAYROLL RECORD`;
    empBanner.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    empBanner.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandNavy } };
    empBanner.alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(1).height = 36;

    // 2. Sections Overview (Top Summary Blocks)
    // Section Headers
    ws.addRow([]);
    const secHead = ws.addRow(['1. EMPLOYEE & WORK SETUP', '', '', '', '2. ATTENDANCE & DEFICIT SUMMARY', '', '', '', '3. LEAVE & PAYROLL SUMMARY']);
    secHead.height = 24;
    [1, 5, 9].forEach(col => {
      const c = secHead.getCell(col);
      c.font = { name: 'Calibri', size: 11, bold: true, color: { argb: brandNavy } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: softHeaderBg } };
    });

    // Info Grid
    const infoRows = [
      ['Employee Name', e.name, '', '', 'Expected Working Days', a.expectedWorkingDays, '', '', 'Monthly Base Wage', `${p.currency} ${p.monthlyWage.toLocaleString()}`],
      ['Employee ID', e.employeeNumber, '', '', 'Complete Working Days', a.completeWorkingDays, '', '', 'Attendance Deduction', `${p.currency} ${p.attendanceDeduction.toLocaleString()}`],
      ['Role / Title', e.role, '', '', 'Scheduled Days Off', a.scheduledDaysOff, '', '', 'Unpaid Leave Deduction', `${p.currency} ${p.unpaidLeaveDeduction.toLocaleString()}`],
      ['Work Status', e.workStatus, '', '', 'WFH / Remote Days', `${a.wfhDays} WFH / ${a.remoteDays} Rem`, '', '', 'Final Payroll Amount', `${p.currency} ${p.finalPayrollAmount.toLocaleString()}`],
      ['Main Schedule', e.scheduleSummary, '', '', 'Total Worked Hours', a.totalWorkedFormatted, '', '', 'Annual Leave Balance', `${l.annualLeaveClosing} days available`],
      ['Break Allowance', `${e.permittedBreakMinutes} mins`, '', '', 'Gross Shortfall', a.grossShortfallFormatted, '', '', 'Paid Leave Used', `${l.paidLeaveDays} days`],
      ['Overtime Counted', e.overtimeCounted ? 'Enabled' : 'Disabled', '', '', 'Approved Credit (Total)', a.approvedCreditFormatted, '', '', 'Unauthorised Absence', `${l.unauthorisedAbsenceDays} days`],
      ['Payroll Period', reportData.meta.formattedPeriod, '', '', 'Net Shortfall', a.netShortfallFormatted, '', '', 'Surplus Extra Time', a.surplusCreditFormatted],
    ];

    infoRows.forEach(r => {
      const row = ws.addRow(r);
      row.height = 20;
      row.getCell(1).font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF475569' } };
      row.getCell(2).font = { name: 'Calibri', size: 10, bold: true };
      row.getCell(5).font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF475569' } };
      row.getCell(6).font = { name: 'Calibri', size: 10, bold: true };
      row.getCell(9).font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF475569' } };
      row.getCell(10).font = { name: 'Calibri', size: 10, bold: true };
      
      // Highlight Net Shortfall in Red if > 0
      if (r[4] === 'Net Shortfall' && a.netShortfallMinutes > 0) {
        row.getCell(6).font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFB91C1C' } };
      }
      // Highlight Final Pay in Green
      if (r[8] === 'Final Payroll Amount') {
        row.getCell(10).font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF15803D' } };
      }
    });

    ws.addRow([]); // Blank spacer

    // Detailed Daily Attendance Header
    ws.mergeCells(`A13:N13`);
    const tableTitle = ws.getCell('A13');
    tableTitle.value = 'DETAILED DAY-BY-DAY ATTENDANCE & TIMESHEET ENTRIES';
    tableTitle.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    tableTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandIndigo } };
    tableTitle.alignment = { vertical: 'middle', horizontal: 'center' };
    ws.getRow(13).height = 28;

    const dailyHeaders = [
      'Date', 'Day', 'Work Status', 'Scheduled Shift', 'Payroll Hrs', 'Reg. Hrs',
      'Check In', 'Check Out', 'Break Taken', 'Break Allowed', 'Daily Status',
      'Gross Shortfall', 'Approved Credit', 'Net Shortfall'
    ];

    const dHeadRow = ws.addRow(dailyHeaders);
    dHeadRow.height = 24;
    dHeadRow.eachCell(c => {
      c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: brandNavy } };
      c.alignment = { vertical: 'middle', horizontal: 'center' };
      c.border = {
        top: { style: 'thin', color: { argb: borderGrey } },
        bottom: { style: 'medium', color: { argb: brandNavy } },
        left: { style: 'thin', color: { argb: borderGrey } },
        right: { style: 'thin', color: { argb: borderGrey } },
      };
    });

    // Daily records
    er.dailyRecords.forEach((dr, dIdx) => {
      const dRow = ws.addRow([
        dr.dateFormatted,
        dr.dayName,
        dr.workStatus,
        dr.scheduledShift,
        dr.payrollHoursFormatted,
        dr.regularHoursFormatted,
        dr.checkIn,
        dr.checkOut,
        dr.breakDurationFormatted,
        dr.allowedBreakFormatted,
        dr.dailyStatus,
        dr.grossShortfallFormatted,
        dr.creditFormatted,
        dr.netShortfallFormatted,
      ]);

      dRow.height = 20;
      const isEven = dIdx % 2 === 0;

      dRow.eachCell((c, colNum) => {
        c.font = { name: 'Calibri', size: 10 };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isEven ? 'FFFFFFFF' : zebraBg } };
        c.border = {
          top: { style: 'thin', color: { argb: borderGrey } },
          bottom: { style: 'thin', color: { argb: borderGrey } },
          left: { style: 'thin', color: { argb: borderGrey } },
          right: { style: 'thin', color: { argb: borderGrey } },
        };
        c.alignment = { vertical: 'middle', horizontal: colNum === 11 ? 'left' : 'center' };

        // Badge styling for Daily Status
        if (colNum === 11) {
          if (dr.dailyStatus === 'Complete Day') {
            c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF15803D' } };
          } else if (dr.dailyStatus.includes('Late') || dr.dailyStatus === 'Incomplete Day') {
            c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFB45309' } };
          } else if (dr.dailyStatus.includes('Leave')) {
            c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF1D4ED8' } };
          } else if (dr.dailyStatus === 'Unauthorised Absence') {
            c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFB91C1C' } };
          }
        }

        // Highlight Net Shortfall
        if (colNum === 14 && dr.netShortfallMinutes > 0) {
          c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFB91C1C' } };
        }
      });
    });

    // Column widths
    ws.columns = [
      { width: 14 }, // Date
      { width: 14 }, // Day
      { width: 14 }, // Work Status
      { width: 18 }, // Scheduled Shift
      { width: 13 }, // Payroll Hrs
      { width: 13 }, // Reg Hrs
      { width: 12 }, // In
      { width: 12 }, // Out
      { width: 14 }, // Break Taken
      { width: 14 }, // Break Allowed
      { width: 20 }, // Daily Status
      { width: 15 }, // Gross Shortfall
      { width: 15 }, // Credit
      { width: 15 }, // Net Shortfall
    ];
  }

  return wb;
}

/**
 * Builds CSV export string (Overall summary + daily detail)
 */
function buildCsv(reportData) {
  const lines = [];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  lines.push(`FORGOTTEN WOMEN - WORKFORCE ATTENDANCE & PAYROLL REPORT`);
  lines.push(`Period,${reportData.meta.formattedPeriod},Total Employees,${reportData.meta.totalEmployees},Generated,${reportData.meta.generatedAt}`);
  lines.push('');

  lines.push('OVERALL WORKFORCE SUMMARY');
  lines.push([
    'Employee ID', 'Employee Name', 'Role', 'Work Status', 'Main Schedule', 'Break Allowance',
    'Expected Days', 'Complete Days', 'Days Off', 'WFH Days', 'Paid Leave', 'Unpaid Leave',
    'Sick Leave', 'Unauth. Absence', 'Worked Hours', 'Payroll Hours',
    'Gross Shortfall', 'Approved Credit', 'Net Shortfall', 'Monthly Wage', 'Final Pay'
  ].join(','));

  for (const er of reportData.employees) {
    const e = er.employee;
    const a = er.attendanceSummary;
    const l = er.leaveSummary;
    const p = er.payrollSummary;

    lines.push([
      esc(e.employeeNumber), esc(e.name), esc(e.role), esc(e.workStatus), esc(e.scheduleSummary), `${e.permittedBreakMinutes}m`,
      a.expectedWorkingDays, a.completeWorkingDays, a.scheduledDaysOff, a.wfhDays, l.paidLeaveDays, l.unpaidLeaveDays,
      l.sickLeaveDays, l.unauthorisedAbsenceDays, esc(a.totalWorkedFormatted), esc(a.totalPayrollFormatted),
      esc(a.grossShortfallFormatted), esc(a.approvedCreditFormatted), esc(a.netShortfallFormatted), p.monthlyWage, p.finalPayrollAmount
    ].join(','));
  }

  lines.push('');
  lines.push('DETAILED DAILY ATTENDANCE');
  lines.push([
    'Employee ID', 'Employee Name', 'Date', 'Day', 'Work Status', 'Scheduled Shift',
    'Payroll Hrs', 'Reg. Hrs', 'Check In', 'Check Out', 'Break Taken', 'Break Allowed',
    'Daily Status', 'Gross Shortfall', 'Approved Credit', 'Net Shortfall'
  ].join(','));

  for (const er of reportData.employees) {
    const e = er.employee;
    for (const dr of er.dailyRecords) {
      lines.push([
        esc(e.employeeNumber), esc(e.name), dr.dateFormatted, esc(dr.dayName), esc(dr.workStatus), esc(dr.scheduledShift),
        esc(dr.payrollHoursFormatted), esc(dr.regularHoursFormatted), esc(dr.checkIn), esc(dr.checkOut),
        esc(dr.breakDurationFormatted), esc(dr.allowedBreakFormatted), esc(dr.dailyStatus),
        esc(dr.grossShortfallFormatted), esc(dr.creditFormatted), esc(dr.netShortfallFormatted)
      ].join(','));
    }
  }

  return lines.join('\n');
}

module.exports = {
  generateReportData,
  buildExcelWorkbook,
  buildCsv,
};
