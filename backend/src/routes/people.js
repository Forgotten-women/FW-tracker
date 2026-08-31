// Employee master record and org-structure API. Spec sections 4, 37.
//
// The consolidated profile (spec 37) is the centrepiece: one call returns the
// whole person, with each sensitive group included only if the caller holds its
// permission. The write routes cover the parts of the record that had no API -
// employment terms, personal and bank details, emergency contacts, departments,
// offices and manager assignments.

const express = require('express');
const router = express.Router();

const { db } = require('../db');
const {
  requireDevice, requireUserOrAdminKey, requireEmployeeAccess,
} = require('../middleware/auth');
const people = require('../domain/people');
const payroll = require('../domain/payroll');
const T = require('../util/time');

// ---------------------------------------------------------------------------
// Employee Mobile Self-Profile
// ---------------------------------------------------------------------------

router.get('/mine/profile', (req, res, next) => {
  if (req.headers['x-admin-key']) {
    return requireUserOrAdminKey()(req, res, () => {
      const empId = req.query.employeeId || req.auth.employeeId || req.auth.userId;
      if (!empId) return res.status(400).json({ status: 'ERROR', message: 'employeeId required for admin caller.' });
      const prof = people.myEmployeeProfile(empId);
      if (!prof) return res.status(404).json({ status: 'ERROR', message: 'Profile not found.' });
      return res.json({ status: 'SUCCESS', profile: prof });
    });
  }
  requireDevice(req, res, () => {
    const employeeId = req.auth.employeeId;
    const prof = people.myEmployeeProfile(employeeId);
    if (!prof) return res.status(404).json({ status: 'ERROR', message: 'Profile not found.' });
    res.json({ status: 'SUCCESS', profile: prof });
  });
});

// ---------------------------------------------------------------------------
// Consolidated profile (spec 37)
// ---------------------------------------------------------------------------

router.get('/employee/:employeeId/profile',
  requireUserOrAdminKey('employee.read'), requireEmployeeAccess(),
  (req, res) => {
    const prof = people.profile(req.params.employeeId, { permissions: req.auth.permissions });
    if (!prof) return res.status(404).json({ status: 'ERROR', message: 'No such employee.' });

    // Salary is a sensitive group of its own; attach it only with the salary
    // permission, and always the current figure plus history.
    if (req.auth.permissions.has('employee.salary.read')) {
      const s = payroll.salaryAt(req.params.employeeId);
      prof.salary = s.blocked ? null : { monthly: s.monthly, annual: s.annual, daily: s.daily };
      prof.salaryHistory = payroll.salaryHistoryFor(req.params.employeeId);
    }

    res.json({ status: 'SUCCESS', profile: prof });
  });

router.get('/employee/:employeeId/employment-history',
  requireUserOrAdminKey('employee.read'), requireEmployeeAccess(),
  (req, res) => {
    res.json({
      status: 'SUCCESS',
      history: people.employmentHistory(req.params.employeeId).map(er => ({
        jobTitle: er.job_title,
        employmentType: er.employment_type,
        startDate: er.start_date,
        contractEndDate: er.contract_end_date,
        effectiveFrom: er.effective_from,
        effectiveTo: er.effective_to,
        changeReason: er.change_reason,
        by: er.created_by,
      })),
    });
  });

// ---------------------------------------------------------------------------
// Employment terms (spec 4.2) - the write that unblocks leave and payroll
// ---------------------------------------------------------------------------

router.post('/employee/:employeeId/employment',
  requireUserOrAdminKey('employee.write'), requireEmployeeAccess(),
  (req, res) => {
    try {
      const r = people.setEmployment({
        employeeId: req.params.employeeId,
        ...req.body,
        actor: req.auth.actor,
      });
      res.status(201).json({ status: 'SUCCESS', employment: r });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

router.post('/employee/:employeeId/status',
  requireUserOrAdminKey('employee.write'), requireEmployeeAccess(),
  (req, res) => {
    try {
      const r = people.setStatus({
        employeeId: req.params.employeeId,
        status: req.body?.status,
        effectiveDate: req.body?.effectiveDate || null,
        reason: req.body?.reason,
        actor: req.auth.actor,
      });
      res.json({ status: 'SUCCESS', ...r });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

// ---------------------------------------------------------------------------
// Sensitive detail groups - each behind its own permission (spec 3.2)
// ---------------------------------------------------------------------------

router.post('/employee/:employeeId/personal',
  requireUserOrAdminKey('employee.write', 'employee.personal.read'), requireEmployeeAccess(),
  (req, res) => {
    try {
      people.setPersonal({ employeeId: req.params.employeeId, fields: req.body || {}, actor: req.auth.actor });
      res.json({ status: 'SUCCESS' });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

router.post('/employee/:employeeId/bank',
  requireUserOrAdminKey('employee.write', 'employee.bank.read'), requireEmployeeAccess(),
  (req, res) => {
    try {
      people.setBank({ employeeId: req.params.employeeId, fields: req.body || {}, actor: req.auth.actor });
      res.json({ status: 'SUCCESS' });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

router.post('/employee/:employeeId/emergency-contact',
  requireUserOrAdminKey('employee.write', 'employee.nextofkin.read'), requireEmployeeAccess(),
  (req, res) => {
    try {
      const r = people.addEmergencyContact({ employeeId: req.params.employeeId, ...req.body, actor: req.auth.actor });
      res.status(201).json({ status: 'SUCCESS', ...r });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

// ---------------------------------------------------------------------------
// Org structure
// ---------------------------------------------------------------------------

router.get('/departments', requireUserOrAdminKey('employee.read'), (req, res) => {
  res.json({ status: 'SUCCESS', departments: people.listDepartments() });
});

router.post('/departments', requireUserOrAdminKey('employee.write'), (req, res) => {
  try {
    res.status(201).json({ status: 'SUCCESS', department: people.createDepartment({ ...req.body, actor: req.auth.actor }) });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.get('/offices', requireUserOrAdminKey('employee.read'), (req, res) => {
  res.json({ status: 'SUCCESS', offices: people.listOffices() });
});

router.post('/offices', requireUserOrAdminKey('settings.write'), (req, res) => {
  try {
    res.status(201).json({ status: 'SUCCESS', office: people.createOffice({ ...req.body, actor: req.auth.actor }) });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/employee/:employeeId/manager',
  requireUserOrAdminKey('employee.write'), requireEmployeeAccess(),
  (req, res) => {
    try {
      const r = people.assignManager({
        managerEmployeeId: req.body?.managerEmployeeId,
        employeeId: req.params.employeeId,
        actor: req.auth.actor,
      });
      res.json({ status: 'SUCCESS', ...r });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

router.delete('/employee/:employeeId/manager/:managerEmployeeId',
  requireUserOrAdminKey('employee.write'), requireEmployeeAccess(),
  (req, res) => {
    people.endManagerAssignment({
      managerEmployeeId: req.params.managerEmployeeId,
      employeeId: req.params.employeeId,
      actor: req.auth.actor,
    });
    res.json({ status: 'SUCCESS' });
  });

module.exports = router;
