// Marks any function that contains `await` as async.
//
// A general safety net for the conversion: an await inside a non-async function
// is a syntax error, so this cannot mask a real problem - it only fixes the
// cases where a transformation added an await inside a callback that was still
// synchronous (a `test('...', () => {})` body, most often).
//
// Usage: node tools/fix-missing-async.js [--dry]

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
const files = new Set();

for (const file of [...listFiles('src'), ...listFiles('test')]) {
  const code = fs.readFileSync(file, 'utf8');
  if (!code.includes('await ')) continue;

  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2023, sourceType: 'script', allowAwaitOutsideFunction: true });
  } catch { continue; }

  const s = new MagicString(code);
  let touched = false;

  walk.ancestor(ast, {
    AwaitExpression(node, _state, ancestors) {
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i];
        if (!FN.has(a.type)) continue;
        if (!a.async && !a.__marked) {
          a.__marked = true;
          s.appendLeft(a.start, 'async ');
          fixed++;
          touched = true;
        }
        return; // only the innermost enclosing function matters
      }
    },
  });

  if (touched) {
    files.add(path.relative(ROOT, file));
    if (!DRY) fs.writeFileSync(file, s.toString());
  }
}

console.log(`${DRY ? 'DRY RUN — ' : ''}marked ${fixed} function(s) async in ${files.size} file(s)`);
for (const f of files) console.log(`    ${f}`);
