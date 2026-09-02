-- Employee master record, employment history, salary history and documents.
-- Spec sections 4, 5, 6 and 17.
--
-- Two principles run through this file:
--
-- 1. Sensitive fields live in their OWN tables rather than as columns on
--    `employees`. Spec 3.2 requires a manager to read employment data while
--    being blocked from addresses, bank details, next-of-kin and medical
--    records. If those were columns on one row, every read would have to
--    remember to strip them. As separate tables, the permission check happens
--    at the query, and forgetting it is a missing join rather than a leak.
--
-- 2. Anything historical is APPEND-ONLY. Spec section 31: "important historical
--    data such as salary, leave and warnings should not be stored as a single
--    overwriteable field." Salary and employment terms are versioned with
--    effective dates, so "what was this person paid in June" stays answerable.

-- ---------------------------------------------------------------------------
-- Employee core (extends the existing table)
-- ---------------------------------------------------------------------------

ALTER TABLE employees ADD COLUMN employee_number  TEXT;
ALTER TABLE employees ADD COLUMN preferred_name   TEXT;
ALTER TABLE employees ADD COLUMN work_email       TEXT;
ALTER TABLE employees ADD COLUMN photo_path       TEXT;
-- Spec 4.3: Pre-start | Active | Probation | Probation extended | Notice period
--           | Suspended | Long-term leave | Left employment
ALTER TABLE employees ADD COLUMN employment_status TEXT NOT NULL DEFAULT 'Active';
ALTER TABLE employees ADD COLUMN office_id        TEXT REFERENCES office_locations(id);
ALTER TABLE employees ADD COLUMN department_id    TEXT REFERENCES departments(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_number ON employees(employee_number)
  WHERE employee_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(employment_status);
CREATE INDEX IF NOT EXISTS idx_employees_dept   ON employees(department_id);

-- Sensitive personal data. Reading this requires employee.personal.read.
CREATE TABLE IF NOT EXISTS employee_personal (
  employee_id     TEXT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  date_of_birth   TEXT,               -- YYYY-MM-DD
  personal_email  TEXT,
  mobile_phone    TEXT,
  address_line1   TEXT,
  address_line2   TEXT,
  city            TEXT,
  postcode        TEXT,
  country         TEXT,
  national_id     TEXT,               -- NI number / CNIC, jurisdiction dependent
  updated_at      INTEGER NOT NULL,
  updated_by      TEXT
);

-- Requires employee.bank.read, kept apart from the rest of personal data
-- because it is the highest-value target in the system.
CREATE TABLE IF NOT EXISTS employee_bank_details (
  employee_id    TEXT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  account_name   TEXT,
  account_number TEXT,
  sort_code      TEXT,
  iban           TEXT,
  bank_name      TEXT,
  updated_at     INTEGER NOT NULL,
  updated_by     TEXT
);

-- Requires employee.nextofkin.read.
CREATE TABLE IF NOT EXISTS emergency_contacts (
  id           TEXT PRIMARY KEY,
  employee_id  TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  relationship TEXT,
  phone        TEXT,
  email        TEXT,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emergency_employee ON emergency_contacts(employee_id);

-- ---------------------------------------------------------------------------
-- Working patterns (spec section 6)
-- ---------------------------------------------------------------------------

-- The org-wide default lives in config/office.json. This table exists because
-- the spec is explicit that the schedule "must be configurable rather than
-- permanently hard-coded because future employees, departments or offices may
-- use different schedules".
CREATE TABLE IF NOT EXISTS working_patterns (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  -- Comma-separated day keys, e.g. 'mon,tue,wed,thu,fri'
  working_days           TEXT NOT NULL DEFAULT 'mon,tue,wed,thu,fri',
  start_time             TEXT NOT NULL DEFAULT '11:00',
  end_time               TEXT NOT NULL DEFAULT '19:00',
  permitted_break_minutes INTEGER NOT NULL DEFAULT 30,
  -- Spec 8.3: minutes that constitute one whole-day equivalent.
  day_equivalent_minutes INTEGER NOT NULL DEFAULT 480,
  -- Spec 35 item 2 is undecided. NULL means "not decided", and the lateness
  -- engine refuses to classify rather than assuming zero.
  grace_minutes          INTEGER,
  is_default             INTEGER NOT NULL DEFAULT 0,
  active                 INTEGER NOT NULL DEFAULT 1,
  created_at             INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Employment record, versioned (spec section 4.2)
-- ---------------------------------------------------------------------------

-- One row per set of employment terms. A promotion, department move or contract
-- change closes the current row and opens a new one, so history is preserved.
CREATE TABLE IF NOT EXISTS employment_records (
  id                  TEXT PRIMARY KEY,
  employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  job_title           TEXT NOT NULL,
  department_id       TEXT REFERENCES departments(id) ON DELETE SET NULL,
  manager_employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  office_id           TEXT REFERENCES office_locations(id) ON DELETE SET NULL,
  -- Full-time | Part-time | Temporary | Contractor | Volunteer
  employment_type     TEXT NOT NULL DEFAULT 'Full-time',
  working_pattern_id  TEXT REFERENCES working_patterns(id) ON DELETE SET NULL,
  start_date          TEXT NOT NULL,          -- YYYY-MM-DD
  probation_start_date  TEXT,
  probation_review_date TEXT,
  probation_outcome     TEXT,
  contract_start_date   TEXT,
  contract_end_date     TEXT,
  notice_period_days    INTEGER,
  holiday_entitlement_days REAL NOT NULL DEFAULT 20,
  holiday_year_start    TEXT,                 -- MM-DD, e.g. '01-01'
  leave_policy_id       TEXT,
  attendance_policy_id  TEXT,
  effective_from      TEXT NOT NULL,          -- YYYY-MM-DD
  effective_to        TEXT,                   -- NULL = current
  created_at          INTEGER NOT NULL,
  created_by          TEXT,
  change_reason       TEXT
);
CREATE INDEX IF NOT EXISTS idx_employment_employee  ON employment_records(employee_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_employment_current   ON employment_records(employee_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_employment_contract  ON employment_records(contract_end_date)
  WHERE contract_end_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employment_probation ON employment_records(probation_review_date)
  WHERE probation_review_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS employment_status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id  TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  reason       TEXT,
  changed_at   INTEGER NOT NULL,
  changed_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_status_history_employee ON employment_status_history(employee_id, effective_date);

-- ---------------------------------------------------------------------------
-- Salary history (spec section 17)
-- ---------------------------------------------------------------------------

-- Append-only. A pay rise inserts a row; it never updates the previous one.
-- Spec example: 1,800 effective 1 Jan 2026 and 2,000 effective 1 Jun 2026 must
-- BOTH remain answerable, or historical payroll cannot be reconstructed.
CREATE TABLE IF NOT EXISTS salary_history (
  id             TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  amount         REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'GBP',
  -- Monthly | Annual | Hourly | Daily
  pay_frequency  TEXT NOT NULL DEFAULT 'Monthly',
  effective_from TEXT NOT NULL,              -- YYYY-MM-DD
  effective_to   TEXT,                       -- NULL = current
  -- Spec 17: Monthly x 12 / 52 / 5. Stored so a later formula change cannot
  -- silently restate what someone was historically paid per day.
  daily_rate     REAL,
  reason         TEXT,
  created_at     INTEGER NOT NULL,
  created_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_salary_employee ON salary_history(employee_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_salary_current  ON salary_history(employee_id) WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------------
-- Document vault (spec section 5)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_types (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  -- normal | sensitive | highly_confidential. Drives which permission is
  -- required to read it, so medical records are not reachable with the
  -- permission that opens a job description.
  confidentiality   TEXT NOT NULL DEFAULT 'normal',
  requires_expiry   INTEGER NOT NULL DEFAULT 0,
  requires_acknowledgement INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employee_documents (
  id               TEXT PRIMARY KEY,
  employee_id      TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  document_type_id TEXT NOT NULL REFERENCES document_types(id),
  title            TEXT NOT NULL,
  current_version  INTEGER NOT NULL DEFAULT 1,
  effective_date   TEXT,
  expiry_date      TEXT,
  confidentiality  TEXT NOT NULL DEFAULT 'normal',
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  created_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_employee ON employee_documents(employee_id);
-- Drives the expiring-document alerts required by spec section 5.
CREATE INDEX IF NOT EXISTS idx_documents_expiry   ON employee_documents(expiry_date)
  WHERE expiry_date IS NOT NULL AND archived_at IS NULL;

-- Replacing a document adds a version. Spec 26: "Records should be corrected
-- through versioned changes rather than silently overwritten."
CREATE TABLE IF NOT EXISTS document_versions (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES employee_documents(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  filename      TEXT NOT NULL,
  -- Path in private storage. Never a public URL: spec 27 requires signed,
  -- time-limited access rather than a guessable link.
  storage_path  TEXT NOT NULL,
  mime_type     TEXT,
  size_bytes    INTEGER,
  checksum      TEXT,
  uploaded_at   INTEGER NOT NULL,
  uploaded_by   TEXT NOT NULL,
  notes         TEXT,
  UNIQUE (document_id, version)
);

-- Spec 27 requires an audit of sensitive document access, which means logging
-- reads and not only writes.
CREATE TABLE IF NOT EXISTS document_access_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES employee_documents(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  at          INTEGER NOT NULL,
  action      TEXT NOT NULL,          -- VIEW | DOWNLOAD | LINK_ISSUED
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_access_doc ON document_access_log(document_id, at);

CREATE TABLE IF NOT EXISTS document_acknowledgements (
  id             TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL REFERENCES employee_documents(id) ON DELETE CASCADE,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  requested_at   INTEGER NOT NULL,
  acknowledged_at INTEGER,
  UNIQUE (document_id, employee_id)
);

-- ---------------------------------------------------------------------------
-- Office calendar (spec section 16)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS calendar_days (
  id          TEXT PRIMARY KEY,
  office_id   TEXT NOT NULL REFERENCES office_locations(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,          -- YYYY-MM-DD
  -- WORKING | PUBLIC_HOLIDAY | ORG_CLOSURE | OPTIONAL_HOLIDAY
  day_type    TEXT NOT NULL,
  name        TEXT,
  -- Spec 16: an employee must not lose annual leave for a paid office closure.
  is_paid     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  UNIQUE (office_id, date)
);
CREATE INDEX IF NOT EXISTS idx_calendar_office_date ON calendar_days(office_id, date);

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES
  ('employment_contract',  'Employment contract',      'sensitive', 0, 1),
  ('contract_amendment',   'Contract amendment',       'sensitive', 0, 1),
  ('offer_letter',         'Offer letter',             'sensitive', 0, 0),
  ('job_description',      'Job description',          'normal',    0, 0),
  ('passport_id',          'Passport / ID',            'highly_confidential', 1, 0),
  ('right_to_work',        'Right-to-work evidence',   'highly_confidential', 1, 0),
  ('signed_policy',        'Signed policy',            'normal',    0, 1),
  ('probation_doc',        'Probation documentation',  'sensitive', 0, 0),
  ('performance_review',   'Performance review',       'sensitive', 0, 1),
  ('pip',                  'PIP documentation',        'sensitive', 0, 1),
  ('disciplinary',         'Disciplinary document',    'sensitive', 0, 1),
  ('formal_warning',       'Formal warning',           'sensitive', 0, 1),
  ('training_certificate', 'Training certificate',     'normal',    1, 0),
  ('qualification',        'Qualification document',   'normal',    1, 0),
  ('medical',              'Sickness / medical documentation', 'highly_confidential', 0, 0),
  ('other',                'Other HR record',          'normal',    0, 0);

-- Matches config/office.json so the org default exists in both places from the
-- start. Per-employee patterns override it.
INSERT OR IGNORE INTO working_patterns
  (id, name, working_days, start_time, end_time, permitted_break_minutes,
   day_equivalent_minutes, grace_minutes, is_default, active, created_at)
VALUES
  ('wp_default', 'Forgotten Women standard (11:00-19:00)', 'mon,tue,wed,thu,fri',
   '11:00', '19:00', 30, 480, NULL, 1, 1, 0);
