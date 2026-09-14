-- Migration 020: Workstation Live Screen Telemetry
--
-- Coordinates transient live screen streaming sessions between workstation agents
-- and authorized HR administrators across stateless Vercel serverless containers.

CREATE TABLE IF NOT EXISTS workstation_live_streams (
  device_id           TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  requested_at        BIGINT NOT NULL,
  last_frame_at       BIGINT,
  frame_base64        TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | STOPPED | PAUSED
  updated_at          BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_live_stream_updated ON workstation_live_streams (updated_at);
CREATE INDEX IF NOT EXISTS idx_live_stream_requested ON workstation_live_streams (requested_at);
