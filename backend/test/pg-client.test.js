// Adapter tests. Everything else in the backend sits on this, so the
// placeholder tokenizer and the transaction semantics are tested directly
// rather than only through the code that uses them.

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL
  || 'postgresql://postgres:testpw@127.0.0.1:55432/office_tracker_test';

const pg = require('../src/db/pg/client');

// ---------------------------------------------------------------------------
// Placeholder translation
// ---------------------------------------------------------------------------

test('named parameters become $n in order of first appearance', async () => {
  const r = pg.translate('SELECT * FROM t WHERE a = @alpha AND b = @beta');
  assert.equal(r.text, 'SELECT * FROM t WHERE a = $1 AND b = $2');
  assert.deepEqual(r.names, ['alpha', 'beta']);
});

test('a repeated named parameter reuses its number', async () => {
  const r = pg.translate('SELECT * FROM t WHERE a = @x OR b = @x OR c = @y');
  assert.equal(r.text, 'SELECT * FROM t WHERE a = $1 OR b = $1 OR c = $2');
  assert.deepEqual(r.names, ['x', 'y']);
  assert.equal(r.count, 2);
});

test('positional markers are numbered left to right', async () => {
  const r = pg.translate('INSERT INTO t (a,b,c) VALUES (?,?,?)');
  assert.equal(r.text, 'INSERT INTO t (a,b,c) VALUES ($1,$2,$3)');
  assert.equal(r.names, null);
});

// The reason this is a tokenizer and not a regex.
test('markers inside string literals are left alone', async () => {
  const r = pg.translate("SELECT * FROM t WHERE email = 'a@b.com' AND q = ? AND s = 'why?'");
  assert.equal(r.text, "SELECT * FROM t WHERE email = 'a@b.com' AND q = $1 AND s = 'why?'");
  assert.equal(r.count, 1);
});

test('an escaped quote inside a literal does not end the literal', async () => {
  const r = pg.translate("SELECT * FROM t WHERE n = 'O''Brien? @x' AND id = ?");
  assert.equal(r.text, "SELECT * FROM t WHERE n = 'O''Brien? @x' AND id = $1");
  assert.equal(r.count, 1);
});

test('markers inside line comments are left alone', async () => {
  const r = pg.translate('SELECT 1 -- is this @thing ok?\nWHERE id = @id');
  assert.equal(r.text, 'SELECT 1 -- is this @thing ok?\nWHERE id = $1');
  assert.deepEqual(r.names, ['id']);
});

test('markers inside block comments are left alone', async () => {
  const r = pg.translate('SELECT /* @a and ? */ 1 WHERE id = ?');
  assert.equal(r.text, 'SELECT /* @a and ? */ 1 WHERE id = $1');
  assert.equal(r.count, 1);
});

test('quoted identifiers are left alone', async () => {
  const r = pg.translate('SELECT "od?d@col" FROM t WHERE id = ?');
  assert.equal(r.text, 'SELECT "od?d@col" FROM t WHERE id = $1');
  assert.equal(r.count, 1);
});

// ---------------------------------------------------------------------------
// Dialect
// ---------------------------------------------------------------------------

test('INSERT OR IGNORE becomes ON CONFLICT DO NOTHING', async () => {
  const sql = pg.normaliseDialect('INSERT OR IGNORE INTO t (a) VALUES (?)');
  assert.match(sql, /^INSERT INTO t/);
  assert.match(sql, /ON CONFLICT DO NOTHING$/);
});

test('an INSERT OR IGNORE that already has ON CONFLICT is not double-suffixed', async () => {
  const sql = pg.normaliseDialect(
    'INSERT OR IGNORE INTO t (a) VALUES (?) ON CONFLICT (a) DO NOTHING',
  );
  assert.equal((sql.match(/ON CONFLICT/g) || []).length, 1);
});

// Guessing the conflict target on a payroll table could overwrite the wrong row.
test('INSERT OR REPLACE is refused rather than guessed at', async () => {
  assert.throws(
    () => pg.normaliseDialect('INSERT OR REPLACE INTO t (a) VALUES (?)'),
    /cannot be translated safely/,
  );
});

// ---------------------------------------------------------------------------
// Live behaviour
// ---------------------------------------------------------------------------

test.before(async () => {
  await pg.exec('DROP TABLE IF EXISTS adapter_probe');
  await pg.exec(
    'CREATE TABLE adapter_probe ('
    + '  id   BIGSERIAL PRIMARY KEY,'
    + '  name TEXT NOT NULL UNIQUE,'
    + '  n    BIGINT NOT NULL DEFAULT 0'
    + ')',
  );
});

test.after(async () => {
  await pg.exec('DROP TABLE IF EXISTS adapter_probe');
  await pg.close();
});

test('run reports how many rows changed', async () => {
  const r = await pg.prepare('INSERT INTO adapter_probe (name, n) VALUES (?, ?)').run('alpha', 1);
  assert.equal(r.changes, 1);
});

test('get returns one row and all returns every row', async () => {
  await pg.prepare('INSERT INTO adapter_probe (name, n) VALUES (?, ?)').run('beta', 2);
  const one = await pg.prepare('SELECT * FROM adapter_probe WHERE name = ?').get('beta');
  assert.equal(Number(one.n), 2);
  const many = await pg.prepare('SELECT * FROM adapter_probe ORDER BY name').all();
  assert.ok(many.length >= 2);
});

test('get returns undefined when nothing matches', async () => {
  const row = await pg.prepare('SELECT * FROM adapter_probe WHERE name = ?').get('nobody');
  assert.equal(row, undefined);
});

test('named binding maps object keys to the right placeholders', async () => {
  await pg.prepare('INSERT INTO adapter_probe (name, n) VALUES (@name, @n)')
    .run({ name: 'gamma', n: 7 });
  const row = await pg.prepare('SELECT n FROM adapter_probe WHERE name = @name')
    .get({ name: 'gamma' });
  assert.equal(Number(row.n), 7);
});

test('a missing named parameter binds NULL rather than shifting the others', async () => {
  // Silently shifting positions is how the wrong value lands in the wrong
  // column, which on this schema means one employee's hours against another.
  const row = await pg.prepare('SELECT @a::text AS a, @b::text AS b').get({ b: 'second' });
  assert.equal(row.a, null);
  assert.equal(row.b, 'second');
});

test('a transaction commits as a unit', async () => {
  await pg.tx(async () => {
    await pg.prepare('INSERT INTO adapter_probe (name, n) VALUES (?, ?)').run('tx1', 1);
    await pg.prepare('INSERT INTO adapter_probe (name, n) VALUES (?, ?)').run('tx2', 2);
  });
  const rows = await pg.prepare("SELECT * FROM adapter_probe WHERE name IN ('tx1','tx2')").all();
  assert.equal(rows.length, 2);
});

test('a failing transaction leaves nothing behind', async () => {
  await assert.rejects(pg.tx(async () => {
    await pg.prepare('INSERT INTO adapter_probe (name, n) VALUES (?, ?)').run('rollback_me', 1);
    throw new Error('deliberate');
  }), /deliberate/);

  const row = await pg.prepare('SELECT * FROM adapter_probe WHERE name = ?').get('rollback_me');
  assert.equal(row, undefined, 'the insert must not have survived');
});

test('statements inside a transaction use the transaction connection', async () => {
  await assert.rejects(pg.tx(async () => {
    await pg.prepare('INSERT INTO adapter_probe (name, n) VALUES (?, ?)').run('visible_inside', 9);
    // If this read went to the pool instead of the transaction's connection it
    // would not see the uncommitted row, and the whole ambient-client design
    // would be broken.
    const seen = await pg.prepare('SELECT n FROM adapter_probe WHERE name = ?').get('visible_inside');
    assert.equal(Number(seen.n), 9);
    throw new Error('now undo it');
  }), /now undo it/);
});

test('a nested transaction rolls back to its savepoint without losing the outer one', async () => {
  await pg.tx(async () => {
    await pg.prepare('INSERT INTO adapter_probe (name, n) VALUES (?, ?)').run('outer_kept', 1);
    try {
      await pg.tx(async () => {
        await pg.prepare('INSERT INTO adapter_probe (name, n) VALUES (?, ?)').run('inner_dropped', 2);
        throw new Error('inner fails');
      });
    } catch { /* handled: the outer work should still commit */ }
  });

  assert.ok(await pg.prepare('SELECT 1 FROM adapter_probe WHERE name = ?').get('outer_kept'));
  assert.equal(
    await pg.prepare('SELECT 1 FROM adapter_probe WHERE name = ?').get('inner_dropped'),
    undefined,
  );
});

test('an error names the statement it came from', async () => {
  await assert.rejects(
    await pg.prepare('SELECT no_such_column FROM adapter_probe').all(),
    /in: SELECT no_such_column/,
  );
});
