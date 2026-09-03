// Office Tracker - Desktop Mini-App UI Logic (Cross-Platform Windows & macOS)
// Works seamlessly both inside Tauri GUI and in standalone App Mode!

const isTauri = typeof window !== 'undefined' && !!window.__TAURI__;
const tauriInvoke = isTauri && window.__TAURI__.tauri ? window.__TAURI__.tauri.invoke : null;
const tauriWindow = isTauri && window.__TAURI__.window ? window.__TAURI__.window.appWindow : null;

// Universal backend invoker (Tauri IPC or Local Agent HTTP Server)
async function callBackend(command, args = {}) {
  if (isTauri && tauriInvoke) {
    return tauriInvoke(command, args);
  }

  // Fallback to local agent server
  if (command === 'get_app_status') {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  if (command === 'enroll_device') {
    const res = await fetch('/api/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    if (!res.ok || data.status === 'ERROR') {
      throw new Error(data.message || 'Enrollment failed. Please check the code with HR.');
    }
    return data;
  }

  if (command === 'toggle_manual_break') {
    const res = await fetch('/api/break', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  return {};
}

const enrollSection = document.getElementById('enroll-section');
const statusSection = document.getElementById('status-section');
const employeeBadge = document.getElementById('employee-badge');
const enrollBtn = document.getElementById('enroll-btn');
const enrollError = document.getElementById('enroll-error');
const serverUrlInput = document.getElementById('server-url-input');
const enrollCodeInput = document.getElementById('enroll-code-input');
const closeBtn = document.getElementById('close-btn');
const breakToggleBtn = document.getElementById('break-toggle-btn');
const activeTimer = document.getElementById('active-timer');
const statBreak = document.getElementById('stat-break');
const statIdle = document.getElementById('stat-idle');
const statusBanner = document.getElementById('status-banner');
const statusText = document.getElementById('status-text');
const networkText = document.getElementById('network-text');

let currentActiveSecs = 0;
let timerInterval = null;

function formatHMS(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

async function refreshStatus() {
  try {
    const data = await callBackend('get_app_status');
    if (data.enrolled) {
      enrollSection.classList.add('hidden');
      statusSection.classList.remove('hidden');
      employeeBadge.textContent = `${data.employeeName || 'Staff'} (${data.employeeRole || 'Member'})`;

      if (data.latest && data.latest.today) {
        currentActiveSecs = data.latest.today.activeSeconds || 0;
        statBreak.textContent = `${Math.round((data.latest.today.breakSeconds || 0) / 60)}m`;
        statIdle.textContent = `${Math.round((data.latest.today.idleSeconds || 0) / 60)}m`;
        
        if (data.isManualBreak) {
          statusBanner.className = 'status-banner away';
          statusText.textContent = '☕ On Manual Break';
          breakToggleBtn.textContent = '▶ Resume Work';
        } else if (data.latest.workstationStatus === 'AWAY') {
          statusBanner.className = 'status-banner away';
          statusText.textContent = '🔒 Screen Locked (Away)';
          breakToggleBtn.textContent = '☕ Take Break';
        } else if (data.latest.workstationStatus === 'IDLE') {
          statusBanner.className = 'status-banner away';
          statusText.textContent = '⏳ Idle Inactivity';
          breakToggleBtn.textContent = '☕ Take Break';
        } else {
          statusBanner.className = 'status-banner';
          statusText.textContent = data.latest.inOffice ? '🟢 Active · In Office' : '🔵 Active · Outside Office';
          breakToggleBtn.textContent = '☕ Take Break';
        }

        networkText.textContent = data.latest.inOffice ? 'Connected to Office Wi-Fi' : 'Outside Office Network';
      }
      activeTimer.textContent = formatHMS(currentActiveSecs);
    } else {
      enrollSection.classList.remove('hidden');
      statusSection.classList.add('hidden');
      employeeBadge.textContent = 'Not Enrolled';
    }
  } catch (err) {
    console.error('refreshStatus error:', err);
  }
}

// Tick timer locally every second when actively working
clearInterval(timerInterval);
timerInterval = setInterval(() => {
  if (statusBanner && !statusBanner.classList.contains('away') && !statusBanner.classList.contains('offline')) {
    currentActiveSecs++;
    if (activeTimer) {
      activeTimer.textContent = formatHMS(currentActiveSecs);
    }
  }
}, 1000);

if (enrollCodeInput) {
  // Auto uppercase formatting
  enrollCodeInput.addEventListener('input', () => {
    enrollCodeInput.value = enrollCodeInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  });
}

if (enrollBtn) {
  enrollBtn.addEventListener('click', async () => {
    const url = serverUrlInput.value.trim();
    const code = enrollCodeInput.value.trim();
    if (!url || !code) {
      enrollError.textContent = 'Please enter both Server URL and Enrollment Code.';
      enrollError.style.color = '#f87171';
      return;
    }
    
    enrollBtn.disabled = true;
    enrollBtn.textContent = 'Pairing Laptop…';
    enrollError.textContent = '';

    try {
      await callBackend('enroll_device', { serverUrl: url, code });
      enrollError.style.color = '#34d399';
      enrollError.textContent = '✓ Successfully paired! Launching session…';
      setTimeout(() => {
        refreshStatus();
      }, 1000);
    } catch (e) {
      enrollError.style.color = '#f87171';
      enrollError.textContent = e.message || 'Enrollment failed. Invalid or expired code.';
    } finally {
      enrollBtn.disabled = false;
      enrollBtn.textContent = 'Pair This Laptop';
    }
  });
}

if (closeBtn) {
  closeBtn.addEventListener('click', () => {
    if (isTauri && tauriWindow) {
      tauriWindow.hide();
    } else {
      window.close();
    }
  });
}

if (breakToggleBtn) {
  breakToggleBtn.addEventListener('click', async () => {
    try {
      await callBackend('toggle_manual_break');
      refreshStatus();
    } catch (err) {
      console.error('Break toggle failed:', err);
    }
  });
}

// Listen for Tauri events if running under Tauri
if (isTauri && window.__TAURI__.event) {
  window.__TAURI__.event.listen('heartbeat-updated', () => {
    refreshStatus();
  });
}

refreshStatus();
setInterval(refreshStatus, 10000);
