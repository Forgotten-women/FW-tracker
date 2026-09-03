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

const SCHEMA_SQL = path.join(__dirname, '..', '..', 'src', 'db', 'pg', 'schema.sql');

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

/** Create the suite's schema and apply the full table definitions into it. */
async function prepareDatabase() {
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
    await admin.query(`SET search_path TO ${schema}, public`);
    await admin.query(fs.readFileSync(SCHEMA_SQL, 'utf8'));
  } finally {
    await admin.end();
  }
}

/** Drop the suite's schema and close the pool. */
async function dropDatabase() {
  const pg = require('../../src/db/pg/client');
  try {
    await pg.exec(`DROP SCHEMA IF EXISTS ${process.env.PG_SCHEMA} CASCADE`);
  } catch { /* the pool may already be closing */ }
  await pg.close();
}

module.exports = { useTestDatabase, prepareDatabase, dropDatabase, DEFAULT_URL };
