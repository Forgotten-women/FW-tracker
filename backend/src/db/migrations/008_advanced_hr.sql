-- Advanced HR: performance reviews and alert acknowledgement. Spec sections 5,
-- 20.2, 22 and Phase 8.
--
-- Most of what Phase 8 needs already exists: employment_records carries
-- contract_end_date and probation_review_date, and employee_documents carries
-- expiry_date. So the alert engine reads those rather than duplicating them.
-- The only genuinely new things are a performance-review record and a way to
-- dismiss an alert without losing that it was raised.

-- Performance reviews. Confirmed 2026-08-27 as AD-HOC: HR schedules each one
-- with a due date and records its outcome. No automatic cycle is imposed,
-- because the organisation has not defined one.
CREATE TABLE IF NOT EXISTS performance_reviews (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  review_type   TEXT NOT NULL DEFAULT 'GENERAL',   -- GENERAL | PROBATION | ANNUAL | PIP
  due_date      TEXT NOT NULL,                      -- YYYY-MM-DD
  -- SCHEDULED | IN_PROGRESS | COMPLETED | CANCELLED
  status        TEXT NOT NULL DEFAULT 'SCHEDULED',
  reviewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  outcome       TEXT,
  notes         TEXT,
  document_id   TEXT REFERENCES employee_documents(id) ON DELETE SET NULL,
  completed_at  INTEGER,
  created_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_employee ON performance_reviews(employee_id);
CREATE INDEX IF NOT EXISTS idx_reviews_due      ON performance_reviews(due_date)
  WHERE status IN ('SCHEDULED', 'IN_PROGRESS');

-- An alert is DERIVED from a date passing a threshold, so there is no alert
-- table to store. This records only that someone dismissed one, keyed by a
-- stable identity for the underlying thing (e.g. "contract:er_123"). Dismissing
-- an alert must not erase the date behind it, so the alert reappears if the
-- date changes.
CREATE TABLE IF NOT EXISTS alert_dismissals (
  alert_key     TEXT PRIMARY KEY,
  -- The value the alert was about when dismissed (the date). If it later
  -- changes, the dismissal no longer applies and the alert returns.
  dismissed_value TEXT NOT NULL,
  dismissed_by  TEXT NOT NULL,
  dismissed_at  INTEGER NOT NULL,
  note          TEXT
);

-- Records which alerts have already produced an HR notification, so the daily
-- scan does not raise the same one every day.
CREATE TABLE IF NOT EXISTS alert_notifications_sent (
  alert_key   TEXT PRIMARY KEY,
  sent_value  TEXT NOT NULL,
  sent_at     INTEGER NOT NULL
);

-- A permission for the Advanced HR alert board. Kept distinct from
-- attendance/leave reads so it can be granted independently. Confirmed
-- 2026-08-27: HR and Super Admin only.
INSERT OR IGNORE INTO permissions (id, category, description, is_sensitive) VALUES
  ('hr.alerts.read',   'admin', 'View Advanced HR alerts (contract, probation, document and review dates)', 1),
  ('hr.reviews.manage','admin', 'Schedule and record performance reviews', 1);

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'hr', id FROM permissions WHERE id IN ('hr.alerts.read', 'hr.reviews.manage');
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'super_admin', id FROM permissions WHERE id IN ('hr.alerts.read', 'hr.reviews.manage');
