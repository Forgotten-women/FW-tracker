-- Office Tracker schema.
--
-- Replaces backend/data/db.json, where saveDb() only set a dirty flag, a 3s
-- interval did a blocking non-atomic writeFileSync of the whole file, and a
-- truncated file caused the loadDb() catch block to silently start an EMPTY
-- database.
--
-- Principle: presence is recorded as immutable events. Attendance is DERIVED
-- by replaying them, never mutated in place. That gives a real audit trail and
-- lets history be recomputed after a bug fix.
--
-- All timestamps are UTC epoch milliseconds (INTEGER).

PRAGMA foreign_keys = ON;

-- Internal key/value: schema version, MAC-hashing salt.
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- Employees carry NO device columns. The old schema stored a single deviceIp
-- and deviceMac on the employee row and matched on them, which broke under MAC
-- randomisation and DHCP lease reuse, and could attribute one person's
-- presence to another. Devices now live in their own table, many per employee.
CREATE TABLE IF NOT EXISTS employees (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'Team Member',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_employees_active ON employees(active);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  employee_id  TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL DEFAULT 'unknown',   -- android | ios | esp | unknown
  model        TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL DEFAULT '',
  enrolled_at  INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_devices_employee ON devices(employee_id);

-- Bearer tokens are stored hashed. A database leak must not yield usable
-- credentials.
CREATE TABLE IF NOT EXISTS device_tokens (
  token_hash   TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tokens_device ON device_tokens(device_id);

-- Single-use, short-TTL codes an admin hands to an employee to enrol a phone.
-- This replaces the old flow, where the CLIENT invented its own employee id as
-- emp_${millis % 10000} and the server accepted whatever name it was given.
CREATE TABLE IF NOT EXISTS enrollment_codes (
  code_hash      TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  used_at        INTEGER,
  used_by_device TEXT
);

-- ---------------------------------------------------------------------------
-- Presence: append-only event log
-- ---------------------------------------------------------------------------

-- Never UPDATEd, never DELETEd except by the retention job.
--
-- location is the anti-spoofing verdict computed server-side at ingest:
--   OFFICE  - BSSID on the office allowlist AND source IP in an office subnet
--   REMOTE  - authenticated, but not physically at the office
--   UNKNOWN - could not be verified
-- Only OFFICE events count toward attendance.
--
-- confidence lets sensors of different reliability be fused rather than
-- overwrite each other: an authenticated app heartbeat outranks an ARP
-- sighting, which is a stale cache and cannot establish identity.
CREATE TABLE IF NOT EXISTS presence_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id  TEXT REFERENCES employees(id) ON DELETE SET NULL,
  device_id    TEXT REFERENCES devices(id) ON DELETE SET NULL,
  source       TEXT NOT NULL,        -- APP | ESP_SNIFFER | ARP | ROUTER | ADMIN
  location     TEXT NOT NULL,        -- OFFICE | REMOTE | UNKNOWN
  confidence   REAL NOT NULL DEFAULT 0.5,
  ssid         TEXT,
  bssid        TEXT,
  src_ip       TEXT,
  mac_hash     TEXT,
  rssi         INTEGER,
  observed_at  INTEGER NOT NULL,     -- when the sensor saw it
  received_at  INTEGER NOT NULL,     -- when the server ingested it
  -- Makes replay of the offline queue in the app idempotent: a buffered
  -- heartbeat resent with its original timestamp inserts once, not twice.
  dedupe_key   TEXT NOT NULL UNIQUE,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_emp_time ON presence_events(employee_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_events_time     ON presence_events(observed_at);

-- Devices on the office Wi-Fi not matched to an employee. MACs are stored
-- HASHED, see hashMac() in util/time.js. Retained on a short TTL.
CREATE TABLE IF NOT EXISTS unknown_devices (
  mac_hash       TEXT PRIMARY KEY,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  last_source    TEXT NOT NULL,
  sighting_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_unknown_lastseen ON unknown_devices(last_seen_at);

-- ---------------------------------------------------------------------------
-- Derived attendance (the payroll record)
-- ---------------------------------------------------------------------------

-- A materialised cache of replaying presence_events for one employee-day.
-- Safe to DELETE and rebuild from the event log at any time.
--
-- `closed` is set by the midnight rollover job. The old code had no rollover
-- at all: checkDepartures() only looked at the CURRENT day ledger, so a
-- session left open across midnight was never closed and its minutes grew
-- without bound.
CREATE TABLE IF NOT EXISTS attendance_days (
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date_key       TEXT NOT NULL,              -- local YYYY-MM-DD
  first_in_at    INTEGER,
  last_active_at INTEGER,
  total_minutes  INTEGER NOT NULL DEFAULT 0,
  sessions_json  TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'NOT_CHECKED_IN',
  closed         INTEGER NOT NULL DEFAULT 0,
  -- HR corrections are additive and attributable, never silent edits to the
  -- underlying record.
  adjustment_minutes INTEGER NOT NULL DEFAULT 0,
  adjustment_note    TEXT,
  derived_at     INTEGER NOT NULL,
  PRIMARY KEY (employee_id, date_key)
);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_days(date_key);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- Every admin mutation. Required because this data feeds payroll: changes to
-- the recorded hours of an employee must be attributable after the fact.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  before_json TEXT,
  after_json  TEXT,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

-- Human-readable activity feed for the dashboard (ARRIVED / DEPARTED / ...).
-- Previously capped at 1000 entries in memory, so history was silently lost.
CREATE TABLE IF NOT EXISTS movements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  type          TEXT NOT NULL,
  employee_id   TEXT REFERENCES employees(id) ON DELETE SET NULL,
  employee_name TEXT,
  details       TEXT
);
CREATE INDEX IF NOT EXISTS idx_movements_at ON movements(at);
