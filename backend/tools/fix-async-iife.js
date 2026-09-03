// Awaits immediately-invoked async arrow functions.
//
// The codemod resolves calls by name - a local function, or one imported from
// another module - so an IIFE has no name for it to look up. It correctly made
// the arrow `async` because of the database call inside, but left the
// invocation unawaited, and the surrounding object then held a Promise where a
// value was expected. In profile() that meant `personal` and `bank` came back
// as pending promises, so every field read as undefined.
//
// Usage: node tools/fix-async-iife.js [--dry]

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const MagicString = require('magic-string').MagicString;

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');
const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function listFiles(dir) {
  const out = [];
  const stack = [path.join(ROOT, dir)];
  while (stack.length) {
    const cur = stack.pop();
    if (!fs.existsSync(cur)) continue;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith('.js')) out.push(full);
    }
  }
  return out;
}

let fixed = 0;
const touched = new Set();

for (const file of [...listFiles('src'), ...listFiles('test')]) {
  if (file.includes(path.join('src', 'db', 'pg'))) continue;
  const code = fs.readFileSync(file, 'utf8');
  if (!code.includes('async (')) continue;

  const ast = acorn.parse(code, { ecmaVersion: 2023, sourceType: 'script' });
  const s = new MagicString(code);
  let dirty = false;
  const needAsync = new Set();

  walk.ancestor(ast, {
    CallExpression(node, _state, ancestors) {
      const callee = node.callee;
      if (!FN.has(callee.type) || !callee.async) return;

      const parent = ancestors[ancestors.length - 2];
      if (parent && parent.type === 'AwaitExpression') return;

      s.appendLeft(node.start, 'await ');
      fixed++;
      dirty = true;

      // Whatever contains the IIFE now needs to be async too.
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i];
        if (a === callee) continue;
        if (FN.has(a.type)) { if (!a.async) needAsync.add(a); break; }
      }
    },
  });

  for (const fn of needAsync) s.appendLeft(fn.start, 'async ');

  if (dirty) {
    touched.add(path.relative(ROOT, file));
    if (!DRY) fs.writeFileSync(file, s.toString());
  }
}

console.log(`${DRY ? 'DRY RUN — ' : ''}awaited ${fixed} async IIFE(s) in ${touched.size} file(s)`);
for (const f of touched) console.log(`    ${f}`);
