-- PostgreSQL schema for Office Tracker.
--
-- Generated from the final SQLite schema (baseline + all migrations
-- applied, including ALTER TABLE additions) so that it reflects what the
-- application actually reads and writes, rather than a hand-written
-- approximation. The previous supabase_schema.sql covered 33 of 71 tables
-- and renamed several of them, which is why attendance, leave, warnings,
-- payroll, documents and the audit log had nowhere to persist.
--
-- Conventions carried over deliberately:
--   * timestamps are epoch milliseconds in BIGINT, not TIMESTAMPTZ, so the
--     existing time handling in src/util/time.js stays correct;
--   * booleans are 0/1 in BIGINT, because the application compares them as
--     integers (`active = 1`) in ~200 places.
-- Changing either would be a separate, testable change of its own.

CREATE TABLE IF NOT EXISTS absence_records (
  id TEXT,
  employee_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  absence_type TEXT NOT NULL,
  detected_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  reviewed_by TEXT,
  reviewed_at BIGINT,
  review_notes TEXT,
  deduct_annual_leave BIGINT,
  treat_as_unpaid BIGINT,
  create_warning_trigger BIGINT,
  consequences_applied_at BIGINT,
  reason TEXT,
  evidence_document_id TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS alert_dismissals (
  alert_key TEXT,
  dismissed_value TEXT NOT NULL,
  dismissed_by TEXT NOT NULL,
  dismissed_at BIGINT NOT NULL,
  note TEXT,
  PRIMARY KEY (alert_key)
);

CREATE TABLE IF NOT EXISTS alert_notifications_sent (
  alert_key TEXT,
  sent_value TEXT NOT NULL,
  sent_at BIGINT NOT NULL,
  PRIMARY KEY (alert_key)
);

CREATE TABLE IF NOT EXISTS app_releases (
  id TEXT,
  version_name TEXT NOT NULL,
  version_code BIGINT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android',
  file_name TEXT,
  file_size BIGINT DEFAULT 0,
  download_url TEXT NOT NULL,
  release_notes TEXT,
  mandatory BIGINT NOT NULL DEFAULT 0,
  download_count BIGINT NOT NULL DEFAULT 0,
  active BIGINT NOT NULL DEFAULT 1,
  published_at BIGINT NOT NULL,
  created_by TEXT DEFAULT 'admin',
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS attendance_corrections (
  id TEXT,
  employee_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at BIGINT NOT NULL,
  event_id TEXT,
  requested_change TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_document_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_by TEXT,
  reviewed_at BIGINT,
  review_notes TEXT,
  applied_change TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS attendance_daily_summary (
  employee_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  scheduled_start TEXT,
  scheduled_end TEXT,
  is_working_day BIGINT NOT NULL DEFAULT 1,
  first_clock_in BIGINT,
  last_clock_out BIGINT,
  worked_minutes BIGINT NOT NULL DEFAULT 0,
  break_minutes BIGINT NOT NULL DEFAULT 0,
  late_minutes BIGINT NOT NULL DEFAULT 0,
  excess_break_minutes BIGINT NOT NULL DEFAULT 0,
  early_departure_minutes BIGINT NOT NULL DEFAULT 0,
  unauthorised_missing_minutes BIGINT NOT NULL DEFAULT 0,
  approved_adjustment_minutes BIGINT NOT NULL DEFAULT 0,
  daily_deficit_minutes BIGINT NOT NULL DEFAULT 0,
  is_late_occurrence BIGINT NOT NULL DEFAULT 0,
  attendance_status TEXT NOT NULL DEFAULT 'PENDING',
  leave_request_id TEXT,
  finalised BIGINT NOT NULL DEFAULT 0,
  derived_at BIGINT NOT NULL,
  PRIMARY KEY (employee_id, date_key)
);

CREATE TABLE IF NOT EXISTS attendance_days (
  employee_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  first_in_at BIGINT,
  last_active_at BIGINT,
  total_minutes BIGINT NOT NULL DEFAULT 0,
  sessions_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'NOT_CHECKED_IN',
  closed BIGINT NOT NULL DEFAULT 0,
  adjustment_minutes BIGINT NOT NULL DEFAULT 0,
  adjustment_note TEXT,
  derived_at BIGINT NOT NULL,
  PRIMARY KEY (employee_id, date_key)
);

CREATE TABLE IF NOT EXISTS attendance_deficit_ledger (
  id TEXT,
  employee_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  minutes_delta BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  whole_days_after BIGINT NOT NULL DEFAULT 0,
  carry_forward_after BIGINT NOT NULL DEFAULT 0,
  description TEXT,
  created_at BIGINT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS attendance_events (
  id TEXT,
  employee_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  office_id TEXT,
  device_id TEXT,
  esp_device_id TEXT,
  presence_event_id BIGINT,
  original_at BIGINT,
  adjusted_at BIGINT,
  adjustment_reason TEXT,
  created_at BIGINT NOT NULL,
  created_by TEXT,
  voided_at BIGINT,
  voided_reason TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS attendance_policies (
  id TEXT,
  name TEXT NOT NULL,
  working_pattern_id TEXT,
  grace_minutes BIGINT,
  min_minutes_for_late_occurrence BIGINT NOT NULL DEFAULT 1,
  departure_grace_minutes BIGINT NOT NULL DEFAULT 15,
  active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  at BIGINT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  before_json TEXT,
  after_json TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS break_records (
  id TEXT,
  employee_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  permitted_minutes BIGINT NOT NULL,
  actual_minutes BIGINT,
  excess_minutes BIGINT NOT NULL DEFAULT 0,
  start_event_id TEXT,
  end_event_id TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS calendar_days (
  id TEXT,
  office_id TEXT NOT NULL,
  date TEXT NOT NULL,
  day_type TEXT NOT NULL,
  name TEXT,
  is_paid BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT,
  name TEXT NOT NULL,
  parent_id TEXT,
  head_employee_id TEXT,
  active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS device_mac_bindings (
  id TEXT,
  employee_id TEXT NOT NULL,
  device_id TEXT,
  mac_hash TEXT NOT NULL,
  bound_at BIGINT NOT NULL,
  last_confirmed_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  bound_via TEXT NOT NULL,
  bound_ip TEXT,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  revoked_at BIGINT,
  revoked_reason TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS device_tokens (
  token_hash TEXT,
  device_id TEXT NOT NULL,
  issued_at BIGINT NOT NULL,
  expires_at BIGINT,
  last_used_at BIGINT,
  revoked_at BIGINT,
  PRIMARY KEY (token_hash)
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT,
  employee_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  model TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  enrolled_at BIGINT NOT NULL,
  last_seen_at BIGINT,
  revoked_at BIGINT,
  device_type TEXT NOT NULL DEFAULT 'mobile',
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS document_access_log (
  id BIGSERIAL PRIMARY KEY,
  document_id TEXT NOT NULL,
  user_id TEXT,
  at BIGINT NOT NULL,
  action TEXT NOT NULL,
  ip TEXT
);

CREATE TABLE IF NOT EXISTS document_acknowledgements (
  id TEXT,
  document_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  requested_at BIGINT NOT NULL,
  acknowledged_at BIGINT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS document_types (
  id TEXT,
  name TEXT NOT NULL,
  confidentiality TEXT NOT NULL DEFAULT 'normal',
  requires_expiry BIGINT NOT NULL DEFAULT 0,
  requires_acknowledgement BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT,
  document_id TEXT NOT NULL,
  version BIGINT NOT NULL,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  checksum TEXT,
  uploaded_at BIGINT NOT NULL,
  uploaded_by TEXT NOT NULL,
  notes TEXT,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id TEXT,
  employee_id TEXT NOT NULL,
  name TEXT NOT NULL,
  relationship TEXT,
  phone TEXT,
  email TEXT,
  is_primary BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS employee_bank_details (
  employee_id TEXT,
  account_name TEXT,
  account_number TEXT,
  sort_code TEXT,
  iban TEXT,
  bank_name TEXT,
  updated_at BIGINT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (employee_id)
);

CREATE TABLE IF NOT EXISTS employee_documents (
  id TEXT,
  employee_id TEXT NOT NULL,
  document_type_id TEXT NOT NULL,
  title TEXT NOT NULL,
  current_version BIGINT NOT NULL DEFAULT 1,
  effective_date TEXT,
  expiry_date TEXT,
  confidentiality TEXT NOT NULL DEFAULT 'normal',
  archived_at BIGINT,
  created_at BIGINT NOT NULL,
  created_by TEXT,
  verification_status TEXT NOT NULL DEFAULT 'VERIFIED',
  verified_by TEXT,
  verified_at BIGINT,
  rejection_reason TEXT,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS employee_personal (
  employee_id TEXT,
  date_of_birth TEXT,
  personal_email TEXT,
  mobile_phone TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  postcode TEXT,
  country TEXT,
  national_id TEXT,
  updated_at BIGINT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (employee_id)
);

CREATE TABLE IF NOT EXISTS employee_warning_standing (
  employee_id TEXT,
  warnings_issued BIGINT NOT NULL DEFAULT 0,
  highest_level TEXT,
  last_issued_at BIGINT,
  next_level TEXT,
  sequence_exhausted BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (employee_id)
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Team Member',
  active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  employee_number TEXT,
  preferred_name TEXT,
  work_email TEXT,
  photo_path TEXT,
  employment_status TEXT NOT NULL DEFAULT 'Active',
  office_id TEXT,
  department_id TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS employment_records (
  id TEXT,
  employee_id TEXT NOT NULL,
  job_title TEXT NOT NULL,
  department_id TEXT,
  manager_employee_id TEXT,
  office_id TEXT,
  employment_type TEXT NOT NULL DEFAULT 'Full-time',
  working_pattern_id TEXT,
  start_date TEXT NOT NULL,
  probation_start_date TEXT,
  probation_review_date TEXT,
  probation_outcome TEXT,
  contract_start_date TEXT,
  contract_end_date TEXT,
  notice_period_days BIGINT,
  holiday_entitlement_days DOUBLE PRECISION NOT NULL DEFAULT 20,
  holiday_year_start TEXT,
  leave_policy_id TEXT,
  attendance_policy_id TEXT,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at BIGINT NOT NULL,
  created_by TEXT,
  change_reason TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS employment_status_history (
  id BIGSERIAL PRIMARY KEY,
  employee_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  reason TEXT,
  changed_at BIGINT NOT NULL,
  changed_by TEXT
);

CREATE TABLE IF NOT EXISTS enrollment_codes (
  code_hash TEXT,
  employee_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  used_by_device TEXT,
  PRIMARY KEY (code_hash)
);

CREATE TABLE IF NOT EXISTS esp_devices (
  id TEXT,
  office_id TEXT,
  label TEXT,
  firmware_version TEXT,
  last_heartbeat_at BIGINT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  installed_on TEXT,
  last_maintenance_on TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS formal_warnings (
  id TEXT,
  employee_id TEXT NOT NULL,
  trigger_id TEXT,
  warning_type TEXT NOT NULL,
  warning_level TEXT NOT NULL,
  triggering_rule TEXT,
  related_incidents TEXT,
  explanation TEXT NOT NULL,
  document_id TEXT,
  issued_at BIGINT NOT NULL,
  issued_by TEXT NOT NULL,
  review_date TEXT,
  expiry_date TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  outcome TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS leave_accrual_ledger (
  id TEXT,
  employee_id TEXT NOT NULL,
  leave_year TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  days_delta DOUBLE PRECISION NOT NULL,
  balance_after DOUBLE PRECISION NOT NULL,
  effective_date TEXT NOT NULL,
  leave_request_id TEXT,
  description TEXT,
  created_at BIGINT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS leave_approval_routes (
  id TEXT,
  leave_type_id TEXT,
  step BIGINT NOT NULL,
  approver_role TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS leave_approvals (
  id TEXT,
  request_id TEXT NOT NULL,
  step BIGINT NOT NULL,
  approver_role TEXT NOT NULL,
  approver_user_id TEXT,
  decision TEXT,
  decided_at BIGINT,
  notes TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS leave_entitlements (
  id TEXT,
  employee_id TEXT NOT NULL,
  leave_year TEXT NOT NULL,
  policy_id TEXT,
  entitlement_days DOUBLE PRECISION NOT NULL,
  carried_over_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  adjustment_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  adjustment_reason TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS leave_overdraft_approvals (
  id TEXT,
  request_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  shortfall_days DOUBLE PRECISION NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at BIGINT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS leave_policies (
  id TEXT,
  name TEXT NOT NULL,
  annual_entitlement_days DOUBLE PRECISION NOT NULL DEFAULT 20,
  accrual_method TEXT NOT NULL DEFAULT 'MONTHLY_ACCRUAL',
  carry_over_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  carry_over_expiry_months BIGINT,
  allow_negative_balance BIGINT NOT NULL DEFAULT 0,
  holiday_year_start TEXT NOT NULL DEFAULT '01-01',
  active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT,
  employee_id TEXT NOT NULL,
  leave_type_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  day_portion TEXT NOT NULL DEFAULT 'FULL_DAY',
  total_days DOUBLE PRECISION NOT NULL,
  reason TEXT,
  evidence_document_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_MANAGER',
  submitted_at BIGINT NOT NULL,
  decided_at BIGINT,
  cancelled_at BIGINT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS leave_types (
  id TEXT,
  name TEXT NOT NULL,
  requires_approval BIGINT NOT NULL DEFAULT 1,
  reduces_entitlement BIGINT NOT NULL DEFAULT 1,
  is_paid BIGINT NOT NULL DEFAULT 1,
  requires_evidence BIGINT NOT NULL DEFAULT 0,
  counts_toward_warnings BIGINT NOT NULL DEFAULT 0,
  active BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS login_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  email_tried TEXT,
  at BIGINT NOT NULL,
  outcome TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS mac_binding_events (
  id BIGSERIAL PRIMARY KEY,
  binding_id TEXT,
  employee_id TEXT,
  mac_hash TEXT,
  at BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS manager_assignments (
  manager_employee_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  assigned_at BIGINT NOT NULL,
  assigned_by TEXT,
  ended_at BIGINT,
  PRIMARY KEY (manager_employee_id, employee_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT,
  value TEXT NOT NULL,
  PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS movements (
  id BIGSERIAL PRIMARY KEY,
  at BIGINT NOT NULL,
  type TEXT NOT NULL,
  employee_id TEXT,
  employee_name TEXT,
  details TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT,
  employee_id TEXT,
  user_id TEXT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  link TEXT,
  created_at BIGINT NOT NULL,
  read_at BIGINT,
  dismissed_at BIGINT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS office_locations (
  id TEXT,
  name TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  country TEXT,
  address TEXT,
  active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS org_settings (
  key TEXT,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT,
  user_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  PRIMARY KEY (token_hash)
);

CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id TEXT,
  period_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  adjustment_type TEXT NOT NULL,
  calculated_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  calculated_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  approved_days DOUBLE PRECISION,
  approved_amount DOUBLE PRECISION,
  source_reference TEXT,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED',
  approved_by TEXT,
  approved_at BIGINT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS payroll_periods (
  id TEXT,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  approved_by TEXT,
  approved_at BIGINT,
  created_at BIGINT NOT NULL,
  exchange_rate DOUBLE PRECISION DEFAULT 350.0,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS performance_reviews (
  id TEXT,
  employee_id TEXT NOT NULL,
  review_type TEXT NOT NULL DEFAULT 'GENERAL',
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  reviewer_user_id TEXT,
  outcome TEXT,
  notes TEXT,
  document_id TEXT,
  completed_at BIGINT,
  created_at BIGINT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  is_sensitive BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS presence_events (
  id BIGSERIAL PRIMARY KEY,
  employee_id TEXT,
  device_id TEXT,
  source TEXT NOT NULL,
  location TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ssid TEXT,
  bssid TEXT,
  src_ip TEXT,
  mac_hash TEXT,
  rssi BIGINT,
  observed_at BIGINT NOT NULL,
  received_at BIGINT NOT NULL,
  dedupe_key TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS process_anomalies (
  id TEXT,
  employee_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  process_name TEXT NOT NULL,
  window_title TEXT,
  duration_seconds BIGINT NOT NULL,
  detected_at BIGINT NOT NULL,
  resolved BIGINT NOT NULL DEFAULT 0,
  notes TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  is_system BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS salary_history (
  id TEXT,
  employee_id TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  pay_frequency TEXT NOT NULL DEFAULT 'Monthly',
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  daily_rate DOUBLE PRECISION,
  reason TEXT,
  created_at BIGINT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT,
  applied_at BIGINT NOT NULL,
  checksum TEXT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  category TEXT NOT NULL,
  description TEXT,
  requires_decision BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS unknown_devices (
  mac_hash TEXT,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  last_source TEXT NOT NULL,
  sighting_count BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (mac_hash)
);

CREATE TABLE IF NOT EXISTS user_permission_grants (
  user_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  granted_at BIGINT NOT NULL,
  granted_by TEXT NOT NULL,
  expires_at BIGINT,
  reason TEXT,
  PRIMARY KEY (user_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  granted_at BIGINT NOT NULL,
  granted_by TEXT,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT,
  user_id TEXT NOT NULL,
  issued_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT,
  ip TEXT,
  user_agent TEXT,
  PRIMARY KEY (token_hash)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  employee_id TEXT,
  active BIGINT NOT NULL DEFAULT 1,
  mfa_secret TEXT,
  mfa_enabled BIGINT NOT NULL DEFAULT 0,
  must_change_password BIGINT NOT NULL DEFAULT 0,
  failed_attempts BIGINT NOT NULL DEFAULT 0,
  locked_until BIGINT,
  last_login_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS warning_acknowledgements (
  id TEXT,
  warning_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  requested_at BIGINT NOT NULL,
  acknowledged_at BIGINT,
  comments TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS warning_rules (
  id TEXT,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  threshold BIGINT NOT NULL,
  monitoring_period TEXT,
  warning_level TEXT NOT NULL DEFAULT 'INFORMAL',
  active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS warning_triggers (
  id TEXT,
  employee_id TEXT NOT NULL,
  rule_id TEXT,
  triggered_at BIGINT NOT NULL,
  trigger_reason TEXT NOT NULL,
  occurrence_count BIGINT,
  related_dates TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  reviewed_by TEXT,
  reviewed_at BIGINT,
  review_notes TEXT,
  formal_warning_id TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS working_patterns (
  id TEXT,
  name TEXT NOT NULL,
  working_days TEXT NOT NULL DEFAULT 'mon,tue,wed,thu,fri',
  start_time TEXT NOT NULL DEFAULT '11:00',
  end_time TEXT NOT NULL DEFAULT '19:00',
  permitted_break_minutes BIGINT NOT NULL DEFAULT 30,
  day_equivalent_minutes BIGINT NOT NULL DEFAULT 480,
  grace_minutes BIGINT,
  is_default BIGINT NOT NULL DEFAULT 0,
  active BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS workstation_app_usage (
  id TEXT,
  employee_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  session_date TEXT NOT NULL,
  app_name TEXT NOT NULL,
  active_seconds BIGINT NOT NULL DEFAULT 0,
  last_used_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS workstation_sessions (
  id TEXT,
  device_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  session_date TEXT NOT NULL,
  active_seconds BIGINT NOT NULL DEFAULT 0,
  idle_seconds BIGINT NOT NULL DEFAULT 0,
  break_seconds BIGINT NOT NULL DEFAULT 0,
  lock_state TEXT NOT NULL DEFAULT 'UNLOCKED',
  connected_bssid TEXT,
  in_office BIGINT NOT NULL DEFAULT 0,
  last_heartbeat_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id)
);

-- Unique constraints -------------------------------------------------------

DO $$ BEGIN
  ALTER TABLE absence_records ADD CONSTRAINT uq_absence_records_employee_id_date_key UNIQUE (employee_id, date_key);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE calendar_days ADD CONSTRAINT uq_calendar_days_office_id_date UNIQUE (office_id, date);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE document_acknowledgements ADD CONSTRAINT uq_document_acknowledgements_document_id_employee_id UNIQUE (document_id, employee_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE document_versions ADD CONSTRAINT uq_document_versions_document_id_version UNIQUE (document_id, version);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE leave_entitlements ADD CONSTRAINT uq_leave_entitlements_employee_id_leave_year UNIQUE (employee_id, leave_year);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE payroll_periods ADD CONSTRAINT uq_payroll_periods_start_date_end_date UNIQUE (start_date, end_date);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE presence_events ADD CONSTRAINT uq_presence_events_dedupe_key UNIQUE (dedupe_key);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT uq_users_email UNIQUE (email);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE warning_acknowledgements ADD CONSTRAINT uq_warning_acknowledgements_warning_id_employee_id UNIQUE (warning_id, employee_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE workstation_app_usage ADD CONSTRAINT uq_workstation_app_usage_device_id_session_date_app_name UNIQUE (device_id, session_date, app_name);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE workstation_sessions ADD CONSTRAINT uq_workstation_sessions_device_id_session_date UNIQUE (device_id, session_date);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

-- users.email was COLLATE NOCASE under SQLite. Enforce the same rule here.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email));

-- Foreign keys -------------------------------------------------------------
-- Added after every table exists: employees -> departments -> employees is a
-- cycle, so no ordering of inline references would resolve.

DO $$ BEGIN
  ALTER TABLE absence_records ADD CONSTRAINT fk_absence_records_evidence_document_id
    FOREIGN KEY (evidence_document_id) REFERENCES employee_documents (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE absence_records ADD CONSTRAINT fk_absence_records_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance_corrections ADD CONSTRAINT fk_attendance_corrections_evidence_document_id
    FOREIGN KEY (evidence_document_id) REFERENCES employee_documents (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance_corrections ADD CONSTRAINT fk_attendance_corrections_event_id
    FOREIGN KEY (event_id) REFERENCES attendance_events (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance_corrections ADD CONSTRAINT fk_attendance_corrections_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance_daily_summary ADD CONSTRAINT fk_attendance_daily_summary_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance_days ADD CONSTRAINT fk_attendance_days_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance_deficit_ledger ADD CONSTRAINT fk_attendance_deficit_ledger_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance_events ADD CONSTRAINT fk_attendance_events_presence_event_id
    FOREIGN KEY (presence_event_id) REFERENCES presence_events (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance_events ADD CONSTRAINT fk_attendance_events_device_id
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance_events ADD CONSTRAINT fk_attendance_events_office_id
    FOREIGN KEY (office_id) REFERENCES office_locations (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance_events ADD CONSTRAINT fk_attendance_events_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE attendance_policies ADD CONSTRAINT fk_attendance_policies_working_pattern_id
    FOREIGN KEY (working_pattern_id) REFERENCES working_patterns (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE break_records ADD CONSTRAINT fk_break_records_end_event_id
    FOREIGN KEY (end_event_id) REFERENCES attendance_events (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE break_records ADD CONSTRAINT fk_break_records_start_event_id
    FOREIGN KEY (start_event_id) REFERENCES attendance_events (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE break_records ADD CONSTRAINT fk_break_records_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE calendar_days ADD CONSTRAINT fk_calendar_days_office_id
    FOREIGN KEY (office_id) REFERENCES office_locations (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE departments ADD CONSTRAINT fk_departments_head_employee_id
    FOREIGN KEY (head_employee_id) REFERENCES employees (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE departments ADD CONSTRAINT fk_departments_parent_id
    FOREIGN KEY (parent_id) REFERENCES departments (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE device_mac_bindings ADD CONSTRAINT fk_device_mac_bindings_device_id
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE device_mac_bindings ADD CONSTRAINT fk_device_mac_bindings_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE device_tokens ADD CONSTRAINT fk_device_tokens_device_id
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE devices ADD CONSTRAINT fk_devices_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE document_access_log ADD CONSTRAINT fk_document_access_log_user_id
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE document_access_log ADD CONSTRAINT fk_document_access_log_document_id
    FOREIGN KEY (document_id) REFERENCES employee_documents (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE document_acknowledgements ADD CONSTRAINT fk_document_acknowledgements_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE document_acknowledgements ADD CONSTRAINT fk_document_acknowledgements_document_id
    FOREIGN KEY (document_id) REFERENCES employee_documents (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE document_versions ADD CONSTRAINT fk_document_versions_document_id
    FOREIGN KEY (document_id) REFERENCES employee_documents (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE emergency_contacts ADD CONSTRAINT fk_emergency_contacts_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employee_bank_details ADD CONSTRAINT fk_employee_bank_details_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employee_documents ADD CONSTRAINT fk_employee_documents_document_type_id
    FOREIGN KEY (document_type_id) REFERENCES document_types (id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employee_documents ADD CONSTRAINT fk_employee_documents_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employee_personal ADD CONSTRAINT fk_employee_personal_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employee_warning_standing ADD CONSTRAINT fk_employee_warning_standing_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employees ADD CONSTRAINT fk_employees_department_id
    FOREIGN KEY (department_id) REFERENCES departments (id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employees ADD CONSTRAINT fk_employees_office_id
    FOREIGN KEY (office_id) REFERENCES office_locations (id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employment_records ADD CONSTRAINT fk_employment_records_working_pattern_id
    FOREIGN KEY (working_pattern_id) REFERENCES working_patterns (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employment_records ADD CONSTRAINT fk_employment_records_office_id
    FOREIGN KEY (office_id) REFERENCES office_locations (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employment_records ADD CONSTRAINT fk_employment_records_manager_employee_id
    FOREIGN KEY (manager_employee_id) REFERENCES employees (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employment_records ADD CONSTRAINT fk_employment_records_department_id
    FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employment_records ADD CONSTRAINT fk_employment_records_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE employment_status_history ADD CONSTRAINT fk_employment_status_history_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE enrollment_codes ADD CONSTRAINT fk_enrollment_codes_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE esp_devices ADD CONSTRAINT fk_esp_devices_office_id
    FOREIGN KEY (office_id) REFERENCES office_locations (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE formal_warnings ADD CONSTRAINT fk_formal_warnings_document_id
    FOREIGN KEY (document_id) REFERENCES employee_documents (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE formal_warnings ADD CONSTRAINT fk_formal_warnings_trigger_id
    FOREIGN KEY (trigger_id) REFERENCES warning_triggers (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE formal_warnings ADD CONSTRAINT fk_formal_warnings_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE leave_accrual_ledger ADD CONSTRAINT fk_leave_accrual_ledger_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE leave_approval_routes ADD CONSTRAINT fk_leave_approval_routes_leave_type_id
    FOREIGN KEY (leave_type_id) REFERENCES leave_types (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE leave_approvals ADD CONSTRAINT fk_leave_approvals_approver_user_id
    FOREIGN KEY (approver_user_id) REFERENCES users (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE leave_approvals ADD CONSTRAINT fk_leave_approvals_request_id
    FOREIGN KEY (request_id) REFERENCES leave_requests (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE leave_entitlements ADD CONSTRAINT fk_leave_entitlements_policy_id
    FOREIGN KEY (policy_id) REFERENCES leave_policies (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE leave_entitlements ADD CONSTRAINT fk_leave_entitlements_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE leave_overdraft_approvals ADD CONSTRAINT fk_leave_overdraft_approvals_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE leave_overdraft_approvals ADD CONSTRAINT fk_leave_overdraft_approvals_request_id
    FOREIGN KEY (request_id) REFERENCES leave_requests (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE leave_requests ADD CONSTRAINT fk_leave_requests_evidence_document_id
    FOREIGN KEY (evidence_document_id) REFERENCES employee_documents (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE leave_requests ADD CONSTRAINT fk_leave_requests_leave_type_id
    FOREIGN KEY (leave_type_id) REFERENCES leave_types (id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE leave_requests ADD CONSTRAINT fk_leave_requests_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE login_events ADD CONSTRAINT fk_login_events_user_id
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE manager_assignments ADD CONSTRAINT fk_manager_assignments_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE manager_assignments ADD CONSTRAINT fk_manager_assignments_manager_employee_id
    FOREIGN KEY (manager_employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE movements ADD CONSTRAINT fk_movements_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE notifications ADD CONSTRAINT fk_notifications_user_id
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE notifications ADD CONSTRAINT fk_notifications_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE password_reset_tokens ADD CONSTRAINT fk_password_reset_tokens_user_id
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE payroll_adjustments ADD CONSTRAINT fk_payroll_adjustments_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE payroll_adjustments ADD CONSTRAINT fk_payroll_adjustments_period_id
    FOREIGN KEY (period_id) REFERENCES payroll_periods (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE performance_reviews ADD CONSTRAINT fk_performance_reviews_document_id
    FOREIGN KEY (document_id) REFERENCES employee_documents (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE performance_reviews ADD CONSTRAINT fk_performance_reviews_reviewer_user_id
    FOREIGN KEY (reviewer_user_id) REFERENCES users (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE performance_reviews ADD CONSTRAINT fk_performance_reviews_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE presence_events ADD CONSTRAINT fk_presence_events_device_id
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE presence_events ADD CONSTRAINT fk_presence_events_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE process_anomalies ADD CONSTRAINT fk_process_anomalies_device_id
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE process_anomalies ADD CONSTRAINT fk_process_anomalies_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE role_permissions ADD CONSTRAINT fk_role_permissions_permission_id
    FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE role_permissions ADD CONSTRAINT fk_role_permissions_role_id
    FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE salary_history ADD CONSTRAINT fk_salary_history_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE user_permission_grants ADD CONSTRAINT fk_user_permission_grants_permission_id
    FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE user_permission_grants ADD CONSTRAINT fk_user_permission_grants_user_id
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE user_roles ADD CONSTRAINT fk_user_roles_role_id
    FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE user_roles ADD CONSTRAINT fk_user_roles_user_id
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE user_sessions ADD CONSTRAINT fk_user_sessions_user_id
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT fk_users_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE warning_acknowledgements ADD CONSTRAINT fk_warning_acknowledgements_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE warning_acknowledgements ADD CONSTRAINT fk_warning_acknowledgements_warning_id
    FOREIGN KEY (warning_id) REFERENCES formal_warnings (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE warning_triggers ADD CONSTRAINT fk_warning_triggers_rule_id
    FOREIGN KEY (rule_id) REFERENCES warning_rules (id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE warning_triggers ADD CONSTRAINT fk_warning_triggers_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE workstation_app_usage ADD CONSTRAINT fk_workstation_app_usage_device_id
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE workstation_app_usage ADD CONSTRAINT fk_workstation_app_usage_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE workstation_sessions ADD CONSTRAINT fk_workstation_sessions_employee_id
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE workstation_sessions ADD CONSTRAINT fk_workstation_sessions_device_id
    FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Indexes ------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_absence_status ON absence_records (status, date_key);
CREATE INDEX IF NOT EXISTS idx_app_releases_version ON app_releases (version_code, active);
CREATE INDEX IF NOT EXISTS idx_corrections_emp ON attendance_corrections (employee_id, date_key);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON attendance_corrections (status, requested_at);
CREATE INDEX IF NOT EXISTS idx_daily_status ON attendance_daily_summary (attendance_status);
CREATE INDEX IF NOT EXISTS idx_daily_date ON attendance_daily_summary (date_key);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_days (date_key);
CREATE INDEX IF NOT EXISTS idx_deficit_employee ON attendance_deficit_ledger (employee_id, created_at);
CREATE INDEX IF NOT EXISTS idx_att_events_time ON attendance_events (occurred_at);
CREATE INDEX IF NOT EXISTS idx_att_events_emp_day ON attendance_events (employee_id, date_key);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
CREATE INDEX IF NOT EXISTS idx_breaks_emp_day ON break_records (employee_id, date_key);
CREATE INDEX IF NOT EXISTS idx_calendar_office_date ON calendar_days (office_id, date);
CREATE INDEX IF NOT EXISTS idx_departments_parent ON departments (parent_id);
CREATE INDEX IF NOT EXISTS idx_mac_binding_employee ON device_mac_bindings (employee_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mac_binding_active ON device_mac_bindings (mac_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tokens_device ON device_tokens (device_id);
CREATE INDEX IF NOT EXISTS idx_devices_employee ON devices (employee_id);
CREATE INDEX IF NOT EXISTS idx_doc_access_doc ON document_access_log (document_id, at);
CREATE INDEX IF NOT EXISTS idx_emergency_employee ON emergency_contacts (employee_id);
CREATE INDEX IF NOT EXISTS idx_documents_verification ON employee_documents (verification_status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_expiry ON employee_documents (expiry_date) WHERE expiry_date IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_employee ON employee_documents (employee_id);
CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees (department_id);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees (employment_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_number ON employees (employee_number) WHERE employee_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_active ON employees (active);
CREATE INDEX IF NOT EXISTS idx_employment_probation ON employment_records (probation_review_date) WHERE probation_review_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employment_contract ON employment_records (contract_end_date) WHERE contract_end_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employment_current ON employment_records (employee_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_employment_employee ON employment_records (employee_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_status_history_employee ON employment_status_history (employee_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_warnings_employee ON formal_warnings (employee_id, issued_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accrual_unique_month ON leave_accrual_ledger (employee_id, leave_year, effective_date) WHERE entry_type = 'ACCRUAL';
CREATE INDEX IF NOT EXISTS idx_accrual_employee ON leave_accrual_ledger (employee_id, leave_year);
CREATE INDEX IF NOT EXISTS idx_leave_approvals_request ON leave_approvals (request_id, step);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests (status);
CREATE INDEX IF NOT EXISTS idx_leave_requests_emp ON leave_requests (employee_id, start_date);
CREATE INDEX IF NOT EXISTS idx_login_events_at ON login_events (at);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events (user_id, at);
CREATE INDEX IF NOT EXISTS idx_mac_binding_events_at ON mac_binding_events (at);
CREATE INDEX IF NOT EXISTS idx_manager_assignments_emp ON manager_assignments (employee_id);
CREATE INDEX IF NOT EXISTS idx_movements_at ON movements (at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_emp ON notifications (employee_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payroll_adj ON payroll_adjustments (period_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_reviews_due ON performance_reviews (due_date) WHERE status IN ('SCHEDULED', 'IN_PROGRESS');
CREATE INDEX IF NOT EXISTS idx_reviews_employee ON performance_reviews (employee_id);
CREATE INDEX IF NOT EXISTS idx_events_time ON presence_events (observed_at);
CREATE INDEX IF NOT EXISTS idx_events_emp_time ON presence_events (employee_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_anomalies_emp ON process_anomalies (employee_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_salary_current ON salary_history (employee_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_salary_employee ON salary_history (employee_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_unknown_lastseen ON unknown_devices (last_seen_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_users_active ON users (active);
CREATE INDEX IF NOT EXISTS idx_users_employee ON users (employee_id);
CREATE INDEX IF NOT EXISTS idx_triggers_emp ON warning_triggers (employee_id);
CREATE INDEX IF NOT EXISTS idx_triggers_status ON warning_triggers (status, triggered_at);
CREATE INDEX IF NOT EXISTS idx_app_usage_emp_date ON workstation_app_usage (employee_id, session_date);
CREATE INDEX IF NOT EXISTS idx_workstation_emp_date ON workstation_sessions (employee_id, session_date);
