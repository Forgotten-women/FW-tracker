-- Migration 029: monthly employee invoices, generated on demand.
--
-- No invoice document is ever stored. The only stored artefact is the Word
-- template HR uploads (invoice_templates); each view fills it from the
-- figures. What an approved month was paid on is frozen as numbers only: the
-- payslip row already holds the money, and statement_json adds the
-- attendance counts, employee and bank details it was published with, so a
-- later correction cannot change an invoice someone has been paid on.
--
-- Additive and idempotent. Safe to run against production.

CREATE TABLE IF NOT EXISTS invoice_templates (
  id TEXT PRIMARY KEY,
  version BIGINT NOT NULL,
  name TEXT NOT NULL,
  file BYTEA NOT NULL,
  sha256 TEXT NOT NULL,
  placeholders TEXT NOT NULL,          -- JSON array of the fields it uses
  active BIGINT NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  uploaded_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_templates_version ON invoice_templates(version);
CREATE INDEX IF NOT EXISTS idx_invoice_templates_active ON invoice_templates(active);

-- The invoice data an approved month was published with, and the template
-- version it is rendered in.
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS statement_json TEXT;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS template_id TEXT;

-- The note HR writes when approving a run, printed on the invoice. It used to
-- go to audit_log only.
ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS approval_note TEXT;
