-- Migration 024: Add work_mode and remote_allowed to employees for Remote Work tracking
ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_mode TEXT NOT NULL DEFAULT 'IN_OFFICE';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS remote_allowed INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_employees_work_mode ON employees(work_mode);

-- Insert common alternative working pattern templates if not already present
INSERT INTO working_patterns (id, name, working_days, start_time, end_time, permitted_break_minutes, day_equivalent_minutes, grace_minutes, is_default, active, created_at)
VALUES 
  ('wp_10_18', 'Morning Shift (10:00 - 18:00)', 'mon,tue,wed,thu,fri', '10:00', '18:00', 30, 450, 10, 0, 1, 1727180000000),
  ('wp_12_20', 'Evening Shift (12:00 - 20:00)', 'mon,tue,wed,thu,fri', '12:00', '20:00', 30, 450, 10, 0, 1, 1727180000000)
ON CONFLICT (id) DO NOTHING;
