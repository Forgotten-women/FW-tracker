-- Adds exchange_rate to payroll_periods so each monthly payroll has its own historical conversion rate.
ALTER TABLE payroll_periods ADD COLUMN exchange_rate REAL DEFAULT 350.0;
