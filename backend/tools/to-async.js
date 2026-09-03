// Codemod: better-sqlite3 (synchronous) -> pg adapter (asynchronous).
//
// The database API changes from synchronous to promise-returning, so every
// statement call needs `await`, every function containing one becomes `async`,
// and that property propagates outwards to every caller, across files, until it
// stops changing.
//
// Doing that by hand over 512 call sites in payroll code is not a reasonable
// thing to trust. So the mechanical part is automated, and the part that CANNOT
// be automated safely is reported instead of guessed at:
//
//   an async function passed to a synchronous array method. `.filter(async …)`
//   keeps every element, because a promise is always truthy. `.map(async …)`
//   yields promises rather than values. `.forEach(async …)` ignores failures
//   entirely. Each needs a human decision (Promise.all, a for-of loop, or
//   hoisting the await out), so each is listed for review.
//
// Usage:
//   node tools/to-async.js --dry     report only
//   node tools/to-async.js           rewrite in place

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const MagicString = require('magic-string').MagicString;

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');

const TARGET_DIRS = ['src', 'test'];

// Methods on a prepared statement that hit the database.
const STATEMENT_METHODS = new Set(['get', 'all', 'run', 'iterate', 'pluck']);

// Array methods that take a callback and do NOT understand promises.
const SYNC_HIGHER_ORDER = new Set([
  'map', 'filter', 'forEach', 'find', 'findIndex', 'some', 'every',
  'reduce', 'reduceRight', 'sort', 'flatMap',
]);

// ---------------------------------------------------------------------------

function listFiles() {
  const out = [];
  for (const dir of TARGET_DIRS) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        // The adapter itself is already async and hand-written.
        if (full.includes(path.join('src', 'db', 'pg'))) continue;
        out.push(full);
      }
    }
  }
  return out.sort();
}

function parse(code, file) {
  try {
    return acorn.parse(code, {
      ecmaVersion: 2023,
      sourceType: 'script',
      locations: true,
      allowReturnOutsideFunction: true,
    });
  } catch (err) {
    throw new Error(`parse failed in ${path.relative(ROOT, file)}: ${err.message}`);
  }
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
]);

/** The innermost function node containing `node`, from a stack of ancestors. */
function enclosingFunction(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (FUNCTION_TYPES.has(ancestors[i].type)) return ancestors[i];
  }
  return null;
}

/** The name a function node is known by, if any. */
function functionName(fn, ancestors) {
  if (fn.type === 'FunctionDeclaration' && fn.id) return fn.id.name;
  const parent = ancestors[ancestors.indexOf(fn) - 1];
  if (!parent) return null;
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  if (parent.type === 'Property' && parent.key && parent.key.name) return parent.key.name;
  if (parent.type === 'AssignmentExpression' && parent.left.type === 'Identifier') {
    return parent.left.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pass 1 — per-file analysis
// ---------------------------------------------------------------------------

function analyse(file) {
  const code = fs.readFileSync(file, 'utf8');
  const ast = parse(code, file);

  // Identifiers that hold a prepared statement.
  const statements = new Set();
  // Local name -> module path, for require() bindings.
  const imports = new Map();
  // Functions defined here, by name.
  const functions = new Map();

  walk.ancestor(ast, {
    VariableDeclarator(node) {
      // const x = db.prepare(...)  /  const x = prepare(...)
      const init = node.init;
      if (!init) return;
      const isPrepare =
        init.type === 'CallExpression'
        && ((init.callee.type === 'MemberExpression' && init.callee.property.name === 'prepare')
          || (init.callee.type === 'Identifier' && init.callee.name === 'prepare'));
      if (isPrepare && node.id.type === 'Identifier') statements.add(node.id.name);

      // const { a, b } = require('./x')  /  const m = require('./x')
      if (init.type === 'CallExpression'
        && init.callee.type === 'Identifier'
        && init.callee.name === 'require'
        && init.arguments[0]
        && init.arguments[0].type === 'Literal'
        && String(init.arguments[0].value).startsWith('.')) {
        const target = String(init.arguments[0].value);
        if (node.id.type === 'Identifier') {
          imports.set(node.id.name, { module: target, namespace: true });
        } else if (node.id.type === 'ObjectPattern') {
          for (const prop of node.id.properties) {
            if (prop.type !== 'Property') continue;
            const local = prop.value.name || prop.key.name;
            imports.set(local, { module: target, exported: prop.key.name });
          }
        }
      }
    },
  });

  walk.ancestor(ast, {
    FunctionDeclaration(node, _state, ancestors) {
      const name = functionName(node, ancestors);
      if (name) functions.set(name, node);
    },
    FunctionExpression(node, _state, ancestors) {
      const name = functionName(node, ancestors);
      if (name && !functions.has(name)) functions.set(name, node);
    },
    ArrowFunctionExpression(node, _state, ancestors) {
      const name = functionName(node, ancestors);
      if (name && !functions.has(name)) functions.set(name, node);
    },
  });

  return { file, code, ast, statements, imports, functions };
}

/** Does this call touch the database directly? */
function isDatabaseCall(node, statements) {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;

  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    const method = callee.property.name;

    // stmt.get(...) where stmt came from prepare()
    if (STATEMENT_METHODS.has(method)
      && callee.object.type === 'Identifier'
      && statements.has(callee.object.name)) return true;

    // db.prepare(...).get(...) inline
    if (STATEMENT_METHODS.has(method)
      && callee.object.type === 'CallExpression'
      && callee.object.callee.type === 'MemberExpression'
      && callee.object.callee.property.name === 'prepare') return true;

    // this.stmt.get(...) / obj.stmt.get(...) chained off a prepare
    if (STATEMENT_METHODS.has(method)
      && callee.object.type === 'MemberExpression'
      && statements.has(callee.object.property.name)) return true;

    // db.exec(...) / db.pragma(...)
    if ((method === 'exec' || method === 'pragma')
      && callee.object.type === 'Identifier'
      && /^(db|database)$/i.test(callee.object.name)) return true;
  }

  // tx(...) and audit(...) both write.
  if (callee.type === 'Identifier' && (callee.name === 'tx' || callee.name === 'audit')) return true;
  if (callee.type === 'MemberExpression'
    && callee.object.type === 'Identifier'
    && /^db$/i.test(callee.object.name)
    && callee.property.name === 'transaction') return true;

  return false;
}

module.exports = {
  listFiles, parse, analyse, isDatabaseCall, enclosingFunction, functionName,
  FUNCTION_TYPES, SYNC_HIGHER_ORDER, STATEMENT_METHODS, ROOT, DRY, MagicString, walk,
};

if (require.main === module) {
  require('./to-async-run');
}
