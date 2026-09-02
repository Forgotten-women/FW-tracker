// Bidirectional Synchronization between Supabase PostgreSQL and local SQLite.
//
// In serverless environments (e.g. Vercel), instances are ephemeral and /tmp is
// isolated per container. This module ensures every serverless instance is
// hydrated from Supabase PostgreSQL on incoming requests and that all writes
// are synced to Supabase PostgreSQL in real-time.

const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// The connection string comes from the environment and nowhere else.
//
// It used to have the live production URL - password included - as an inline
// fallback, which meant three things at once: the credential was in the source
// tree, any checkout could write to the real HR database, and `npm test` read
// and wrote production data. A test run creating employees and valid device
// tokens in production is not a hypothetical: it is what was happening.
//
// With no fallback, an unconfigured environment gets no database rather than
// silently getting the real one.
const databaseUrl = (process.env.DATABASE_URL || '').trim();

// A test run must never reach a real database by accident.
//
// NODE_TEST_CONTEXT is set by the Node test runner itself, so this holds even
// for a test file that forgets to set NODE_ENV - which is exactly how the leak
// happened: six of the suites never set it, and those were the ones reading and
// writing production. Tests that genuinely need Postgres opt in by setting
// TEST_DATABASE_URL to a throwaway database.
const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);

let pool = null;
function getPool() {
  if (isTest && !process.env.TEST_DATABASE_URL) return null;
  if (!pool && databaseUrl) {
    try {
      pool = new Pool({
        connectionString: databaseUrl,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 4000,
      });
      pool.on('error', (err) => {
        console.warn('[supabase-sync] Pool idle client error:', err.message);
      });
    } catch (err) {
      console.warn('[supabase-sync] Could not initialize PostgreSQL pool:', err.message);
    }
  }
  return pool;
}

let lastHydratedAt = 0;
let isHydrating = false;

/**
 * Pulls all core data from Supabase PostgreSQL into SQLite.
 */
async function hydrateAllTables(db) {
  const p = getPool();
  if (!p) return;

  const client = await p.connect();
  try {
    // 1. Employees
    try {
      const empRes = await client.query('SELECT * FROM employees');
      if (empRes.rows.length > 0) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO employees (
            id, name, role, active, created_at, updated_at
          ) VALUES (
            @id, @name, @role, @active, @created_at, @updated_at
          )
        `);
        db.transaction(() => {
          for (const r of empRes.rows) {
            stmt.run({
              id: r.id,
              name: r.name,
              role: r.role || 'Team Member',
              active: r.active ? 1 : 0,
              created_at: Number(r.created_at) || Date.now(),
              updated_at: Number(r.updated_at) || Date.now(),
            });
          }
        })();
      }
    } catch (e) {
      console.warn('[supabase-sync] employees sync:', e.message);
    }

    // 2. Devices
    try {
      const devRes = await client.query('SELECT * FROM devices');
      if (devRes.rows.length > 0) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO devices (
            id, employee_id, platform, model, label, enrolled_at, last_seen_at, revoked_at
          ) VALUES (
            @id, @employee_id, @platform, @model, @label, @enrolled_at, @last_seen_at, @revoked_at
          )
        `);
        db.transaction(() => {
          for (const r of devRes.rows) {
            stmt.run({
              id: r.id,
              employee_id: r.employee_id,
              platform: r.platform || 'unknown',
              model: r.model || '',
              label: r.label || '',
              enrolled_at: Number(r.enrolled_at) || Date.now(),
              last_seen_at: r.last_seen_at ? Number(r.last_seen_at) : null,
              revoked_at: r.revoked_at ? Number(r.revoked_at) : null,
            });
          }
        })();
      }
    } catch (e) {
      console.warn('[supabase-sync] devices sync:', e.message);
    }

    // 3. Device Tokens
    try {
      const tokRes = await client.query('SELECT * FROM device_tokens');
      if (tokRes.rows.length > 0) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO device_tokens (
            token_hash, device_id, issued_at, expires_at, last_used_at, revoked_at
          ) VALUES (
            @token_hash, @device_id, @issued_at, @expires_at, @last_used_at, @revoked_at
          )
        `);
        db.transaction(() => {
          for (const r of tokRes.rows) {
            stmt.run({
              token_hash: r.token_hash,
              device_id: r.device_id,
              issued_at: Number(r.issued_at) || Date.now(),
              expires_at: r.expires_at ? Number(r.expires_at) : null,
              last_used_at: r.last_used_at ? Number(r.last_used_at) : null,
              revoked_at: r.revoked_at ? Number(r.revoked_at) : null,
            });
          }
        })();
      }
    } catch (e) {
      console.warn('[supabase-sync] device_tokens sync:', e.message);
    }

    // 4. Enrollment Codes
    try {
      const codeRes = await client.query('SELECT * FROM enrollment_codes');
      if (codeRes.rows.length > 0) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO enrollment_codes (
            code_hash, employee_id, created_at, expires_at, used_at, used_by_device
          ) VALUES (
            @code_hash, @employee_id, @created_at, @expires_at, @used_at, @used_by_device
          )
        `);
        db.transaction(() => {
          for (const r of codeRes.rows) {
            stmt.run({
              code_hash: r.code_hash,
              employee_id: r.employee_id,
              created_at: Number(r.created_at) || Date.now(),
              expires_at: Number(r.expires_at) || Date.now(),
              used_at: r.used_at ? Number(r.used_at) : null,
              used_by_device: r.used_by_device || null,
            });
          }
        })();
      }
    } catch (e) {
      console.warn('[supabase-sync] enrollment_codes sync:', e.message);
    }

    // 5. Org Settings
    try {
      const setRes = await client.query('SELECT * FROM org_settings');
      if (setRes.rows.length > 0) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO org_settings (
            key, value, updated_at, updated_by
          ) VALUES (
            @key, @value, @updated_at, @updated_by
          )
        `);
        db.transaction(() => {
          for (const r of setRes.rows) {
            stmt.run({
              key: r.key,
              value: r.value,
              updated_at: Number(r.updated_at) || Date.now(),
              updated_by: r.updated_by || null,
            });
          }
        })();
      }
    } catch (e) {
      console.warn('[supabase-sync] org_settings sync:', e.message);
    }

    // 6. Salary History
    try {
      const salRes = await client.query('SELECT * FROM salary_history');
      if (salRes.rows.length > 0) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO salary_history (
            id, employee_id, amount, currency, effective_from, effective_to, daily_rate, reason, created_at, created_by
          ) VALUES (
            @id, @employee_id, @amount, @currency, @effective_from, @effective_to, @daily_rate, @reason, @created_at, @created_by
          )
        `);
        db.transaction(() => {
          for (const r of salRes.rows) {
            stmt.run({
              id: r.id,
              employee_id: r.employee_id,
              amount: Number(r.amount) || 0,
              currency: r.currency || 'PKR',
              effective_from: r.effective_from || new Date().toISOString().slice(0, 10),
              effective_to: r.effective_to || null,
              daily_rate: r.daily_rate ? Number(r.daily_rate) : null,
              reason: r.reason || null,
              created_at: Number(r.updated_at || r.created_at) || Date.now(),
              created_by: r.updated_by || r.created_by || 'system',
            });
          }
        })();
      }
    } catch (e) {
      console.warn('[supabase-sync] salary_history sync:', e.message);
    }

    // 7. Employment Records
    try {
      const empRecRes = await client.query('SELECT * FROM employment_records');
      if (empRecRes.rows.length > 0) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO employment_records (
            id, employee_id, job_title, start_date, effective_from, effective_to, employment_type, created_at, created_by
          ) VALUES (
            @id, @employee_id, @job_title, @start_date, @effective_from, @effective_to, @employment_type, @created_at, @created_by
          )
        `);
        db.transaction(() => {
          for (const r of empRecRes.rows) {
            stmt.run({
              id: r.id,
              employee_id: r.employee_id,
              job_title: r.job_title || 'Team Member',
              start_date: r.start_date || new Date().toISOString().slice(0, 10),
              effective_from: r.effective_from || new Date().toISOString().slice(0, 10),
              effective_to: r.effective_to || null,
              employment_type: r.employment_type || 'FULL_TIME',
              created_at: Number(r.updated_at || r.created_at) || Date.now(),
              created_by: r.updated_by || r.created_by || 'system',
            });
          }
        })();
      }
    } catch (e) {
      console.warn('[supabase-sync] employment_records sync:', e.message);
    }

    // 8. Workstation Sessions
    try {
      const wsRes = await client.query('SELECT * FROM workstation_sessions');
      if (wsRes.rows.length > 0) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO workstation_sessions (
            id, device_id, employee_id, status, session_date, active_seconds, idle_seconds, break_seconds, lock_state, connected_bssid, in_office, last_heartbeat_at, created_at, updated_at
          ) VALUES (
            @id, @device_id, @employee_id, @status, @session_date, @active_seconds, @idle_seconds, @break_seconds, @lock_state, @connected_bssid, @in_office, @last_heartbeat_at, @created_at, @updated_at
          )
        `);
        db.transaction(() => {
          for (const r of wsRes.rows) {
            stmt.run({
              id: r.id,
              device_id: r.device_id,
              employee_id: r.employee_id,
              status: r.status || 'ACTIVE',
              session_date: r.session_date,
              active_seconds: Number(r.active_seconds) || 0,
              idle_seconds: Number(r.idle_seconds) || 0,
              break_seconds: Number(r.break_seconds) || 0,
              lock_state: r.lock_state || 'UNLOCKED',
              connected_bssid: r.connected_bssid || null,
              in_office: r.in_office ? 1 : 0,
              last_heartbeat_at: Number(r.last_heartbeat_at) || Date.now(),
              created_at: Number(r.created_at) || Date.now(),
              updated_at: Number(r.updated_at) || Date.now(),
            });
          }
        })();
      }
    } catch (e) {
      console.warn('[supabase-sync] workstation_sessions sync:', e.message);
    }

    // 9. Notifications
    try {
      const notifRes = await client.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50');
      if (notifRes.rows.length > 0) {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO notifications (
            id, employee_id, user_id, category, title, body, severity, link, created_at, read_at, dismissed_at
          ) VALUES (
            @id, @employee_id, @user_id, @category, @title, @body, @severity, @link, @created_at, @read_at, @dismissed_at
          )
        `);
        db.transaction(() => {
          for (const r of notifRes.rows) {
            stmt.run({
              id: r.id,
              employee_id: r.employee_id || null,
              user_id: r.user_id || null,
              category: r.category || 'SYSTEM',
              title: r.title || '',
              body: r.body || '',
              severity: r.severity || 'INFO',
              link: r.link || null,
              created_at: Number(r.created_at) || Date.now(),
              read_at: r.read_at ? Number(r.read_at) : null,
              dismissed_at: r.dismissed_at ? Number(r.dismissed_at) : null,
            });
          }
        })();
      }
    } catch (e) {
      console.warn('[supabase-sync] notifications sync:', e.message);
    }

    lastHydratedAt = Date.now();
  } finally {
    client.release();
  }
}

/**
 * Ensures SQLite is hydrated from Supabase within the last 15 seconds.
 */
async function ensureHydrated(db) {
  if (isHydrating) return;
  const now = Date.now();
  const empCount = db.prepare('SELECT COUNT(*) c FROM employees').get()?.c || 0;
  
  // If empty or expired (> 15s)
  if (empCount === 0 || now - lastHydratedAt > 15000) {
    isHydrating = true;
    try {
      await hydrateAllTables(db);
    } finally {
      isHydrating = false;
    }
  }
}

/**
 * Pushes a created or updated employee to Supabase PostgreSQL.
 */
async function pushEmployee(emp) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      INSERT INTO employees (id, name, role, active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        role = EXCLUDED.role,
        active = EXCLUDED.active,
        updated_at = EXCLUDED.updated_at
    `, [emp.id, emp.name, emp.role, emp.active ? 1 : 0, emp.created_at || Date.now(), emp.updated_at || Date.now()]);
  } catch (err) {
    console.warn('[supabase-sync] pushEmployee error:', err.message);
  }
}

/**
 * Pushes a salary record to Supabase PostgreSQL.
 */
async function pushSalary(sh) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      INSERT INTO salary_history (id, employee_id, amount, currency, effective_from, effective_to, daily_rate, updated_at, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        amount = EXCLUDED.amount,
        currency = EXCLUDED.currency,
        effective_from = EXCLUDED.effective_from,
        effective_to = EXCLUDED.effective_to,
        daily_rate = EXCLUDED.daily_rate,
        updated_at = EXCLUDED.updated_at
    `, [sh.id, sh.employee_id, sh.amount, sh.currency || 'PKR', sh.effective_from, sh.effective_to, sh.daily_rate, sh.updated_at || Date.now(), sh.updated_by || 'admin']);
  } catch (err) {
    console.warn('[supabase-sync] pushSalary error:', err.message);
  }
}

/**
 * Pushes an enrollment code to Supabase PostgreSQL.
 */
async function pushEnrollmentCode(c) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      INSERT INTO enrollment_codes (code_hash, employee_id, created_at, expires_at, used_at, used_by_device)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (code_hash) DO UPDATE SET
        used_at = EXCLUDED.used_at,
        used_by_device = EXCLUDED.used_by_device
    `, [c.code_hash, c.employee_id, c.created_at, c.expires_at, c.used_at, c.used_by_device]);
  } catch (err) {
    console.warn('[supabase-sync] pushEnrollmentCode error:', err.message);
  }
}

/**
 * Pushes a device and token to Supabase PostgreSQL.
 */
async function pushDeviceAndToken(dev, token) {
  const p = getPool();
  if (!p) return;
  try {
    if (dev) {
      await p.query(`
        INSERT INTO devices (id, employee_id, platform, model, label, enrolled_at, last_seen_at, revoked_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          last_seen_at = EXCLUDED.last_seen_at,
          revoked_at = EXCLUDED.revoked_at
      `, [dev.id, dev.employee_id, dev.platform, dev.model || '', dev.label || '', dev.enrolled_at, dev.last_seen_at, dev.revoked_at]);
    }
    if (token) {
      await p.query(`
        INSERT INTO device_tokens (token_hash, device_id, issued_at, expires_at, last_used_at, revoked_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (token_hash) DO UPDATE SET
          last_used_at = EXCLUDED.last_used_at,
          revoked_at = EXCLUDED.revoked_at
      `, [token.token_hash, token.device_id, token.issued_at, token.expires_at, token.last_used_at, token.revoked_at]);
    }
  } catch (err) {
    console.warn('[supabase-sync] pushDevice error:', err.message);
  }
}

module.exports = {
  getPool,
  hydrateAllTables,
  ensureHydrated,
  pushEmployee,
  pushSalary,
  pushEnrollmentCode,
  pushDeviceAndToken,
};
