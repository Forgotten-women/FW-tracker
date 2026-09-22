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

  if (command === 'set_manual_break' || command === 'toggle_manual_break') {
    if (isTauri && tauriInvoke) {
      return tauriInvoke('set_manual_break', { onBreak: Boolean(args.onBreak) });
    }
    const res = await fetch('/api/break', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  if (command === 'checkout_shift') {
    const res = await fetch('/api/checkout', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  return {};
}

const enrollSection = document.getElementById('enroll-section');
const statusSection = document.getElementById('status-section');
const employeeBadge = document.getElementById('employee-badge');
const checkinText = document.getElementById('checkin-text');
const enrollBtn = document.getElementById('enroll-btn');
const enrollError = document.getElementById('enroll-error');
const serverUrlInput = document.getElementById('server-url-input');
const enrollCodeInput = document.getElementById('enroll-code-input');
const minimizeBtn = document.getElementById('minimize-btn');
const closeBtn = document.getElementById('close-btn');
const breakToggleBtn = document.getElementById('break-toggle-btn');
const checkoutBtn = document.getElementById('checkout-btn');
const undoCheckoutWrap = document.getElementById('undo-checkout-wrap');
const undoTimerNum = document.getElementById('undo-timer-num');
const undoCheckoutBtn = document.getElementById('undo-checkout-btn');
const activeTimer = document.getElementById('active-timer');
const presenceValue = document.getElementById('presence-value');
const presenceGapNote = document.getElementById('presence-gap-note');
const statBreak = document.getElementById('stat-break');
const statIdle = document.getElementById('stat-idle');
const statusBanner = document.getElementById('status-banner');
const statusText = document.getElementById('status-text');
const networkText = document.getElementById('network-text');
const wifiConnectBtn = document.getElementById('wifi-connect-btn');
const statusFeedback = document.getElementById('status-feedback');
let feedbackTimeout = null;
let isTogglingBreak = false;
let checkoutCountdownTimer = null;
let checkoutSecondsLeft = 5;

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

const CACHE_KEY_ACTIVE = 'officetracker_active_secs';
const CACHE_KEY_DATE = 'officetracker_date_key';

function getTodayDateKey() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Restore saved active seconds from localStorage on startup so it never resets to 00:00:00
const todayDateStr = getTodayDateKey();
const savedDateStr = typeof localStorage !== 'undefined' ? localStorage.getItem(CACHE_KEY_DATE) : null;
const savedSecsVal = typeof localStorage !== 'undefined' ? parseInt(localStorage.getItem(CACHE_KEY_ACTIVE) || '0', 10) : 0;

let currentActiveSecs = (savedDateStr === todayDateStr && savedSecsVal > 0) ? savedSecsVal : 0;
let lastSyncedServerSecs = -1;
let lastSyncedDateKey = savedDateStr === todayDateStr ? todayDateStr : '';
let timerInterval = null;
let lastLocalDay = new Date().toDateString();

function saveLocalProgress(secs, dateKey = getTodayDateKey()) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CACHE_KEY_ACTIVE, String(secs));
      localStorage.setItem(CACHE_KEY_DATE, dateKey);
    }
  } catch (_) {}
}

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
  if (isTogglingBreak) return;
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
          saveLocalProgress(currentActiveSecs, serverDateKey);
        } else if (lastSyncedServerSecs === -1) {
          currentActiveSecs = Math.max(currentActiveSecs, serverActive);
          lastSyncedServerSecs = serverActive;
          lastSyncedDateKey = serverDateKey || todayDateStr;
          saveLocalProgress(currentActiveSecs, lastSyncedDateKey);
        } else if (serverActive > lastSyncedServerSecs) {
          currentActiveSecs = Math.max(currentActiveSecs, serverActive);
          lastSyncedServerSecs = serverActive;
          saveLocalProgress(currentActiveSecs, serverDateKey);
        } else if (serverActive < lastSyncedServerSecs && serverActive > 0) {
          currentActiveSecs = serverActive;
          lastSyncedServerSecs = serverActive;
          saveLocalProgress(currentActiveSecs, serverDateKey);
        } else {
          // If local timer drifted ahead of server by >90s, pull back to server active time
          if (serverActive > 0 && currentActiveSecs > serverActive + 90) {
            currentActiveSecs = serverActive;
            saveLocalProgress(currentActiveSecs, serverDateKey);
          }
        }

        const breakMins = Math.floor((data.latest.today.breakSeconds || 0) / 60);
        statBreak.textContent = `${breakMins}m`;
        statIdle.textContent = `${Math.floor((data.latest.today.idleSeconds || 0) / 60)}m`;

        if (data.latest && data.latest.today && checkinText) {
          checkinText.textContent = `Check-in: ${data.latest.today.checkInTime || 'Not Recorded'}`;
        }

        // Office Presence (phone + Wi-Fi verified) alongside this agent's own
        // Active Time. Backend omits/nulls these fields if it couldn't
        // resolve presence for some reason -- shown as "--" rather than a
        // stale or misleading number in that case.
        if (presenceValue) {
          const presenceMins = data.latest.today.officePresenceMinutes;
          if (presenceMins === null || presenceMins === undefined) {
            presenceValue.textContent = '--';
            if (presenceGapNote) presenceGapNote.classList.add('hidden');
          } else {
            presenceValue.textContent = data.latest.today.officePresenceFormatted
              || formatHMS(presenceMins * 60);

            // A gap of 10+ minutes between the two is worth explaining --
            // it almost always means idle/locked/asleep time that presence
            // (continuous as long as the phone stays on office Wi-Fi) counts
            // but this agent's own Active Time does not.
            const activeMins = Math.floor(currentActiveSecs / 60);
            const gapMins = presenceMins - activeMins;
            if (presenceGapNote) {
              if (gapMins >= 10) {
                presenceGapNote.textContent =
                  `ℹ️ ${gapMins}m more presence than active time -- likely idle, `
                  + `screen-locked, or sleep time while still on office Wi-Fi.`;
                presenceGapNote.classList.remove('hidden');
              } else {
                presenceGapNote.classList.add('hidden');
              }
            }
          }
        }

        const serverOnBreak = Boolean(data.latest && data.latest.today && data.latest.today.onBreak);
        const isBreakUsed = Boolean(data.latest && data.latest.today && data.latest.today.breakAlreadyTaken);
        const isOnBreak = isBreakUsed ? false : (serverOnBreak || (Boolean(data.isManualBreak) && !isBreakUsed));

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
          if (!isTogglingBreak) {
            updateBreakCountdown();
            statusBanner.className = 'status-banner away';
            statusText.textContent = '☕ On Break';
            breakToggleBtn.disabled = false;
            breakToggleBtn.classList.remove('disabled');
          }
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
            } else if (data.latest.workstationStatus === 'CHECKED_OUT') {
              statusBanner.className = 'status-banner away';
              statusText.textContent = '🏁 Shift Ended (Checked Out)';
            } else {
              statusBanner.className = 'status-banner';
              statusText.textContent = data.latest.inOffice ? '🟢 Active · In Office' : '🔵 Active · Outside Office';
            }
            if (!isTogglingBreak) {
              breakToggleBtn.textContent = `☕ Break Taken (${breakMins}m used)`;
              breakToggleBtn.disabled = true;
              breakToggleBtn.classList.add('disabled');
            }
          } else if (data.latest.workstationStatus === 'AWAY') {
            statusBanner.className = 'status-banner away';
            statusText.textContent = '🔒 Screen Locked (Away)';
            if (!isTogglingBreak) {
              breakToggleBtn.textContent = '☕ Take Break';
              breakToggleBtn.disabled = false;
              breakToggleBtn.classList.remove('disabled');
            }
          } else if (data.latest.workstationStatus === 'IDLE') {
            statusBanner.className = 'status-banner away';
            statusText.textContent = '⏳ Idle Inactivity';
            if (!isTogglingBreak) {
              breakToggleBtn.textContent = '☕ Take Break';
              breakToggleBtn.disabled = false;
              breakToggleBtn.classList.remove('disabled');
            }
          } else if (data.latest.workstationStatus === 'CHECKED_OUT') {
            statusBanner.className = 'status-banner away';
            statusText.textContent = '🏁 Shift Ended (Checked Out)';
            if (!isTogglingBreak) {
              breakToggleBtn.textContent = '☕ Take Break';
              breakToggleBtn.disabled = true;
              breakToggleBtn.classList.add('disabled');
            }
          } else {
            statusBanner.className = 'status-banner';
            statusText.textContent = data.latest.inOffice ? '🟢 Active · In Office' : '🔵 Active · Outside Office';
            if (!isTogglingBreak) {
              breakToggleBtn.textContent = '☕ Take Break';
              breakToggleBtn.disabled = false;
              breakToggleBtn.classList.remove('disabled');
            }
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
    if (currentActiveSecs % 5 === 0) {
      saveLocalProgress(currentActiveSecs);
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

if (minimizeBtn) {
  minimizeBtn.addEventListener('click', () => {
    if (isTauri && tauriWindow && typeof tauriWindow.minimize === 'function') {
      tauriWindow.minimize();
    } else {
      window.blur();
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
  breakToggleBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (isTogglingBreak || breakToggleBtn.disabled || breakToggleBtn.classList.contains('disabled')) return;
    
    isTogglingBreak = true;
    breakToggleBtn.disabled = true;
    breakToggleBtn.classList.add('disabled');

    const targetIsBreak = !isOnBreakState;
    if (targetIsBreak) {
      isOnBreakState = true;
      breakStartedAtMs = Date.now();
      if (breakCountdownWrap) breakCountdownWrap.classList.remove('hidden');
      if (statusBanner) statusBanner.className = 'status-banner away';
      if (statusText) statusText.textContent = '☕ On Break';
      breakToggleBtn.textContent = '⏳ Starting break…';
      updateBreakCountdown();
    } else {
      isOnBreakState = false;
      breakStartedAtMs = null;
      if (breakCountdownWrap) breakCountdownWrap.classList.add('hidden');
      if (statusBanner) statusBanner.className = 'status-banner';
      if (statusText) statusText.textContent = '🟢 Active · In Office';
      breakToggleBtn.textContent = '☕ Break Taken';
    }

    try {
      await callBackend('set_manual_break', { onBreak: targetIsBreak });
    } catch (err) {
      console.error('Break toggle failed:', err);
      const errMsg = (typeof err === 'string' ? err : (err && err.message) || '').toLowerCase();
      if (!errMsg.includes('no break') && !errMsg.includes('not_on_break')) {
        showFeedback(typeof err === 'string' ? err : (err && err.message) || 'Could not change break status.');
      }
    } finally {
      isTogglingBreak = false;
      await refreshStatus();
    }
  });
}

if (checkoutBtn) {
  checkoutBtn.addEventListener('click', () => {
    if (checkoutCountdownTimer) return;
    checkoutSecondsLeft = 5;
    if (undoTimerNum) undoTimerNum.textContent = '5';
    if (undoCheckoutWrap) undoCheckoutWrap.classList.remove('hidden');
    checkoutBtn.disabled = true;
    checkoutBtn.classList.add('disabled');

    checkoutCountdownTimer = setInterval(async () => {
      checkoutSecondsLeft--;
      if (undoTimerNum) undoTimerNum.textContent = String(checkoutSecondsLeft);

      if (checkoutSecondsLeft <= 0) {
        clearInterval(checkoutCountdownTimer);
        checkoutCountdownTimer = null;
        if (undoCheckoutWrap) undoCheckoutWrap.classList.add('hidden');

        try {
          if (isTauri && tauriInvoke) {
            await tauriInvoke('checkout_shift');
          } else {
            await fetch('/api/checkout', { method: 'POST' });
          }
          showFeedback('✓ Shift checked out successfully.', false);
          refreshStatus();
        } catch (err) {
          showFeedback('Checkout failed. Please try again.');
        } finally {
          checkoutBtn.disabled = false;
          checkoutBtn.classList.remove('disabled');
        }
      }
    }, 1000);
  });
}

if (undoCheckoutBtn) {
  undoCheckoutBtn.addEventListener('click', () => {
    if (checkoutCountdownTimer) {
      clearInterval(checkoutCountdownTimer);
      checkoutCountdownTimer = null;
    }
    if (undoCheckoutWrap) undoCheckoutWrap.classList.add('hidden');
    if (checkoutBtn) {
      checkoutBtn.disabled = false;
      checkoutBtn.classList.remove('disabled');
    }
    showFeedback('✓ Checkout cancelled. Session continues.', false);
  });
}

// Listen for Tauri events if running under Tauri
if (isTauri && window.__TAURI__.event) {
  window.__TAURI__.event.listen('heartbeat-updated', () => {
    refreshStatus();
  });
}

if (activeTimer && currentActiveSecs > 0) {
  activeTimer.textContent = formatHMS(currentActiveSecs);
}

refreshStatus();
setInterval(refreshStatus, 10000);
