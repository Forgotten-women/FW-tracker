-- Migration 031: real laptop idle intervals.
--
-- workstation_sessions.idle_seconds is a running counter fed by the agent's
-- per-sample split. It also counts small idle slices inside heartbeats that
-- were otherwise ACTIVE, and it drifted above wall-clock time (active + idle +
-- break exceeded the time elapsed). Worked time now subtracts idle, so it
-- needs WHEN the laptop was idle: one span per stretch of heartbeats whose
-- status was IDLE (no input for 5+ minutes) or AWAY (locked 5+ minutes).
--
-- Additive and idempotent. Safe to run against production.

CREATE TABLE IF NOT EXISTS workstation_idle_spans (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  start_at BIGINT NOT NULL,
  end_at BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'IDLE',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idle_spans_emp_day ON workstation_idle_spans (employee_id, date_key);
CREATE INDEX IF NOT EXISTS idx_idle_spans_dev_day ON workstation_idle_spans (device_id, date_key, end_at);
