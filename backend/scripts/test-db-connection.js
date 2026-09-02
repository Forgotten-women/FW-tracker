const { Pool } = require('pg');
const { databaseUrl } = require('./_connection');

const pool = new Pool({
  connectionString: databaseUrl(),
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log('[db-test] Connecting to Supabase PostgreSQL...');
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT NOW() as now, version() as version;');
    console.log('[db-test] Connected successfully!');
    console.log('[db-test] PostgreSQL version:', res.rows[0].version);
    console.log('[db-test] Server time:', res.rows[0].now);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('[db-test] PostgreSQL connection error:', err);
  process.exit(1);
});
