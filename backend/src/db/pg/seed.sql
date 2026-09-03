-- Reference data for Office Tracker.
--
-- Roles, permissions, leave types, document types and the default
-- policies. These were seeded by INSERT OR IGNORE statements inside the
-- SQLite migrations, so generating the schema from table definitions alone
-- left them out and every insert that referenced them failed its foreign
-- key.
--
-- ON CONFLICT DO NOTHING throughout, so applying this to a database that
-- already has the rows is a no-op and it stays safe to re-run.

-- roles (4 rows)
INSERT INTO roles (id, name, description, is_system, created_at) VALUES ('employee', 'Employee', 'Own record only. Cannot see other employees.', 1, 0) ON CONFLICT DO NOTHING;
INSERT INTO roles (id, name, description, is_system, created_at) VALUES ('manager', 'Manager', 'Assigned reports only. No sensitive personal data without an explicit grant.', 1, 0) ON CONFLICT DO NOTHING;
INSERT INTO roles (id, name, description, is_system, created_at) VALUES ('hr', 'HR / Admin', 'Full employee administration, attendance, leave and payroll preparation.', 1, 0) ON CONFLICT DO NOTHING;
INSERT INTO roles (id, name, description, is_system, created_at) VALUES ('super_admin', 'Super Admin', 'All areas, including policy configuration and security logs.', 1, 0) ON CONFLICT DO NOTHING;

-- permissions (35 rows)
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('self.read', 'self', 'View own profile, attendance and leave', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('self.leave.request', 'self', 'Submit own leave requests', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('self.attendance.correct', 'self', 'Submit own attendance correction requests', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('self.document.read', 'self', 'View own permitted documents', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('self.warning.acknowledge', 'self', 'Acknowledge warnings issued to self', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('employee.read', 'employee', 'View basic employment information', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('employee.write', 'employee', 'Create and edit employee records', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('employee.personal.read', 'employee', 'View home address, date of birth, personal contact details', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('employee.identity.read', 'employee', 'View passport, ID and right-to-work documents', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('employee.bank.read', 'employee', 'View bank account details', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('employee.nextofkin.read', 'employee', 'View next-of-kin and emergency contacts', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('employee.medical.read', 'employee', 'View sickness and medical documentation', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('employee.salary.read', 'employee', 'View salary and salary history', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('employee.salary.write', 'employee', 'Change salary (creates a new salary history row)', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('attendance.read', 'attendance', 'View attendance records', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('attendance.write', 'attendance', 'Manually add or adjust attendance', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('attendance.correction.review', 'attendance', 'Approve or reject attendance corrections', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('attendance.import', 'attendance', 'Import historical attendance data', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('leave.read', 'leave', 'View leave balances and requests', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('leave.approve', 'leave', 'Approve or reject leave requests', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('leave.write', 'leave', 'Adjust leave entitlement and balances', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('warning.read', 'warning', 'View warning status and triggers', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('warning.issue', 'warning', 'Confirm or waive a warning trigger, issue formal warnings', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('document.read', 'document', 'View non-confidential employee documents', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('document.write', 'document', 'Upload and replace employee documents', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('payroll.read', 'payroll', 'View payroll preparation figures', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('payroll.approve', 'payroll', 'Approve payroll adjustments', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('report.read', 'report', 'Run and export reports', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('settings.read', 'admin', 'View organisation settings', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('settings.write', 'admin', 'Change attendance, leave, warning and payroll policy', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('user.manage', 'admin', 'Create and manage user accounts and roles', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('device.manage', 'admin', 'Manage enrolled phones and ESP8266 sensors', 0) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('audit.read', 'admin', 'Read the security and audit log', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('hr.alerts.read', 'admin', 'View Advanced HR alerts (contract, probation, document and review dates)', 1) ON CONFLICT DO NOTHING;
INSERT INTO permissions (id, category, description, is_sensitive) VALUES ('hr.reviews.manage', 'admin', 'Schedule and record performance reviews', 1) ON CONFLICT DO NOTHING;

-- role_permissions (84 rows)
INSERT INTO role_permissions (role_id, permission_id) VALUES ('employee', 'self.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('employee', 'self.leave.request') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('employee', 'self.attendance.correct') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('employee', 'self.document.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('employee', 'self.warning.acknowledge') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('manager', 'attendance.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('manager', 'employee.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('manager', 'leave.approve') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('manager', 'leave.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('manager', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('manager', 'self.attendance.correct') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('manager', 'self.document.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('manager', 'self.leave.request') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('manager', 'self.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('manager', 'self.warning.acknowledge') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('manager', 'warning.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'attendance.correction.review') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'attendance.import') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'attendance.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'attendance.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'audit.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'device.manage') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'document.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'document.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'employee.bank.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'employee.identity.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'employee.medical.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'employee.nextofkin.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'employee.personal.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'employee.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'employee.salary.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'employee.salary.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'employee.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'leave.approve') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'leave.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'leave.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'payroll.approve') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'payroll.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'self.attendance.correct') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'self.document.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'self.leave.request') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'self.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'self.warning.acknowledge') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'settings.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'warning.issue') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'warning.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'attendance.correction.review') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'attendance.import') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'attendance.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'attendance.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'audit.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'device.manage') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'document.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'document.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'employee.bank.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'employee.identity.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'employee.medical.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'employee.nextofkin.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'employee.personal.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'employee.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'employee.salary.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'employee.salary.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'employee.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'leave.approve') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'leave.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'leave.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'payroll.approve') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'payroll.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'self.attendance.correct') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'self.document.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'self.leave.request') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'self.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'self.warning.acknowledge') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'settings.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'settings.write') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'user.manage') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'warning.issue') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'warning.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'hr.alerts.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('hr', 'hr.reviews.manage') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'hr.alerts.read') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id) VALUES ('super_admin', 'hr.reviews.manage') ON CONFLICT DO NOTHING;

-- document_types (22 rows)
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('employment_contract', 'Employment contract', 'sensitive', 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('contract_amendment', 'Contract amendment', 'sensitive', 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('offer_letter', 'Offer letter', 'sensitive', 0, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('job_description', 'Job description', 'normal', 0, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('passport_id', 'Passport / ID', 'highly_confidential', 1, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('right_to_work', 'Right-to-work evidence', 'highly_confidential', 1, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('signed_policy', 'Signed policy', 'normal', 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('probation_doc', 'Probation documentation', 'sensitive', 0, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('performance_review', 'Performance review', 'sensitive', 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('pip', 'PIP documentation', 'sensitive', 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('disciplinary', 'Disciplinary document', 'sensitive', 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('formal_warning', 'Formal warning', 'sensitive', 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('training_certificate', 'Training certificate', 'normal', 1, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('qualification', 'Qualification document', 'normal', 1, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('medical', 'Sickness / medical documentation', 'highly_confidential', 0, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('other', 'Other HR record', 'normal', 0, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('cv_resume', 'CV / Resume', 'normal', 0, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('nic_card', 'National Identity Card (CNIC / Smart Card)', 'highly_confidential', 1, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('next_of_kin', 'Next of Kin Form & ID', 'sensitive', 0, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('utility_bill', 'Home Utility Bill (Electricity/Gas/Water)', 'sensitive', 1, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('experience_letter', 'Experience & Reference Letter', 'normal', 0, 0) ON CONFLICT DO NOTHING;
INSERT INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES ('police_verification', 'Police Verification / Character Certificate', 'sensitive', 1, 0) ON CONFLICT DO NOTHING;

-- leave_approval_routes (1 row)
INSERT INTO leave_approval_routes (id, leave_type_id, step, approver_role, created_at) VALUES ('lar_default_hr', NULL, 1, 'hr', 0) ON CONFLICT DO NOTHING;

-- leave_policies (1 row)
INSERT INTO leave_policies (id, name, annual_entitlement_days, accrual_method, carry_over_days, carry_over_expiry_months, allow_negative_balance, holiday_year_start, active, created_at) VALUES ('lp_default', 'Forgotten Women standard (20 days, anniversary year)', 20, 'MONTHLY_ON_COMPLETION', 0, NULL, 1, 'ANNIVERSARY', 1, 0) ON CONFLICT DO NOTHING;

-- leave_types (14 rows)
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('annual', 'Paid annual leave', 1, 1, 1, 0, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('unpaid', 'Unpaid leave', 1, 0, 0, 0, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('sick', 'Sick leave', 0, 0, 1, 1, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('compassionate', 'Compassionate leave', 1, 0, 1, 0, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('maternity', 'Maternity leave', 1, 0, 1, 1, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('paternity', 'Paternity leave', 1, 0, 1, 1, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('parental', 'Parental leave', 1, 0, 1, 1, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('emergency', 'Emergency leave', 1, 0, 1, 0, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('study', 'Study leave', 1, 0, 1, 0, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('toil', 'Time off in lieu', 1, 0, 1, 0, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('public_holiday', 'Public/bank holiday', 0, 0, 1, 0, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('authorised', 'Authorised absence', 1, 0, 1, 0, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('unauthorised', 'Unauthorised absence', 0, 0, 0, 0, 1, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active) VALUES ('other', 'Other', 1, 0, 1, 0, 0, 1) ON CONFLICT DO NOTHING;

-- org_settings (9 rows)
INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES ('show_salary_to_employees', '0', 0, 'system') ON CONFLICT DO NOTHING;
INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES ('min_supported_version_code', '1', 0, 'system') ON CONFLICT DO NOTHING;
INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES ('ios_testflight_url', '', 0, 'system') ON CONFLICT DO NOTHING;
INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES ('ios_enterprise_manifest_url', '', 0, 'system') ON CONFLICT DO NOTHING;
INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES ('github_repo_owner', 'Abdullah-rethink', 0, 'system') ON CONFLICT DO NOTHING;
INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES ('github_repo_name', 'Office_tracker', 0, 'system') ON CONFLICT DO NOTHING;
INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES ('idle_threshold_minutes', '5', 0, 'system') ON CONFLICT DO NOTHING;
INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES ('lock_screen_grace_minutes', '5', 0, 'system') ON CONFLICT DO NOTHING;
INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES ('approved_work_processes', 'code.exe,chrome.exe,slack.exe,ms-teams.exe,teams.exe,excel.exe,winword.exe,powerpnt.exe,figma.exe,cursor.exe,webstorm64.exe,idea64.exe,notepad.exe,outlook.exe,postman.exe,terminal.exe,powershell.exe,cmd.exe,devenv.exe,Code,Google Chrome,Slack,Microsoft Teams,Microsoft Excel,Microsoft Word,Figma,Cursor,WebStorm,IntelliJ IDEA,Notes,Terminal,iTerm2', 0, 'system') ON CONFLICT DO NOTHING;

-- warning_rules (3 rows)
INSERT INTO warning_rules (id, name, rule_type, threshold, monitoring_period, warning_level, active, created_at) VALUES ('wr_lateness', 'Lateness: 3 permitted, 4th triggers review', 'LATENESS_OCCURRENCES', 3, 'CALENDAR_MONTH', 'INFORMAL_NOTICE', 1, 0) ON CONFLICT DO NOTHING;
INSERT INTO warning_rules (id, name, rule_type, threshold, monitoring_period, warning_level, active, created_at) VALUES ('wr_deficit', 'Attendance deficit reaches one whole-day equivalent', 'DEFICIT_MINUTES', 480, 'CALENDAR_MONTH', 'INFORMAL', 1, 0) ON CONFLICT DO NOTHING;
INSERT INTO warning_rules (id, name, rule_type, threshold, monitoring_period, warning_level, active, created_at) VALUES ('wr_absence', 'Unauthorised absence', 'UNAUTHORISED_ABSENCE', 1, 'CALENDAR_MONTH', 'REFERRAL_ONLY', 1, 0) ON CONFLICT DO NOTHING;

-- working_patterns (1 row)
INSERT INTO working_patterns (id, name, working_days, start_time, end_time, permitted_break_minutes, day_equivalent_minutes, grace_minutes, is_default, active, created_at) VALUES ('wp_default', 'Forgotten Women standard (11:00-19:00)', 'mon,tue,wed,thu,fri', '11:00', '19:00', 30, 480, NULL, 1, 1, 0) ON CONFLICT DO NOTHING;
