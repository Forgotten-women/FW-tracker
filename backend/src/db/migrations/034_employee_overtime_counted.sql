-- Migration 034: Add overtime_counted to employees for individual overtime tracking policy
ALTER TABLE employees ADD COLUMN IF NOT EXISTS overtime_counted BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_employees_overtime_counted ON employees(overtime_counted);
