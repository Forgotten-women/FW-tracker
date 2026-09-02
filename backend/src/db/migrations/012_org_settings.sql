-- Organization settings table (e.g. employee mobile salary visibility)
CREATE TABLE IF NOT EXISTS org_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

INSERT OR IGNORE INTO org_settings (key, value, updated_at, updated_by)
VALUES ('show_salary_to_employees', '0', 0, 'system');
