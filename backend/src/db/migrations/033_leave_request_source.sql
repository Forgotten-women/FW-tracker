-- Migration 033: Add source column to leave_requests to distinguish between
-- HR manually added leaves and employee requested & approved leaves.

ALTER TABLE leave_requests 
ADD COLUMN IF NOT EXISTS source VARCHAR(32) DEFAULT 'EMPLOYEE_REQUEST';

UPDATE leave_requests
SET source = 'HR_MANUAL'
WHERE id LIKE 'lr_hrwb_%' 
   OR id LIKE 'lr_hr_%'
   OR reason ILIKE '%HR record%' 
   OR reason ILIKE '%Recorded by HR%' 
   OR (submitted_at IS NOT NULL AND submitted_at = decided_at);
