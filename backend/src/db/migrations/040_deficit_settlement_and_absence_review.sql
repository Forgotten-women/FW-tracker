-- 040_deficit_settlement_and_absence_review.sql
-- "Office App - Update Requirements" (HR, 2026-11-12), phase 1:
--   * leave categories: unpaid sick and unpaid maternity;
--   * unauthorised absence review (notice given, emergency, treatment,
--     fixed one-day penalty per incident, approver);
--   * monthly deficit settlement (paid annual leave / unpaid / carried
--     forward) and a separate, fixed deficit penalty; 8 h = 1 deficit day;
--   * annual leave charges the balance cannot cover are held as an
--     Outstanding Annual Leave Adjustment until accrual (or leaving) covers them.

-- Leave categories
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active)
  VALUES ('sick_unpaid', 'Sick leave (unpaid)', 1, 0, 0, 1, 0, 1) ON CONFLICT DO NOTHING;
INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active)
  VALUES ('maternity_unpaid', 'Maternity leave (unpaid)', 1, 0, 0, 1, 0, 1) ON CONFLICT DO NOTHING;
UPDATE leave_types SET name = 'Sick leave (paid)' WHERE id = 'sick' AND name = 'Sick leave';
UPDATE leave_types SET name = 'Maternity leave (paid)' WHERE id = 'maternity' AND name = 'Maternity leave';

-- Unauthorised absence review
ALTER TABLE absence_records ADD COLUMN IF NOT EXISTS notification_status TEXT;      -- NO_NOTICE | SHORT_NOTICE | NORMAL_NOTICE
ALTER TABLE absence_records ADD COLUMN IF NOT EXISTS emergency_exception BIGINT;    -- 1 = genuine emergency / exceptional circumstances
ALTER TABLE absence_records ADD COLUMN IF NOT EXISTS treatment TEXT;                -- UNPAID | PAID_ANNUAL_LEAVE
ALTER TABLE absence_records ADD COLUMN IF NOT EXISTS incident_id TEXT;              -- consecutive days share one incident: one penalty
ALTER TABLE absence_records ADD COLUMN IF NOT EXISTS cover_al_days DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE absence_records ADD COLUMN IF NOT EXISTS penalty_al_days DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE absence_records ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE absence_records ADD COLUMN IF NOT EXISTS approved_at BIGINT;
ALTER TABLE absence_records ADD COLUMN IF NOT EXISTS cover_ledger_id TEXT;
ALTER TABLE absence_records ADD COLUMN IF NOT EXISTS penalty_ledger_id TEXT;
ALTER TABLE absence_records ADD COLUMN IF NOT EXISTS reclassified_request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_absence_incident ON absence_records(incident_id);

-- Deficit settlement, one row per HR decision (a period may be settled in parts)
CREATE TABLE IF NOT EXISTS attendance_deficit_settlements (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,                        -- YYYY-MM
  al_days DOUBLE PRECISION NOT NULL DEFAULT 0,     -- covered by paid annual leave
  unpaid_days DOUBLE PRECISION NOT NULL DEFAULT 0, -- whole days treated as unpaid
  unpaid_minutes BIGINT NOT NULL DEFAULT 0,        -- hours/minutes treated as unpaid
  settled_minutes BIGINT NOT NULL,
  snapshot_json TEXT NOT NULL,                     -- the deficit card as it stood when HR confirmed
  reason TEXT NOT NULL,
  entered_by TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  ledger_entry_id TEXT,
  leave_ledger_id TEXT,
  outstanding_adjustment_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_deficit_settlements_emp ON attendance_deficit_settlements(employee_id, period_key);

-- Deficit penalty: at most one per employee per period, never multiplied by days
CREATE TABLE IF NOT EXISTS attendance_deficit_penalties (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  penalty_option TEXT NOT NULL,                    -- NONE | OPTION_1 | OPTION_2
  al_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  pay_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  entered_by TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  leave_ledger_id TEXT,
  outstanding_adjustment_id TEXT,
  UNIQUE (employee_id, period_key)
);

-- Annual leave charges the balance could not cover
CREATE TABLE IF NOT EXISTS leave_outstanding_adjustments (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  days DOUBLE PRECISION NOT NULL,
  applied_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN',             -- OPEN | APPLIED | SETTLED_ON_LEAVING | CANCELLED
  ledger_entry_type TEXT NOT NULL,                 -- PENALTY | UA_COVER | DEFICIT_COVER
  source_type TEXT NOT NULL,                       -- ABSENCE | DEFICIT_SETTLEMENT | DEFICIT_PENALTY
  source_id TEXT,
  reason TEXT NOT NULL,
  entered_by TEXT NOT NULL,
  approved_by TEXT,
  created_at BIGINT NOT NULL,
  settled_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_leave_outstanding_emp ON leave_outstanding_adjustments(employee_id, status);
