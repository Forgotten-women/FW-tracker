-- 038_employee_emails_and_email_settings.sql
-- Populate work_email on employees from PK employee directory
UPDATE employees SET work_email = 'anwar@forgottenwomen.org' WHERE employee_number = 'PK001';
UPDATE employees SET work_email = 'hafsa@forgottenwomen.org' WHERE employee_number = 'PK002';
UPDATE employees SET work_email = 'naveed@forgottenwomen.org' WHERE employee_number = 'PK003';
UPDATE employees SET work_email = 'kanwal@forgottenwomen.org' WHERE employee_number = 'PK004';
UPDATE employees SET work_email = 'ahsan@forgottenwomen.org' WHERE employee_number = 'PK005';
UPDATE employees SET work_email = 'huzaifa@forgottenwomen.org' WHERE employee_number = 'PK007';
UPDATE employees SET work_email = 'zoha@forgottenwomen.org' WHERE employee_number = 'PK008';
UPDATE employees SET work_email = 'zainab@forgottenwomen.org' WHERE employee_number = 'PK009';
UPDATE employees SET work_email = 'farwa@forgottenwomen.org' WHERE employee_number = 'PK010';
UPDATE employees SET work_email = 'rubina@forgottenwomen.org' WHERE employee_number = 'PK011';
UPDATE employees SET work_email = 'hummaira@forgottenwomen.org' WHERE employee_number = 'PK012';
UPDATE employees SET work_email = 'hr@forgottenwomen.org' WHERE employee_number = 'PK013';
UPDATE employees SET work_email = 'sohaib@forgottenwomen.org' WHERE employee_number = 'PK014';
UPDATE employees SET work_email = 'maaz@forgottenwomen.org' WHERE employee_number = 'PK015';
UPDATE employees SET work_email = 'office@rethinkcharity.org.uk' WHERE employee_number = 'PK016';
UPDATE employees SET work_email = 'accounts@forgottenwomen.org' WHERE employee_number = 'PK017';
UPDATE employees SET work_email = 'accounts@rethinkcharity.org.uk' WHERE employee_number = 'PK018';
UPDATE employees SET work_email = 'fawad@forgottenwomen.org' WHERE employee_number = 'PK019';
UPDATE employees SET work_email = 'mahnoor@forgottenwomen.org' WHERE employee_number = 'PK020';
UPDATE employees SET work_email = 'ali@forgottenwomen.org' WHERE employee_number = 'PK021';
UPDATE employees SET work_email = 'umar@forgottenwomen.org' WHERE employee_number = 'PK022';
UPDATE employees SET work_email = 'zeenia@forgottenwomen.org' WHERE employee_number = 'PK023';
UPDATE employees SET work_email = 'wasif@forgottenwomen.org' WHERE employee_number = 'PK024';

-- Default email notification settings
INSERT INTO org_settings (key, value, updated_at, updated_by)
VALUES
  ('email_notifications_enabled', '0', 0, 'system'),
  ('email_smtp_host', 'smtp.office365.com', 0, 'system'),
  ('email_smtp_port', '587', 0, 'system'),
  ('email_smtp_secure', '0', 0, 'system'),
  ('email_smtp_user', '', 0, 'system'),
  ('email_smtp_pass', '', 0, 'system'),
  ('email_from_name', 'Forgotten Women HR', 0, 'system'),
  ('email_from_address', '', 0, 'system'),
  ('email_notif_formal_warnings', '1', 0, 'system'),
  ('email_notif_late_warnings', '1', 0, 'system'),
  ('email_notif_leave_decisions', '1', 0, 'system'),
  ('email_notif_leave_recorded', '1', 0, 'system'),
  ('email_notif_corrections', '1', 0, 'system'),
  ('email_notif_documents', '1', 0, 'system'),
  ('email_notif_absences', '1', 0, 'system')
ON CONFLICT (key) DO NOTHING;
