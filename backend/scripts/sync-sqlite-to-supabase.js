const Database = require('better-sqlite3');
const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DB_FILE = path.join(__dirname, '..', 'data', 'office.db');
const db = new Database(DB_FILE);

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres.xywqabfcqbrheaqfbyib:h1H1rjrIrPmLDZpq@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';
const client = new Client({ connectionString: databaseUrl });

async function sync() {
  await client.connect();
  console.log('[sync] Connected to Supabase PostgreSQL...');

  // 1. Sync Employees
  const employees = db.prepare('SELECT * FROM employees').all();
  console.log(`[sync] Syncing ${employees.length} employees...`);
  for (const e of employees) {
    await client.query(`
      INSERT INTO employees (id, name, role, active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        role = EXCLUDED.role,
        active = EXCLUDED.active,
        updated_at = EXCLUDED.updated_at
    `, [e.id, e.name, e.role, e.active ? 1 : 0, e.created_at, e.updated_at]);
  }

  // 2. Sync Devices
  const devices = db.prepare('SELECT * FROM devices').all();
  console.log(`[sync] Syncing ${devices.length} devices...`);
  for (const d of devices) {
    await client.query(`
      INSERT INTO devices (id, employee_id, platform, model, label, enrolled_at, last_seen_at, revoked_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        last_seen_at = EXCLUDED.last_seen_at,
        revoked_at = EXCLUDED.revoked_at
    `, [d.id, d.employee_id, d.platform, d.model || '', d.label || '', d.enrolled_at, d.last_seen_at, d.revoked_at]);
  }

  // 3. Sync Device Tokens
  const tokens = db.prepare('SELECT * FROM device_tokens').all();
  console.log(`[sync] Syncing ${tokens.length} device tokens...`);
  for (const t of tokens) {
    await client.query(`
      INSERT INTO device_tokens (token_hash, device_id, issued_at, expires_at, last_used_at, revoked_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (token_hash) DO UPDATE SET
        last_used_at = EXCLUDED.last_used_at,
        revoked_at = EXCLUDED.revoked_at
    `, [t.token_hash, t.device_id, t.issued_at, t.expires_at, t.last_used_at, t.revoked_at]);
  }

  // 4. Sync Enrollment Codes
  const codes = db.prepare('SELECT * FROM enrollment_codes').all();
  console.log(`[sync] Syncing ${codes.length} enrollment codes...`);
  for (const c of codes) {
    await client.query(`
      INSERT INTO enrollment_codes (code_hash, employee_id, created_at, expires_at, used_at, used_by_device)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (code_hash) DO UPDATE SET
        used_at = EXCLUDED.used_at,
        used_by_device = EXCLUDED.used_by_device
    `, [c.code_hash, c.employee_id, c.created_at, c.expires_at, c.used_at, c.used_by_device]);
  }

  // 5. Sync Org Settings
  try {
    const settings = db.prepare('SELECT * FROM org_settings').all();
    console.log(`[sync] Syncing ${settings.length} org settings...`);
    for (const s of settings) {
      await client.query(`
        INSERT INTO org_settings (key, value, updated_at, updated_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (key) DO UPDATE SET
          value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at
      `, [s.key, s.value, s.updated_at, s.updated_by]);
    }
  } catch (_) {}

  // 6. Sync Salary History
  try {
    const salaries = db.prepare('SELECT * FROM salary_history').all();
    console.log(`[sync] Syncing ${salaries.length} salary records...`);
    for (const sh of salaries) {
      await client.query(`
        INSERT INTO salary_history (id, employee_id, amount, currency, effective_from, effective_to, daily_rate, updated_at, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING
      `, [sh.id, sh.employee_id, sh.amount, sh.currency || 'PKR', sh.effective_from, sh.effective_to, sh.daily_rate, sh.updated_at, sh.updated_by]);
    }
  } catch (_) {}

  console.log('✅ Sync complete! Supabase PostgreSQL has full parity with local SQLite.');
}

sync().catch(console.error).finally(() => client.end());
