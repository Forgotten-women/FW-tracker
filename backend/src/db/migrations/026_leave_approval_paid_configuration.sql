-- Migration 026: Leave approval paid/unpaid configuration
-- Allows HR to approve a leave request explicitly as PAID (1) or UNPAID (0).
-- When NULL, it defaults to the leave type's base configuration.

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS is_paid BIGINT DEFAULT NULL;
ALTER TABLE leave_approvals ADD COLUMN IF NOT EXISTS is_paid BIGINT DEFAULT NULL;
