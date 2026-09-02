-- Migration 015: Workstation Application & Software Usage Records
CREATE TABLE IF NOT EXISTS workstation_app_usage (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  app_name TEXT NOT NULL,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL,
  UNIQUE(device_id, session_date, app_name)
);

CREATE INDEX IF NOT EXISTS idx_app_usage_emp_date ON workstation_app_usage(employee_id, session_date);
