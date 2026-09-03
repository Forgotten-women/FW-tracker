// Moves `test.before(prepareDatabase)` to the top level of each test file.
//
// The test converter anchored the insertion on the last require() in the file,
// but several suites call require() INSIDE a test (to poke at config), so the
// hook landed in a finally block or inside a test body. A hook registered from
// there does not run before the suite - it registers partway through it - so
// the schema was recreated mid-run and suites contaminated themselves.
//
// Usage: node tools/fix-before-hooks.js [--dry]

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const MagicString = require('magic-string').MagicString;

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');

let moved = 0;

for (const name of fs.readdirSync(path.join(ROOT, 'test'))) {
  if (!name.endsWith('.test.js')) continue;
  const file = path.join(ROOT, 'test', name);
  const code = fs.readFileSync(file, 'utf8');
  if (!code.includes('test.before(prepareDatabase)')) continue;

  const ast = acorn.parse(code, { ecmaVersion: 2023, sourceType: 'script', locations: true });

  const isHook = n =>
    n.type === 'ExpressionStatement'
    && n.expression.type === 'CallExpression'
    && n.expression.callee.type === 'MemberExpression'
    && n.expression.callee.object.name === 'test'
    && n.expression.callee.property.name === 'before'
    && n.expression.arguments[0]
    && n.expression.arguments[0].name === 'prepareDatabase';

  // Already correct if it is a direct child of the Program body.
  if (ast.body.some(isHook)) continue;

  const s = new MagicString(code);

  // Remove every nested occurrence.
  const stack = [ast];
  const found = [];
  while (stack.length) {
    const node = stack.pop();
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === 'string') {
            if (isHook(child)) found.push(child); else stack.push(child);
          }
        }
      } else if (value && typeof value.type === 'string') {
        if (isHook(value)) found.push(value); else stack.push(value);
      }
    }
  }
  if (!found.length) continue;
  for (const node of found) s.remove(node.start, node.end);

  // Re-insert immediately after useTestDatabase(...), which is top level and
  // runs before anything in src/ is required.
  const anchor = code.indexOf('\n', code.indexOf('useTestDatabase('));
  s.appendLeft(anchor + 1, '\ntest.before(prepareDatabase);\n');

  moved++;
  console.log(`  ${name}: hook moved to top level (was nested)`);
  if (!DRY) fs.writeFileSync(file, s.toString());
}

console.log(`${DRY ? 'DRY RUN — ' : ''}fixed ${moved} file(s)`);
