// Migration runner.
//
// The database now holds live attendance that feeds payroll, so schema changes
// have to be additive and replayable rather than a rewrite. Each file in
// migrations/ runs exactly once, in filename order, inside a transaction - a
// failure rolls the whole file back rather than leaving the schema half-applied.

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      checksum   TEXT NOT NULL
    );
  `);
}

function checksum(sql) {
  // Detects a migration being edited after it has run, which would leave
  // different databases with silently different schemas.
  return require('crypto').createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => ({
      id: f,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'),
    }));
}

/**
 * Applies any migration not yet recorded. Returns the ids that ran.
 */
function migrate(db, { verbose = true } = {}) {
  ensureMigrationsTable(db);

  const applied = new Map(
    db.prepare('SELECT id, checksum FROM schema_migrations').all().map(r => [r.id, r.checksum]),
  );
  const record = db.prepare(
    'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)',
  );

  const ran = [];

  for (const m of listMigrations()) {
    const sum = checksum(m.sql);

    if (applied.has(m.id)) {
      if (applied.get(m.id) !== sum) {
        // Loud, because the alternative is two deployments quietly disagreeing
        // about the shape of the payroll database.
        console.warn(
          `[migrate] WARNING ${m.id} has changed since it was applied. ` +
          'Migrations must be immutable once they have run - add a new one instead.',
        );
      }
      continue;
    }

    // foreign_keys must be off while tables are created out of dependency
    // order, and PRAGMA cannot be changed inside a transaction.
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        record.run(m.id, Date.now(), sum);
      })();
      ran.push(m.id);
      if (verbose) console.log(`[migrate] applied ${m.id}`);
    } catch (err) {
      console.error(`[migrate] FAILED ${m.id}: ${err.message}`);
      throw err;
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  if (verbose && ran.length === 0) console.log('[migrate] schema up to date');
  return ran;
}

function status(db) {
  ensureMigrationsTable(db);
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id));
  return listMigrations().map(m => ({ id: m.id, applied: applied.has(m.id) }));
}

module.exports = { migrate, status };
