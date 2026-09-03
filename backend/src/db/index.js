// Database handle and shared helpers.
//
// Backed by PostgreSQL. This replaces the previous better-sqlite3 setup, which
// on a serverless host wrote to a per-container file in os.tmpdir(): every
// instance had its own database, only 9 of 71 tables were ever copied back, and
// identical requests seconds apart returned different data. Attendance, leave,
// warnings, payroll, documents and the audit log had nowhere durable to live at
// all.
//
// The exported shape is deliberately unchanged - `db.prepare(sql)` returning
// something with .get()/.all()/.run(), plus tx() and audit() - so call sites
// read the same as before. What changed is that every one of them is now
// asynchronous and must be awaited. See src/db/pg/client.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const pg = require('./pg/client');

// Documents still land on a local filesystem when no object store is
// configured, so a writable directory is still needed. On a serverless host it
// is per-container and therefore temporary, which is why storage.js prefers S3.
const isServerless = Boolean(
  process.env.VERCEL
  || process.env.AWS_LAMBDA_FUNCTION_NAME
  || process.env.LAMBDA_TASK_ROOT
  || process.env.NOW_REGION,
);

const DATA_DIR = isServerless
  ? path.join(os.tmpdir(), 'office_tracker_data')
  : (process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'));

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch { /* best effort; storage.js reports if it cannot write */ }

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

const db = {
  prepare: sql => pg.prepare(sql),
  exec: sql => pg.exec(sql),
  // Kept so the better-sqlite3 spelling still resolves; both go through tx().
  transaction: fn => pg.tx(fn),
};

const tx = pg.tx;

// ---------------------------------------------------------------------------
// MAC pseudonymisation salt
// ---------------------------------------------------------------------------

// Read from the environment rather than from the database.
//
// It used to be generated once and stored in the `meta` table, which worked
// when there was a single long-lived process and one database file. It does not
// survive the move: every serverless instance would have to fetch it before it
// could hash anything, on a hot path, and a fresh instance that failed to fetch
// would invent a new one - silently making that instance's hashes incomparable
// with everyone else's, which quietly breaks device bindings.
//
// The existing salt has been carried into MAC_SALT so hashes already recorded
// stay valid.
const MAC_SALT = (process.env.MAC_SALT || '').trim()
  || crypto.randomBytes(32).toString('hex');

const MAC_SALT_IS_EPHEMERAL = !(process.env.MAC_SALT || '').trim();

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const insertAudit = pg.prepare(`
  INSERT INTO audit_log (at, actor, action, target_type, target_id, before_json, after_json, note)
  VALUES (@at, @actor, @action, @target_type, @target_id, @before_json, @after_json, @note)
`);

/** Append an audit entry. Every admin mutation must call this. */
async function audit({
  actor, action, targetType = null, targetId = null,
  before = null, after = null, note = null,
}) {
  await insertAudit.run({
    at: Date.now(),
    actor: String(actor || 'unknown'),
    action: String(action),
    target_type: targetType,
    target_id: targetId,
    before_json: before === null ? null : JSON.stringify(before),
    after_json: after === null ? null : JSON.stringify(after),
    note,
  });
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const getMetaStmt = pg.prepare('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = pg.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
);

async function getMeta(key, fallback = null) {
  const row = await getMetaStmt.get(key);
  return row ? row.value : fallback;
}

async function setMeta(key, value) {
  await setMetaStmt.run(key, String(value));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Backups are the database provider's job now.
 *
 * The old nightly job called SQLite's online .backup() into a local directory.
 * There is no equivalent worth reimplementing here: on a serverless host the
 * destination would be a container-local temp directory that disappears, which
 * is a backup in name only. Supabase takes scheduled backups at the project
 * level (Settings > Database > Backups), and that is where this belongs.
 */
async function backup() {
  throw new Error(
    'In-process backups were removed with SQLite. Database backups are configured '
    + 'on the Supabase project (Settings > Database > Backups), not here.',
  );
}

async function close() {
  await pg.close();
}

/** True once the schema has been applied. Used by health checks and setup. */
async function isInitialised() {
  const row = await pg.prepare(
    "SELECT to_regclass('public.employees') AS t",
  ).get();
  return Boolean(row && row.t);
}

module.exports = {
  db, tx, audit, getMeta, setMeta, backup, close, isInitialised,
  MAC_SALT, MAC_SALT_IS_EPHEMERAL, DATA_DIR,
};
