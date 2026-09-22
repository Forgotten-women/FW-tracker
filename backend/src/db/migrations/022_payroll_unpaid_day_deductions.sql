-- Migration 022: Indexes supporting attendance-deficit and unauthorised-
-- absence/unpaid-leave payroll deductions.
--
-- No new tables or columns: the "already claimed" high-water-mark for
-- attendance-deficit whole-days is derived from payroll_adjustments (SUM of
-- calculated_days by employee + adjustment_type = 'ATTENDANCE_DEFICIT_DAY'),
-- and "already claimed" for unauthorised absences / unpaid leave is a
-- NOT EXISTS join against payroll_adjustments.source_reference plus
-- absence_records.consequences_applied_at (an existing, previously-unused
-- column that now gets written on approval). These indexes make both
-- derivations cheap once payroll_adjustments and absence_records span many
-- periods.

CREATE INDEX IF NOT EXISTS idx_payroll_adj_employee_type
  ON payroll_adjustments (employee_id, adjustment_type);

CREATE INDEX IF NOT EXISTS idx_payroll_adj_type_source
  ON payroll_adjustments (adjustment_type, source_reference);

CREATE INDEX IF NOT EXISTS idx_absence_unpaid_lookup
  ON absence_records (employee_id, status, treat_as_unpaid, consequences_applied_at);
