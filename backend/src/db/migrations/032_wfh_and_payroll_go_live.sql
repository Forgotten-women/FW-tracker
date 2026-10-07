-- Migration 032: work-from-home days, and payroll's go-live date.
--
-- 1. Leave type `wfh` ("Work from home"). An approved WFH request is NOT time
--    off: the day stays a normal working day (schedule.leaveOn ignores it),
--    it never uses annual leave (leave.balanceRaw ignores it), and on that day
--    the employee is treated as a remote worker, so time worked away from the
--    office (phone and laptop) is recorded as REMOTE_VERIFIED and counted.
--    Office-based staff working from home used to show as absent with a
--    shortfall.
--
-- 2. org_settings.payroll_go_live_date = 2026-09-01. Payroll deducts unpaid
--    leave and unpaid absences only from this date. Unpaid days before it
--    (HR's records from 2025-2026, entered for history) were already settled
--    in salaries paid before this system ran payroll, and would otherwise be
--    deducted again in the next run, since those queries had no lower bound.
--    Production data, so it is not in pg/seed.sql (tests keep no lower bound).
--
-- Additive and idempotent. Safe to run against production.

INSERT INTO leave_types (id, name, requires_approval, reduces_entitlement, is_paid, requires_evidence, counts_toward_warnings, active)
VALUES ('wfh', 'Work from home', 1, 0, 1, 0, 0, 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO org_settings (key, value, updated_at, updated_by)
VALUES ('payroll_go_live_date', '2026-09-01', 0, 'system')
ON CONFLICT (key) DO NOTHING;
