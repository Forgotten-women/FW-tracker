// Test database setup.
//
// Every suite gets its OWN Postgres schema inside one throwaway database, so
// suites cannot see each other's rows and none of them can reach a real
// database. Isolation used to come free: each file wrote its own SQLite file in
// the temp directory. It has to be arranged deliberately now.
//
// A suite calls prepareDatabase() before its first test and dropDatabase()
// after its last. Both are safe to call more than once.
//
// The connection string points at the local container from tools/test-db.js.
// It is never allowed to be the production URL - see the guard below.

const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'postgresql://postgres:testpw@127.0.0.1:55432/office_tracker_test';

const PG_DIR = path.join(__dirname, '..', '..', 'src', 'db', 'pg');
const SCHEMA_SQL = path.join(PG_DIR, 'schema.sql');
const SEED_SQL = path.join(PG_DIR, 'seed.sql');

/**
 * Point this process at the test database, in its own schema.
 *
 * Call at the TOP of a test file, before requiring anything from src/, because
 * the modules build prepared statements at load time.
 */
function useTestDatabase(suiteName) {
  const schema = 'test_' + String(suiteName).replace(/[^a-z0-9]+/gi, '_').toLowerCase();

  process.env.NODE_ENV = 'test';
  process.env.PG_SCHEMA = schema;
  process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || DEFAULT_URL;
  process.env.OFFICE_CONFIG_FILE = process.env.OFFICE_CONFIG_FILE
    || path.join(__dirname, '..', 'fixtures', 'office.test.json');
  process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test-admin-key-0123456789';
  process.env.MAC_SALT = process.env.MAC_SALT || 'test-salt-not-a-real-one';

  // A suite must never be able to reach production, however it was invoked.
  const url = process.env.TEST_DATABASE_URL;
  if (!/(localhost|127\.0\.0\.1)/.test(url)) {
    throw new Error(
      `Refusing to run tests against a non-local database: ${url.replace(/:[^:@]*@/, ':***@')}`,
    );
  }

  return schema;
}

// Memoised, and awaited explicitly by the suites that have fixtures of their
// own.
//
// Registration order of two separate top-level `before` hooks turned out not to
// be the order they run in, so a suite's fixture hook could execute before the
// schema existed - every insert then failed with "relation does not exist".
// Memoising makes prepareDatabase safe to call from anywhere: the first caller
// does the work, everyone else awaits the same promise, and the schema is never
// dropped out from under fixtures that are already loaded.
let preparing = null;

function prepareDatabase() {
  if (!preparing) preparing = createSchema();
  return preparing;
}

/** Create the suite's schema and apply the full table definitions into it. */
async function createSchema() {
  const { Client } = require('pg');
  const schema = process.env.PG_SCHEMA;

  // The schema is created on a connection of its own, NOT through the adapter.
  // The adapter pins search_path at connection start-up, so a pooled connection
  // opened before the schema existed would resolve to `public` and quietly
  // create all 71 tables in the wrong place.
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(fs.readFileSync(SCHEMA_SQL, 'utf8'));
    // Roles, permissions, leave types and document types. Without these every
    // insert that references them fails its foreign key.
    await admin.query(fs.readFileSync(SEED_SQL, 'utf8'));
  } finally {
    await admin.end();
  }
}

/** Drop the suite's schema and close the pool. */
async function dropDatabase() {
  preparing = null;
  const pg = require('../../src/db/pg/client');
  try {
    await pg.exec(`DROP SCHEMA IF EXISTS ${process.env.PG_SCHEMA} CASCADE`);
  } catch { /* the pool may already be closing */ }
  await pg.close();
}

/**
 * The columns of a table, in the shape PRAGMA table_info() returned.
 *
 * A handful of tests assert on the schema itself - that an absence's three
 * consequences are separate nullable columns, that payroll keeps calculated and
 * approved amounts apart - and those assertions are worth keeping, so the
 * lookup is ported rather than the tests dropped.
 */
async function tableInfo(table) {
  const pg = require('../../src/db/pg/client');
  return pg.prepare(`
    SELECT column_name                                    AS name,
           data_type                                      AS type,
           CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull,
           column_default                                 AS dflt_value
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ?
    ORDER BY ordinal_position
  `).all(table);
}

module.exports = { useTestDatabase, prepareDatabase, dropDatabase, tableInfo, DEFAULT_URL };
