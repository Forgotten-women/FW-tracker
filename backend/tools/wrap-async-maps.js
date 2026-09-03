// Wraps `xs.map(async … )` in `Promise.all(...)`.
//
// An async callback handed to .map produces an array of pending promises, not
// values - so the responses that used these would have serialised as a list of
// empty objects. The codemod deliberately refuses to do this automatically
// because the correct fix is not always Promise.all; these particular sites were
// each read first and are all straightforward per-row lookups.
//
// .filter is NOT handled here: a filter over promises keeps every element, and
// the fix is to resolve before filtering, which changes the shape of the
// surrounding code. Those are done by hand.
//
// Usage: node tools/wrap-async-maps.js [--dry]

const fs = require('fs');
const path = require('path');
const walk = require('acorn-walk');
const MagicString = require('magic-string').MagicString;
const { analyse, ROOT } = require('./to-async');

const DRY = process.argv.includes('--dry');

// file -> line numbers of the .map(...) calls to wrap
const TARGETS = {
  'src/domain/documents.js': 'listFor',
  'src/routes/attendance-hr.js': 'lateness board',
  'src/routes/leave.js': 'requests / balances',
  'src/routes/warnings.js': 'board / triggers',
};

let wrapped = 0;

for (const rel of Object.keys(TARGETS)) {
  const file = path.join(ROOT, rel);
  const a = analyse(file);
  const s = new MagicString(a.code);
  let touched = false;

  walk.ancestor(a.ast, {
    CallExpression(node, _state, ancestors) {
      if (node.callee.type !== 'MemberExpression') return;
      if (node.callee.property.name !== 'map') return;
      const cb = node.arguments[0];
      if (!cb || !cb.async) return;

      // Already inside Promise.all(...)?
      const parent = ancestors[ancestors.length - 2];
      if (parent
        && parent.type === 'CallExpression'
        && parent.callee.type === 'MemberExpression'
        && parent.callee.object.name === 'Promise'
        && parent.callee.property.name === 'all') return;

      // A `return xs.map(async …)` can hand the promise array straight back to
      // an awaiting caller; everything else needs the value here and now.
      const needsAwait = !(parent && parent.type === 'ReturnStatement');

      s.appendLeft(node.start, needsAwait ? 'await Promise.all(' : 'Promise.all(');
      s.appendRight(node.end, ')');
      wrapped++;
      touched = true;
    },
  });

  if (touched) {
    console.log(`  ${rel}  (${TARGETS[rel]})`);
    if (!DRY) fs.writeFileSync(file, s.toString());
  }
}

console.log(`${DRY ? 'DRY RUN — ' : ''}wrapped ${wrapped} async .map call(s) in Promise.all`);
