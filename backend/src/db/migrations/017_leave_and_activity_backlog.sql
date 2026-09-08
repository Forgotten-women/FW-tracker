-- Migration 017: Leave Carry-Forward Records and Employee App Usage Backlog Indexing
-- 
-- 1. Creates leave_carry_forward_records table to track management approval (max 5 days)
--    and carry-forward into the next work anniversary cycle.
-- 2. Ensures workstation_app_usage supports fast backlog queries per employee and date range
--    while maintaining ultra-lean storage footprint (one row per employee, session_date, app_name).

CREATE TABLE IF NOT EXISTS leave_carry_forward_records (
  id                    TEXT PRIMARY KEY,
  employee_id           TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  from_leave_year       TEXT NOT NULL,
  to_leave_year         TEXT NOT NULL,
  unused_days_at_close  REAL NOT NULL,
  approved_days         REAL NOT NULL DEFAULT 0,
  lapsed_days           REAL NOT NULL DEFAULT 0,
  decision              TEXT NOT NULL, -- APPROVED | REJECTED | NO_REQUEST_LAPSED
  approved_by           TEXT,          -- User ID or 'admin'
  approved_at           BIGINT,        -- Epoch ms
  notes                 TEXT,
  applied_at            BIGINT,        -- Epoch ms when rollover applied to ledger
  created_at            BIGINT NOT NULL,
  CONSTRAINT uq_carry_forward_emp_year UNIQUE (employee_id, from_leave_year)
);

CREATE INDEX IF NOT EXISTS idx_carry_forward_emp ON leave_carry_forward_records(employee_id);

-- Ensure workstation_app_usage has index on (employee_id, session_date) for lean backlog aggregation
CREATE INDEX IF NOT EXISTS idx_app_usage_emp_session ON workstation_app_usage(employee_id, session_date);
