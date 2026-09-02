const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { databaseUrl, confirmTarget } = require('./_connection');

const connectionString = databaseUrl();
confirmTarget(connectionString);

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log('[supabase-migrate] Connecting to Supabase PostgreSQL...');
  const client = await pool.connect();
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'supabase_schema.sql'), 'utf-8');
    console.log('[supabase-migrate] Applying complete PostgreSQL schema...');
    await client.query(schemaSql);
    console.log('[supabase-migrate] -> Schema applied successfully!');

    // Verify all created tables
    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log(`[supabase-migrate] Verified ${res.rows.length} tables in Supabase:`);
    console.table(res.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('[supabase-migrate] Migration error:', err);
  process.exit(1);
});
