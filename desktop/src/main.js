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
const wifiConnectBtn = document.getElementById('wifi-connect-btn');
const statusFeedback = document.getElementById('status-feedback');
let feedbackTimeout = null;

const breakCountdownWrap = document.getElementById('break-countdown-wrap');
const breakCountdownTimer = document.getElementById('break-countdown-timer');
const breakProgressBar = document.getElementById('break-progress-bar');
const breakCountdownFooter = document.getElementById('break-countdown-footer');
const breakPermittedPill = document.getElementById('break-permitted-pill');

let isOnBreakState = false;
let breakStartedAtMs = null;
let breakPermittedMins = 30;

function showFeedback(msg, isError = true) {
  if (!statusFeedback) return;
  clearTimeout(feedbackTimeout);
  statusFeedback.textContent = msg;
  statusFeedback.style.color = isError ? '#f87171' : '#34d399';
  statusFeedback.classList.remove('hidden');
  feedbackTimeout = setTimeout(() => {
    statusFeedback.classList.add('hidden');
  }, 4000);
}

if (wifiConnectBtn) {
  wifiConnectBtn.addEventListener('click', async () => {
    wifiConnectBtn.disabled = true;
    wifiConnectBtn.textContent = 'Connecting...';
    try {
      if (isTauri && tauriInvoke) {
        await tauriInvoke('connect_office_wifi');
      } else {
        await fetch('/api/connect-office-wifi', { method: 'POST' });
      }
      setTimeout(refreshStatus, 2000);
    } catch (_) {}
    setTimeout(() => {
      wifiConnectBtn.disabled = false;
      wifiConnectBtn.textContent = '📶 Connect to Trans K 2.4G';
    }, 4000);
  });
}

let currentActiveSecs = 0;
let lastSyncedServerSecs = -1;
let lastSyncedDateKey = '';
let timerInterval = null;
let lastLocalDay = new Date().toDateString();

function formatHMS(seconds) {
  const total = Math.max(0, parseInt(seconds, 10) || 0);
  const h = Math.floor(total / 3600).toString().padStart(2, '0');
  const m = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatMS(seconds) {
  const isNegative = seconds < 0;
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60).toString().padStart(2, '0');
  const s = (abs % 60).toString().padStart(2, '0');
  return isNegative ? `+${m}:${s}` : `${m}:${s}`;
}

function updateBreakCountdown() {
  if (!isOnBreakState || !breakStartedAtMs || !breakCountdownTimer) return;
  const elapsedSecs = Math.max(0, Math.floor((Date.now() - breakStartedAtMs) / 1000));
  const totalPermittedSecs = breakPermittedMins * 60;
  const remainingSecs = totalPermittedSecs - elapsedSecs;

  const pct = Math.max(0, Math.min(100, Math.round((remainingSecs / totalPermittedSecs) * 100)));
  if (breakProgressBar) {
    breakProgressBar.style.width = `${pct}%`;
  }

  if (remainingSecs > 0) {
    const formatted = formatMS(remainingSecs);
    breakCountdownTimer.textContent = formatted;
    breakToggleBtn.textContent = `▶ Resume Work (${Math.ceil(remainingSecs / 60)}m left)`;

    if (remainingSecs <= 300) {
      if (breakCountdownWrap) breakCountdownWrap.className = 'break-countdown-wrap warning';
      if (breakProgressBar) breakProgressBar.style.background = '#f59e0b';
      if (breakCountdownFooter) {
        breakCountdownFooter.textContent = '⚠️ Under 5 minutes remaining! Resume work soon.';
        breakCountdownFooter.style.color = '#facc15';
      }
    } else {
      if (breakCountdownWrap) breakCountdownWrap.className = 'break-countdown-wrap';
      if (breakProgressBar) breakProgressBar.style.background = '#38bdf8';
      if (breakCountdownFooter) {
        breakCountdownFooter.textContent = 'Permitted daily break · Resume work before 00:00';
        breakCountdownFooter.style.color = '#94a3b8';
      }
    }
  } else {
    const overdueSecs = Math.abs(remainingSecs);
    breakCountdownTimer.textContent = `+${formatMS(overdueSecs)} OVERDUE`;
    breakToggleBtn.textContent = '▶ Resume Work (Break Overdue)';
    if (breakCountdownWrap) breakCountdownWrap.className = 'break-countdown-wrap overdue';
    if (breakProgressBar) {
      breakProgressBar.style.width = '100%';
      breakProgressBar.style.background = '#ef4444';
    }
    if (breakCountdownFooter) {
      breakCountdownFooter.textContent = '⚠️ Break exceeded! Excess time counts toward daily deficit.';
      breakCountdownFooter.style.color = '#f87171';
    }
  }
}

async function refreshStatus() {
  try {
    const data = await callBackend('get_app_status');
    if (data.enrolled) {
      enrollSection.classList.add('hidden');
      statusSection.classList.remove('hidden');
      employeeBadge.textContent = `${data.employeeName || 'Staff'} (${data.employeeRole || 'Member'})`;

      if (data.latest && data.latest.today) {
        const serverDateKey = data.latest.today.dateKey || '';
        const serverActive = data.latest.today.activeSeconds || 0;

        // Date rollover: if the day changed overnight or across midnight, reset to today's active seconds
        if (serverDateKey && lastSyncedDateKey && serverDateKey !== lastSyncedDateKey) {
          console.log(`[desktop] Day changed from ${lastSyncedDateKey} to ${serverDateKey}. Resetting active counter.`);
          currentActiveSecs = serverActive;
          lastSyncedServerSecs = serverActive;
          lastSyncedDateKey = serverDateKey;
        } else if (lastSyncedServerSecs === -1) {
          currentActiveSecs = serverActive;
          lastSyncedServerSecs = serverActive;
          lastSyncedDateKey = serverDateKey;
        } else if (serverActive > lastSyncedServerSecs) {
          currentActiveSecs = Math.max(currentActiveSecs, serverActive);
          lastSyncedServerSecs = serverActive;
        } else if (serverActive < lastSyncedServerSecs) {
          // If server reports fewer seconds (e.g. day roll over or correction)
          currentActiveSecs = serverActive;
          lastSyncedServerSecs = serverActive;
        } else {
          // If local timer drifted ahead of server by >90s, pull back to server active time
          if (currentActiveSecs > serverActive + 90) {
            currentActiveSecs = serverActive;
          }
        }

        const breakMins = Math.floor((data.latest.today.breakSeconds || 0) / 60);
        statBreak.textContent = `${breakMins}m`;
        statIdle.textContent = `${Math.floor((data.latest.today.idleSeconds || 0) / 60)}m`;

        const serverOnBreak = Boolean(data.latest && data.latest.today && data.latest.today.onBreak);
        const isBreakUsed = Boolean(data.latest && data.latest.today && data.latest.today.breakAlreadyTaken);
        const isOnBreak = serverOnBreak || (data.isManualBreak && !isBreakUsed);

        if (isOnBreak) {
          isOnBreakState = true;
          breakPermittedMins = (data.latest && data.latest.today && data.latest.today.breakPermittedMinutes) || 30;
          if (data.latest && data.latest.today && data.latest.today.breakStartedAt) {
            breakStartedAtMs = data.latest.today.breakStartedAt;
          } else if (!breakStartedAtMs) {
            const pastBreakSecs = (data.latest && data.latest.today && data.latest.today.breakSeconds) || 0;
            breakStartedAtMs = Date.now() - (pastBreakSecs * 1000);
          }
          if (breakPermittedPill) {
            breakPermittedPill.textContent = `${breakPermittedMins}m max`;
          }
          if (breakCountdownWrap) {
            breakCountdownWrap.classList.remove('hidden');
          }
          updateBreakCountdown();

          statusBanner.className = 'status-banner away';
          statusText.textContent = '☕ On Break';
          breakToggleBtn.disabled = false;
          breakToggleBtn.classList.remove('disabled');
        } else {
          isOnBreakState = false;
          breakStartedAtMs = null;
          if (breakCountdownWrap) {
            breakCountdownWrap.classList.add('hidden');
          }

          if (isBreakUsed) {
            if (data.latest.workstationStatus === 'AWAY') {
              statusBanner.className = 'status-banner away';
              statusText.textContent = '🔒 Screen Locked (Away)';
            } else if (data.latest.workstationStatus === 'IDLE') {
              statusBanner.className = 'status-banner away';
              statusText.textContent = '⏳ Idle Inactivity';
            } else {
              statusBanner.className = 'status-banner';
              statusText.textContent = data.latest.inOffice ? '🟢 Active · In Office' : '🔵 Active · Outside Office';
            }
            breakToggleBtn.textContent = `☕ Break Taken (${breakMins}m used)`;
            breakToggleBtn.disabled = true;
            breakToggleBtn.classList.add('disabled');
          } else if (data.latest.workstationStatus === 'AWAY') {
            statusBanner.className = 'status-banner away';
            statusText.textContent = '🔒 Screen Locked (Away)';
            breakToggleBtn.textContent = '☕ Take Break';
            breakToggleBtn.disabled = false;
            breakToggleBtn.classList.remove('disabled');
          } else if (data.latest.workstationStatus === 'IDLE') {
            statusBanner.className = 'status-banner away';
            statusText.textContent = '⏳ Idle Inactivity';
            breakToggleBtn.textContent = '☕ Take Break';
            breakToggleBtn.disabled = false;
            breakToggleBtn.classList.remove('disabled');
          } else {
            statusBanner.className = 'status-banner';
            statusText.textContent = data.latest.inOffice ? '🟢 Active · In Office' : '🔵 Active · Outside Office';
            breakToggleBtn.textContent = '☕ Take Break';
            breakToggleBtn.disabled = false;
            breakToggleBtn.classList.remove('disabled');
          }
        }

        if (data.latest.inOffice) {
          networkText.textContent = '🟢 Verified in Office (Trans K)';
          if (wifiConnectBtn) wifiConnectBtn.classList.add('hidden');
        } else {
          networkText.textContent = '⚠️ Attendance Paused · Not on Office Wi-Fi';
          if (wifiConnectBtn) wifiConnectBtn.classList.remove('hidden');
        }
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
  // Midnight rollover detection on local machine
  const nowDay = new Date().toDateString();
  if (nowDay !== lastLocalDay) {
    lastLocalDay = nowDay;
    currentActiveSecs = 0;
    lastSyncedServerSecs = -1;
    lastSyncedDateKey = '';
    refreshStatus();
    return;
  }

  if (isOnBreakState) {
    updateBreakCountdown();
  } else if (statusBanner && !statusBanner.classList.contains('away') && !statusBanner.classList.contains('offline')) {
    currentActiveSecs++;
    if (activeTimer) {
      activeTimer.textContent = formatHMS(currentActiveSecs);
    }
  }
}, 1000);

// Window Dragging Support for Frameless Window
const headerEl = document.querySelector('.header');
if (headerEl) {
  headerEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a')) {
      return;
    }
    if (isTauri && tauriWindow && typeof tauriWindow.startDragging === 'function') {
      tauriWindow.startDragging();
    }
  });
}

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
    if (breakToggleBtn.disabled || breakToggleBtn.classList.contains('disabled')) return;
    try {
      breakToggleBtn.disabled = true;
      const targetIsBreak = !isOnBreakState;
      if (targetIsBreak) {
        isOnBreakState = true;
        breakStartedAtMs = Date.now();
        if (breakCountdownWrap) breakCountdownWrap.classList.remove('hidden');
        updateBreakCountdown();
      } else {
        isOnBreakState = false;
        breakStartedAtMs = null;
        if (breakCountdownWrap) breakCountdownWrap.classList.add('hidden');
      }

      await callBackend('toggle_manual_break');
      await refreshStatus();
    } catch (err) {
      console.error('Break toggle failed:', err);
      const errMsg = (typeof err === 'string' ? err : (err && err.message) || '').toLowerCase();
      if (errMsg.includes('no break') || errMsg.includes('not_on_break')) {
        await refreshStatus();
      } else {
        showFeedback(typeof err === 'string' ? err : (err && err.message) || 'Could not change break status.');
        await refreshStatus();
      }
    } finally {
      // refreshStatus() sets the correct disabled/enabled state
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
