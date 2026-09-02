-- Spec Section 10 & 2.2 Sickness & Absence enhancements
ALTER TABLE absence_records ADD COLUMN reason TEXT;
ALTER TABLE absence_records ADD COLUMN evidence_document_id TEXT REFERENCES employee_documents(id) ON DELETE SET NULL;
