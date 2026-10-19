-- 035_attendance_period_adjustments.sql
-- Bulk / Period Attendance Adjustments & Extra Time Credits (Spec Section 13 & 14)

CREATE TABLE IF NOT EXISTS attendance_period_adjustments (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  credit_minutes INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_period_adj_emp ON attendance_period_adjustments(employee_id);
CREATE INDEX IF NOT EXISTS idx_period_adj_dates ON attendance_period_adjustments(period_start, period_end);
