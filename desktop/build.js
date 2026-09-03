'use strict';
const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('\n=============================================');
console.log('  Office Tracker - Desktop Agent Builder');
console.log('=============================================\n');

// ── 1. Check for Rust / Cargo ────────────────────────────────────────────────
let hasCargo = false;
try {
  execSync('cargo --version', { stdio: 'ignore' });
  hasCargo = true;
} catch (_) {}

if (hasCargo) {
  console.log('✓ Rust & Cargo detected. Building Tauri native installer & tray app...');
  try {
    execSync('npx @tauri-apps/cli build', { stdio: 'inherit' });
    console.log('\n✅ Tauri build completed successfully!');
  } catch (e) {
    console.error('Tauri build exited with error:', e.message);
  }
  return;
}

// ── 2. No Rust – produce a standalone JS bundle (no native compile needed) ───
console.log('ℹ Rust & Cargo compiler is not installed on this machine.');
console.log('Building standalone distributable (bundled Node.js script)...\n');

// Use @vercel/ncc to bundle everything into a single dist/index.js
// ncc is pure-JS and needs no compiler, works on all platforms.
let nccAvailable = false;
try {
  execSync('npx -y @vercel/ncc --version', { stdio: 'ignore' });
  nccAvailable = true;
} catch (_) {}

const outDir  = path.join(__dirname, 'dist');
const outFile = path.join(outDir, 'office-tracker-agent.js');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

console.log('Bundling run-agent.js into dist/office-tracker-agent.js...');
try {
  execSync(`npx -y @vercel/ncc build run-agent.js --out ${outDir} --target es2020`, {
    stdio: 'inherit',
    cwd: __dirname,
  });
  // ncc outputs dist/index.js – rename to our preferred name
  const nccOut = path.join(outDir, 'index.js');
  if (fs.existsSync(nccOut) && nccOut !== outFile) {
    fs.renameSync(nccOut, outFile);
  }
  console.log('\n✅ Bundle created: dist/office-tracker-agent.js');
} catch (bundleErr) {
  console.warn('⚠  ncc bundling failed – falling back to plain copy...');
  // Fallback: just copy the source files so the user can run them with Node
  ['run-agent.js', 'package.json'].forEach(f => {
    const src = path.join(__dirname, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, f));
  });
  // Copy src/ assets
  const srcDir = path.join(__dirname, 'src');
  if (fs.existsSync(srcDir)) {
    const destSrc = path.join(outDir, 'src');
    if (!fs.existsSync(destSrc)) fs.mkdirSync(destSrc);
    fs.readdirSync(srcDir).forEach(f => {
      fs.copyFileSync(path.join(srcDir, f), path.join(destSrc, f));
    });
  }
  console.log('✅ Source files copied to dist/');
}

// ── 3. Write platform launchers into dist/ ───────────────────────────────────
const agentFile = fs.existsSync(outFile) ? 'office-tracker-agent.js' : 'run-agent.js';

// Windows .bat
fs.writeFileSync(
  path.join(outDir, 'Start Office Tracker (Windows).bat'),
  `@echo off\r\ntitle Office Tracker\r\ncd /d "%~dp0"\r\nnode ${agentFile}\r\npause\r\n`,
);

// Windows silent VBScript launcher (no black console window)
fs.writeFileSync(
  path.join(outDir, 'Start Office Tracker (Silent).vbs'),
  `Set WshShell = CreateObject("WScript.Shell")\r\n` +
  `WshShell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)\r\n` +
  `WshShell.Run "node ${agentFile}", 0, False\r\n`,
);

// macOS / Linux .command
const macLauncher = path.join(outDir, 'Start Office Tracker (Mac).command');
fs.writeFileSync(
  macLauncher,
  `#!/bin/bash\ncd "$(dirname "$0")"\nnode ${agentFile}\n`,
);
try { fs.chmodSync(macLauncher, 0o755); } catch (_) {}

console.log('\n📦 Distribution package ready in: dist/');
console.log('');
console.log('HOW TO DISTRIBUTE TO EMPLOYEES:');
console.log('  1. Copy the entire dist/ folder to the employee PC/Mac.');
console.log('     (Node.js must be installed on the target machine, or bundle it with NVM/Volta.)');
console.log('  2. Windows: Double-click  "Start Office Tracker (Windows).bat"');
console.log('     Windows (silent, no console): Double-click  "Start Office Tracker (Silent).vbs"');
console.log('  3. macOS: Right-click -> Open  "Start Office Tracker (Mac).command"');
console.log('');
console.log('  On first launch, a beautiful registration window will open automatically.');
console.log('  After pairing, the agent runs silently in the background.\n');
