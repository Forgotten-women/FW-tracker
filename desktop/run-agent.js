// Office Tracker - Desktop Workstation Companion (Node/Native Runner)
//
// Cross-platform desktop agent runner that monitors idle time, screen lock state
// (with 5-minute grace period), office Wi-Fi BSSID, and unapproved process anomalies.
// Communicates with backend /api/desktop/heartbeat and /api/desktop/anomaly.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const readline = require('readline');

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save config:', err.message);
  }
}

function getIdleSeconds() {
  if (process.platform === 'win32') {
    try {
      const scriptPath = path.join(__dirname, 'get-idle.ps1');
      const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { timeout: 3000 }).toString().trim();
      return parseInt(out, 10) || 0;
    } catch (_) {
      return 0;
    }
  }
  return 0;
}

function getConnectedBssid() {
  if (process.platform === 'win32') {
    try {
      const out = execSync('netsh wlan show interfaces', { timeout: 2500 }).toString();
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('BSSID')) {
          const parts = trimmed.split(':');
          if (parts.length >= 2) {
            return parts.slice(1).join(':').trim().toLowerCase();
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

function getForegroundProcess() {
  if (process.platform === 'win32') {
    try {
      const cmd = `powershell -NoProfile -Command "(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).ProcessName"`;
      const out = execSync(cmd, { timeout: 2500 }).toString().trim();
      return out ? `${out.toLowerCase()}.exe` : 'unknown.exe';
    } catch (_) {}
  }
  return 'unknown.exe';
}

async function promptEnrollment() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));

  console.log('\n=============================================');
  console.log('  Office Tracker - Desktop Workstation Agent');
  console.log('=============================================\n');

  const defaultUrl = 'https://backend-ten-lyart-57.vercel.app';
  let serverUrl = await ask(`Enter Backend Server URL [${defaultUrl}]: `);
  serverUrl = (serverUrl.trim() || defaultUrl).replace(/\/+$/, '');

  const code = await ask('Enter 8-Character Enrollment Code from HR: ');
  rl.close();

  if (!code.trim()) {
    console.error('Enrollment code is required. Exiting.');
    process.exit(1);
  }

  console.log(`\nEnrolling laptop with ${serverUrl}...`);
  try {
    const res = await fetch(`${serverUrl}/api/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code.trim(),
        platform: process.platform,
        model: `${os.type()} ${os.release()}`,
        label: `${os.hostname()} (Work Laptop)`,
      }),
    });

    const data = await res.json();
    if (res.status !== 201 || data.status !== 'SUCCESS') {
      console.error('Enrollment failed:', data.message || JSON.stringify(data));
      process.exit(1);
    }

    const cfg = {
      serverUrl,
      token: data.token,
      deviceId: data.deviceId,
      employeeName: data.employee.name,
      employeeRole: data.employee.role,
    };
    saveConfig(cfg);
    console.log(`✅ Successfully enrolled as: ${cfg.employeeName} (${cfg.employeeRole})\n`);
    return cfg;
  } catch (err) {
    console.error('Network error during enrollment:', err.message);
    process.exit(1);
  }
}

async function startAgent() {
  let cfg = loadConfig();
  if (!cfg || !cfg.token) {
    cfg = await promptEnrollment();
  } else {
    console.log(`\n[Office Tracker Desktop] Logged in as: ${cfg.employeeName} (${cfg.employeeRole})`);
    console.log(`[Office Tracker Desktop] Server: ${cfg.serverUrl}`);
  }

  let accumulatedActive = 0;
  let accumulatedIdle = 0;
  let lockDuration = 0;
  let isManualBreak = false;
  let sampleCount = 0;
  let lastApprovedCsv = '';

  console.log('[Office Tracker Desktop] Active work monitoring running (Heartbeat every 60s)...');

  setInterval(async () => {
    sampleCount++;
    const idleSecs = getIdleSeconds();
    const bssid = getConnectedBssid();
    const isIdle = idleSecs >= 300; // 5 min idle threshold

    if (isManualBreak || isIdle) {
      accumulatedIdle += 10;
    } else {
      accumulatedActive += 10;
    }

    // Every 60 seconds, send heartbeat with active application tracking
    if (sampleCount >= 6) {
      sampleCount = 0;
      const sendActive = accumulatedActive;
      const sendIdle = accumulatedIdle;
      accumulatedActive = 0;
      accumulatedIdle = 0;
      const currentApp = getForegroundProcess();

      try {
        const res = await fetch(`${cfg.serverUrl}/api/desktop/heartbeat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.token}`,
          },
          body: JSON.stringify({
            activeSeconds: sendActive,
            idleSeconds: sendIdle,
            currentApp,
            lockState: 'UNLOCKED',
            lockDurationSeconds: 0,
            connectedBssid: bssid,
            isManualBreak,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const activeMins = Math.round((data.today?.activeSeconds || 0) / 60);
          const statusIcon = data.inOffice ? '🟢 [IN OFFICE]' : '🟡 [REMOTE / OUTSIDE]';
          console.log(`[${new Date().toLocaleTimeString()}] Heartbeat sent | ${statusIcon} Status: ${data.workstationStatus} | App: ${currentApp} | Today: ${activeMins}m active`);
        } else if (res.status === 401) {
          console.error('[Office Tracker Desktop] Token expired or revoked. Re-enroll required.');
          fs.unlinkSync(CONFIG_FILE);
          process.exit(1);
        }
      } catch (err) {
        console.warn(`[${new Date().toLocaleTimeString()}] Heartbeat upload failed (will retry): ${err.message}`);
      }
    }
  }, 10000);
}

startAgent();
