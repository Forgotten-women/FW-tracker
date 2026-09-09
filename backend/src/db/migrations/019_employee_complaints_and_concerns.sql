-- Migration 019: Employee Complaints & Concerns System
--
-- Enables confidential submission and tracking of employee concerns and grievances.
-- Only accessible to the submitting employee and authorised HR/Management personnel.

CREATE TABLE IF NOT EXISTS complaints (
  id                  TEXT PRIMARY KEY,
  reference_number    TEXT NOT NULL UNIQUE,      -- e.g. CMP-2026-0001
  employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  category            TEXT NOT NULL,
  subject             TEXT NOT NULL,
  description         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'SUBMITTED', -- SUBMITTED | UNDER_REVIEW | IN_PROGRESS | RESOLVED | CLOSED
  priority            TEXT NOT NULL DEFAULT 'NORMAL',     -- LOW | NORMAL | HIGH | URGENT
  hr_notes            TEXT,
  resolution_notes    TEXT,
  resolved_at         BIGINT,
  resolved_by         TEXT,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_complaints_employee ON complaints(employee_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_category ON complaints(category);
CREATE INDEX IF NOT EXISTS idx_complaints_created ON complaints(created_at DESC);

CREATE TABLE IF NOT EXISTS complaint_attachments (
  id                  TEXT PRIMARY KEY,
  complaint_id        TEXT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  file_name           TEXT NOT NULL,
  file_size           BIGINT NOT NULL,
  mime_type           TEXT NOT NULL,
  storage_key         TEXT NOT NULL,
  storage_provider    TEXT NOT NULL DEFAULT 'local',
  created_at          BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_complaint_attachments_complaint ON complaint_attachments(complaint_id);

-- Register permissions for confidential concerns
INSERT INTO permissions (id, category, description, is_sensitive) VALUES
  ('self.complaint.submit', 'self', 'Submit confidential concerns and complaints', 0),
  ('self.complaint.read',   'self', 'View own submitted complaints', 0),
  ('complaint.read',        'complaint', 'View employee complaints and concerns (HR/Manager confidential)', 1),
  ('complaint.write',       'complaint', 'Update status, add response notes and resolve employee complaints', 1)
ON CONFLICT (id) DO NOTHING;

-- Map permissions to roles
INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('employee',    'self.complaint.submit'),
  ('employee',    'self.complaint.read'),
  ('manager',     'self.complaint.submit'),
  ('manager',     'self.complaint.read'),
  ('manager',     'complaint.read'),
  ('hr',          'self.complaint.submit'),
  ('hr',          'self.complaint.read'),
  ('hr',          'complaint.read'),
  ('hr',          'complaint.write'),
  ('super_admin', 'self.complaint.submit'),
  ('super_admin', 'self.complaint.read'),
  ('super_admin', 'complaint.read'),
  ('super_admin', 'complaint.write')
ON CONFLICT (role_id, permission_id) DO NOTHING;
