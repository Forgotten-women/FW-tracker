// Fixpoint propagation and rewriting for the sync -> async migration.
// See tools/to-async.js for why this exists.

const fs = require('fs');
const path = require('path');
const {
  listFiles, parse, analyse, isDatabaseCall, enclosingFunction, functionName,
  FUNCTION_TYPES, SYNC_HIGHER_ORDER, ROOT, DRY, MagicString, walk,
} = require('./to-async');

// ---------------------------------------------------------------------------

function resolveModule(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Names this module puts on module.exports. */
function exportedNames(ast) {
  const names = new Map(); // exported name -> local name
  walk.simple(ast, {
    AssignmentExpression(node) {
      const left = node.left;
      if (left.type !== 'MemberExpression') return;

      const isModuleExports =
        (left.object.type === 'Identifier' && left.object.name === 'exports')
        || (left.object.type === 'MemberExpression'
          && left.object.object.type === 'Identifier'
          && left.object.object.name === 'module'
          && left.object.property.name === 'exports');

      // module.exports = { a, b: c }
      if (left.type === 'MemberExpression'
        && left.object.type === 'Identifier'
        && left.object.name === 'module'
        && left.property.name === 'exports'
        && node.right.type === 'ObjectExpression') {
        for (const prop of node.right.properties) {
          if (prop.type !== 'Property') continue;
          const exported = prop.key.name || prop.key.value;
          const local = prop.value.type === 'Identifier' ? prop.value.name : exported;
          names.set(exported, local);
        }
        return;
      }

      // exports.x = ... / module.exports.x = ...
      if (isModuleExports && left.property && left.property.name) {
        const exported = left.property.name;
        const local = node.right.type === 'Identifier' ? node.right.name : exported;
        names.set(exported, local);
      }
    },
  });
  return names;
}

// ---------------------------------------------------------------------------

const files = listFiles();
const info = new Map();

for (const file of files) {
  const a = analyse(file);
  a.exports = exportedNames(a.ast);
  a.asyncFunctions = new Set();   // local names known to be async
  a.asyncNodes = new Set();       // function AST nodes needing `async`
  info.set(file, a);
}

// Local name -> { file, exported } for calls into other modules.
for (const a of info.values()) {
  a.resolvedImports = new Map();
  for (const [local, spec] of a.imports) {
    const target = resolveModule(a.file, spec.module);
    if (target && info.has(target)) {
      a.resolvedImports.set(local, { file: target, exported: spec.exported, namespace: spec.namespace });
    }
  }
}

/** Is a call to this name known to reach the database? */
function callIsAsync(a, node) {
  const callee = node.callee;

  if (callee.type === 'Identifier') {
    if (a.asyncFunctions.has(callee.name)) return true;
    const imported = a.resolvedImports.get(callee.name);
    if (imported && imported.exported) {
      const target = info.get(imported.file);
      const local = target.exports.get(imported.exported);
      if (local && target.asyncFunctions.has(local)) return true;
      if (target.asyncFunctions.has(imported.exported)) return true;
    }
    return false;
  }

  // ns.fn(...) where ns is a whole-module import
  if (callee.type === 'MemberExpression'
    && callee.object.type === 'Identifier'
    && callee.property.type === 'Identifier') {
    const imported = a.resolvedImports.get(callee.object.name);
    if (imported && imported.namespace) {
      const target = info.get(imported.file);
      const local = target.exports.get(callee.property.name);
      if (local && target.asyncFunctions.has(local)) return true;
      if (target.asyncFunctions.has(callee.property.name)) return true;
    }
  }

  return false;
}

// --- fixpoint --------------------------------------------------------------

let changed = true;
let rounds = 0;

while (changed && rounds < 50) {
  changed = false;
  rounds++;

  for (const a of info.values()) {
    walk.ancestor(a.ast, {
      CallExpression(node, _state, ancestors) {
        if (!isDatabaseCall(node, a.statements) && !callIsAsync(a, node)) return;

        const fn = enclosingFunction(ancestors);
        if (!fn) return; // module scope - reported separately
        if (a.asyncNodes.has(fn)) return;

        a.asyncNodes.add(fn);
        changed = true;

        const name = functionName(fn, ancestors);
        if (name) a.asyncFunctions.add(name);
      },
    });
  }
}

// --- rewrite ---------------------------------------------------------------

const report = { topLevel: [], higherOrder: [], files: 0, awaits: 0, asyncs: 0 };

for (const a of info.values()) {
  const s = new MagicString(a.code);
  let touched = false;

  // `async` on every function that needs it.
  for (const fn of a.asyncNodes) {
    if (fn.async) continue;
    s.appendLeft(fn.start, 'async ');
    report.asyncs++;
    touched = true;
  }

  // `await` on every call that needs it.
  walk.ancestor(a.ast, {
    CallExpression(node, _state, ancestors) {
      const needs = isDatabaseCall(node, a.statements) || callIsAsync(a, node);
      if (!needs) return;

      const parent = ancestors[ancestors.length - 2];
      if (parent && parent.type === 'AwaitExpression') return; // already awaited

      const fn = enclosingFunction(ancestors);
      if (!fn) {
        report.topLevel.push({
          file: path.relative(ROOT, a.file),
          line: node.loc.start.line,
          text: a.code.slice(node.start, Math.min(node.end, node.start + 70)).replace(/\s+/g, ' '),
        });
        return;
      }

      s.appendLeft(node.start, 'await ');
      report.awaits++;
      touched = true;
    },
  });

  // Report async callbacks handed to synchronous array methods.
  walk.ancestor(a.ast, {
    CallExpression(node, _state, ancestors) {
      if (node.callee.type !== 'MemberExpression') return;
      if (!SYNC_HIGHER_ORDER.has(node.callee.property.name)) return;
      for (const arg of node.arguments) {
        if (!FUNCTION_TYPES.has(arg.type)) continue;
        if (!a.asyncNodes.has(arg) && !arg.async) continue;
        report.higherOrder.push({
          file: path.relative(ROOT, a.file),
          line: node.loc.start.line,
          method: node.callee.property.name,
          text: a.code.slice(node.start, Math.min(node.end, node.start + 90)).replace(/\s+/g, ' '),
        });
      }
    },
  });

  if (touched) {
    report.files++;
    if (!DRY) fs.writeFileSync(a.file, s.toString());
  }
}

// --- output ----------------------------------------------------------------

console.log(`${DRY ? 'DRY RUN — ' : ''}fixpoint reached in ${rounds} round(s)`);
console.log(`  files changed : ${report.files}`);
console.log(`  await added   : ${report.awaits}`);
console.log(`  async added   : ${report.asyncs}`);

if (report.topLevel.length) {
  console.log(`\n  ${report.topLevel.length} DATABASE CALL(S) AT MODULE SCOPE — cannot be awaited in CommonJS,`);
  console.log('  these need restructuring by hand (lazy init, or move into a function):');
  for (const t of report.topLevel) console.log(`    ${t.file}:${t.line}  ${t.text}`);
}

if (report.higherOrder.length) {
  console.log(`\n  ${report.higherOrder.length} ASYNC CALLBACK(S) IN SYNCHRONOUS ARRAY METHODS — each is a`);
  console.log('  real bug if left as is (.filter keeps everything, .map yields promises):');
  for (const h of report.higherOrder) {
    console.log(`    ${h.file}:${h.line}  .${h.method}(...)  ${h.text}`);
  }
}

if (!report.topLevel.length && !report.higherOrder.length) {
  console.log('\n  nothing flagged for manual review.');
}
