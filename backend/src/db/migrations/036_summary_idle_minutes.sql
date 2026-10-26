-- 036_summary_idle_minutes.sql
-- Laptop idle per day, kept apart from the deficit (late, break overrun, early
-- leave, unexplained gaps). It never changes pay by itself: HR decides, and
-- can add an IDLE_DEDUCTION payroll line if they want it to (2026-10-26).
ALTER TABLE attendance_daily_summary ADD COLUMN IF NOT EXISTS idle_minutes INTEGER NOT NULL DEFAULT 0;
