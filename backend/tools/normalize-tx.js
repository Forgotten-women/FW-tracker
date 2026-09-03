// Normalises the two better-sqlite3 transaction idioms into a single direct
// call, before the async codemod runs.
//
// better-sqlite3's db.transaction(fn) returns a WRAPPED FUNCTION which you then
// invoke, so the codebase has both:
//
//     tx(() => { ... })();                  // immediately invoked
//     const run = tx(() => { ... }); run(); // deferred, then invoked
//
// The pg adapter's tx() runs the function and returns a promise, so both become:
//
//     await tx(async () => { ... });
//
// Left alone, the first would become `await tx(fn)()` - calling the resolved
// value - and the second would leave `run()` calling undefined. Both fail
// loudly rather than silently, but neither should be left for the test run to
// find when the shapes are this mechanical.
//
// Usage: node tools/normalize-tx.js [--dry]

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const MagicString = require('magic-string').MagicString;

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');

function listFiles(dir) {
  const out = [];
  const stack = [path.join(ROOT, dir)];
  while (stack.length) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  }
  return out.sort();
}

const isTxCall = node =>
  node.type === 'CallExpression'
  && ((node.callee.type === 'Identifier' && node.callee.name === 'tx')
    || (node.callee.type === 'MemberExpression'
      && node.callee.property.type === 'Identifier'
      && node.callee.property.name === 'transaction'));

let changedFiles = 0;
let immediate = 0;
let deferred = 0;
const unresolved = [];

for (const file of [...listFiles('src'), ...listFiles('test')]) {
  if (file.includes(path.join('src', 'db', 'pg'))) continue;

  const code = fs.readFileSync(file, 'utf8');
  if (!/\btx\s*\(|\.transaction\s*\(/.test(code)) continue;

  const ast = acorn.parse(code, { ecmaVersion: 2023, sourceType: 'script', locations: true });
  const s = new MagicString(code);
  let touched = false;

  // Pattern 1: tx(fn)()  ->  tx(fn)
  walk.simple(ast, {
    CallExpression(node) {
      if (!isTxCall(node.callee)) return;
      if (node.arguments.length) return; // tx(fn)(a) is not the idiom; leave it
      s.remove(node.callee.end, node.end);
      immediate++;
      touched = true;
    },
  });

  // Pattern 2: const run = tx(fn); ... run();  ->  tx(fn);
  walk.ancestor(ast, {
    VariableDeclaration(node, _state, ancestors) {
      if (node.declarations.length !== 1) return;
      const decl = node.declarations[0];
      if (!decl.init || !isTxCall(decl.init)) return;
      if (decl.id.type !== 'Identifier') return;

      const name = decl.id.name;
      const scope = ancestors[ancestors.length - 2];
      const body = scope && Array.isArray(scope.body) ? scope.body : null;
      if (!body) return;

      // The matching `name();` statement in the same block.
      const invocation = body.find(st =>
        st.type === 'ExpressionStatement'
        && st.expression.type === 'CallExpression'
        && st.expression.callee.type === 'Identifier'
        && st.expression.callee.name === name
        && st.expression.arguments.length === 0);

      if (!invocation) {
        unresolved.push(`${path.relative(ROOT, file)}:${node.loc.start.line}  const ${name} = tx(...) with no plain ${name}()`);
        return;
      }

      // Any OTHER use of the name means inlining would change behaviour.
      //
      // Scoped to the enclosing block, not the file: several functions in the
      // same file each declare their own `const run = tx(...)`, and counting
      // across the whole file made every one of them look shared.
      let otherUses = 0;
      walk.simple(scope, {
        Identifier(id) {
          if (id.name !== name) return;
          if (id.start === decl.id.start) return;
          if (id.start === invocation.expression.callee.start) return;
          otherUses++;
        },
      });
      if (otherUses) {
        unresolved.push(`${path.relative(ROOT, file)}:${node.loc.start.line}  ${name} used ${otherUses} more time(s)`);
        return;
      }

      // Drop `const run = `, keeping the tx(...) call as a statement.
      s.remove(node.start, decl.init.start);
      // Drop the separate `run();` line.
      s.remove(invocation.start, invocation.end);
      deferred++;
      touched = true;
    },
  });

  if (touched) {
    changedFiles++;
    if (!DRY) fs.writeFileSync(file, s.toString());
  }
}

console.log(`${DRY ? 'DRY RUN — ' : ''}transaction idiom normalisation`);
console.log(`  files changed      : ${changedFiles}`);
console.log(`  tx(fn)() collapsed : ${immediate}`);
console.log(`  const run = tx(fn) : ${deferred}`);
if (unresolved.length) {
  console.log(`\n  ${unresolved.length} left for manual handling:`);
  for (const u of unresolved) console.log(`    ${u}`);
}
