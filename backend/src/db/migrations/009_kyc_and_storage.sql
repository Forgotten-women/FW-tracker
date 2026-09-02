-- Staff KYC repository and Cloud Storage verification. Spec sections 5 and 27.

ALTER TABLE employee_documents ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'VERIFIED';
ALTER TABLE employee_documents ADD COLUMN verified_by TEXT;
ALTER TABLE employee_documents ADD COLUMN verified_at INTEGER;
ALTER TABLE employee_documents ADD COLUMN rejection_reason TEXT;
ALTER TABLE employee_documents ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'local';

ALTER TABLE document_versions ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'local';

-- Seed explicit KYC categories
INSERT OR IGNORE INTO document_types (id, name, confidentiality, requires_expiry, requires_acknowledgement) VALUES
  ('cv_resume',            'CV / Resume',                              'normal',              0, 0),
  ('nic_card',             'National Identity Card (CNIC / Smart Card)','highly_confidential', 1, 0),
  ('next_of_kin',          'Next of Kin Form & ID',                    'sensitive',           0, 0),
  ('utility_bill',         'Home Utility Bill (Electricity/Gas/Water)', 'sensitive',           1, 0),
  ('experience_letter',    'Experience & Reference Letter',            'normal',              0, 0),
  ('police_verification',  'Police Verification / Character Certificate','sensitive',         1, 0);

CREATE INDEX IF NOT EXISTS idx_documents_verification ON employee_documents(verification_status)
  WHERE archived_at IS NULL;
