// Re-parenthesises `await stmt.all().map(f)` into `(await stmt.all()).map(f)`.
//
// `await` takes the whole member-call chain as its operand, so the codemod's
// insertion produced code that calls .map / .filter / .some on the Promise
// itself rather than on the rows. That throws immediately, which is at least
// loud - but there are enough of them that fixing each by hand invites typos in
// exactly the queries that feed payroll.
//
// Usage: node tools/fix-await-chains.js [--dry]

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const MagicString = require('magic-string').MagicString;
const { isDatabaseCall, analyse } = require('./to-async');

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

/** Walk down a member/call chain looking for the database call at its root. */
function findDatabaseCall(node, statements) {
  let current = node;
  const guard = 20;
  for (let i = 0; i < guard && current; i++) {
    if (current.type === 'CallExpression' && isDatabaseCall(current, statements)) return current;
    if (current.type === 'CallExpression') { current = current.callee; continue; }
    if (current.type === 'MemberExpression') { current = current.object; continue; }
    // `stmt.get()?.c` is a ChainExpression wrapping the member access. Without
    // this the chain looked opaque, the await stayed on the outside where it
    // resolved `undefined?.c` instead of the row, and the codemod kept adding
    // another await on every run because the call itself still looked unawaited.
    if (current.type === 'ChainExpression') { current = current.expression; continue; }
    return null;
  }
  return null;
}

let fixed = 0;
const touchedFiles = [];

for (const file of [...listFiles('src'), ...listFiles('test')]) {
  if (file.includes(path.join('src', 'db', 'pg'))) continue;

  const a = analyse(file);
  const s = new MagicString(a.code);
  let touched = false;

  walk.simple(a.ast, {
    AwaitExpression(node) {
      const arg = node.argument;
      // `await await x` - collapse the duplicate rather than leaving it.
      if (arg.type === 'AwaitExpression') {
        s.remove(node.start, arg.start);
        fixed++;
        touched = true;
        return;
      }
      if (arg.type !== 'CallExpression' && arg.type !== 'MemberExpression'
        && arg.type !== 'ChainExpression') return;
      // Already awaiting the database call itself - nothing to do.
      if (arg.type === 'CallExpression' && isDatabaseCall(arg, a.statements)) return;

      const dbCall = findDatabaseCall(arg, a.statements);
      if (!dbCall || dbCall === arg) return;

      // Drop the original `await ` and wrap only the database call.
      s.remove(node.start, arg.start);
      s.appendLeft(dbCall.start, '(await ');
      s.appendRight(dbCall.end, ')');
      fixed++;
      touched = true;
    },
  });

  if (touched) {
    touchedFiles.push(path.relative(ROOT, file));
    if (!DRY) fs.writeFileSync(file, s.toString());
  }
}

console.log(`${DRY ? 'DRY RUN — ' : ''}await-chain re-parenthesisation`);
console.log(`  sites fixed : ${fixed}`);
for (const f of touchedFiles) console.log(`    ${f}`);
