-- Migration 021: Serverless-Safe Ephemeral Auth State
--
-- Sensor replay signatures, SSE tickets, and document download grants
-- previously lived in per-process in-memory Maps (src/middleware/auth.js,
-- src/domain/documents.js). On Vercel, consecutive requests can land on
-- different Lambda instances that never saw each other's in-memory state:
-- a legitimate SSE ticket or document download grant issued on one instance
-- could be redeemed on another that has no record of it and fails, and the
-- sensor replay cache only protected "per instance" rather than globally, so
-- a captured sensor request could be replayed as long as it landed on an
-- instance that had not seen it yet. These tables give all three a single
-- shared source of truth, following the same pattern already used for
-- workstation_live_streams (migration 020).

CREATE TABLE IF NOT EXISTS sensor_replay_signatures (
  signature   TEXT PRIMARY KEY,
  expires_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sensor_replay_expires ON sensor_replay_signatures (expires_at);

CREATE TABLE IF NOT EXISTS sse_tickets (
  ticket      TEXT PRIMARY KEY,
  expires_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sse_tickets_expires ON sse_tickets (expires_at);

CREATE TABLE IF NOT EXISTS document_download_grants (
  token        TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES employee_documents(id) ON DELETE CASCADE,
  expires_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_grants_expires ON document_download_grants (expires_at);
