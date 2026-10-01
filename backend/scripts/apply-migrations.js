// Applies named migration files to the database in DATABASE_URL, one
// transaction per file. For additive migrations only: a file containing DROP,
// TRUNCATE, DELETE or a column rename/type change is refused rather than run.
//
// Production migrations are applied by hand (there is no runner on deploy),
// so a new column the code already reads -- e.g. employees.work_mode, read by
// every desktop heartbeat -- makes those requests fail until this is run.
//
// Usage (from backend/):
//   node scripts/apply-migrations.js 024_configurable_shifts_and_work_mode.sql 024_payroll_run_automation.sql \
//     025_backfill_runtime_schema.sql 026_leave_approval_paid_configuration.sql
// It prints the target host and asks for CONFIRM_TARGET=<host> before writing.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { databaseUrl, confirmTarget } = require('./_connection');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');
const DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN|INDEX|SCHEMA|CONSTRAINT)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN|RENAME\s+(COLUMN|TO))\b/i;

function stripComments(sql) {
  return sql.replace(/--.*$/gm, '');
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Name the migration files to apply, e.g. 025_backfill_runtime_schema.sql');
    process.exit(1);
  }

  const plan = files.map((name) => {
    const file = path.join(MIGRATIONS_DIR, path.basename(name));
    if (!fs.existsSync(file)) {
      console.error(`No such migration: ${name}`);
      process.exit(1);
    }
    const sql = fs.readFileSync(file, 'utf8');
    if (DESTRUCTIVE.test(stripComments(sql))) {
      console.error(`Refusing ${name}: it contains a destructive statement. Apply it deliberately by hand.`);
      process.exit(1);
    }
    return { name: path.basename(file), sql };
  });

  const url = databaseUrl();
  confirmTarget(url);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const m of plan) {
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${m.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] ${m.name} failed and was rolled back: ${err.message}`);
        process.exitCode = 1;
        return;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] Failed:', err.message);
  process.exit(1);
});
