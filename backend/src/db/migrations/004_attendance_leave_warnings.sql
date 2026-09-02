-- Attendance ledger, leave, warnings and payroll preparation.
-- Spec sections 7-15, 18 and 21.
--
-- Created now, ahead of the engines that fill them, so later phases add code
-- rather than migrating a database that by then holds live payroll data.
--
-- The governing rule throughout, from spec section 29: the software calculates
-- what the policy says, but it does not BECOME the policy. Every table that
-- could reduce someone's pay or leave separates the calculated value from the
-- approved one, and nothing takes effect without a recorded human decision.

-- ---------------------------------------------------------------------------
-- Attendance events (spec section 7)
-- ---------------------------------------------------------------------------

-- Distinct from `presence_events`, which is raw sensor observation. This table
-- is the HR-meaningful timeline: clock in, break start, break end, clock out.
-- A presence event may CAUSE an attendance event, but the two are not the same
-- thing and conflating them would make manual HR entry indistinguishable from
-- a Wi-Fi sighting.
CREATE TABLE IF NOT EXISTS attendance_events (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date_key      TEXT NOT NULL,            -- local YYYY-MM-DD
  occurred_at   INTEGER NOT NULL,         -- UTC epoch ms
  -- CLOCK_IN | BREAK_START | BREAK_END | CLOCK_OUT | TEMPORARY_ABSENCE
  -- | OFFSITE_WORK | REMOTE_WORK | CORRECTION | HR_ADJUSTMENT
  event_type    TEXT NOT NULL,
  -- MOBILE_APP | ESP_PRESENCE | HR_MANUAL | MANAGER | IMPORT | SYSTEM_RULE
  -- Spec 7.1: "The source must always remain visible in the audit trail."
  source        TEXT NOT NULL,
  office_id     TEXT REFERENCES office_locations(id) ON DELETE SET NULL,
  device_id     TEXT REFERENCES devices(id) ON DELETE SET NULL,
  esp_device_id TEXT,
  presence_event_id INTEGER REFERENCES presence_events(id) ON DELETE SET NULL,
  -- Populated when a correction changes a value; the original is never erased.
  original_at   INTEGER,
  adjusted_at   INTEGER,
  adjustment_reason TEXT,
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  voided_at     INTEGER,
  voided_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_events_emp_day ON attendance_events(employee_id, date_key);
CREATE INDEX IF NOT EXISTS idx_att_events_time    ON attendance_events(occurred_at);

CREATE TABLE IF NOT EXISTS break_records (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date_key      TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  permitted_minutes INTEGER NOT NULL,
  actual_minutes    INTEGER,
  -- Spec 12: "Only the excess break time should normally enter the
  -- attendance-deficit ledger."
  excess_minutes    INTEGER NOT NULL DEFAULT 0,
  start_event_id TEXT REFERENCES attendance_events(id) ON DELETE SET NULL,
  end_event_id   TEXT REFERENCES attendance_events(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_breaks_emp_day ON break_records(employee_id, date_key);

-- ---------------------------------------------------------------------------
-- Daily summary and deficit ledger (spec section 8)
-- ---------------------------------------------------------------------------

-- One row per employee-day. Derived, and safe to rebuild from events.
CREATE TABLE IF NOT EXISTS attendance_daily_summary (
  employee_id      TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date_key         TEXT NOT NULL,
  scheduled_start  TEXT,
  scheduled_end    TEXT,
  is_working_day   INTEGER NOT NULL DEFAULT 1,
  first_clock_in   INTEGER,
  last_clock_out   INTEGER,
  worked_minutes   INTEGER NOT NULL DEFAULT 0,
  break_minutes    INTEGER NOT NULL DEFAULT 0,

  -- The four components of spec 8.1, kept separate so the employee dashboard
  -- can show WHY a deficit exists rather than one unexplained number.
  late_minutes             INTEGER NOT NULL DEFAULT 0,
  excess_break_minutes     INTEGER NOT NULL DEFAULT 0,
  early_departure_minutes  INTEGER NOT NULL DEFAULT 0,
  unauthorised_missing_minutes INTEGER NOT NULL DEFAULT 0,
  approved_adjustment_minutes  INTEGER NOT NULL DEFAULT 0,
  daily_deficit_minutes    INTEGER NOT NULL DEFAULT 0,

  -- A late ARRIVAL is not the same as late MINUTES. Spec 9.1: "The system must
  -- therefore count late occurrences, not only late minutes."
  is_late_occurrence  INTEGER NOT NULL DEFAULT 0,
  -- PRESENT | LATE | ABSENT_AUTHORISED | ABSENT_UNAUTHORISED | LEAVE
  -- | REMOTE | OFFSITE | NON_WORKING_DAY | PENDING
  attendance_status   TEXT NOT NULL DEFAULT 'PENDING',
  leave_request_id    TEXT,
  finalised           INTEGER NOT NULL DEFAULT 0,
  derived_at          INTEGER NOT NULL,
  PRIMARY KEY (employee_id, date_key)
);
CREATE INDEX IF NOT EXISTS idx_daily_date   ON attendance_daily_summary(date_key);
CREATE INDEX IF NOT EXISTS idx_daily_status ON attendance_daily_summary(attendance_status);

-- Append-only running balance. Spec 8.2/8.3: 480 accumulated minutes equals one
-- whole-day equivalent, and BOTH the whole-day count and the carried-forward
-- remainder must be kept (527 minutes is 1 day plus 47 minutes, not 1.1 days).
CREATE TABLE IF NOT EXISTS attendance_deficit_ledger (
  id                TEXT PRIMARY KEY,
  employee_id       TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date_key          TEXT NOT NULL,
  -- DAILY_DEFICIT | HR_ADJUSTMENT | WHOLE_DAY_CONVERSION | RESET | CORRECTION
  entry_type        TEXT NOT NULL,
  minutes_delta     INTEGER NOT NULL,
  balance_after     INTEGER NOT NULL,
  whole_days_after  INTEGER NOT NULL DEFAULT 0,
  carry_forward_after INTEGER NOT NULL DEFAULT 0,
  description       TEXT,
  created_at        INTEGER NOT NULL,
  created_by        TEXT
);
CREATE INDEX IF NOT EXISTS idx_deficit_employee ON attendance_deficit_ledger(employee_id, created_at);

-- Spec section 11. The original record stays in history; a correction is a
-- separate reviewable request, never an in-place edit.
CREATE TABLE IF NOT EXISTS attendance_corrections (
  id             TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date_key       TEXT NOT NULL,
  requested_by   TEXT NOT NULL,
  requested_at   INTEGER NOT NULL,
  event_id       TEXT REFERENCES attendance_events(id) ON DELETE SET NULL,
  requested_change TEXT NOT NULL,        -- JSON: what the employee says it should be
  reason         TEXT NOT NULL,
  evidence_document_id TEXT REFERENCES employee_documents(id) ON DELETE SET NULL,
  -- PENDING | APPROVED | REJECTED | AMENDED | INFO_REQUESTED
  status         TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_by    TEXT,
  reviewed_at    INTEGER,
  review_notes   TEXT,
  applied_change TEXT                     -- JSON: what was actually applied
);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON attendance_corrections(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_corrections_emp    ON attendance_corrections(employee_id, date_key);

CREATE TABLE IF NOT EXISTS attendance_policies (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  working_pattern_id    TEXT REFERENCES working_patterns(id) ON DELETE SET NULL,
  grace_minutes         INTEGER,
  min_minutes_for_late_occurrence INTEGER NOT NULL DEFAULT 1,
  -- Spec 30: minimum disconnect duration before a departure is suspected.
  departure_grace_minutes INTEGER NOT NULL DEFAULT 15,
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Leave (spec sections 13-15)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS leave_types (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  requires_approval   INTEGER NOT NULL DEFAULT 1,
  reduces_entitlement INTEGER NOT NULL DEFAULT 1,
  is_paid             INTEGER NOT NULL DEFAULT 1,
  requires_evidence   INTEGER NOT NULL DEFAULT 0,
  -- Whether this absence counts toward attendance warnings.
  counts_toward_warnings INTEGER NOT NULL DEFAULT 0,
  active              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS leave_policies (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  annual_entitlement_days REAL NOT NULL DEFAULT 20,
  -- MONTHLY_ACCRUAL | ANNUAL_UPFRONT | PRO_RATA
  accrual_method        TEXT NOT NULL DEFAULT 'MONTHLY_ACCRUAL',
  carry_over_days       REAL NOT NULL DEFAULT 0,
  carry_over_expiry_months INTEGER,
  allow_negative_balance INTEGER NOT NULL DEFAULT 0,
  holiday_year_start    TEXT NOT NULL DEFAULT '01-01',
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leave_entitlements (
  id                TEXT PRIMARY KEY,
  employee_id       TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_year        TEXT NOT NULL,        -- e.g. '2026'
  policy_id         TEXT REFERENCES leave_policies(id) ON DELETE SET NULL,
  entitlement_days  REAL NOT NULL,
  carried_over_days REAL NOT NULL DEFAULT 0,
  adjustment_days   REAL NOT NULL DEFAULT 0,
  adjustment_reason TEXT,
  created_at        INTEGER NOT NULL,
  UNIQUE (employee_id, leave_year)
);

-- Append-only. Spec 14 requires full internal precision (20/12 = 1.6666...)
-- with rounding only at display, so a year of accrual sums to exactly 20 days.
CREATE TABLE IF NOT EXISTS leave_accrual_ledger (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_year    TEXT NOT NULL,
  -- ACCRUAL | TAKEN | BOOKED | CANCELLED | CARRY_OVER | ADJUSTMENT | FORFEIT
  entry_type    TEXT NOT NULL,
  days_delta    REAL NOT NULL,
  balance_after REAL NOT NULL,
  effective_date TEXT NOT NULL,
  leave_request_id TEXT,
  description   TEXT,
  created_at    INTEGER NOT NULL,
  created_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_accrual_employee ON leave_accrual_ledger(employee_id, leave_year);

CREATE TABLE IF NOT EXISTS leave_requests (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id TEXT NOT NULL REFERENCES leave_types(id),
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  -- FULL_DAY | HALF_DAY_AM | HALF_DAY_PM
  day_portion   TEXT NOT NULL DEFAULT 'FULL_DAY',
  total_days    REAL NOT NULL,
  reason        TEXT,
  evidence_document_id TEXT REFERENCES employee_documents(id) ON DELETE SET NULL,
  -- DRAFT | PENDING_MANAGER | PENDING_HR | APPROVED | REJECTED | CANCELLED
  status        TEXT NOT NULL DEFAULT 'PENDING_MANAGER',
  submitted_at  INTEGER NOT NULL,
  decided_at    INTEGER,
  cancelled_at  INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_emp    ON leave_requests(employee_id, start_date);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);

-- One row per step, so a configurable Employee -> Manager -> HR route (spec 15)
-- keeps a full record of who decided what and when.
CREATE TABLE IF NOT EXISTS leave_approvals (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  step         INTEGER NOT NULL,
  approver_role TEXT NOT NULL,
  approver_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision     TEXT,                     -- APPROVED | REJECTED | INFO_REQUESTED
  decided_at   INTEGER,
  notes        TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leave_approvals_request ON leave_approvals(request_id, step);

-- Spec section 10. Recorded as a suspicion first; consequences are proposed,
-- never applied automatically.
CREATE TABLE IF NOT EXISTS absence_records (
  id             TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date_key       TEXT NOT NULL,
  -- SUSPECTED_NO_SHOW | UNAUTHORISED | AUTHORISED | SICK
  absence_type   TEXT NOT NULL,
  detected_at    INTEGER NOT NULL,
  -- PENDING_REVIEW | CONFIRMED | DISMISSED
  status         TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  reviewed_by    TEXT,
  reviewed_at    INTEGER,
  review_notes   TEXT,
  -- Spec 10.2 is emphatic that these are THREE separate switches. The phrasing
  -- supplied ("deducted from paid leave while the employee is not paid") would
  -- apply two consequences for one day, so each is recorded independently and
  -- neither is a hard-coded assumption.
  deduct_annual_leave  INTEGER,
  treat_as_unpaid      INTEGER,
  create_warning_trigger INTEGER,
  consequences_applied_at INTEGER,
  UNIQUE (employee_id, date_key)
);
CREATE INDEX IF NOT EXISTS idx_absence_status ON absence_records(status, date_key);

-- ---------------------------------------------------------------------------
-- Warnings (spec sections 9 and 21)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS warning_rules (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  -- LATENESS_OCCURRENCES | DEFICIT_MINUTES | UNAUTHORISED_ABSENCE
  rule_type          TEXT NOT NULL,
  threshold          INTEGER NOT NULL,
  -- Spec 9.6 is explicit that the reset period is NOT yet decided. NULL means
  -- undecided, and the engine must refuse to evaluate rather than assume.
  monitoring_period  TEXT,
  warning_level      TEXT NOT NULL DEFAULT 'INFORMAL',
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL
);

-- Spec 9.3: an automatic policy alert is NOT a formal warning. A late record
-- may later be corrected or authorised, so the trigger is a referral to HR and
-- nothing more until a human decides.
CREATE TABLE IF NOT EXISTS warning_triggers (
  id             TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  rule_id        TEXT REFERENCES warning_rules(id) ON DELETE SET NULL,
  triggered_at   INTEGER NOT NULL,
  trigger_reason TEXT NOT NULL,
  occurrence_count INTEGER,
  related_dates  TEXT,                   -- JSON array of date_keys
  -- PENDING_REVIEW | CONFIRMED | WAIVED | CORRECTED | SUPERSEDED
  status         TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  reviewed_by    TEXT,
  reviewed_at    INTEGER,
  review_notes   TEXT,
  formal_warning_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_triggers_status ON warning_triggers(status, triggered_at);
CREATE INDEX IF NOT EXISTS idx_triggers_emp    ON warning_triggers(employee_id);

CREATE TABLE IF NOT EXISTS formal_warnings (
  id             TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  trigger_id     TEXT REFERENCES warning_triggers(id) ON DELETE SET NULL,
  warning_type   TEXT NOT NULL,
  -- INFORMAL_NOTICE | FIRST_WRITTEN | FINAL_WRITTEN | OTHER
  warning_level  TEXT NOT NULL,
  triggering_rule TEXT,
  related_incidents TEXT,                -- JSON
  explanation    TEXT NOT NULL,
  document_id    TEXT REFERENCES employee_documents(id) ON DELETE SET NULL,
  issued_at      INTEGER NOT NULL,
  issued_by      TEXT NOT NULL,
  review_date    TEXT,
  expiry_date    TEXT,
  -- ACTIVE | EXPIRED | WITHDRAWN | SUPERSEDED
  status         TEXT NOT NULL DEFAULT 'ACTIVE',
  outcome        TEXT
);
CREATE INDEX IF NOT EXISTS idx_warnings_employee ON formal_warnings(employee_id, issued_at);

CREATE TABLE IF NOT EXISTS warning_acknowledgements (
  id            TEXT PRIMARY KEY,
  warning_id    TEXT NOT NULL REFERENCES formal_warnings(id) ON DELETE CASCADE,
  employee_id   TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  requested_at  INTEGER NOT NULL,
  acknowledged_at INTEGER,
  comments      TEXT,
  UNIQUE (warning_id, employee_id)
);

-- ---------------------------------------------------------------------------
-- Payroll preparation (spec sections 17-18)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payroll_periods (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  -- OPEN | IN_REVIEW | APPROVED | CLOSED
  status       TEXT NOT NULL DEFAULT 'OPEN',
  approved_by  TEXT,
  approved_at  INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE (start_date, end_date)
);

-- Spec 18: "All payroll calculations should remain payroll-preparation values
-- requiring HR/payroll approval before finalisation." The calculated and the
-- approved amounts are therefore separate columns, and nothing here is
-- authoritative until approved_by is set.
CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id             TEXT PRIMARY KEY,
  period_id      TEXT NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- UNPAID_ABSENCE | ATTENDANCE_DEFICIT | UNPAID_LEAVE | STARTER_PRORATA
  -- | LEAVER_PRORATA | EXCESS_LEAVE_TAKEN | OTHER
  adjustment_type TEXT NOT NULL,
  calculated_days   REAL NOT NULL DEFAULT 0,
  calculated_amount REAL NOT NULL DEFAULT 0,
  approved_days     REAL,
  approved_amount   REAL,
  source_reference  TEXT,
  explanation       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PROPOSED',  -- PROPOSED | APPROVED | REJECTED
  approved_by    TEXT,
  approved_at    INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payroll_adj ON payroll_adjustments(period_id, employee_id);

-- ---------------------------------------------------------------------------
-- ESP devices and notifications (spec sections 22, 23.3)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS esp_devices (
  id             TEXT PRIMARY KEY,       -- matches X-Sensor-Id
  office_id      TEXT REFERENCES office_locations(id) ON DELETE SET NULL,
  label          TEXT,
  firmware_version TEXT,
  last_heartbeat_at INTEGER,
  -- ACTIVE | OFFLINE | RETIRED
  status         TEXT NOT NULL DEFAULT 'ACTIVE',
  installed_on   TEXT,
  last_maintenance_on TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  -- Exactly one of these is set: an employee-facing or an HR-facing message.
  employee_id  TEXT REFERENCES employees(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info',   -- info | warning | urgent
  link         TEXT,
  created_at   INTEGER NOT NULL,
  read_at      INTEGER,
  dismissed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifications_emp  ON notifications(employee_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO leave_types
  (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings) VALUES
  ('annual',        'Paid annual leave',   1, 1, 1, 0, 0),
  ('unpaid',        'Unpaid leave',        1, 0, 0, 0, 0),
  ('sick',          'Sick leave',          0, 0, 1, 1, 0),
  ('compassionate', 'Compassionate leave', 1, 0, 1, 0, 0),
  ('maternity',     'Maternity leave',     1, 0, 1, 1, 0),
  ('paternity',     'Paternity leave',     1, 0, 1, 1, 0),
  ('parental',      'Parental leave',      1, 0, 1, 1, 0),
  ('emergency',     'Emergency leave',     1, 0, 1, 0, 0),
  ('study',         'Study leave',         1, 0, 1, 0, 0),
  ('toil',          'Time off in lieu',    1, 0, 1, 0, 0),
  ('public_holiday','Public/bank holiday', 0, 0, 1, 0, 0),
  ('authorised',    'Authorised absence',  1, 0, 1, 0, 0),
  ('unauthorised',  'Unauthorised absence',0, 0, 0, 0, 1),
  ('other',         'Other',               1, 0, 1, 0, 0);

INSERT OR IGNORE INTO leave_policies
  (id, name, annual_entitlement_days, accrual_method, carry_over_days,
   allow_negative_balance, holiday_year_start, active, created_at)
VALUES
  ('lp_default', 'Forgotten Women standard (20 days)', 20, 'MONTHLY_ACCRUAL', 0, 0, '01-01', 1, 0);

-- monitoring_period is deliberately NULL. Spec 9.6: "Do not hard-code this
-- until the organisation confirms its policy."
INSERT OR IGNORE INTO warning_rules
  (id, name, rule_type, threshold, monitoring_period, warning_level, active, created_at)
VALUES
  ('wr_lateness', 'Lateness: 3 permitted, 4th triggers review',
   'LATENESS_OCCURRENCES', 3, NULL, 'FIRST_WRITTEN', 1, 0),
  ('wr_deficit',  'Attendance deficit reaches one whole-day equivalent',
   'DEFICIT_MINUTES', 480, NULL, 'INFORMAL', 1, 0),
  ('wr_absence',  'Unauthorised absence',
   'UNAUTHORISED_ABSENCE', 1, NULL, 'FIRST_WRITTEN', 1, 0);
