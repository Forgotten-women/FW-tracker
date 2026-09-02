-- Leave policy, confirmed by Forgotten Women on 2026-08-27.
--
-- The seeded policy carried my own placeholders for everything except the 20
-- day entitlement, which is the only figure the spec actually states. All of it
-- is now the confirmed position.

UPDATE leave_policies
SET name = 'Forgotten Women standard (20 days, anniversary year)',
    annual_entitlement_days = 20,
    accrual_method = 'MONTHLY_ON_COMPLETION',
    carry_over_days = 0,
    carry_over_expiry_months = NULL,
    -- Confirmed: an employee may go beyond their entitlement, but only where HR
    -- approves it. The request still shows the shortfall before anyone decides.
    allow_negative_balance = 1,
    -- The column is NOT NULL and holds a calendar MM-DD, which no longer applies
    -- now the year runs from each employment anniversary. An explicit sentinel
    -- says so, where a leftover '01-01' would read as a real January boundary.
    holiday_year_start = 'ANNIVERSARY'
WHERE id = 'lp_default';

-- Confirmed approval route: HR only. One step, so a request is never waiting on
-- a manager who has not been set up as a user.
CREATE TABLE IF NOT EXISTS leave_approval_routes (
  id          TEXT PRIMARY KEY,
  leave_type_id TEXT REFERENCES leave_types(id) ON DELETE CASCADE,
  step        INTEGER NOT NULL,
  approver_role TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO leave_approval_routes (id, leave_type_id, step, approver_role, created_at)
VALUES ('lar_default_hr', NULL, 1, 'hr', 0);

-- Accrual is posted per employee-month, so re-running the accrual job cannot
-- credit the same month twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accrual_unique_month
  ON leave_accrual_ledger(employee_id, leave_year, effective_date)
  WHERE entry_type = 'ACCRUAL';

-- Records that HR knowingly allowed a balance to go negative. Spec 29: the
-- system calculates, a person decides, and the decision is attributable.
CREATE TABLE IF NOT EXISTS leave_overdraft_approvals (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  employee_id  TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shortfall_days REAL NOT NULL,
  approved_by  TEXT NOT NULL,
  approved_at  INTEGER NOT NULL,
  reason       TEXT NOT NULL
);
