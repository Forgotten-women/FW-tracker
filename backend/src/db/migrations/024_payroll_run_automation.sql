-- Migration 024: automated monthly payroll run, exception-based review and
-- immutable payslips.
--
-- The run is still "the system calculates, a person approves": the
-- maintenance tick opens a calendar-month period, and after the cut-off day
-- generates the PROPOSED deductions and moves the period to IN_REVIEW. Nothing
-- reaches anyone's pay until a person approves the run, which writes one
-- payslip snapshot per employee. Lifecycle:
--
--   OPEN -> IN_REVIEW -> PUBLISHED -> PAID      (automated monthly periods)
--   OPEN -> CLOSED                              (legacy manual periods)
--
-- payroll_periods.status has no CHECK constraint, so the new statuses need no
-- constraint change.
--
-- Everything is additive and idempotent (IF NOT EXISTS / ON CONFLICT), so it
-- is safe to run more than once against a live database.

ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS cutoff_date TEXT;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS pay_date TEXT;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS auto_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS generated_at BIGINT;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS published_at BIGINT;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS published_by TEXT;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS paid_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_payroll_periods_status
  ON payroll_periods (status, cutoff_date);

-- ROUTINE | ATTENTION. NULL on rows created before this migration.
-- review_reasons is a JSON array of short human-readable strings.
ALTER TABLE payroll_adjustments ADD COLUMN IF NOT EXISTS review_level TEXT;
ALTER TABLE payroll_adjustments ADD COLUMN IF NOT EXISTS review_reasons TEXT;

-- One row per employee per published run. The figures are written once and
-- never updated; a correction would be a new version, with the old one marked
-- SUPERSEDED. content_hash is sha256 over the canonical JSON of the figures,
-- so any later tampering with a published payslip is detectable.
CREATE TABLE IF NOT EXISTS payslips (
  id                     TEXT PRIMARY KEY,
  period_id              TEXT NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id            TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  version                INTEGER NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL DEFAULT 'PUBLISHED',   -- PUBLISHED | SUPERSEDED
  currency               TEXT,
  exchange_rate          DOUBLE PRECISION,
  monthly_salary         DOUBLE PRECISION,
  daily_rate             DOUBLE PRECISION,
  gross_baseline         DOUBLE PRECISION NOT NULL,
  deductions_total       DOUBLE PRECISION NOT NULL DEFAULT 0, -- positive sum of the negative lines
  adjustments_total      DOUBLE PRECISION NOT NULL DEFAULT 0, -- signed sum of every approved line
  net_payable            DOUBLE PRECISION NOT NULL,           -- gross_baseline + adjustments_total
  working_days           INTEGER,
  full_period_days       INTEGER,
  is_partial             INTEGER NOT NULL DEFAULT 0,
  is_starter             INTEGER NOT NULL DEFAULT 0,
  salary_effective_from  TEXT,
  lines_json             TEXT NOT NULL DEFAULT '[]',
  cutoff_date            TEXT,
  pay_date               TEXT,
  published_at           BIGINT NOT NULL,
  published_by           TEXT NOT NULL,
  paid_at                BIGINT,
  content_hash           TEXT NOT NULL,
  created_at             BIGINT NOT NULL,
  CONSTRAINT uq_payslips_period_id_employee_id_version UNIQUE (period_id, employee_id, version)
);

-- At most one live payslip per employee per period, whatever the version.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payslips_live_per_period
  ON payslips (period_id, employee_id) WHERE status = 'PUBLISHED';

-- The phone's "has a new payslip been published" check, and its history list.
CREATE INDEX IF NOT EXISTS idx_payslips_employee
  ON payslips (employee_id, status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_payslips_period
  ON payslips (period_id, status);

INSERT INTO org_settings (key, value, updated_at, updated_by)
  VALUES ('payroll_cutoff_day', '25', 0, 'system') ON CONFLICT (key) DO NOTHING;
INSERT INTO org_settings (key, value, updated_at, updated_by)
  VALUES ('show_payroll_estimate_to_employees', '1', 0, 'system') ON CONFLICT (key) DO NOTHING;
