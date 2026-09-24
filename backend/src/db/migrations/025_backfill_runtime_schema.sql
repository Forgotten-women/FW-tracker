-- Migration 025: record schema that production gained outside the migrations.
--
-- Everything here already exists in the production database -- it was
-- created by runtime DDL in routes/desktop.js and routes/screenshots.js
-- (ensureScreenshotsTable), or, for workstation_sessions.unverified_seconds,
-- by nothing in the repository at all even though every desktop heartbeat
-- reads and writes it. Recording it here (idempotently) means a database
-- built from the migrations matches production, and src/db/pg/schema.sql
-- mirrors it so a fresh test schema can run a heartbeat at all.
--
-- Safe to run against production: IF NOT EXISTS throughout, nothing dropped.

CREATE TABLE IF NOT EXISTS workstation_screenshots (
  id                  TEXT PRIMARY KEY,
  employee_id         TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  date_key            TEXT NOT NULL,
  captured_at         BIGINT NOT NULL,
  storage_path        TEXT NOT NULL,
  file_size_bytes     BIGINT NOT NULL DEFAULT 0,
  mime_type           TEXT NOT NULL DEFAULT 'image/jpeg',
  active_app          TEXT,
  window_title        TEXT,
  capture_status      TEXT NOT NULL DEFAULT 'SUCCESS',
  created_at          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ws_shots_emp_date ON workstation_screenshots (employee_id, date_key);
CREATE INDEX IF NOT EXISTS idx_ws_shots_captured ON workstation_screenshots (captured_at);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS screenshot_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS screenshot_interval_minutes INTEGER NOT NULL DEFAULT 5;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS screenshot_mode TEXT NOT NULL DEFAULT 'ACTIVE_ONLY';

ALTER TABLE workstation_sessions ADD COLUMN IF NOT EXISTS unverified_seconds BIGINT NOT NULL DEFAULT 0;
