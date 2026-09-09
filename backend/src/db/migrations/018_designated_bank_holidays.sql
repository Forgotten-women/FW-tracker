-- Migration 018: Designated Bank Holidays / Public Holidays System
--
-- Creates the bank_holidays table to track the organisation's 5 designated
-- approved bank holidays per year. These are paid non-working days that:
--   1. Appear on the company calendar
--   2. Do not deduct from employee annual leave
--   3. Are excluded from normal absence calculations
--   4. Are included correctly when calculating monthly required working hours
--   5. Are configurable strictly by HR

CREATE TABLE IF NOT EXISTS bank_holidays (
  id          TEXT PRIMARY KEY,
  year        INTEGER NOT NULL,
  date        TEXT NOT NULL,          -- YYYY-MM-DD
  name        TEXT NOT NULL,          -- e.g. "New Year's Day", "Eid al-Fitr", etc.
  notes       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  CONSTRAINT uq_bank_holiday_date UNIQUE (date)
);

CREATE INDEX IF NOT EXISTS idx_bank_holidays_year ON bank_holidays(year);
CREATE INDEX IF NOT EXISTS idx_bank_holidays_date ON bank_holidays(date);

-- Seed initial 5 designated bank holidays for 2025, 2026, and 2027
-- (HR can update or reconfigure dates/names at any time via the HR Dashboard)

-- 2025
INSERT INTO bank_holidays (id, year, date, name, notes, is_active, created_at, updated_at) VALUES
  ('bh_2025_01_01', 2025, '2025-01-01', 'New Year''s Day', 'Designated Organisation Bank Holiday', 1, 1735689600000, 1735689600000),
  ('bh_2025_03_31', 2025, '2025-03-31', 'Eid al-Fitr Holiday', 'Designated Organisation Bank Holiday', 1, 1735689600000, 1735689600000),
  ('bh_2025_06_06', 2025, '2025-06-06', 'Eid al-Adha Holiday', 'Designated Organisation Bank Holiday', 1, 1735689600000, 1735689600000),
  ('bh_2025_08_25', 2025, '2025-08-25', 'Summer Bank Holiday', 'Designated Organisation Bank Holiday', 1, 1735689600000, 1735689600000),
  ('bh_2025_12_25', 2025, '2025-12-25', 'Christmas Day', 'Designated Organisation Bank Holiday', 1, 1735689600000, 1735689600000)
ON CONFLICT (date) DO UPDATE SET
  year = EXCLUDED.year,
  name = EXCLUDED.name,
  notes = EXCLUDED.notes,
  updated_at = EXCLUDED.updated_at;

-- 2026
INSERT INTO bank_holidays (id, year, date, name, notes, is_active, created_at, updated_at) VALUES
  ('bh_2026_01_01', 2026, '2026-01-01', 'New Year''s Day', 'Designated Organisation Bank Holiday', 1, 1767225600000, 1767225600000),
  ('bh_2026_03_20', 2026, '2026-03-20', 'Eid al-Fitr Holiday', 'Designated Organisation Bank Holiday', 1, 1767225600000, 1767225600000),
  ('bh_2026_05_27', 2026, '2026-05-27', 'Eid al-Adha Holiday', 'Designated Organisation Bank Holiday', 1, 1767225600000, 1767225600000),
  ('bh_2026_08_31', 2026, '2026-08-31', 'Summer Bank Holiday', 'Designated Organisation Bank Holiday', 1, 1767225600000, 1767225600000),
  ('bh_2026_12_25', 2026, '2026-12-25', 'Christmas Day', 'Designated Organisation Bank Holiday', 1, 1767225600000, 1767225600000)
ON CONFLICT (date) DO UPDATE SET
  year = EXCLUDED.year,
  name = EXCLUDED.name,
  notes = EXCLUDED.notes,
  updated_at = EXCLUDED.updated_at;

-- 2027
INSERT INTO bank_holidays (id, year, date, name, notes, is_active, created_at, updated_at) VALUES
  ('bh_2027_01_01', 2027, '2027-01-01', 'New Year''s Day', 'Designated Organisation Bank Holiday', 1, 1798761600000, 1798761600000),
  ('bh_2027_03_10', 2027, '2027-03-10', 'Eid al-Fitr Holiday', 'Designated Organisation Bank Holiday', 1, 1798761600000, 1798761600000),
  ('bh_2027_05_17', 2027, '2027-05-17', 'Eid al-Adha Holiday', 'Designated Organisation Bank Holiday', 1, 1798761600000, 1798761600000),
  ('bh_2027_08_30', 2027, '2027-08-30', 'Summer Bank Holiday', 'Designated Organisation Bank Holiday', 1, 1798761600000, 1798761600000),
  ('bh_2027_12_25', 2027, '2027-12-25', 'Christmas Day', 'Designated Organisation Bank Holiday', 1, 1798761600000, 1798761600000)
ON CONFLICT (date) DO UPDATE SET
  year = EXCLUDED.year,
  name = EXCLUDED.name,
  notes = EXCLUDED.notes,
  updated_at = EXCLUDED.updated_at;
