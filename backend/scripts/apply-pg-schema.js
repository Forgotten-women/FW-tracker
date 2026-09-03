const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const KEEP_TABLES = new Set([
  'employees',
  'devices',
  'device_tokens',
  'enrollment_codes',
  'workstation_sessions',
  'org_settings',
  'workstation_app_usage'
]);

async function applyMissingSchema() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('[pg-setup] Connected to Supabase...');

  // 1. Add missing columns to preserved tables so foreign keys succeed
  console.log('[pg-setup] Ensuring employees and devices have full columns...');
  await client.query(`
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_number TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS preferred_name TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_email TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_path TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_status TEXT NOT NULL DEFAULT 'Active';
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS office_id TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS department_id TEXT;

    ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_type TEXT NOT NULL DEFAULT 'mobile';
  `);

  // 2. Drop all other tables that have old schemas
  const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  const toDrop = [];
  for (const r of res.rows) {
    if (!KEEP_TABLES.has(r.table_name)) {
      toDrop.push(`"${r.table_name}"`);
    }
  }

  if (toDrop.length > 0) {
    console.log(`[pg-setup] Dropping ${toDrop.length} tables:`, toDrop.join(', '));
    await client.query(`DROP TABLE IF EXISTS ${toDrop.join(', ')} CASCADE`);
  }

  // 3. Apply schema.sql
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'pg', 'schema.sql'), 'utf-8');
  console.log(`[pg-setup] Applying schema.sql (${schemaSql.length} bytes)...`);
  await client.query(schemaSql);
  console.log('[pg-setup] ✅ Complete PostgreSQL schema applied!');

  // 4. Apply seed.sql
  const seedSql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'pg', 'seed.sql'), 'utf-8');
  console.log(`[pg-setup] Applying seed.sql (${seedSql.length} bytes)...`);
  await client.query(seedSql);
  console.log('[pg-setup] ✅ seed.sql applied!');

  await client.end();
}

applyMissingSchema().catch(console.error);
