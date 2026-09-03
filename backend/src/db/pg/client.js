// PostgreSQL access layer.
//
// Presents the same shape as the better-sqlite3 API the codebase was written
// against - `prepare(sql)` returning an object with `.get()`, `.all()` and
// `.run()` - so the ~390 statement definitions and ~512 call sites keep their
// existing form and only gain `await`. Rewriting them all into raw pool.query
// calls would have been a much larger diff over payroll code for no benefit.
//
// Two things it does that the SQLite driver did for free:
//
//   * placeholder translation. The existing SQL uses `@named` and `?` markers;
//     Postgres wants $1..$n. Translation happens once per statement and is
//     cached, and it is done with a real tokenizer rather than a regex, so an
//     `@` or `?` inside a string literal or a comment is left alone.
//
//   * transactions. better-sqlite3 transactions are synchronous, so nesting
//     just worked. With a connection pool, every statement in a transaction
//     must run on the SAME connection. The transaction's client is carried in
//     AsyncLocalStorage, so statements inside `tx()` find it automatically and
//     call sites do not have to thread a client parameter through every
//     function.

const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// The connection the current transaction is running on, if any.
const txContext = new AsyncLocalStorage();

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let pool = null;

function connectionString() {
  const url = (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '').trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. The server has no database to talk to. ' +
      'Set it in backend/.env (and in the hosting environment).',
    );
  }
  return url;
}

function getPool() {
  if (pool) return pool;

  const url = connectionString();
  const local = /(^|@)(localhost|127\.0\.0\.1)[:/]/.test(url);

  // Test isolation. Each test file works in its own Postgres schema inside one
  // database, so suites cannot see each other's rows without needing a database
  // each. Unset in normal operation.
  //
  // Passed as a connection START-UP option rather than by issuing `SET
  // search_path` on the pool's connect event: the event handler cannot be
  // awaited, so a query could reach the server before the SET landed and end up
  // reading the wrong schema.
  const schema = (process.env.PG_SCHEMA || '').trim();
  if (schema && !/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`PG_SCHEMA must be a plain identifier, got: ${schema}`);
  }

  pool = new Pool({
    connectionString: url,
    // Serverless instances are numerous and short-lived, so each one keeps a
    // small pool. Supabase's pooler is what multiplexes them.
    max: Number(process.env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Supabase requires TLS; a local test container does not offer it.
    ssl: local ? false : { rejectUnauthorized: false },
    ...(schema ? { options: `-c search_path=${schema},public` } : {}),
  });

  pool.on('error', err => {
    // An idle client erroring is not fatal - the pool replaces it. Logged
    // rather than thrown, which would take the process down.
    console.error('[pg] idle client error:', err.message);
  });

  return pool;
}

/** The connection to use: the transaction's if we are inside one, else the pool. */
function executor() {
  return txContext.getStore() || getPool();
}

// ---------------------------------------------------------------------------
// Placeholder translation
// ---------------------------------------------------------------------------

// Walks the SQL once, tracking whether it is inside a quoted string, a quoted
// identifier, a line comment or a block comment, and only treats `@name` and
// `?` as placeholders in ordinary code. A regex would happily rewrite the `?`
// in a comment or the `@` in an email literal.
function translate(sql) {
  let out = '';
  let index = 0;
  const names = new Map(); // @name -> $n, so a repeated name reuses its number

  let i = 0;
  while (i < sql.length) {
    const c = sql[i];

    // '...' string literal, with '' as the escape
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // "..." quoted identifier
    if (c === '"') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== '"') j++;
      j++;
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // -- line comment
    if (c === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = sql.length;
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // /* block comment */
    if (c === '/' && sql[i + 1] === '*') {
      let j = sql.indexOf('*/', i + 2);
      j = j === -1 ? sql.length : j + 2;
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // @name placeholder
    if (c === '@' && /[A-Za-z_]/.test(sql[i + 1] || '')) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      if (!names.has(name)) names.set(name, `$${++index}`);
      out += names.get(name);
      i = j;
      continue;
    }

    // ? placeholder
    if (c === '?') {
      out += `$${++index}`;
      i++;
      continue;
    }

    out += c;
    i++;
  }

  return {
    text: out,
    // Present only for named statements; positional ones bind by argument order.
    names: names.size ? [...names.keys()] : null,
    count: index,
  };
}

// `INSERT OR IGNORE` has no Postgres equivalent as a prefix, but it is exactly
// `ON CONFLICT DO NOTHING`. `INSERT OR REPLACE` is NOT auto-translated: the
// right conflict target cannot be inferred, and guessing it on a payroll table
// could overwrite the wrong row. Those must be written out explicitly.
function normaliseDialect(sql) {
  if (/\bINSERT\s+OR\s+REPLACE\b/i.test(sql)) {
    throw new Error(
      'INSERT OR REPLACE is SQLite-only and cannot be translated safely. ' +
      'Write an explicit "INSERT ... ON CONFLICT (<key>) DO UPDATE SET ..." instead.',
    );
  }
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(sql)) {
    const rewritten = sql.replace(/\bINSERT\s+OR\s+IGNORE\b/i, 'INSERT');
    return /\bON\s+CONFLICT\b/i.test(rewritten)
      ? rewritten
      : `${rewritten.replace(/;\s*$/, '')} ON CONFLICT DO NOTHING`;
  }
  return sql;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

class Statement {
  constructor(sql) {
    this.source = sql;
    this.compiled = translate(normaliseDialect(sql));
  }

  /** Turn call-site arguments into the positional array Postgres wants. */
  bind(args) {
    const { names, count } = this.compiled;

    if (names) {
      const params = args[0] || {};
      return names.map(n => {
        const v = params[n];
        return v === undefined ? null : v;
      });
    }

    // better-sqlite3 accepts both run(a, b) and run([a, b]).
    const flat = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return flat.slice(0, count).map(v => (v === undefined ? null : v));
  }

  async execute(args) {
    try {
      return await executor().query(this.compiled.text, this.bind(args));
    } catch (err) {
      // Without the statement, a Postgres error is nearly unactionable - it
      // names a column but not which of 390 statements used it.
      err.message = `${err.message}\n  in: ${this.source.trim().split('\n')[0]}`;
      throw err;
    }
  }

  async get(...args) {
    const res = await this.execute(args);
    return res.rows[0];
  }

  async all(...args) {
    const res = await this.execute(args);
    return res.rows;
  }

  async run(...args) {
    const res = await this.execute(args);
    return {
      changes: res.rowCount,
      // Populated only when the statement asks for it with RETURNING.
      lastInsertRowid: res.rows[0] ? (res.rows[0].id ?? null) : null,
    };
  }

  /** Alias so `for (const row of await stmt.iterate())` style reads still work. */
  async iterate(...args) {
    return this.all(...args);
  }
}

// Statements are defined once at module load in most files, but some are built
// inside handlers; caching keeps that from re-parsing the same SQL repeatedly.
const cache = new Map();

function prepare(sql) {
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = new Statement(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

/** Run raw SQL with no parameters (schema application, maintenance). */
async function exec(sql) {
  await executor().query(sql);
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside a single transaction. Commits if it returns, rolls back if it
 * throws. Statements executed inside pick up the transaction's connection
 * automatically via AsyncLocalStorage.
 *
 * Nesting is handled with savepoints rather than by opening a second
 * transaction, so an inner failure can be caught without discarding the outer
 * one.
 */
async function tx(fn) {
  const existing = txContext.getStore();

  if (existing) {
    const name = `sp_${Math.random().toString(36).slice(2, 10)}`;
    await existing.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn(existing);
      await existing.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      await existing.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw err;
    }
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await txContext.run(client, () => fn(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  cache.clear();
}

module.exports = { prepare, exec, tx, close, getPool, translate, normaliseDialect };
