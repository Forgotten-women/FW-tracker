-- Migration 030: the payroll processing fee is a percentage of each
-- employee's gross pay for the period, not one fixed amount for everyone.
--
-- processing_fee keeps its column; processing_fee_basis says how to read it.
-- Periods created before this keep 'FIXED' (an amount), so their existing
-- fee lines keep their meaning; new periods are created as 'PERCENT'.
--
-- Additive and idempotent. Safe to run against production.

ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS processing_fee_basis TEXT NOT NULL DEFAULT 'FIXED';
