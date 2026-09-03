const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  console.log('--- TABLES WITH ROWS ---');
  for (const t of tables.rows) {
    try {
      const c = await client.query('SELECT count(*) FROM ' + t.table_name);
      if (Number(c.rows[0].count) > 0) {
        console.log(t.table_name, ':', c.rows[0].count);
      }
    } catch (_) {}
  }
  await client.end();
}
main().catch(console.error);
