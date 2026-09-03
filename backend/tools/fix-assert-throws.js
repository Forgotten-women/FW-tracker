// assert.throws(async () => ...) -> await assert.rejects(async () => ...)
//
// assert.throws only catches a SYNCHRONOUS throw. An async function returns a
// rejected promise instead, which assert.throws never sees, so the assertion
// fails with "Missing expected exception" - and, worse, would silently pass if
// the guard being tested were removed, because there is nothing to catch either
// way. Every one of these is a test that had stopped testing anything.
//
// Only callbacks the async conversion actually marked `async` are touched; a
// genuinely synchronous assert.throws is left alone.
//
// Usage: node tools/fix-assert-throws.js [--dry]

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const MagicString = require('magic-string').MagicString;

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');

const files = fs.readdirSync(path.join(ROOT, 'test'))
  .filter(f => f.endsWith('.test.js'))
  .map(f => path.join(ROOT, 'test', f));

let converted = 0;
const touchedFiles = new Set();

for (const file of files) {
  const code = fs.readFileSync(file, 'utf8');
  if (!/assert\.(throws|doesNotThrow)\s*\(/.test(code)) continue;

  const ast = acorn.parse(code, { ecmaVersion: 2023, sourceType: 'script', locations: true });
  const s = new MagicString(code);
  let touched = false;

  walk.ancestor(ast, {
    CallExpression(node, _state, ancestors) {
      if (node.callee.type !== 'MemberExpression') return;
      if (node.callee.object.name !== 'assert') return;

      const method = node.callee.property.name;
      if (method !== 'throws' && method !== 'doesNotThrow') return;

      const cb = node.arguments[0];
      if (!cb || !cb.async) return; // synchronous assertion: leave it

      // assert.throws -> assert.rejects, assert.doesNotThrow -> assert.doesNotReject
      s.overwrite(
        node.callee.property.start,
        node.callee.property.end,
        method === 'throws' ? 'rejects' : 'doesNotReject',
      );

      // These return promises, so the assertion must be awaited or a failure
      // surfaces as an unhandled rejection after the test has already passed.
      const parent = ancestors[ancestors.length - 2];
      if (!parent || parent.type !== 'AwaitExpression') {
        s.appendLeft(node.start, 'await ');
      }

      converted++;
      touched = true;
      touchedFiles.add(path.relative(ROOT, file));
    },
  });

  if (touched && !DRY) fs.writeFileSync(file, s.toString());
}

console.log(`${DRY ? 'DRY RUN — ' : ''}converted ${converted} assertion(s) in ${touchedFiles.size} file(s)`);
for (const f of touchedFiles) console.log(`    ${f}`);
