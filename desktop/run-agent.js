// Office Tracker - Desktop Workstation Companion (Node/Native Runner)
//
// Cross-platform desktop agent runner that monitors idle time, screen lock state
// (with 5-minute grace period), office Wi-Fi BSSID, and unapproved process anomalies.
// Communicates with backend /api/desktop/heartbeat and /api/desktop/anomaly.

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const readline = require('readline');

let localDb = null;
try {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (_) {
    Database = require(path.join(__dirname, '..', 'backend', 'node_modules', 'better-sqlite3'));
  }
  if (Database) {
    localDb = new Database(path.join(__dirname, 'agent_offline.db'));
    localDb.pragma('journal_mode = WAL');
    localDb.exec(`
      CREATE TABLE IF NOT EXISTS local_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        synced_at INTEGER,
        retry_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_local_events_synced ON local_events (synced_at);
    `);
    console.log('[Office Tracker Desktop] SQLite local storage active (WAL mode enabled).');
  }
} catch (e) {
  console.warn('[Office Tracker Desktop] Local SQLite storage fallback notice:', e.message);
}

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (process.env.BACKEND_URL) {
        cfg.serverUrl = process.env.BACKEND_URL.replace(/\/+$/, '');
      } else if (!cfg.serverUrl || cfg.serverUrl.includes('127.0.0.1') || cfg.serverUrl.includes('localhost') || cfg.serverUrl.includes('192.168.')) {
        cfg.serverUrl = 'https://backend-ten-lyart-57.vercel.app';
        saveConfig(cfg);
      }
      return cfg;
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
  } else if (process.platform === 'darwin') {
    try {
      const scriptPath = path.join(__dirname, 'get-idle.sh');
      if (fs.existsSync(scriptPath)) {
        const out = execSync(`bash "${scriptPath}"`, { timeout: 2500 }).toString().trim();
        return parseInt(out, 10) || 0;
      }
      const out = execSync("ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'", { timeout: 2500 }).toString().trim();
      return parseInt(out, 10) || 0;
    } catch (_) {
      return 0;
    }
  }
  return 0;
}

// Matches the MAC on the BSSID line of `netsh wlan show interfaces`, whatever
// the label around it. Windows 10 prints "BSSID : <mac>"; Windows 11 prints
// "AP BSSID : <mac>". Matching on the label meant Windows 11 reported no access
// point at all, which the server reads as "not on office Wi-Fi" - so every
// laptop on Windows 11 was silently recorded as remote.
const MAC_ON_BSSID_LINE = /bssid[^:]*:\s*((?:[0-9a-f]{2}:){5}[0-9a-f]{2})/i;

function getConnectedBssid() {
  if (process.platform === 'win32') {
    try {
      const out = execSync('netsh wlan show interfaces', { timeout: 2500 }).toString();
      for (const line of out.split('\n')) {
        const m = MAC_ON_BSSID_LINE.exec(line.trim());
        if (m) return m[1].toLowerCase();
      }
    } catch (_) {}
  } else if (process.platform === 'darwin') {
    try {
      const airport = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';
      const out = execSync(`"${airport}" -I 2>/dev/null`, { timeout: 2500 }).toString();
      for (const line of out.split('\n')) {
        const m = MAC_ON_BSSID_LINE.exec(line.trim());
        if (m) return m[1].toLowerCase();
      }
    } catch (_) {}
  }
  return null;
}

// Virtual adapters installed by WSL, Hyper-V, Docker and the VM tools. They
// hold private addresses of their own, so taking "the first private address"
// picked one of these (172.17.x / 172.25.x on a developer machine) instead of
// the Wi-Fi address - again reported as off-network.
const VIRTUAL_ADAPTER = /vethernet|virtual|vmware|virtualbox|hyper-?v|wsl|docker|loopback|bluetooth|tailscale|zerotier|tap-|tun-/i;

function isPrivateIpv4(address) {
  const parts = address.split('.');
  if (parts[0] === '10') return true;
  if (parts[0] === '172' && Number(parts[1]) >= 16 && Number(parts[1]) <= 31) return true;
  return parts[0] === '192' && parts[1] === '168';
}

/**
 * The private IPv4 address of a REAL network adapter.
 *
 * The server compares this against the configured office subnets, so picking
 * the wrong adapter is not cosmetic - it decides whether the day counts as
 * office attendance.
 */
function getLocalIp() {
  try {
    const ifaces = os.networkInterfaces();
    const candidates = [];
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        if (iface.family !== 'IPv4' || iface.internal) continue;
        if (!isPrivateIpv4(iface.address)) continue;
        candidates.push({ name, address: iface.address, virtual: VIRTUAL_ADAPTER.test(name) });
      }
    }
    // Physical adapters first; a virtual one is only a last resort, so a machine
    // with no real connection still reports something rather than null.
    const physical = candidates.find(c => !c.virtual);
    return (physical || candidates[0] || {}).address || null;
  } catch (_) {}
  return null;
}

function parseActiveApplication(procName, title) {
  const p = (procName || '').toLowerCase().replace(/\.exe$/, '');
  const t = (title || '').trim();

  // 1. Browsers: Parse specific website / web application from window title
  const isBrowser = ['chrome', 'msedge', 'edge', 'firefox', 'brave', 'opera', 'safari'].includes(p);
  if (isBrowser && t) {
    const lower = t.toLowerCase();
    const b = p === 'chrome' ? 'Chrome' : p.includes('edge') ? 'Edge' : p === 'firefox' ? 'Firefox' : 'Browser';

    if (lower.includes('youtube')) return `YouTube (${b})`;
    if (lower.includes('figma')) return `Figma (${b})`;
    if (lower.includes('github')) return `GitHub (${b})`;
    if (lower.includes('gitlab')) return `GitLab (${b})`;
    if (lower.includes('jira') || lower.includes('atlassian')) return `Jira (${b})`;
    if (lower.includes('chatgpt') || lower.includes('openai')) return `ChatGPT (${b})`;
    if (lower.includes('claude')) return `Claude AI (${b})`;
    if (lower.includes('google meet') || lower.includes('meet.google')) return `Google Meet (${b})`;
    if (lower.includes('google docs')) return `Google Docs (${b})`;
    if (lower.includes('google sheets')) return `Google Sheets (${b})`;
    if (lower.includes('google slides')) return `Google Slides (${b})`;
    if (lower.includes('google drive')) return `Google Drive (${b})`;
    if (lower.includes('notion')) return `Notion (${b})`;
    if (lower.includes('canva')) return `Canva (${b})`;
    if (lower.includes('stack overflow')) return `Stack Overflow (${b})`;
    if (lower.includes('linkedin')) return `LinkedIn (${b})`;
    if (lower.includes('whatsapp')) return `WhatsApp Web (${b})`;
    if (lower.includes('netflix')) return `Netflix (${b})`;
    if (lower.includes('reddit')) return `Reddit (${b})`;
    if (lower.includes('twitter') || lower.includes('x.com')) return `X / Twitter (${b})`;
    if (lower.includes('facebook')) return `Facebook (${b})`;
    if (lower.includes('instagram')) return `Instagram (${b})`;

    // General web site name
    const parts = t.split(' - ');
    if (parts.length >= 2) {
      const site = parts[parts.length - 2].trim();
      if (site && site.length < 28 && !site.toLowerCase().includes('google') && !site.toLowerCase().includes('microsoft')) {
        return `${site} (${b})`;
      }
    }
    return `Web Browsing (${b})`;
  }

  // 2. Desktop Application Names
  const APP_NAMES = {
    'antigravity ide': 'Antigravity IDE',
    'code': 'VS Code',
    'cursor': 'Cursor Editor',
    'webstorm64': 'WebStorm',
    'idea64': 'IntelliJ IDEA',
    'pycharm64': 'PyCharm',
    'slack': 'Slack',
    'teams': 'Microsoft Teams',
    'ms-teams': 'Microsoft Teams',
    'zoom': 'Zoom Meetings',
    'excel': 'Microsoft Excel',
    'winword': 'Microsoft Word',
    'powerpnt': 'Microsoft PowerPoint',
    'outlook': 'Microsoft Outlook',
    'onenote': 'OneNote',
    'notepad': 'Notepad',
    'notepad++': 'Notepad++',
    'spotify': 'Spotify',
    'discord': 'Discord',
    'postman': 'Postman',
    'dbeaver': 'DBeaver',
    'terminal': 'Windows Terminal',
    'powershell': 'PowerShell',
    'cmd': 'Command Prompt',
    'explorer': 'File Explorer',
  };

  if (APP_NAMES[p]) return APP_NAMES[p];
  if (p && p !== 'unknown') return `${p.charAt(0).toUpperCase() + p.slice(1)}`;
  return 'Desktop Active';
}

function getActiveWindowInfo() {
  if (process.platform === 'win32') {
    try {
      const scriptPath = path.join(__dirname, 'get-window.ps1');
      const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { timeout: 3000 }).toString().trim();
      const parsed = JSON.parse(out);
      return parseActiveApplication(parsed.process, parsed.title);
    } catch (_) {
      try {
        const cmd = `powershell -NoProfile -Command "(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).ProcessName"`;
        const out = execSync(cmd, { timeout: 2500 }).toString().trim();
        return parseActiveApplication(out, '');
      } catch (_) {}
    }
  } else if (process.platform === 'darwin') {
    try {
      const scriptPath = path.join(__dirname, 'get-window.sh');
      if (fs.existsSync(scriptPath)) {
        const out = execSync(`bash "${scriptPath}"`, { timeout: 3000 }).toString().trim();
        const parsed = JSON.parse(out);
        return parseActiveApplication(parsed.process, parsed.title);
      }
      const appleScript = 'tell application "System Events" to get name of first application process whose frontmost is true';
      const proc = execSync(`osascript -e '${appleScript}' 2>/dev/null`, { timeout: 2000 }).toString().trim();
      return parseActiveApplication(proc, '');
    } catch (_) {
      return 'Desktop Active';
    }
  }
  return 'Desktop Active';
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
  let isManualBreak = false;
  let appBreakdown = {};
  let secondsElapsed = 0;
  let currentApp = 'Desktop Active';
  let isSyncing = false;

  console.log('[Office Tracker Desktop] High-Precision 1-Second Monitoring Active (Heartbeat sync every 60s)...');

  async function syncLocalQueue() {
    if (isSyncing) return;
    isSyncing = true;
    try {
      let events = [];
      if (localDb) {
        events = localDb.prepare('SELECT * FROM local_events WHERE synced_at IS NULL ORDER BY created_at ASC LIMIT 10').all();
      }

      for (const ev of events) {
        try {
          const payload = JSON.parse(ev.payload);
          const res = await fetch(`${cfg.serverUrl}/api/desktop/heartbeat`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${cfg.token}`,
            },
            body: JSON.stringify(payload),
          });

          if (res.ok) {
            const data = await res.json();
            if (localDb) {
              localDb.prepare('UPDATE local_events SET synced_at = ? WHERE event_id = ?').run(Date.now(), ev.event_id);
            }
            const activeMins = Math.round((data.today?.activeSeconds || 0) / 60);
            const statusIcon = data.inOffice ? '🟢 [IN OFFICE]' : '🟡 [REMOTE / OUTSIDE]';
            console.log(`[${new Date().toLocaleTimeString()}] Heartbeat synced (${ev.event_id.slice(0, 8)}) | ${statusIcon} Status: ${data.workstationStatus} | App: ${payload.currentApp} | Today: ${activeMins}m active`);
          } else if (res.status === 401) {
            console.error('[Office Tracker Desktop] Token expired or revoked. Re-enroll required.');
            try { fs.unlinkSync(CONFIG_FILE); } catch (_) {}
            process.exit(1);
          } else {
            if (localDb) {
              localDb.prepare('UPDATE local_events SET retry_count = retry_count + 1 WHERE event_id = ?').run(ev.event_id);
            }
          }
        } catch (err) {
          if (localDb) {
            localDb.prepare('UPDATE local_events SET retry_count = retry_count + 1 WHERE event_id = ?').run(ev.event_id);
          }
          console.warn(`[${new Date().toLocaleTimeString()}] Sync paused for ${ev.event_id.slice(0, 8)}: ${err.message}`);
          break; // Stop batch on connection drop
        }
      }

      // Cleanup synced events older than 24 hours
      if (localDb) {
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        localDb.prepare('DELETE FROM local_events WHERE synced_at IS NOT NULL AND synced_at < ?').run(oneDayAgo);
      }
    } finally {
      isSyncing = false;
    }
  }

  let latestContinuousIdle = 0;

  function onSecondSample(idleSecs, procName, title) {
    secondsElapsed++;
    latestContinuousIdle = Math.max(0, parseInt(idleSecs, 10) || 0);

    // If there has been no physical input for at least 60 seconds (or manual break),
    // this 1-second interval counts as idle rather than active typing/clicking
    const isIdle = isManualBreak || latestContinuousIdle >= 60;
    if (isIdle) {
      accumulatedIdle++;
    } else {
      accumulatedActive++;
      const app = parseActiveApplication(procName, title);
      currentApp = app;
      appBreakdown[app] = (appBreakdown[app] || 0) + 1;
    }

    if (secondsElapsed >= 60) {
      secondsElapsed = 0;
      const sendActive = accumulatedActive;
      const sendIdle = accumulatedIdle;
      const sendBreakdown = { ...appBreakdown };
      accumulatedActive = 0;
      accumulatedIdle = 0;
      appBreakdown = {};

      const bssid = getConnectedBssid();
      const localIp = getLocalIp();
      const eventId = 'evt_' + crypto.randomUUID();
      const payload = {
        eventId,
        activeSeconds: sendActive,
        idleSeconds: sendIdle,
        currentIdleSeconds: latestContinuousIdle,
        currentApp,
        appBreakdown: sendBreakdown,
        lockState: 'UNLOCKED',
        lockDurationSeconds: 0,
        connectedBssid: bssid,
        localIp,
        isManualBreak,
      };

      if (localDb) {
        localDb.prepare(`
          INSERT INTO local_events (event_id, event_type, payload, created_at)
          VALUES (?, 'HEARTBEAT', ?, ?)
        `).run(eventId, JSON.stringify(payload), Date.now());
      }

      void syncLocalQueue();
    }
  }

  if (process.platform === 'win32') {
    const streamScript = path.join(__dirname, 'stream-monitor.ps1');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', streamScript]);

    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const sample = JSON.parse(trimmed);
          onSecondSample(sample.idle || 0, sample.process || '', sample.title || '');
        } catch (_) {}
      }
    });

    child.stderr.on('data', () => {});

    child.on('exit', () => {
      console.warn('[Office Tracker Desktop] Stream monitor exited, restarting in 3s...');
      setTimeout(startAgent, 3000);
    });
  } else {
    setInterval(() => {
      const idleSecs = getIdleSeconds();
      const app = getActiveWindowInfo();
      onSecondSample(idleSecs, app, '');
    }, 1000);
  }

  // Periodic flush for offline/queued events
  setInterval(() => {
    void syncLocalQueue();
  }, 20000);
}

startAgent();
