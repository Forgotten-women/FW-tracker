-- ============================================================================
-- Office Tracker: Supabase PostgreSQL Complete Schema
-- ============================================================================

-- Meta table
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Identity & Core
CREATE TABLE IF NOT EXISTS employees (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'Team Member',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_employees_active ON employees(active);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  employee_id  TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL DEFAULT 'unknown',
  model        TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL DEFAULT '',
  enrolled_at  BIGINT NOT NULL,
  last_seen_at BIGINT,
  revoked_at   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_devices_employee ON devices(employee_id);

CREATE TABLE IF NOT EXISTS device_tokens (
  token_hash   TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  issued_at    BIGINT NOT NULL,
  expires_at   BIGINT,
  last_used_at BIGINT,
  revoked_at   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_tokens_device ON device_tokens(device_id);

CREATE TABLE IF NOT EXISTS enrollment_codes (
  code_hash      TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at     BIGINT NOT NULL,
  expires_at     BIGINT NOT NULL,
  used_at        BIGINT,
  used_by_device TEXT
);

CREATE TABLE IF NOT EXISTS device_mac_bindings (
  id           TEXT PRIMARY KEY,
  employee_id  TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  mac_hash     TEXT NOT NULL,
  label        TEXT,
  bound_at     BIGINT NOT NULL,
  revoked_at   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_device_mac_bindings_emp ON device_mac_bindings(employee_id);
CREATE INDEX IF NOT EXISTS idx_device_mac_bindings_hash ON device_mac_bindings(mac_hash);

-- Presence & Attendance
CREATE TABLE IF NOT EXISTS presence_events (
  id                  BIGSERIAL PRIMARY KEY,
  employee_id         TEXT REFERENCES employees(id) ON DELETE SET NULL,
  device_id           TEXT REFERENCES devices(id) ON DELETE SET NULL,
  source              TEXT NOT NULL,
  location            TEXT NOT NULL,
  confidence          DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ssid                TEXT,
  bssid               TEXT,
  src_ip              TEXT,
  observed_at         BIGINT NOT NULL,
  server_received_at  BIGINT NOT NULL,
  raw_payload         TEXT
);
CREATE INDEX IF NOT EXISTS idx_presence_emp_obs ON presence_events(employee_id, observed_at);

CREATE TABLE IF NOT EXISTS daily_attendance (
  employee_id      TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date             TEXT NOT NULL,
  first_seen_at    BIGINT,
  last_seen_at     BIGINT,
  minutes_present  INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'NOT_CHECKED_IN',
  derived_at       BIGINT NOT NULL,
  is_closed        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (employee_id, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_attendance_date ON daily_attendance(date);

CREATE TABLE IF NOT EXISTS employee_breaks (
  id                BIGSERIAL PRIMARY KEY,
  employee_id       TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date              TEXT NOT NULL,
  started_at        BIGINT NOT NULL,
  ended_at          BIGINT,
  duration_minutes  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_breaks_emp_date ON employee_breaks(employee_id, date);

CREATE TABLE IF NOT EXISTS attendance_corrections (
  id                TEXT PRIMARY KEY,
  employee_id       TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date              TEXT NOT NULL,
  proposed_status   TEXT NOT NULL,
  proposed_minutes  INTEGER NOT NULL,
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING',
  submitted_at      BIGINT NOT NULL,
  reviewed_at       BIGINT,
  reviewed_by       TEXT,
  review_note       TEXT
);

CREATE TABLE IF NOT EXISTS employee_absences (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'RECORDED',
  note          TEXT,
  recorded_at   BIGINT NOT NULL,
  reviewed_at   BIGINT,
  reviewed_by   TEXT,
  consequence   TEXT
);

-- Users & Access Control
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  salt           TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'viewer',
  active         INTEGER NOT NULL DEFAULT 1,
  last_login_at  BIGINT,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at     BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  last_seen_at  BIGINT,
  revoked_at    BIGINT
);

-- Leave Management
CREATE TABLE IF NOT EXISTS leave_types (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  allowance_days  DOUBLE PRECISION NOT NULL,
  is_paid         INTEGER NOT NULL DEFAULT 1,
  description     TEXT
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id             TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id  TEXT NOT NULL REFERENCES leave_types(id),
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  days           DOUBLE PRECISION NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING',
  reason         TEXT,
  submitted_at   BIGINT NOT NULL,
  decided_at     BIGINT,
  decided_by     TEXT,
  decision_note  TEXT
);

CREATE TABLE IF NOT EXISTS leave_balances (
  employee_id     TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id   TEXT NOT NULL REFERENCES leave_types(id),
  year            INTEGER NOT NULL,
  days_allocated  DOUBLE PRECISION NOT NULL,
  days_taken      DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (employee_id, leave_type_id, year)
);

-- Disciplinary & Warnings
CREATE TABLE IF NOT EXISTS warning_policies (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  trigger_count  INTEGER NOT NULL,
  severity       TEXT NOT NULL,
  description    TEXT
);

CREATE TABLE IF NOT EXISTS formal_warnings (
  id               TEXT PRIMARY KEY,
  employee_id      TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  policy_id        TEXT REFERENCES warning_policies(id),
  level            TEXT NOT NULL,
  reason           TEXT NOT NULL,
  issued_at        BIGINT NOT NULL,
  expires_at       BIGINT,
  issued_by        TEXT NOT NULL,
  acknowledged_at  BIGINT,
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  revoked_at       BIGINT,
  revoke_reason    TEXT
);

CREATE TABLE IF NOT EXISTS warning_triggers (
  id             TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  date           TEXT NOT NULL,
  count          INTEGER NOT NULL,
  triggered_at   BIGINT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_at    BIGINT,
  reviewed_by    TEXT,
  review_note    TEXT,
  warning_id     TEXT REFERENCES formal_warnings(id)
);

-- HR Profiles, Compensation & Payroll
CREATE TABLE IF NOT EXISTS employee_salaries (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  base_salary     DOUBLE PRECISION NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'PKR',
  effective_from  TEXT NOT NULL,
  effective_to    TEXT,
  daily_rate      DOUBLE PRECISION,
  updated_at      BIGINT NOT NULL,
  updated_by      TEXT
);

CREATE TABLE IF NOT EXISTS payroll_periods (
  id          TEXT PRIMARY KEY,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'DRAFT',
  closed_at   BIGINT,
  closed_by   TEXT
);

CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id           TEXT PRIMARY KEY,
  period_id    TEXT NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id  TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  amount       DOUBLE PRECISION NOT NULL,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PROPOSED',
  decided_at   BIGINT,
  decided_by   TEXT,
  note         TEXT
);

-- Documents & KYC Vault
CREATE TABLE IF NOT EXISTS employee_documents (
  id                TEXT PRIMARY KEY,
  employee_id       TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  doc_type          TEXT NOT NULL,
  filename          TEXT NOT NULL,
  file_size         INTEGER NOT NULL,
  mime_type         TEXT NOT NULL,
  storage_key       TEXT NOT NULL,
  storage_provider  TEXT NOT NULL DEFAULT 'supabase',
  status            TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
  uploaded_at       BIGINT NOT NULL,
  uploaded_by       TEXT NOT NULL,
  verified_at       BIGINT,
  verified_by       TEXT,
  rejection_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_emp_docs_employee ON employee_documents(employee_id);

-- In-App Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  recipient_type  TEXT NOT NULL,
  recipient_id    TEXT,
  title           TEXT NOT NULL,
  message         TEXT NOT NULL,
  category        TEXT NOT NULL,
  read_at         BIGINT,
  dismissed_at    BIGINT,
  created_at      BIGINT NOT NULL,
  meta_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_rec ON notifications(recipient_type, recipient_id, created_at);

-- App Releases (OTA)
CREATE TABLE IF NOT EXISTS app_releases (
  id            TEXT PRIMARY KEY,
  version_tag   TEXT NOT NULL,
  version_code  INTEGER NOT NULL,
  platform      TEXT NOT NULL,
  download_url  TEXT NOT NULL,
  release_notes TEXT,
  is_mandatory  INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    BIGINT NOT NULL,
  created_by    TEXT
);

-- Org Settings & Audit Log
CREATE TABLE IF NOT EXISTS org_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  BIGINT NOT NULL,
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           BIGINT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  before_json  TEXT,
  after_json   TEXT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);

CREATE TABLE IF NOT EXISTS migrations (
  id          TEXT PRIMARY KEY,
  applied_at  BIGINT NOT NULL
);

-- Workstation Sessions (Desktop Agent Tracking)
CREATE TABLE IF NOT EXISTS workstation_sessions (
  id                  TEXT PRIMARY KEY,
  device_id           TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'IDLE', 'ON_BREAK', 'AWAY', 'OFFLINE'
  session_date        TEXT NOT NULL,                  -- YYYY-MM-DD
  active_seconds      INTEGER NOT NULL DEFAULT 0,
  idle_seconds        INTEGER NOT NULL DEFAULT 0,
  break_seconds       INTEGER NOT NULL DEFAULT 0,
  lock_state          TEXT NOT NULL DEFAULT 'UNLOCKED',
  connected_bssid     TEXT,
  in_office           INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at   BIGINT NOT NULL,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  UNIQUE(device_id, session_date)
);
CREATE INDEX IF NOT EXISTS idx_workstation_emp_date ON workstation_sessions(employee_id, session_date);

-- Process / Application Anomalies
CREATE TABLE IF NOT EXISTS process_anomalies (
  id                  TEXT PRIMARY KEY,
  employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  device_id           TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  process_name        TEXT NOT NULL,
  window_title        TEXT,
  duration_seconds    INTEGER NOT NULL,
  detected_at         BIGINT NOT NULL,
  resolved            INTEGER NOT NULL DEFAULT 0,
  notes               TEXT
);
CREATE INDEX IF NOT EXISTS idx_anomalies_emp ON process_anomalies(employee_id, detected_at);
