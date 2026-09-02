const fs = require('fs');
const path = require('path');

const dbDir = path.join(__dirname, '..', 'src', 'db');
const schemaSql = fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf-8');

const migrationsDir = path.join(dbDir, 'migrations');
const migrationFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

const migrations = migrationFiles.map(f => ({
  id: f,
  sql: fs.readFileSync(path.join(migrationsDir, f), 'utf-8'),
}));

const out = `// Auto-generated embedded migrations for serverless packaging resilience
module.exports = {
  schemaSql: ${JSON.stringify(schemaSql)},
  migrations: ${JSON.stringify(migrations, null, 2)},
};
`;

fs.writeFileSync(path.join(dbDir, 'embedded-migrations.js'), out, 'utf-8');
console.log(`[build-migrations] Embedded schema and ${migrations.length} migrations generated.`);
