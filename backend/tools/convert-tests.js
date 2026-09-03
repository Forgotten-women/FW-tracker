// Converts the test suites from the throwaway-SQLite-file bootstrap to the
// shared Postgres test database, one schema per suite.
//
// Three mechanical changes per file:
//
//   1. the DB_FILE / temp-path preamble becomes useTestDatabase(<suite>), which
//      must still run BEFORE anything requires src/, because those modules
//      prepare their statements at load time;
//   2. a before hook creates the suite's schema and a matching after hook drops
//      it, replacing the unlink of the .db/.db-wal/.db-shm files;
//   3. `INSERT OR REPLACE` becomes an explicit upsert. The adapter refuses to
//      translate that automatically, because the conflict target cannot be
//      inferred and guessing it on a real table could overwrite the wrong row -
//      but in a test helper the target is always the primary key, and the
//      primary key is read from the generated schema rather than assumed.
//
// Usage: node tools/convert-tests.js [--dry]

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, 'src', 'db', 'pg', 'schema.sql'), 'utf8');

// table -> primary key columns, taken from the generated schema.
function primaryKeys() {
  const keys = new Map();
  const tableRe = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
  let m;
  while ((m = tableRe.exec(SCHEMA_SQL))) {
    const [, table, body] = m;
    const explicit = body.match(/^\s*PRIMARY KEY \(([^)]+)\)/m);
    if (explicit) {
      keys.set(table, explicit[1].split(',').map(s => s.trim()));
      continue;
    }
    const inline = body.match(/^\s*(\w+)[^,\n]*\bPRIMARY KEY\b/m);
    if (inline) keys.set(table, [inline[1]]);
  }
  return keys;
}

const PK = primaryKeys();

/** INSERT OR REPLACE INTO t (a,b,c) VALUES (...) -> upsert on t's primary key. */
function rewriteUpserts(source, file) {
  const missing = [];
  const out = source.replace(
    /INSERT OR REPLACE INTO (\w+)\s*\(([^)]*)\)/gi,
    (whole, table, cols) => {
      const key = PK.get(table);
      if (!key) { missing.push(table); return whole; }
      const columns = cols.split(',').map(c => c.trim()).filter(Boolean);
      const updates = columns
        .filter(c => !key.includes(c))
        .map(c => `${c} = EXCLUDED.${c}`);
      const suffix = updates.length
        ? `ON CONFLICT (${key.join(', ')}) DO UPDATE SET ${updates.join(', ')}`
        : `ON CONFLICT (${key.join(', ')}) DO NOTHING`;
      // Marker consumed below, once the VALUES (...) has been passed.
      return `INSERT INTO ${table} (${cols})/*__UPSERT__${Buffer.from(suffix).toString('base64')}*/`;
    },
  );
  return { out, missing };
}

/** Move the marker to the end of the statement, after VALUES (...). */
function placeUpsertSuffix(source) {
  return source.replace(
    /\/\*__UPSERT__([A-Za-z0-9+/=]+)\*\/([\s\S]*?)(VALUES\s*\([^)]*\))/g,
    (_whole, b64, between, values) =>
      `${between}${values} ${Buffer.from(b64, 'base64').toString('utf8')}`,
  );
}

const files = fs.readdirSync(path.join(ROOT, 'test'))
  .filter(f => f.endsWith('.test.js') && f !== 'pg-client.test.js')
  .map(f => path.join(ROOT, 'test', f));

let converted = 0;
const notes = [];

for (const file of files) {
  let s = fs.readFileSync(file, 'utf8');
  const name = path.basename(file, '.test.js');
  const before = s;

  // 1. bootstrap
  if (/DB_FILE/.test(s)) {
    s = s.replace(
      /(?:^|\n)(?:\/\/[^\n]*\n)*const TMP = [^\n]*\n(?:process\.env\.[A-Z_]+ = [^\n]*\n)+/,
      `\nconst { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');\n`
      + `useTestDatabase('${name}');\n\n`,
    );
    // Anything left over that still pins a file path.
    s = s.replace(/^process\.env\.DB_FILE = [^\n]*\n/m, '');
  }

  // 2. lifecycle hooks
  if (/test\.after\(/.test(s)) {
    s = s.replace(
      /test\.after\((?:async )?\(\) => \{[\s\S]*?\n\}\);/,
      'test.after(dropDatabase);',
    );
  } else {
    s += '\ntest.after(dropDatabase);\n';
  }

  if (/test\.before\(/.test(s)) {
    // Keep the suite's own setup, but create the schema first.
    s = s.replace(/test\.before\(/, 'test.before(prepareDatabase);\ntest.before(');
  } else {
    s = s.replace(
      /useTestDatabase\('([^']+)'\);\n/,
      "useTestDatabase('$1');\n",
    );
    // Inserted after the requires so `test` is defined.
    const anchor = s.indexOf('\n', s.lastIndexOf("require('"));
    if (anchor !== -1) {
      s = s.slice(0, anchor + 1) + '\ntest.before(prepareDatabase);\n' + s.slice(anchor + 1);
    }
  }

  // 3. upserts
  const { out, missing } = rewriteUpserts(s, file);
  s = placeUpsertSuffix(out);
  for (const t of missing) notes.push(`${path.basename(file)}: no primary key known for "${t}"`);

  if (s !== before) {
    converted++;
    if (!DRY) fs.writeFileSync(file, s);
  }
}

console.log(`${DRY ? 'DRY RUN — ' : ''}converted ${converted} test file(s)`);
for (const n of new Set(notes)) console.log(`  ! ${n}`);
