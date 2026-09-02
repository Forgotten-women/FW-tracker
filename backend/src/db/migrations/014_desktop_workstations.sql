-- Workstation Sessions, Desktop Presence, and Anomaly Monitoring
CREATE TABLE IF NOT EXISTS workstation_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'IDLE', 'ON_BREAK', 'AWAY', 'OFFLINE'
  session_date TEXT NOT NULL, -- YYYY-MM-DD
  active_seconds INTEGER NOT NULL DEFAULT 0,
  idle_seconds INTEGER NOT NULL DEFAULT 0,
  break_seconds INTEGER NOT NULL DEFAULT 0,
  lock_state TEXT NOT NULL DEFAULT 'UNLOCKED', -- 'LOCKED', 'UNLOCKED', 'SLEEPING'
  connected_bssid TEXT,
  in_office INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(device_id, session_date)
);

CREATE INDEX IF NOT EXISTS idx_workstation_emp_date ON workstation_sessions(employee_id, session_date);

-- Unapproved process anomaly alerts
CREATE TABLE IF NOT EXISTS process_anomalies (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  process_name TEXT NOT NULL,
  window_title TEXT,
  duration_seconds INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_anomalies_emp ON process_anomalies(employee_id, detected_at);

-- Add device_type column to devices if not exists
-- Note: in SQLite ALTER TABLE ADD COLUMN succeeds if not present
ALTER TABLE devices ADD COLUMN device_type TEXT NOT NULL DEFAULT 'mobile';

-- System settings for desktop activity policy
INSERT OR IGNORE INTO org_settings (key, value, updated_at, updated_by)
VALUES ('idle_threshold_minutes', '5', 0, 'system');

INSERT OR IGNORE INTO org_settings (key, value, updated_at, updated_by)
VALUES ('lock_screen_grace_minutes', '5', 0, 'system');

INSERT OR IGNORE INTO org_settings (key, value, updated_at, updated_by)
VALUES ('approved_work_processes', 'code.exe,chrome.exe,slack.exe,ms-teams.exe,teams.exe,excel.exe,winword.exe,powerpnt.exe,figma.exe,cursor.exe,webstorm64.exe,idea64.exe,notepad.exe,outlook.exe,postman.exe,terminal.exe,powershell.exe,cmd.exe,devenv.exe,Code,Google Chrome,Slack,Microsoft Teams,Microsoft Excel,Microsoft Word,Figma,Cursor,WebStorm,IntelliJ IDEA,Notes,Terminal,iTerm2', 0, 'system');
