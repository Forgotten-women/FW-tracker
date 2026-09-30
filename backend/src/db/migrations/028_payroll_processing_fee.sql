-- Migration 028: the payroll processing-fee columns.
--
-- routes/payroll.js and domain/payroll.js (commit 3d6aba0) read and write
-- these, but no migration created them -- so creating a payroll period (the
-- automatic monthly opening included) fails on any database without them.
-- Additive and idempotent. Safe to run against production.

ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS processing_fee DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS processing_fee_type TEXT NOT NULL DEFAULT 'DEDUCTION';
