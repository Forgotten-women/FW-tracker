#!/usr/bin/env node
// CI test gate.
//
// Runs the whole suite and fails only on a test that fails and is NOT listed in
// test/known-failures.txt. The list holds tests that were already failing when
// CI was introduced (2026-10-01), so the pipeline can block new regressions
// from day one instead of being permanently red. A listed test that now passes
// is reported so it can be taken off the list.
//
// Usage: node scripts/ci-test.js   (from backend/; needs the test Postgres)

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const known = new Set(
  fs.readFileSync(path.join(root, 'test', 'known-failures.txt'), 'utf8')
    .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')),
);

const files = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.js')).map(f => path.join('test', f));
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: root, env: process.env });

let tap = '';
child.stdout.on('data', d => { tap += d; process.stdout.write(d); });
child.stderr.on('data', d => process.stderr.write(d));

child.on('close', () => {
  // Top-level results only ("not ok 12 - name"); subtests are indented.
  const passed = new Set();
  const failed = new Set();
  for (const line of tap.split(/\r?\n/)) {
    const m = /^(not ok|ok) \d+ - (.+?)(?: # .*)?$/.exec(line);
    if (!m) continue;
    (m[1] === 'ok' ? passed : failed).add(m[2].trim());
  }

  const unexpected = [...failed].filter(n => !known.has(n));
  const knownStillFailing = [...failed].filter(n => known.has(n));
  const fixed = [...known].filter(n => passed.has(n));

  console.log('\n================ CI test gate ================');
  console.log(`passed: ${passed.size}   failed: ${failed.size}   known failures still failing: ${knownStillFailing.length}`);
  if (fixed.length) {
    console.log('\nNow passing (remove from test/known-failures.txt):');
    for (const n of fixed) console.log(`  + ${n}`);
  }
  if (!passed.size && !failed.size) {
    console.log('\nNo test results were reported - treating as a failure.');
    process.exit(1);
  }
  if (unexpected.length) {
    console.log('\nNEW failures (not in test/known-failures.txt):');
    for (const n of unexpected) console.log(`  x ${n}`);
    process.exit(1);
  }
  console.log('\nNo new failures.');
  process.exit(0);
});
