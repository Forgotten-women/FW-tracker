-- 037_period_adjustment_kind.sql
-- A period adjustment is either EXTRA_TIME (offsets the month's deficit first,
-- the rest is extra time) or DEFICIT_FIX (only cancels deficit; never becomes
-- extra time). Before this, the history screen counted every credit as extra
-- time and left the deficit and its whole-day penalty untouched (2026-11-03).
ALTER TABLE attendance_period_adjustments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'EXTRA_TIME';
