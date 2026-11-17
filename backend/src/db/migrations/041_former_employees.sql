-- 041_former_employees.sql
-- Former employees (HR update, 2026-11-17): an employee whose employment has
-- ended is moved to "Former employee" with a confirmed final employment date.
-- From then on they are kept apart from the live workforce (no attendance
-- expected, no deficits, not counted), while every historical record stays.
-- A final date still ahead is held as pending and applied the day after it.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS final_employment_date TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS former_pending BIGINT NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS former_since BIGINT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS former_by TEXT;
