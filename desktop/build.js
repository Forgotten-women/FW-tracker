const { execSync } = require('child_process');

console.log('\n=============================================');
console.log('  Office Tracker - Desktop Agent Builder');
console.log('=============================================\n');

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
} else {
  console.log('ℹ Rust & Cargo compiler is not installed on this machine.');
  console.log('Building standalone zero-dependency executable via pkg...\n');

  const target = process.platform === 'win32'
    ? 'node18-win-x64'
    : process.platform === 'darwin'
      ? 'node18-macos-x64,node18-macos-arm64'
      : 'node18-linux-x64';

  const output = process.platform === 'win32' ? 'office-tracker-agent.exe' : 'office-tracker-agent';

  console.log(`Packaging target: ${target} -> ${output}`);
  try {
    execSync(`npx -y @yao-pkg/pkg run-agent.js --targets ${target} --output ${output}`, { stdio: 'inherit' });
    console.log(`\n✅ Standalone executable created: ${output}`);
    console.log('You can transfer this single file to any PC/Mac. Double click to run — NO Node.js required!');
  } catch (err) {
    console.error('Standalone packaging notice:', err.message);
  }
}
