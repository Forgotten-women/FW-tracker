// Tauri Desktop Agent UI Logic
const { invoke } = window.__TAURI__ ? window.__TAURI__.tauri : { invoke: async () => ({}) };
const { listen } = window.__TAURI__ ? window.__TAURI__.event : { listen: () => {} };
const { appWindow } = window.__TAURI__ ? window.__TAURI__.window : { appWindow: { hide: () => {} } };

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
    const data = await invoke('get_app_status');
    if (data.enrolled) {
      enrollSection.classList.add('hidden');
      statusSection.classList.remove('hidden');
      employeeBadge.textContent = `${data.employeeName} (${data.employeeRole})`;

      if (data.latest && data.latest.today) {
        currentActiveSecs = data.latest.today.activeSeconds || 0;
        statBreak.textContent = `${Math.round((data.latest.today.breakSeconds || 0) / 60)}m`;
        statIdle.textContent = `${Math.round((data.latest.today.idleSeconds || 0) / 60)}m`;
        
        if (data.isManualBreak) {
          statusBanner.className = 'status-banner away';
          statusText.textContent = 'On Manual Break';
          breakToggleBtn.textContent = '▶ Resume Work';
        } else if (data.latest.workstationStatus === 'AWAY') {
          statusBanner.className = 'status-banner away';
          statusText.textContent = 'Screen Locked (Away)';
          breakToggleBtn.textContent = '☕ Take Break';
        } else if (data.latest.workstationStatus === 'IDLE') {
          statusBanner.className = 'status-banner away';
          statusText.textContent = 'Idle (> 5m inactivity)';
          breakToggleBtn.textContent = '☕ Take Break';
        } else {
          statusBanner.className = 'status-banner';
          statusText.textContent = data.latest.inOffice ? 'Active · In Office' : 'Active · Outside Office';
          breakToggleBtn.textContent = '☕ Take Break';
        }

        networkText.textContent = data.latest.inOffice ? 'Connected to Office Wi-Fi' : 'Not on Office Wi-Fi';
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

// Tick active timer locally every second when active
clearInterval(timerInterval);
timerInterval = setInterval(() => {
  if (statusBanner && !statusBanner.classList.contains('away') && !statusBanner.classList.contains('offline')) {
    currentActiveSecs++;
    if (activeTimer) {
      activeTimer.textContent = formatHMS(currentActiveSecs);
    }
  }
}, 1000);

if (enrollBtn) {
  enrollBtn.addEventListener('click', async () => {
    const url = serverUrlInput.value.trim();
    const code = enrollCodeInput.value.trim();
    if (!url || !code) {
      enrollError.textContent = 'Please enter both Server URL and Enrollment Code.';
      return;
    }
    enrollError.textContent = 'Enrolling laptop...';
    try {
      await invoke('enroll_device', { serverUrl: url, code });
      enrollError.textContent = '';
      refreshStatus();
    } catch (e) {
      enrollError.textContent = String(e);
    }
  });
}

if (closeBtn) {
  closeBtn.addEventListener('click', () => {
    if (appWindow) appWindow.hide();
  });
}

if (breakToggleBtn) {
  breakToggleBtn.addEventListener('click', async () => {
    await invoke('toggle_manual_break');
    refreshStatus();
  });
}

if (listen) {
  listen('heartbeat-updated', () => {
    refreshStatus();
  });
}

refreshStatus();
setInterval(refreshStatus, 15000);
