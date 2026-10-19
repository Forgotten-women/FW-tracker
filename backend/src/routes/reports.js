// Reports & Detailed Export Routes
// Compliant with App Updates Specification (Sections 1-19, 429-436).

const express = require('express');
const router = express.Router();
const { requireUserOrAdminKey, requirePermission } = require('../middleware/auth');
const exportReport = require('../domain/exportReport');
const attendance = require('../domain/attendance');
const { audit } = require('../db');
const T = require('../util/time');

// ---------------------------------------------------------------------------
// GET /api/reports/export - Download Excel (.xlsx) or CSV report
// ---------------------------------------------------------------------------
router.get('/export', requireUserOrAdminKey('attendance.read'), async (req, res) => {
  try {
    const { from, to, employeeId, workStatus, departmentId, format = 'excel' } = req.query;

    const reportData = await exportReport.generateReportData({
      from,
      to,
      employeeId: employeeId || null,
      workStatus: workStatus || null,
      departmentId: departmentId || null,
    });

    const isSingle = Boolean(employeeId && reportData.employees.length === 1);
    const empNum = isSingle ? reportData.employees[0].employee.employeeNumber : 'all';
    const filenameBase = `attendance-report-${empNum}-${reportData.meta.startDate}_${reportData.meta.endDate}`;

    await audit({
      actor: req.auth?.user?.username || req.auth?.actor || 'HR',
      action: 'ATTENDANCE_REPORT_EXPORTED',
      targetType: isSingle ? 'employee' : 'workforce',
      targetId: employeeId || 'all',
      note: `Exported ${format} report for period ${reportData.meta.formattedPeriod} (${reportData.meta.totalEmployees} employees)`,
    });

    if (String(format).toLowerCase() === 'csv') {
      const csvContent = exportReport.buildCsv(reportData);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
      return res.send(csvContent);
    }

    // Default: Multi-tab Excel (.xlsx)
    const workbook = await exportReport.buildExcelWorkbook(reportData);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[reports/export] Error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/reports/preview - JSON preview data for web dashboard views
// ---------------------------------------------------------------------------
router.get('/preview', requireUserOrAdminKey('attendance.read'), async (req, res) => {
  try {
    const { from, to, employeeId, workStatus, departmentId } = req.query;
    const reportData = await exportReport.generateReportData({
      from,
      to,
      employeeId: employeeId || null,
      workStatus: workStatus || null,
      departmentId: departmentId || null,
    });
    res.json({ status: 'SUCCESS', ...reportData });
  } catch (err) {
    console.error('[reports/preview] Error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/reports/period-adjustment - Record bulk period adjustment / extra time
// ---------------------------------------------------------------------------
router.post('/period-adjustment', requireUserOrAdminKey('attendance.write'), async (req, res) => {
  try {
    const { employeeId, periodStart, periodEnd, creditMinutes, reason } = req.body;
    if (!employeeId) {
      return res.status(400).json({ status: 'ERROR', message: 'employeeId is required.' });
    }
    const mins = parseInt(creditMinutes, 10);
    if (isNaN(mins) || mins <= 0) {
      return res.status(400).json({ status: 'ERROR', message: 'creditMinutes must be a positive integer.' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ status: 'ERROR', message: 'An explanation / reason is required.' });
    }

    const actor = req.auth?.user?.username || req.auth?.actor || 'HR';
    const result = await attendance.addPeriodAdjustment({
      employeeId,
      periodStart: periodStart || T.dateKey(),
      periodEnd: periodEnd || T.dateKey(),
      minutes: mins,
      reason: String(reason).trim(),
      actor,
    });

    res.json({
      status: 'SUCCESS',
      message: `Successfully credited ${mins} minutes for period ${periodStart || 'current'} – ${periodEnd || 'current'}.`,
      ...result,
    });
  } catch (err) {
    console.error('[reports/period-adjustment] Error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/reports/period-adjustments/:employeeId - List period adjustments
// ---------------------------------------------------------------------------
router.get('/period-adjustments/:employeeId', requireUserOrAdminKey('attendance.read'), async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { periodStart, periodEnd } = req.query;
    const list = await attendance.listPeriodAdjustments(employeeId, periodStart, periodEnd);
    res.json({ status: 'SUCCESS', adjustments: list });
  } catch (err) {
    console.error('[reports/period-adjustments] Error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;
