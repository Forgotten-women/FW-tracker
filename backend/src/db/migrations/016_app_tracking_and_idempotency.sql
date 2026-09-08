-- Migration 016: App Tracking Privacy Toggle & Heartbeat Idempotency Deduplication
--
-- 1. Adds app_tracking_enabled flag to employees (default 1 = enabled).
--    Allows HR to disable application/window tracking for employees using personal laptops (BYOD).
--
-- 2. Creates desktop_heartbeat_dedupe table for idempotency protection against
--    network retransmissions, preventing double-counting of active/idle seconds.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS app_tracking_enabled INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS desktop_heartbeat_dedupe (
  event_id    TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  received_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_desktop_dedupe_device_time ON desktop_heartbeat_dedupe(device_id, received_at);
