// Database handle and durability settings.
//
// Replaces the module-level mutable `db` object that store.js exported live and
// that every route mutated directly, with no transaction boundary, no schema,
// and three concurrent writers (the ARP interval, the checkDepartures interval,
// and HTTP handlers) racing on the same object.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'office.db');
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

const SCHEMA_VERSION = '1';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);

// WAL: readers never block the writer, and a crash mid-write rolls back to the
// last commit instead of leaving a truncated file.
db.pragma('journal_mode = WAL');
// FULL: fsync on every commit. Slower than NORMAL, but NORMAL can lose the most
// recent transactions on power loss - unacceptable for a payroll record, and
// the write volume here is trivial.
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(fs.readFileSync(SCHEMA_FILE, 'utf-8'));

// Incremental schema changes on top of the baseline. Runs on every start, and
// is a no-op once everything has been applied.
require('./migrate').migrate(db, { verbose: process.env.NODE_ENV !== 'test' });

// --- meta ------------------------------------------------------------------

const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function getMeta(key, fallback = null) {
  const row = getMetaStmt.get(key);
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  setMetaStmt.run(key, String(value));
}

setMeta('schema_version', SCHEMA_VERSION);

// Per-install salt for pseudonymising the MACs of non-employee devices.
// Generated once and kept in the database, so hashes stay stable across
// restarts but are not comparable against any other install.
if (!getMeta('mac_salt')) {
  setMeta('mac_salt', crypto.randomBytes(32).toString('hex'));
}
const MAC_SALT = getMeta('mac_salt');

// --- helpers ---------------------------------------------------------------

/** Run fn inside a transaction. Rolls back entirely if fn throws. */
function tx(fn) {
  return db.transaction(fn);
}

/** Append an audit entry. Every admin mutation must call this. */
const insertAudit = db.prepare(`
  INSERT INTO audit_log (at, actor, action, target_type, target_id, before_json, after_json, note)
  VALUES (@at, @actor, @action, @target_type, @target_id, @before_json, @after_json, @note)
`);

function audit({ actor, action, targetType = null, targetId = null, before = null, after = null, note = null }) {
  insertAudit.run({
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

/**
 * Consistent online backup. Safe to call while the server is serving.
 * Returns a promise resolving to the backup path.
 */
async function backup(dir = path.join(DATA_DIR, 'backups')) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `office-${stamp}.db`);
  await db.backup(dest);
  return dest;
}

/** Close cleanly so WAL is checkpointed into the main file. */
function close() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch { /* best effort */ }
  db.close();
}

module.exports = { db, tx, audit, getMeta, setMeta, backup, close, MAC_SALT, DB_FILE, DATA_DIR };
