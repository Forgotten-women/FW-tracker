-- Warning policy, confirmed by Forgotten Women on 2026-08-27.
--
-- The seeded rules deliberately left monitoring_period NULL, because spec
-- section 9.6 said not to hard-code it before the organisation confirmed. It is
-- now confirmed as the calendar month.
--
-- warning_level on wr_lateness was a placeholder chosen when the schema was
-- created, not something the spec specified. Escalation is now driven by the
-- sequence in config/office.json, so the column records only where the sequence
-- starts.

UPDATE warning_rules
SET monitoring_period = 'CALENDAR_MONTH',
    warning_level = 'INFORMAL_NOTICE'
WHERE id = 'wr_lateness';

UPDATE warning_rules
SET monitoring_period = 'CALENDAR_MONTH'
WHERE id = 'wr_deficit';

-- Unauthorised absence raises a referral for review and nothing else. The
-- consequences are chosen per case, so the rule carries no warning level of its
-- own.
UPDATE warning_rules
SET monitoring_period = 'CALENDAR_MONTH',
    warning_level = 'REFERRAL_ONLY'
WHERE id = 'wr_absence';

-- Where an employee currently sits in the escalation sequence. Derived from
-- formal_warnings, but cached so the HR board does not recount history on every
-- page load.
CREATE TABLE IF NOT EXISTS employee_warning_standing (
  employee_id        TEXT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  warnings_issued    INTEGER NOT NULL DEFAULT 0,
  highest_level      TEXT,
  last_issued_at     INTEGER,
  next_level         TEXT,
  -- Set when the confirmed sequence has been exhausted. What follows a final
  -- written warning is not defined by the spec, so the engine stops and says so
  -- rather than inventing an outcome.
  sequence_exhausted INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);
