// Office Tracker - Desktop Workstation Companion (Node/Native Runner)
//
// Cross-platform desktop agent runner that monitors idle time, screen lock state
// (with 5-minute grace period), office Wi-Fi BSSID, and unapproved process anomalies.
// Communicates with backend /api/desktop/heartbeat and /api/desktop/anomaly.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn, exec } = require('child_process');
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

function ensureAutoStart() {
  try {
    if (process.platform === 'win32') {
      const vbsPath = path.join(__dirname, 'Start Office Tracker (Silent).vbs');
      const batPath = path.join(__dirname, 'Start Office Tracker (Windows).bat');
      const targetLauncher = fs.existsSync(vbsPath)
        ? `wscript.exe "${vbsPath}"`
        : (fs.existsSync(batPath) ? `"${batPath}"` : `node "${path.join(__dirname, 'run-agent.js')}"`);
      exec(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "OfficeTracker" /t REG_SZ /d "${targetLauncher.replace(/"/g, '\\"')}" /f`, { windowsHide: true }, () => {});
    } else if (process.platform === 'darwin') {
      const home = os.homedir();
      const agentsDir = path.join(home, 'Library', 'LaunchAgents');
      if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });
      const plistPath = path.join(agentsDir, 'com.officetracker.desktop.plist');
      const scriptPath = path.join(__dirname, 'Start Office Tracker (Mac).command');
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.officetracker.desktop</string>
    <key>ProgramArguments</key>
    <array>
        <string>${fs.existsSync(scriptPath) ? scriptPath : '/usr/local/bin/node'}</string>
        ${fs.existsSync(scriptPath) ? '' : `<string>${path.join(__dirname, 'run-agent.js')}</string>`}
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>`;
      fs.writeFileSync(plistPath, plist);
    }
  } catch (_) {}
}

function captureScreenBase64() {
  if (process.platform === 'win32') {
    try {
      const scriptPath = path.join(__dirname, 'capture-screen.ps1');
      if (fs.existsSync(scriptPath)) {
        const out = execSync(`powershell -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`, { timeout: 3000, windowsHide: true }).toString().trim();
        if (out && (out.startsWith('/9j/') || out.startsWith('iVBOR')) && out.length > 200) {
          return out;
        }
      }
    } catch (_) {}
  } else if (process.platform === 'darwin') {
    try {
      const tmpFile = path.join(os.tmpdir(), `ot_stream_${process.pid}.jpg`);
      execSync(`/usr/sbin/screencapture -x -t jpg "${tmpFile}" 2>/dev/null`, { timeout: 2500 });
      if (fs.existsSync(tmpFile)) {
        const buf = fs.readFileSync(tmpFile);
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        const out = buf.toString('base64');
        if (out && (out.startsWith('/9j/') || out.startsWith('iVBOR')) && out.length > 200) {
          return out;
        }
      }
    } catch (_) {}
  }
  return null;
}

function getIdleSeconds() {
  if (process.platform === 'win32') {
    try {
      const scriptPath = path.join(__dirname, 'get-idle.ps1');
      const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { timeout: 3000, windowsHide: true }).toString().trim();
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
      const out = execSync('netsh wlan show interfaces', { timeout: 2500, windowsHide: true }).toString();
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

function getConnectedSsid() {
  if (process.platform === 'win32') {
    try {
      const out = execSync('netsh wlan show interfaces', { timeout: 2500, windowsHide: true }).toString();
      for (const line of out.split('\n')) {
        const m = /^\s*SSID\s*:\s*(.+)$/i.exec(line.trim());
        if (m) return m[1].trim();
      }
    } catch (_) {}
  }
  return null;
}

const KNOWN_OFFICE_BSSIDS = new Set([
  'ba:9f:cc:db:52:58',
  'ba:9f:cc:db:52:5e',
  'ba:9f:cc:db:52:5c',
  'ba:9f:cc:db:52:5d',
]);

const KNOWN_OFFICE_SSIDS = new Set([
  'trans k 2.4g',
  'trans k 5g',
  'naya k 5g',
  'naya 5g',
  'naya 2.4g',
  'naya k 2.4g',
  'huawei-2.4g-2jwu',
]);

function isOfficeSsid(s) {
  if (!s) return false;
  const lower = s.toLowerCase().trim();
  if (KNOWN_OFFICE_SSIDS.has(lower)) return true;
  if (lower.startsWith('trans k') || lower.startsWith('naya')) return true;
  return false;
}

const OFFICE_PROFILE_CANDIDATES = [
  'Trans K 2.4G',
  'Trans K 5G',
  'Naya K 5G',
  'Naya 5G',
  'Naya 2.4G',
];

function getVisibleOfficeBssids() {
  const visible = [];
  if (process.platform === 'win32') {
    try {
      const out = execSync('netsh wlan show networks mode=bssid', { timeout: 3500, windowsHide: true }).toString();
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        const m = MAC_ON_BSSID_LINE.exec(trimmed);
        if (m) {
          visible.push({ bssid: m[1].toLowerCase(), signal: 50 });
          continue;
        }
        const sigMatch = /signal\s*:\s*(\d+)%/i.exec(trimmed);
        if (sigMatch && visible.length > 0) {
          visible[visible.length - 1].signal = parseInt(sigMatch[1], 10) || 50;
        }
      }
    } catch (_) {}
  } else if (process.platform === 'darwin') {
    try {
      const airport = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';
      const out = execSync(`"${airport}" -s 2>/dev/null`, { timeout: 3000 }).toString();
      for (const line of out.split('\n')) {
        const m = MAC_ON_BSSID_LINE.exec(line.trim());
        if (m) visible.push({ bssid: m[1].toLowerCase(), signal: 60 });
      }
    } catch (_) {}
  }
  return visible;
}

let lastAutoConnectAttempt = 0;
function autoConnectOfficeWifi() {
  const now = Date.now();
  if (now - lastAutoConnectAttempt < 30000) return;
  lastAutoConnectAttempt = now;

  if (process.platform === 'win32') {
    let idx = 0;
    function tryNext() {
      if (idx >= OFFICE_PROFILE_CANDIDATES.length) return;
      const profile = OFFICE_PROFILE_CANDIDATES[idx++];
      exec(`netsh wlan connect name="${profile}"`, { windowsHide: true }, (err) => {
        if (!err) {
          console.log(`[Office Tracker Desktop] Auto-connected to office Wi-Fi ("${profile}").`);
        } else {
          tryNext();
        }
      });
    }
    tryNext();
  }
}

let lastAlertAt = 0;
function alertOutOfOffice() {
  const now = Date.now();
  if (now - lastAlertAt < 300000) return; // Alert at most once every 5 minutes
  lastAlertAt = now;

  console.warn('\n⚠️ [Office Tracker] ATTENDANCE PAUSED: You are not connected to Office Wi-Fi.');
  console.warn('   Please connect to Trans K 2.4G, Trans K 5G, Naya 2.4G, or Naya 5G to record attendance.\n');
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

let lastUrlCheck = 0;
let cachedBrowserUrl = null;
let lastBrowserProc = '';

function getBrowserUrl(procName) {
  const now = Date.now();
  if (procName === lastBrowserProc && (now - lastUrlCheck < 3000)) {
    return cachedBrowserUrl;
  }
  lastUrlCheck = now;
  lastBrowserProc = procName;

  if (process.platform === 'win32') {
    try {
      const scriptPath = path.join(__dirname, 'get-browser-url.ps1');
      if (fs.existsSync(scriptPath)) {
        const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { timeout: 2500, windowsHide: true }).toString().trim();
        if (out) {
          cachedBrowserUrl = out;
          return out;
        }
      }
    } catch (_) {}
  } else if (process.platform === 'darwin') {
    try {
      const p = (procName || '').toLowerCase();
      let appleScript = '';
      if (p.includes('chrome')) {
        appleScript = 'tell application "Google Chrome" to return URL of active tab of front window';
      } else if (p.includes('edge')) {
        appleScript = 'tell application "Microsoft Edge" to return URL of active tab of front window';
      } else if (p.includes('safari')) {
        appleScript = 'tell application "Safari" to return URL of front document';
      } else if (p.includes('brave')) {
        appleScript = 'tell application "Brave Browser" to return URL of active tab of front window';
      }
      if (appleScript) {
        const out = execSync(`osascript -e '${appleScript}' 2>/dev/null`, { timeout: 2000 }).toString().trim();
        if (out) {
          cachedBrowserUrl = out;
          return out;
        }
      }
    } catch (_) {}
  }
  cachedBrowserUrl = null;
  return null;
}

function extractDomain(rawUrl) {
  if (!rawUrl) return null;
  try {
    let toParse = rawUrl.trim();
    if (!toParse.startsWith('http://') && !toParse.startsWith('https://')) {
      toParse = 'https://' + toParse;
    }
    const parsed = new URL(toParse);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    if (host && host.includes('.')) return host;
  } catch (_) {}

  const match = /([a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)/.exec(rawUrl);
  return match ? match[1].toLowerCase().replace(/^www\./, '') : null;
}

function parseActiveApplication(procName, title) {
  const p = (procName || '').toLowerCase().replace(/\.exe$/, '');
  const t = (title || '').trim();

  // 1. Browsers: Direct address bar URL inspection (UIA / AppleScript) + title fallback
  const isBrowser = ['chrome', 'msedge', 'edge', 'firefox', 'brave', 'opera', 'safari'].includes(p);
  if (isBrowser) {
    const b = p === 'chrome' ? 'Chrome' : p.includes('edge') ? 'Edge' : p === 'firefox' ? 'Firefox' : 'Browser';

    // Native Address Bar Domain Extraction (handles ALL sites, internal portals & unknown domains)
    const rawUrl = getBrowserUrl(procName);
    const domain = extractDomain(rawUrl);
    if (domain && domain !== 'newtab' && domain !== 'extensions' && domain !== 'settings') {
      return `${domain} (${b})`;
    }

    if (t) {
      const lower = t.toLowerCase();
      if (lower.includes('youtube')) return `youtube.com (${b})`;
      if (lower.includes('figma')) return `figma.com (${b})`;
      if (lower.includes('github')) return `github.com (${b})`;
      if (lower.includes('gitlab')) return `gitlab.com (${b})`;
      if (lower.includes('jira') || lower.includes('atlassian')) return `atlassian.net (${b})`;
      if (lower.includes('chatgpt') || lower.includes('openai')) return `chatgpt.com (${b})`;
      if (lower.includes('claude')) return `claude.ai (${b})`;
      if (lower.includes('google meet') || lower.includes('meet.google')) return `meet.google.com (${b})`;
      if (lower.includes('google docs')) return `docs.google.com (${b})`;
      if (lower.includes('google sheets')) return `sheets.google.com (${b})`;
      if (lower.includes('google slides')) return `slides.google.com (${b})`;
      if (lower.includes('google drive')) return `drive.google.com (${b})`;
      if (lower.includes('notion')) return `notion.so (${b})`;
      if (lower.includes('canva')) return `canva.com (${b})`;
      if (lower.includes('stack overflow')) return `stackoverflow.com (${b})`;
      if (lower.includes('linkedin')) return `linkedin.com (${b})`;
      if (lower.includes('whatsapp')) return `web.whatsapp.com (${b})`;
      if (lower.includes('netflix')) return `netflix.com (${b})`;
      if (lower.includes('reddit')) return `reddit.com (${b})`;
      if (lower.includes('twitter') || lower.includes('x.com')) return `x.com (${b})`;
      if (lower.includes('facebook')) return `facebook.com (${b})`;
      if (lower.includes('instagram')) return `instagram.com (${b})`;

      // Extract general website name from title if available
      const parts = t.split(' - ');
      if (parts.length >= 2) {
        const site = parts[parts.length - 2].trim();
        if (site && site.length < 28 && !site.toLowerCase().includes('google') && !site.toLowerCase().includes('microsoft')) {
          const cleanSite = site.toLowerCase().replace(/\s+/g, '');
          return `${cleanSite.includes('.') ? cleanSite : site} (${b})`;
        }
      }
      return `Web Browsing (${b})`;
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
      const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { timeout: 3000, windowsHide: true }).toString().trim();
      const parsed = JSON.parse(out);
      return parseActiveApplication(parsed.process, parsed.title);
    } catch (_) {
      try {
        const cmd = `powershell -NoProfile -Command "(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).ProcessName"`;
        const out = execSync(cmd, { timeout: 2500, windowsHide: true }).toString().trim();
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

const MINI_APP_PORT = 48712;
let miniAppServer = null;
const initCfg = loadConfig();
const initialTodayStr = new Date().toISOString().slice(0, 10);
let todayLiveStats = {
  activeSeconds: (initCfg && initCfg.cachedDateKey === initialTodayStr && initCfg.cachedActiveSeconds > 0) ? initCfg.cachedActiveSeconds : 0,
  breakSeconds: 0,
  idleSeconds: 0,
  dateKey: initialTodayStr,
};
let currentWorkstationStatus = 'ACTIVE';
let isManualBreak = false;
let isOnBreak = false;
let latestContinuousIdle = 0;
let appTrackingEnabled = true;
let outsideWorkingHours = false;
let isOverlayOpen = false;
let lastDismissedAt = 0;
// The authoritative break start time, set wherever a break actually begins
// (onSecondSample's auto-conversion or the /api/break handler) and returned
// to the overlay so its UI reflects the real backdate instead of a guess.
let lastBreakStartedAtMs = null;

function isWithinOfficeHours(date = new Date()) {
  const day = date.getDay(); // 0 = Sunday, 1 = Monday, ..., 5 = Friday, 6 = Saturday
  if (day === 0 || day === 6) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  const startMinutes = 11 * 60; // 11:00 AM
  const endMinutes = 19 * 60;   // 7:00 PM (19:00)
  return minutes >= startMinutes && minutes < endMinutes;
}

function launchBrowserApp(url, isFullscreen = false) {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  if (isWin) {
    const candidates = [
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['LocalAppData'] || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env['LocalAppData'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];

    for (const exe of candidates) {
      if (fs.existsSync(exe)) {
        const tempProfile = path.join(os.tmpdir(), isFullscreen ? 'ot_overlay_profile' : 'ot_mini_profile');
        const flags = isFullscreen
          ? `"${exe}" --user-data-dir="${tempProfile}" --app="${url}" --start-fullscreen --no-first-run --no-default-browser-check`
          : `"${exe}" --user-data-dir="${tempProfile}" --app="${url}" --window-size=380,640 --no-first-run --no-default-browser-check`;
        const proc = exec(flags, (err) => {
          if (err) console.warn('[desktop/ui] Browser process note:', err.message);
        });
        return proc;
      }
    }
    // Fallback: PowerShell Start-Process
    return exec(`powershell -NoProfile -Command "Start-Process '${url}'"`);
  } else if (isMac) {
    const cmd = isFullscreen
      ? `open -a "Google Chrome" --args --app="${url}" --start-fullscreen || open "${url}"`
      : `open -a "Google Chrome" --args --app="${url}" --window-size=380,640 || open "${url}"`;
    return exec(cmd);
  } else {
    return exec(`xdg-open "${url}"`);
  }
}

function launchMiniAppWindow(port = MINI_APP_PORT) {
  const url = `http://127.0.0.1:${port}`;
  launchBrowserApp(url, false);
}

function launchIdleOverlayWindow(port = MINI_APP_PORT) {
  if (isOverlayOpen) return;
  isOverlayOpen = true;
  console.log(`[${new Date().toLocaleTimeString()}] ⏳ Workstation idle for 5 mins - Launching Full-Screen Focus Prompt...`);
  const url = `http://127.0.0.1:${port}/overlay`;
  const proc = launchBrowserApp(url, true);
  if (proc && typeof proc.on === 'function') {
    proc.on('exit', () => {
      isOverlayOpen = false;
    });
  }
}

function startMiniAppServer(port = MINI_APP_PORT) {
  if (miniAppServer) return miniAppServer;

  miniAppServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const parsedUrl = new URL(req.url, `http://127.0.0.1:${port}`);

    // GET /api/status
    if (parsedUrl.pathname === '/api/status' && req.method === 'GET') {
      const cfgNow = loadConfig();
      const bssid = getConnectedBssid();
      const ssid = getConnectedSsid();
      const visibleOfficeBssids = getVisibleOfficeBssids();
      const isOfficeConnected = (bssid && KNOWN_OFFICE_BSSIDS.has(bssid)) || isOfficeSsid(ssid);
      const isOfficeVisible = visibleOfficeBssids.some(v => KNOWN_OFFICE_BSSIDS.has(v.bssid));

      const onBreakNow = isManualBreak || isOnBreak;
      const withinHours = isWithinOfficeHours();
      outsideWorkingHours = !withinHours;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        enrolled: !!(cfgNow && cfgNow.token),
        employeeName: cfgNow ? cfgNow.employeeName : null,
        employeeRole: cfgNow ? cfgNow.employeeRole : null,
        isManualBreak: onBreakNow,
        appTrackingEnabled,
        outsideWorkingHours,
        latest: {
          workstationStatus: onBreakNow ? 'ON_BREAK' : (outsideWorkingHours ? 'STANDBY' : currentWorkstationStatus),
          inOffice: isOfficeConnected || isOfficeVisible,
          isOfficeConnected,
          isOfficeVisible,
          connectedBssid: bssid,
          connectedSsid: ssid,
          visibleOfficeBssids,
          today: todayLiveStats,
        }
      }));
    }

    // POST /api/connect-office-wifi
    if (parsedUrl.pathname === '/api/connect-office-wifi' && req.method === 'POST') {
      autoConnectOfficeWifi();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'SUCCESS', message: 'Attempting connection to Trans K 2.4G' }));
    }

    // POST /api/enroll
    if (parsedUrl.pathname === '/api/enroll' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { serverUrl, code } = JSON.parse(body || '{}');
          if (!code || !String(code).trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'ERROR', message: 'Enrollment code is required.' }));
          }

          const cleanUrl = (serverUrl || 'https://backend-ten-lyart-57.vercel.app').trim().replace(/\/+$/, '');
          const enrollRes = await fetch(`${cleanUrl}/api/enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: code.trim().toUpperCase(),
              platform: process.platform,
              model: `${os.type()} ${os.release()}`,
              label: `${os.hostname()} (Work Laptop)`,
            }),
          });

          const data = await enrollRes.json();
          if (enrollRes.status !== 201 || data.status !== 'SUCCESS') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              status: 'ERROR',
              message: data.message || 'Invalid or expired enrollment code.',
            }));
          }

          const newCfg = {
            serverUrl: cleanUrl,
            token: data.token,
            deviceId: data.deviceId,
            employeeName: data.employee.name,
            employeeRole: data.employee.role,
          };
          saveConfig(newCfg);

          if (currentEnrollResolve) {
            currentEnrollResolve(newCfg);
            currentEnrollResolve = null;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            status: 'SUCCESS',
            message: 'Device enrolled successfully.',
            employeeName: newCfg.employeeName,
            employeeRole: newCfg.employeeRole,
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'ERROR', message: err.message }));
        }
      });
      return;
    }

    // POST /api/break
    if (parsedUrl.pathname === '/api/break' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          let reqData = {};
          try { reqData = JSON.parse(body); } catch (_) {}
          const targetBreak = typeof reqData.onBreak === 'boolean' ? reqData.onBreak : !isManualBreak;
          const isAutoIdleConversion = reqData.reason === 'AUTO_IDLE_CONVERSION';

          // The overlay's own grace-period timer used to send this with a
          // hardcoded 5-minute backdate, independent of onSecondSample's own
          // AUTO_BREAK_SECONDS trigger (see the comment there) -- the two
          // could disagree on startedAt for the same idle episode. If this
          // is an auto-idle-conversion request and onSecondSample already
          // converted the break (the common case, since it fires as soon as
          // idle crosses the threshold), this is a stale duplicate: report
          // the already-applied state back without sending a second,
          // differently-backdated break-start to the server.
          if (isAutoIdleConversion && targetBreak && (isManualBreak || isOnBreak)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'SUCCESS', isManualBreak, startedAt: lastBreakStartedAtMs }));
          }

          isManualBreak = targetBreak;
          isOnBreak = targetBreak;
          currentWorkstationStatus = targetBreak ? 'ON_BREAK' : 'ACTIVE';

          // For an auto-idle-conversion, always derive startedAt from this
          // process's own continuously-tracked idle duration rather than
          // trusting a client-supplied guess, so however this got triggered
          // the backdate is the same accurate value onSecondSample would
          // have used.
          const startedAt = isAutoIdleConversion
            ? Date.now() - (latestContinuousIdle * 1000)
            : (reqData.startedAt || undefined);
          lastBreakStartedAtMs = targetBreak ? (startedAt || Date.now()) : null;

          const cfgNow = loadConfig();
          if (cfgNow && cfgNow.token && cfgNow.serverUrl) {
            try {
              await fetch(`${cfgNow.serverUrl}/api/desktop/break`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${cfgNow.token}`,
                },
                body: JSON.stringify({
                  onBreak: targetBreak,
                  reason: reqData.reason || (targetBreak ? 'Employee manual break' : 'Employee resumed work'),
                  startedAt,
                }),
              });
            } catch (err) {
              console.warn('[desktop] Failed to sync break to server:', err.message);
            }
          }

          if (latestHeartbeatResponse && latestHeartbeatResponse.today) {
            latestHeartbeatResponse.today.onBreak = isManualBreak;
            if (!isManualBreak) {
              latestHeartbeatResponse.today.breakAlreadyTaken = true;
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'SUCCESS', isManualBreak, startedAt: lastBreakStartedAtMs }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'ERROR', message: err.message }));
        }
      });
      return;
    }

    // POST /api/dismiss-overlay
    if (parsedUrl.pathname === '/api/dismiss-overlay' && req.method === 'POST') {
      isOverlayOpen = false;
      lastDismissedAt = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'SUCCESS', message: 'Overlay dismissed' }));
    }

    // POST /api/checkout
    if (parsedUrl.pathname === '/api/checkout' && req.method === 'POST') {
      currentWorkstationStatus = 'CHECKED_OUT';
      const cfgNow = loadConfig();
      if (cfgNow && cfgNow.token && cfgNow.serverUrl) {
        try {
          await fetch(`${cfgNow.serverUrl}/api/desktop/checkout`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${cfgNow.token}`,
            },
          });
        } catch (_) {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'SUCCESS', message: 'Shift checked out.' }));
    }

    // Static Assets & Overlay Route
    const cleanPath = parsedUrl.pathname === '/' ? 'index.html' : (parsedUrl.pathname === '/overlay' ? 'overlay.html' : parsedUrl.pathname.replace(/^\/+/, ''));
    const localFile = path.join(__dirname, 'src', cleanPath);
    let contentType = 'text/html';
    if (cleanPath.endsWith('.css')) contentType = 'text/css';
    if (cleanPath.endsWith('.js')) contentType = 'application/javascript';
    if (cleanPath.endsWith('.png')) contentType = 'image/png';
    if (cleanPath.endsWith('.json')) contentType = 'application/json';

    try {
      if (fs.existsSync(localFile) && fs.statSync(localFile).isFile()) {
        res.writeHead(200, { 'Content-Type': contentType });
        return res.end(fs.readFileSync(localFile));
      }
    } catch (_) {}

    // Fallback to index.html
    const indexFallback = path.join(__dirname, 'src', 'index.html');
    if (fs.existsSync(indexFallback)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(indexFallback));
    }

    res.writeHead(404);
    res.end('Not found');
  });

  miniAppServer.listen(port, '127.0.0.1', () => {
    // listening
  });

  return miniAppServer;
}

async function promptEnrollmentCli() {
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
        code: code.trim().toUpperCase(),
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
  startMiniAppServer(MINI_APP_PORT);

  let cfg = loadConfig();
  if (!cfg || !cfg.token) {
    if (process.argv.includes('--cli')) {
      cfg = await promptEnrollmentCli();
    } else {
      console.log('\n=============================================');
      console.log('  Office Tracker - Desktop Workstation Agent');
      console.log('=============================================');
      console.log(`\n[Office Tracker] Not enrolled. Launching Registration Mini-App on your desktop...`);
      launchMiniAppWindow(MINI_APP_PORT);
      cfg = await new Promise((resolve) => {
        currentEnrollResolve = resolve;
      });
      console.log(`\n✅ Device paired as: ${cfg.employeeName} (${cfg.employeeRole})`);
    }
  } else {
    console.log(`\n[Office Tracker Desktop] Logged in as: ${cfg.employeeName} (${cfg.employeeRole})`);
    console.log(`[Office Tracker Desktop] Server: ${cfg.serverUrl}`);
    if (process.argv.includes('--gui') || process.argv.includes('--app')) {
      launchMiniAppWindow(MINI_APP_PORT);
    }
  }

  let accumulatedActive = 0;
  let accumulatedIdle = 0;
  let appBreakdown = {};
  let secondsElapsed = 0;
  let currentApp = 'Desktop Active';
  let isSyncing = false;

  console.log('[Office Tracker Desktop] High-Precision 1-Second Monitoring Active (Heartbeat sync every 60s)...');
  ensureAutoStart();

  let liveStreamActive = false;
  let isSendingFrame = false;
  let persistentStreamProc = null;

  function getPersistentStreamProc() {
    if (persistentStreamProc && !persistentStreamProc.killed) return persistentStreamProc;
    const scriptPath = path.join(__dirname, 'capture-screen.ps1');
    if (fs.existsSync(scriptPath)) {
      persistentStreamProc = spawn('powershell.exe', [
        '-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath, '-Loop'
      ], { windowsHide: true });
      persistentStreamProc.rl = readline.createInterface({ input: persistentStreamProc.stdout });
      persistentStreamProc.on('exit', () => { persistentStreamProc = null; });
    }
    return persistentStreamProc;
  }

  function killPersistentStreamProc() {
    if (persistentStreamProc && !persistentStreamProc.killed) {
      try {
        persistentStreamProc.stdin.write('QUIT\n');
        persistentStreamProc.kill();
      } catch (_) {}
      persistentStreamProc = null;
    }
  }

  async function captureScreenBase64Fast() {
    if (process.platform === 'win32') {
      const proc = getPersistentStreamProc();
      if (proc && proc.rl) {
        return new Promise((resolve) => {
          let timeout = setTimeout(() => { resolve(null); }, 1500);
          const onLine = (line) => {
            clearTimeout(timeout);
            const trimmed = (line || '').trim();
            if ((trimmed.startsWith('/9j/') || trimmed.startsWith('iVBOR')) && trimmed.length > 200) {
              resolve(trimmed);
            } else {
              resolve(null);
            }
          };
          proc.rl.once('line', onLine);
          try {
            proc.stdin.write('CAPTURE\n');
          } catch (_) {
            clearTimeout(timeout);
            resolve(null);
          }
        });
      }
    }
    return captureScreenBase64();
  }

  async function pollStreamStatus() {
    const cfgNow = loadConfig();
    if (!cfgNow || !cfgNow.token || !cfgNow.serverUrl) return;

    try {
      const resp = await fetch(`${cfgNow.serverUrl}/api/desktop/stream-status`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${cfgNow.token}`,
          'X-Device-Id': cfgNow.deviceId || '',
        },
      });
      if (resp.ok) {
        const data = await resp.json();
        const wasStreaming = liveStreamActive;
        liveStreamActive = Boolean(data.liveStreamRequested && data.isPermitted);
        if (wasStreaming && !liveStreamActive) {
          killPersistentStreamProc();
        }
        if (data.onBreak != null) {
          isOnBreak = Boolean(data.onBreak);
        }
      }
    } catch (_) {}
  }

  // Fast polling check for stream requests (every 1.5 seconds)
  setInterval(() => {
    void pollStreamStatus();
  }, 1500);

  // Live screen frame capture loop (~250ms interval when active, sub-second real-time streaming)
  setInterval(async () => {
    if (!liveStreamActive || isSendingFrame) return;
    const onBreakNow = isManualBreak || isOnBreak;
    const withinHours = isWithinOfficeHours();
    if (onBreakNow || !withinHours) {
      killPersistentStreamProc();
      return;
    }

    const cfgNow = loadConfig();
    if (!cfgNow || !cfgNow.token || !cfgNow.serverUrl) return;

    isSendingFrame = true;
    try {
      const frameBase64 = await captureScreenBase64Fast();
      if (frameBase64) {
        await fetch(`${cfgNow.serverUrl}/api/desktop/stream-frame`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfgNow.token}`,
            'X-Device-Id': cfgNow.deviceId || '',
          },
          body: JSON.stringify({ frameBase64 }),
        });
      }
    } catch (_) {
    } finally {
      isSendingFrame = false;
    }
  }, 250);

  let lastPeriodicShotTime = 0;
  let screenshotPolicy = { enabled: false, intervalMinutes: 5, mode: 'ACTIVE_ONLY' };

  // Periodic Screenshot Capturing Loop
  setInterval(async () => {
    if (!screenshotPolicy.enabled) return;
    if (!isWithinOfficeHours()) return;
    if (isManualBreak || isOnBreak) return;

    const intervalMs = (screenshotPolicy.intervalMinutes || 5) * 60 * 1000;
    const now = Date.now();
    if (now - lastPeriodicShotTime < intervalMs) return;

    const idle = getIdleSeconds();
    const isLocked = getLockState().isLocked;

    if (screenshotPolicy.mode === 'ACTIVE_ONLY' && (isLocked || idle >= 300)) {
      return;
    }

    const cfgNow = loadConfig();
    if (!cfgNow || !cfgNow.token || !cfgNow.serverUrl) return;

    const captureStatus = (isLocked || idle >= 300) ? 'IDLE' : 'ACTIVE';
    try {
      const frameBase64 = await captureScreenBase64Fast();
      if (frameBase64) {
        lastPeriodicShotTime = now;
        await fetch(`${cfgNow.serverUrl}/api/desktop/screenshot`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfgNow.token}`,
            'X-Device-Id': cfgNow.deviceId || '',
          },
          body: JSON.stringify({
            frameBase64,
            activeApp: currentApp,
            captureStatus,
          }),
        });
      }
    } catch (err) {
      console.warn('[desktop] Periodic screenshot upload failed:', err.message);
    }
  }, 10000);

  async function syncLocalQueue() {
    if (isSyncing) return;
    if (!isWithinOfficeHours()) {
      // Outside office hours (Mon-Fri 11:00 AM - 7:00 PM):
      // Zero updates sent to backend outside office timings.
      return;
    }

    isSyncing = true;
    try {
      if (!localDb) return;
      const unsynced = localDb.prepare('SELECT * FROM local_events WHERE synced_at IS NULL ORDER BY created_at ASC LIMIT 50').all();
      if (!unsynced || unsynced.length === 0) return;

      if (unsynced.length > 1) {
        // Multi-event offline buffer: flush in high-efficiency atomic batch to /api/desktop/sync-batch
        try {
          const eventsPayload = unsynced.map(ev => {
            const p = JSON.parse(ev.payload);
            return {
              ...p,
              eventId: ev.event_id,
              createdAt: ev.created_at,
              observedAt: p.observedAt || ev.created_at,
            };
          });

          const res = await fetch(`${cfg.serverUrl}/api/desktop/sync-batch`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${cfg.token}`,
            },
            body: JSON.stringify({ events: eventsPayload }),
          });

          if (res.ok) {
            const data = await res.json();
            const syncedIds = new Set(data.syncedEventIds || []);
            const now = Date.now();
            const updateStmt = localDb.prepare('UPDATE local_events SET synced_at = ? WHERE event_id = ?');
            for (const ev of unsynced) {
              if (syncedIds.has(ev.event_id)) {
                updateStmt.run(now, ev.event_id);
              }
            }
            if (data.today) {
              todayLiveStats = data.today;
              if (data.today.onBreak !== undefined) {
                isOnBreak = Boolean(data.today.onBreak);
              }
            }
            if (data.appTrackingEnabled !== undefined) appTrackingEnabled = Boolean(data.appTrackingEnabled);
            if (data.outsideWorkingHours !== undefined) outsideWorkingHours = Boolean(data.outsideWorkingHours);
            console.log(`[${new Date().toLocaleTimeString()}] Batch synced ${syncedIds.size} offline heartbeats to cloud successfully.`);
          } else if (res.status === 401) {
            console.error('[Office Tracker Desktop] Token expired or revoked. Re-enroll required.');
            try { fs.unlinkSync(CONFIG_FILE); } catch (_) {}
            process.exit(1);
          } else {
            const incStmt = localDb.prepare('UPDATE local_events SET retry_count = retry_count + 1 WHERE event_id = ?');
            for (const ev of unsynced) {
              incStmt.run(ev.event_id);
            }
          }
        } catch (err) {
          console.warn(`[${new Date().toLocaleTimeString()}] Batch sync paused: ${err.message}`);
        }
      } else {
        // Single real-time heartbeat via /api/desktop/heartbeat
        const ev = unsynced[0];
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
            if (data.today) {
              todayLiveStats = data.today;
              if (data.today.onBreak !== undefined) {
                isOnBreak = Boolean(data.today.onBreak);
              }
              if (cfg && data.today.activeSeconds) {
                cfg.cachedActiveSeconds = data.today.activeSeconds;
                cfg.cachedDateKey = data.today.dateKey || initialTodayStr;
                saveConfig(cfg);
              }
            }
            if (data.workstationStatus) currentWorkstationStatus = data.workstationStatus;
            if (data.appTrackingEnabled !== undefined) appTrackingEnabled = Boolean(data.appTrackingEnabled);
            if (data.outsideWorkingHours !== undefined) outsideWorkingHours = Boolean(data.outsideWorkingHours);
            if (data.policy?.screenshotPolicy) screenshotPolicy = data.policy.screenshotPolicy;

            localDb.prepare('UPDATE local_events SET synced_at = ? WHERE event_id = ?').run(Date.now(), ev.event_id);

            const activeMins = Math.round((data.today?.activeSeconds || 0) / 60);
            const statusIcon = data.inOffice ? '🟢 [IN OFFICE]' : '🟡 [REMOTE / OUTSIDE]';
            const hoursNote = data.outsideWorkingHours ? ' | 🌙 [STANDBY: Outside Working Hours]' : '';
            const privacyNote = !appTrackingEnabled ? ' | 🔒 [BYOD: App Tracking OFF]' : '';
            console.log(`[${new Date().toLocaleTimeString()}] Heartbeat synced (${ev.event_id.slice(0, 8)}) | ${statusIcon} Status: ${data.workstationStatus}${hoursNote}${privacyNote} | App: ${payload.currentApp} | Today: ${activeMins}m active`);
          } else if (res.status === 401) {
            console.error('[Office Tracker Desktop] Token expired or revoked. Re-enroll required.');
            try { fs.unlinkSync(CONFIG_FILE); } catch (_) {}
            process.exit(1);
          } else {
            localDb.prepare('UPDATE local_events SET retry_count = retry_count + 1 WHERE event_id = ?').run(ev.event_id);
          }
        } catch (err) {
          localDb.prepare('UPDATE local_events SET retry_count = retry_count + 1 WHERE event_id = ?').run(ev.event_id);
          console.warn(`[${new Date().toLocaleTimeString()}] Sync paused for ${ev.event_id.slice(0, 8)}: ${err.message}`);
        }
      }

      // Cleanup synced events older than 24 hours
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      localDb.prepare('DELETE FROM local_events WHERE synced_at IS NOT NULL AND synced_at < ?').run(oneDayAgo);
    } finally {
      isSyncing = false;
    }
  }

  // latestContinuousIdle is declared once, at module scope, specifically so
  // the /api/break handler in startMiniAppServer can read the same
  // continuously-updated value this function writes (see the comment there
  // and in the AUTO_BREAK_SECONDS block below). A second `let` here used to
  // shadow it, silently splitting them into two unrelated variables: this
  // one ticked every second, the module-level one never moved off its
  // initial 0 -- so anything outside this function that read
  // latestContinuousIdle always saw "not idle" regardless of reality.

  function onSecondSample(idleSecs, procName, title) {
    const withinHours = isWithinOfficeHours();
    outsideWorkingHours = !withinHours;

    if (!withinHours) {
      // Outside office hours (Mon-Fri 11:00 AM - 7:00 PM):
      // Pause all app monitoring and accumulation; zero updates sent to backend
      currentApp = 'Outside Office Hours';
      appBreakdown = {};
      secondsElapsed = 0;
      accumulatedActive = 0;
      accumulatedIdle = 0;
      return;
    }

    secondsElapsed++;
    latestContinuousIdle = Math.max(0, parseInt(idleSecs, 10) || 0);

    const onBreakNow = isManualBreak || isOnBreak;

    if (onBreakNow) {
      // On break:
      // PAUSE app monitoring (what employee is using during their break period)
      // Privacy protection: do NOT inspect or record processes/window titles
      currentApp = 'On Break';
      appBreakdown = {};
      accumulatedIdle++;
    } else {
      // If there has been no physical input for at least 60 seconds,
      // this 1-second interval counts as idle rather than active typing/clicking
      const isIdle = latestContinuousIdle >= 60;
      if (isIdle) {
        accumulatedIdle++;
      } else {
        accumulatedActive++;
        // If HR disabled app tracking for personal laptop (BYOD privacy), do NOT inspect window title or process
        if (appTrackingEnabled) {
          const app = parseActiveApplication(procName, title);
          currentApp = app;
          appBreakdown[app] = (appBreakdown[app] || 0) + 1;
        } else {
          currentApp = 'Active Workstation';
          appBreakdown = {};
        }
      }

      // Idle Focus Overlay & Auto-Break Conversion
      const IDLE_PROMPT_SECONDS = 300; // 5 minutes
      const GRACE_SECONDS = 60; // 60 seconds grace window
      const AUTO_BREAK_SECONDS = IDLE_PROMPT_SECONDS + GRACE_SECONDS; // 360 seconds (6 minutes total)

      // 1. Trigger Full-screen Inactivity Prompt at 5 minutes idle
      if (latestContinuousIdle >= IDLE_PROMPT_SECONDS && latestContinuousIdle < AUTO_BREAK_SECONDS) {
        if (!isOverlayOpen && (Date.now() - lastDismissedAt) > 60000) {
          launchIdleOverlayWindow(MINI_APP_PORT);
        }
      }

      // 2. Continuous Idle > 6 minutes (5m + 60s grace) -> Auto-convert to Break retroactively (5m backdated)
      //
      // This is the single authoritative place that decides an idle episode
      // has become a break: it is the only code with an accurate,
      // continuously-updated idle duration (latestContinuousIdle). The
      // overlay window's own grace countdown (overlay.html) used to make
      // this same decision independently on its own local 60s timer, which
      // raced this one -- both could fire, each with a different guessed
      // startedAt, for the same idle episode. The overlay's countdown now
      // only reflects state; it defers the actual conversion (and the
      // startedAt backdate) to this block via the isManualBreak/isOnBreak
      // guard below and the /api/break handler's own recomputation.
      // Guarding on the current break state also stops this from refiring
      // every single second for as long as the user stays idle.
      if (latestContinuousIdle >= AUTO_BREAK_SECONDS && !isManualBreak && !isOnBreak) {
        const retroactiveStartMs = Date.now() - (latestContinuousIdle * 1000);
        isManualBreak = true;
        isOnBreak = true;
        currentWorkstationStatus = 'ON_BREAK';
        lastBreakStartedAtMs = retroactiveStartMs;

        const cfgNow = loadConfig();
        if (cfgNow && cfgNow.token && cfgNow.serverUrl) {
          fetch(`${cfgNow.serverUrl}/api/desktop/break`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${cfgNow.token}`,
            },
            body: JSON.stringify({
              onBreak: true,
              reason: 'AUTO_IDLE_CONVERSION',
              startedAt: retroactiveStartMs,
            }),
          }).catch((err) => console.warn('[desktop/auto-break] Sync note:', err.message));
        }

        if (!isOverlayOpen) {
          launchIdleOverlayWindow(MINI_APP_PORT);
        }
      }
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
      const ssid = getConnectedSsid();
      const visibleOfficeBssids = getVisibleOfficeBssids();
      const localIp = getLocalIp();

      const isOfficeConnected = (bssid && KNOWN_OFFICE_BSSIDS.has(bssid)) || isOfficeSsid(ssid);
      const isOfficeVisible = visibleOfficeBssids.some(v => KNOWN_OFFICE_BSSIDS.has(v.bssid));

      // Auto-connect to office Wi-Fi if available in the air
      if (!isOfficeConnected && isOfficeVisible) {
        autoConnectOfficeWifi();
      }

      // Proactively alert employee if working while completely off office network
      if (!isOfficeConnected && !isOfficeVisible && sendActive > 30 && !onBreakNow) {
        alertOutOfOffice();
      }

      const eventId = 'evt_' + crypto.randomUUID();
      const payload = {
        eventId,
        activeSeconds: sendActive,
        idleSeconds: sendIdle,
        currentIdleSeconds: latestContinuousIdle,
        currentApp,
        appBreakdown: (appTrackingEnabled && !onBreakNow) ? sendBreakdown : {},
        lockState: 'UNLOCKED',
        lockDurationSeconds: 0,
        connectedBssid: bssid,
        connectedSsid: ssid,
        ssid,
        visibleOfficeBssids,
        localIp,
        isManualBreak: onBreakNow,
        observedAt: Date.now(),
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
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', streamScript], { windowsHide: true });

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
