// WorkSync - Desktop Mini-App UI Logic (Cross-Platform Windows & macOS)
// Works seamlessly both inside Tauri GUI and in standalone App Mode!

function getTauri() {
  if (typeof window !== 'undefined' && window.__TAURI__) return window.__TAURI__;
  return null;
}

function getTauriInvoke() {
  const t = getTauri();
  if (!t) return null;
  if (typeof t.invoke === 'function') return t.invoke;
  if (t.tauri && typeof t.tauri.invoke === 'function') return t.tauri.invoke;
  return null;
}

function getTauriWindow() {
  const t = getTauri();
  if (!t) return null;
  if (t.window && t.window.appWindow) return t.window.appWindow;
  if (t.getCurrent && typeof t.getCurrent === 'function') return t.getCurrent();
  return null;
}

// Module-level Tauri globals — resolves at parse time; refreshed inside callBackend
// for the small window where __TAURI__ injects after the script runs.
const isTauri = Boolean(getTauri());
let tauriInvoke = getTauriInvoke();
let tauriWindow = getTauriWindow();

// Universal backend invoker (Tauri IPC or Local Agent HTTP Server)
async function callBackend(command, args = {}) {
  let invoke = getTauriInvoke();
  if (!invoke && typeof window !== 'undefined') {
    // Wait up to 3s in case Tauri globals inject slightly after script parsing
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      invoke = getTauriInvoke();
      if (invoke) break;
    }
    // Keep module-level vars in sync for event handlers that use them directly
    if (invoke) {
      tauriInvoke = invoke;
      tauriWindow = getTauriWindow();
    }
  }

  if (invoke) {
    // Network-bound commands (enrollment, checkout, break toggles) require round-trips
    // over HTTPS to the cloud backend (DNS, TLS handshake, DB transactions).
    // They get a generous 25s timeout. Local in-memory IPC queries get 10s.
    const isNetworkCommand = ['enroll_device', 'checkout_shift', 'set_manual_break', 'toggle_manual_break'].includes(command);
    const timeoutMs = isNetworkCommand ? 25000 : 10000;
    return Promise.race([
      invoke(command, args),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`IPC timeout: ${command} did not respond in ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
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
    const invokeBreak = getTauriInvoke();
    if (invokeBreak) {
      return invokeBreak('set_manual_break', { onBreak: Boolean(args.onBreak) });
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

// Text saved by older versions starts with an emoji; the widget now shows a
// coloured dot and icons instead.
function plainText(text) {
  return String(text || '').replace(/^[^\p{L}\p{N}(]+/u, '').trim();
}

// "10:33:04 AM" -> "10:33 AM": the tile has room for minutes, not seconds.
function shortTime(text) {
  return String(text || '').replace(/^(\d{1,2}:\d{2}):\d{2}/, '$1');
}

// "Name (Role)" -> name and role on one line; the full text on hover.
function renderEmployee(label) {
  if (!employeeBadge) return;
  const full = String(label || '');
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(full);
  employeeBadge.textContent = '';
  employeeBadge.title = full;
  const name = document.createElement('span');
  name.className = 'emp-name';
  name.textContent = m ? m[1] : full;
  employeeBadge.appendChild(name);
  if (m && m[2]) {
    const role = document.createElement('span');
    role.className = 'emp-role';
    role.textContent = m[2];
    employeeBadge.appendChild(role);
  }
}

// enroll-section is visible by default in the HTML (no JS needed for fresh installs).
// For previously-enrolled devices: swap to status view immediately.
try {
  if (localStorage.getItem('ot_enrolled') === 'true') {
    if (enrollSection) enrollSection.classList.add('hidden');
    if (statusSection) statusSection.classList.remove('hidden');
    const cachedEmp = localStorage.getItem('ot_emp_info');
    if (cachedEmp) renderEmployee(cachedEmp);

    // Restore today's last known status & check-in time immediately to eliminate glitch
    const cachedDate = localStorage.getItem('officetracker_date_key');
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (cachedDate === today) {
      const cachedCheckin = localStorage.getItem('ot_last_checkin');
      const checkinEl = document.getElementById('checkin-text');
      if (cachedCheckin && checkinEl) {
        checkinEl.textContent = shortTime(cachedCheckin);
      }
      const cachedStatusText = localStorage.getItem('ot_last_status_text');
      const cachedStatusClass = localStorage.getItem('ot_last_status_class');
      const statusTextEl = document.getElementById('status-text');
      const statusBannerEl = document.getElementById('status-banner');
      if (cachedStatusText && statusTextEl) {
        statusTextEl.textContent = plainText(cachedStatusText);
      }
      if (cachedStatusClass && statusBannerEl) {
        statusBannerEl.className = cachedStatusClass;
      }
      const cachedNet = localStorage.getItem('ot_last_network_text');
      const networkEl = document.getElementById('network-text');
      if (cachedNet && networkEl) {
        networkEl.textContent = plainText(cachedNet);
      }
    }
  }
} catch (_) {}
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
const undoBreakWrap = document.getElementById('undo-break-wrap');
const undoBreakNum = document.getElementById('undo-break-num');
const undoBreakBtn = document.getElementById('undo-break-btn');
const shiftTargetCard = document.getElementById('shift-target-card');
const shiftWorkedValue = document.getElementById('shift-worked-value');
const shiftProgressFill = document.getElementById('shift-progress-fill');
const shiftRemText = document.getElementById('shift-rem-text');
const activeTimer = document.getElementById('active-timer');
const creditNote = document.getElementById('credit-note');
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
let breakStartTimer = null;
let breakSecondsLeft = 5;
let checkoutSecondsLeft = 5;
let consecutiveErrors = 0;

const breakCountdownWrap = document.getElementById('break-countdown-wrap');
const breakCountdownTimer = document.getElementById('break-countdown-timer');
const breakProgressBar = document.getElementById('break-progress-bar');
const breakCountdownFooter = document.getElementById('break-countdown-footer');
const breakPermittedPill = document.getElementById('break-permitted-pill');

let isOnBreakState = false;
// Whether the server is crediting this laptop's time right now. The timer only
// ticks while it is: ticking through time the server never credits (outside
// hours, not yet on office Wi-Fi) is what made it run ahead for hours and then
// snap back to the real figure.
let creditCounting = true;
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
      wifiConnectBtn.textContent = 'Connect';
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

// ---------------------------------------------------------------------------
// Shared day view (1.0.58)
//
// The server sends `today.day`: the same worked / break / idle / progress
// figures the phone app and the HR dashboard show. The widget displays only
// those. Between heartbeats it advances worked time and progress by the time
// that has passed, but only while the server says the day is `counting` and
// this laptop isn't idle or locked, never past the shift end, and never more
// than 15 minutes ahead of the last server figure. Each heartbeat snaps it back.
// ---------------------------------------------------------------------------
let dayView = null;
let dayAsOf = 0;
let daySyncedLocalMs = 0;
let localIdleSecs = 0;
let localLocked = false;

function hm(mins) {
  const m = Math.max(0, Math.floor(mins || 0));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function dayExtraSeconds() {
  if (!dayView || !dayView.counting || localLocked || localIdleSecs >= 300) return 0;
  let extra = Math.max(0, Math.floor((Date.now() - daySyncedLocalMs) / 1000));
  if (dayView.shiftEndAt && dayView.asOf) {
    extra = Math.min(extra, Math.max(0, Math.floor((dayView.shiftEndAt - dayView.asOf) / 1000)));
  }
  return Math.min(extra, 15 * 60);
}

// A new day before the server has answered: nothing from yesterday (worked
// time, "Shift ended", check-in) stays on screen, and the buttons wait.
function renderFreshDay() {
  dayView = null;
  dayAsOf = 0;
  creditCounting = false;
  currentActiveSecs = 0;
  if (activeTimer) activeTimer.textContent = formatHMS(0);
  if (shiftWorkedValue) shiftWorkedValue.innerHTML = '0h 0m <span class="shift-pct">(0%)</span>';
  const ring = document.getElementById('shift-ring');
  if (ring) { ring.style.strokeDashoffset = '263.89'; ring.classList.remove('completed'); }
  const ringPct = document.getElementById('shift-ring-pct');
  if (ringPct) ringPct.textContent = '--';
  if (shiftProgressFill) { shiftProgressFill.style.width = '4%'; shiftProgressFill.className = 'shift-progress-fill'; }
  if (shiftRemText) shiftRemText.innerHTML = '';
  if (creditNote) { creditNote.textContent = ''; creditNote.classList.add('hidden'); }
  if (checkinText) checkinText.textContent = '--:--';
  if (statusBanner) statusBanner.className = 'status-banner syncing';
  if (statusText) statusText.textContent = 'New day · Connecting to server…';
  if (breakToggleBtn && !isTogglingBreak) {
    breakToggleBtn.textContent = 'Take break';
    breakToggleBtn.disabled = true;
    breakToggleBtn.classList.add('disabled');
  }
  updateCheckoutButton();
}

function renderDay() {
  if (!dayView) return;
  const extra = dayExtraSeconds();
  const workedSecs = (dayView.workedMinutes || 0) * 60 + extra;
  const target = dayView.targetMinutes || 0;
  const progressSecs = (dayView.progressMinutes || 0) * 60 + extra;
  const pct = target > 0 ? Math.min(100, Math.round((progressSecs / (target * 60)) * 100)) : 0;
  const remMins = target > 0 ? Math.max(0, Math.ceil((target * 60 - progressSecs) / 60)) : 0;

  currentActiveSecs = workedSecs;
  if (activeTimer) activeTimer.textContent = formatHMS(workedSecs);
  if (shiftWorkedValue) {
    shiftWorkedValue.innerHTML = `${hm(workedSecs / 60)} <span class="shift-pct">(${pct}%)</span>`;
  }
  const ring = document.getElementById('shift-ring');
  if (ring) {
    const circumference = 263.89; // 2 * pi * r (r = 42)
    ring.style.strokeDashoffset = String(circumference * (1 - pct / 100));
    ring.classList.toggle('completed', pct >= 100);
  }
  const ringPct = document.getElementById('shift-ring-pct');
  if (ringPct) ringPct.textContent = target > 0 ? `${pct}%` : '--';
  const targetLabel = document.getElementById('shift-target-label');
  if (targetLabel) {
    targetLabel.textContent = target > 0
      ? `of ${Math.floor(target / 60)}h ${String(target % 60).padStart(2, '0')}m`
      : 'no shift today';
  }
  const ringEl = document.querySelector('.ring');
  if (ringEl && target > 0) {
    ringEl.title = `Worked ${hm(workedSecs / 60)} + break up to ${dayView.permittedBreakMinutes}m, of a ${hm(target)} shift`;
  }
  if (shiftProgressFill) {
    shiftProgressFill.style.width = `${Math.max(4, pct)}%`;
    shiftProgressFill.className = pct >= 100 ? 'shift-progress-fill completed' : 'shift-progress-fill';
  }
  if (shiftRemText) {
    const after = dayView.overtimeMinutes > 0 ? ` · ${hm(dayView.overtimeMinutes)} after shift` : '';
    if (dayView.checkedOut) {
      shiftRemText.innerHTML = `<span class="rem-emerald">Shift ended${after}</span>`;
    } else if (target > 0 && remMins <= 0) {
      shiftRemText.innerHTML = `<span class="rem-emerald">Target reached${after}</span>`;
    } else if (target > 0) {
      shiftRemText.innerHTML = `<span class="rem-amber">${hm(remMins)} remaining</span>`;
    } else {
      shiftRemText.innerHTML = '';
    }
  }
  if (statBreak) statBreak.textContent = `${dayView.breakMinutes || 0}m`;
  if (statIdle) statIdle.textContent = `${dayView.idleMinutes || 0}m`;
  if (checkinText) checkinText.textContent = dayView.checkIn ? shortTime(dayView.checkIn) : '--:--';
}

// The full working day, break included (8h by default), as the server's
// attendance engine judges it. A break longer than the allowance extends it.
let currentShiftTargetMins = 480;
let currentOfficePresenceMins = 0;
let currentExcessBreakMins = 0;

function updateShiftTargetDisplay(activeSecs, shiftTargetMins = currentShiftTargetMins, officePresenceMins = currentOfficePresenceMins) {
  if (!shiftTargetCard) return;
  currentShiftTargetMins = shiftTargetMins || 480;
  currentOfficePresenceMins = officePresenceMins || 0;
  const activeMins = Math.floor((activeSecs || 0) / 60);
  const workedMins = Math.max(activeMins, currentOfficePresenceMins);
  const workedFormatted = `${Math.floor(workedMins / 60)}h ${workedMins % 60}m`;
  const creditedMins = Math.max(0, workedMins - currentExcessBreakMins);
  const pct = Math.min(100, Math.round((creditedMins / currentShiftTargetMins) * 100));
  const remMins = Math.max(0, currentShiftTargetMins - creditedMins);
  const remFormatted = `${Math.floor(remMins / 60)}h ${remMins % 60}m`;

  if (shiftWorkedValue) {
    shiftWorkedValue.innerHTML = `${workedFormatted} <span class="shift-pct">(${pct}%)</span>`;
  }
  const ring = document.getElementById('shift-ring');
  if (ring) {
    const circumference = 263.89; // 2 * pi * r (r = 42)
    ring.style.strokeDashoffset = String(circumference * (1 - Math.max(0, Math.min(100, pct)) / 100));
    ring.classList.toggle('completed', pct >= 100);
  }
  const ringPct = document.getElementById('shift-ring-pct');
  if (ringPct) ringPct.textContent = `${pct}%`;
  const targetLabel = document.getElementById('shift-target-label');
  if (targetLabel) {
    const t = currentShiftTargetMins;
    targetLabel.textContent = `of ${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}m`;
  }
  if (shiftProgressFill) {
    shiftProgressFill.style.width = `${Math.max(4, Math.min(100, pct))}%`;
    if (pct >= 100) {
      shiftProgressFill.className = 'shift-progress-fill completed';
    } else {
      shiftProgressFill.className = 'shift-progress-fill';
    }
  }
  if (shiftRemText) {
    if (remMins <= 0 || pct >= 100) {
      shiftRemText.innerHTML = '<span class="rem-emerald">Target reached</span>';
    } else {
      const over = currentExcessBreakMins > 0 ? ` · incl. ${currentExcessBreakMins}m over break` : '';
      shiftRemText.innerHTML = `<span class="rem-amber">${remFormatted} remaining${over}</span>`;
    }
  }
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
    breakToggleBtn.textContent = `Resume work (${Math.ceil(remainingSecs / 60)}m left)`;

    if (remainingSecs <= 300) {
      if (breakCountdownWrap) breakCountdownWrap.className = 'break-countdown-wrap warning';
      if (breakProgressBar) breakProgressBar.style.background = '#f59e0b';
      if (breakCountdownFooter) {
        breakCountdownFooter.textContent = 'Under 5 minutes left. Resume work soon.';
        breakCountdownFooter.style.color = '#facc15';
      }
    } else {
      if (breakCountdownWrap) breakCountdownWrap.className = 'break-countdown-wrap';
      if (breakProgressBar) breakProgressBar.style.background = '#38bdf8';
      if (breakCountdownFooter) {
        breakCountdownFooter.textContent = 'Permitted daily break';
        breakCountdownFooter.style.color = '#94a3b8';
      }
    }
  } else {
    const overdueSecs = Math.abs(remainingSecs);
    breakCountdownTimer.textContent = `+${formatMS(overdueSecs)} over`;
    breakToggleBtn.textContent = 'Resume work (overdue)';
    if (breakCountdownWrap) breakCountdownWrap.className = 'break-countdown-wrap overdue';
    if (breakProgressBar) {
      breakProgressBar.style.width = '100%';
      breakProgressBar.style.background = '#ef4444';
    }
    if (breakCountdownFooter) {
      breakCountdownFooter.textContent = 'Break exceeded: extra time counts toward your deficit.';
      breakCountdownFooter.style.color = '#f87171';
    }
  }
}

async function refreshStatus() {
  try {
    const data = await callBackend('get_app_status');

    // Show version number wherever visible
    const versionBadge = document.getElementById('version-badge');
    if (versionBadge && data.version) {
      versionBadge.textContent = `v${data.version}`;
    }

    if (data.enrolled) {
      try {
        localStorage.setItem('ot_enrolled', 'true');
        const empTitle = `${data.employeeName || 'Staff'} (${data.employeeRole || 'Member'})`;
        localStorage.setItem('ot_emp_info', empTitle);
        renderEmployee(empTitle);
      } catch (_) {}

      enrollSection.classList.add('hidden');
      statusSection.classList.remove('hidden');

      // A response from an earlier day (the laptop slept overnight, or was
      // clocked out last night) is never shown: the new day starts fresh and
      // waits for the server, which the agent contacts at once on waking.
      const latestDate = (data.latest && data.latest.today)
        ? (data.latest.today.dateKey || (data.latest.today.day && data.latest.today.day.dateKey) || '')
        : '';
      const latestIsToday = !latestDate || latestDate === getTodayDateKey();

      if (data.latest && data.latest.today && latestIsToday) {
        // The shared day view, if the server sent one for today. A new one is
        // recognised by its asOf; the local clock then measures time since.
        const dv = data.latest.today.day || null;
        if (dv && dv.dateKey === getTodayDateKey()) {
          if (dv.asOf !== dayAsOf) {
            dayView = dv;
            dayAsOf = dv.asOf;
            daySyncedLocalMs = Date.now();
          }
        } else {
          dayView = null;
        }
        localIdleSecs = Number(data.idleSeconds) || 0;
        localLocked = data.lockState === 'LOCKED' || data.lockState === 'SLEEPING';

        const serverDateKey = data.latest.today.dateKey || '';
        const serverActive = data.latest.today.activeSeconds || 0;
        const presenceMins = (data.latest.today.officePresenceMinutes !== null && data.latest.today.officePresenceMinutes !== undefined)
          ? data.latest.today.officePresenceMinutes
          : 0;
        const presenceSecs = presenceMins * 60;

        // Date rollover: if the day changed overnight or across midnight, reset to today's active seconds
        // What the server has credited, plus what the agent has counted since
        // its last heartbeat -- but only while the server is crediting at all.
        // (creditState is absent from older backends: treat that as counting.)
        const creditState = data.latest.creditState || null;
        // Without a day view (the start-up placeholder) nothing ticks: the
        // widget waits for the server instead of guessing.
        creditCounting = !dayView && Boolean(creditState) && creditState === 'COUNTED';
        const pending = creditCounting ? (Number(data.pendingActiveSeconds) || 0) : 0;
        
        // Take the highest verified worked/presence time (e.g. 6h 22m) so the widget matches the HR dashboard
        const totalCreditedSecs = Math.max(serverActive, presenceSecs);
        currentActiveSecs = totalCreditedSecs + pending;
        lastSyncedServerSecs = totalCreditedSecs;
        lastSyncedDateKey = serverDateKey || todayDateStr;
        saveLocalProgress(currentActiveSecs, lastSyncedDateKey);

        if (creditNote) {
          const unverified = Number(data.latest.today.unverifiedSeconds) || 0;
          const notes = {
            OUTSIDE_HOURS: 'Outside your working hours, so this time is not counted.',
            UNVERIFIED: unverified > 0
              ? `Not on the office network yet: ${formatHMS(unverified)} is held and will be added once you are verified.`
              : 'Not on the office network yet, so time is held until you are verified.',
            IDLE: 'No activity for 5+ minutes, so this time is idle and not counted as worked.',
            AWAY: 'Screen locked, so this time is not counted as worked.',
            BEFORE_SHIFT: `Your shift starts at ${(dayView && dayView.shiftStart) || 'the scheduled time'}, so time before then isn't counted.`,
          };
          const note = notes[creditState] || '';
          creditNote.textContent = note;
          creditNote.classList.toggle('hidden', !note);
        }

        const breakMins = Math.floor((data.latest.today.breakSeconds || 0) / 60);
        if (statBreak) statBreak.textContent = `${breakMins}m`;
        if (statIdle) statIdle.textContent = `${Math.floor((data.latest.today.idleSeconds || 0) / 60)}m`;

        if (data.latest && data.latest.today && checkinText) {
          const checkinVal = data.latest.today.checkInTime || 'Not Recorded';
          checkinText.textContent = data.latest.today.checkInTime ? shortTime(checkinVal) : '--:--';
          if (data.latest.today.checkInTime) {
            try { localStorage.setItem('ot_last_checkin', data.latest.today.checkInTime); } catch (_) {}
          }
        }

        // Official Daily Shift Target (HR Dashboard Synced). With a day view
        // renderDay() below draws it from the server's figures instead.
        if (shiftTargetCard && !dayView) {
          const REQUIRED_SHIFT_MINS = data.latest.today.shiftTargetMinutes || 480;
          currentExcessBreakMins = Number(data.latest.today.shiftExcessBreakMinutes) || 0;
          const breakIncluded = Number(data.latest.today.shiftBreakIncludedMinutes) || 30;
          const ringEl = document.querySelector('.ring');
          if (ringEl) ringEl.title = `Daily target: ${Math.floor(REQUIRED_SHIFT_MINS / 60)}h ${String(REQUIRED_SHIFT_MINS % 60).padStart(2, '0')}m, including your ${breakIncluded}m break`;
          const presenceMins = (data.latest.today.officePresenceMinutes !== null && data.latest.today.officePresenceMinutes !== undefined)
            ? data.latest.today.officePresenceMinutes
            : 0;
          updateShiftTargetDisplay(currentActiveSecs, REQUIRED_SHIFT_MINS, presenceMins);
        }

        if (dayView) renderDay();
        updateCheckoutButton();

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
            if (statusBanner) statusBanner.className = 'status-banner away';
            if (statusText) statusText.textContent = 'On break';
            if (breakToggleBtn) {
              breakToggleBtn.disabled = false;
              breakToggleBtn.classList.remove('disabled');
            }
          }
        } else {
          isOnBreakState = false;
          breakStartedAtMs = null;
          if (breakCountdownWrap) {
            breakCountdownWrap.classList.add('hidden');
          }

          if (isBreakUsed) {
            if (data.latest.workstationStatus === 'AWAY') {
              if (statusBanner) statusBanner.className = 'status-banner away';
              if (statusText) statusText.textContent = 'Screen locked · Away';
            } else if (data.latest.workstationStatus === 'IDLE') {
              if (statusBanner) statusBanner.className = 'status-banner away';
              if (statusText) statusText.textContent = 'Idle · No activity';
            } else if (data.latest.workstationStatus === 'CHECKED_OUT') {
              if (statusBanner) statusBanner.className = 'status-banner away';
              if (statusText) statusText.textContent = 'Shift ended · Checked out';
            } else {
              if (statusBanner) statusBanner.className = 'status-banner';
              if (statusText) statusText.textContent = data.latest.inOffice ? 'Active · In office' : 'Active · Outside office';
            }
            if (!isTogglingBreak && breakToggleBtn) {
              breakToggleBtn.textContent = `Break taken (${breakMins}m)`;
              breakToggleBtn.disabled = true;
              breakToggleBtn.classList.add('disabled');
            }
          } else if (data.latest.workstationStatus === 'AWAY') {
            if (statusBanner) statusBanner.className = 'status-banner away';
            if (statusText) statusText.textContent = 'Screen locked · Away';
            if (!isTogglingBreak && breakToggleBtn) {
              breakToggleBtn.textContent = 'Take break';
              breakToggleBtn.disabled = false;
              breakToggleBtn.classList.remove('disabled');
            }
          } else if (data.latest.workstationStatus === 'IDLE') {
            if (statusBanner) statusBanner.className = 'status-banner away';
            if (statusText) statusText.textContent = 'Idle · No activity';
            if (!isTogglingBreak && breakToggleBtn) {
              breakToggleBtn.textContent = 'Take break';
              breakToggleBtn.disabled = false;
              breakToggleBtn.classList.remove('disabled');
            }
          } else if (data.latest.workstationStatus === 'CHECKED_OUT') {
            if (statusBanner) statusBanner.className = 'status-banner away';
            if (statusText) statusText.textContent = 'Shift ended · Checked out';
            if (!isTogglingBreak && breakToggleBtn) {
              breakToggleBtn.textContent = 'Take break';
              breakToggleBtn.disabled = true;
              breakToggleBtn.classList.add('disabled');
            }
          } else if (data.latest.workstationStatus === 'OUTSIDE_HOURS') {
            if (statusBanner) statusBanner.className = 'status-banner away';
            if (statusText) statusText.textContent = 'Outside working hours';
            if (!isTogglingBreak && breakToggleBtn) {
              breakToggleBtn.textContent = 'Take break';
              breakToggleBtn.disabled = true;
              breakToggleBtn.classList.add('disabled');
            }
          } else {
            if (statusBanner) statusBanner.className = 'status-banner';
            if (statusText) statusText.textContent = data.latest.inOffice ? 'Active · In office' : 'Active · Outside office';
            if (!isTogglingBreak && breakToggleBtn) {
              breakToggleBtn.textContent = 'Take break';
              breakToggleBtn.disabled = false;
              breakToggleBtn.classList.remove('disabled');
            }
          }
        }

        if (data.latest.inOffice) {
          if (networkText) networkText.textContent = 'On office Wi-Fi · Verified';
          if (wifiConnectBtn) wifiConnectBtn.classList.add('hidden');
        } else {
          if (networkText) networkText.textContent = 'Not on office Wi-Fi · Time paused';
          if (wifiConnectBtn) wifiConnectBtn.classList.remove('hidden');
        }

        // Cache last confirmed status and network text to avoid startup/reconnection glitches
        if (statusText && statusText.textContent) {
          try { localStorage.setItem('ot_last_status_text', statusText.textContent); } catch (_) {}
        }
        if (statusBanner && statusBanner.className) {
          try { localStorage.setItem('ot_last_status_class', statusBanner.className); } catch (_) {}
        }
        if (networkText && networkText.textContent) {
          try { localStorage.setItem('ot_last_network_text', networkText.textContent); } catch (_) {}
        }
      } else {
        // Device is enrolled, but waiting for initial heartbeat response from server
        // If we already have today's confirmed active status cached, keep showing it instead of glitching to "Connecting..."
        const cachedDate = localStorage.getItem(CACHE_KEY_DATE);
        const cachedStatusText = localStorage.getItem('ot_last_status_text');
        if (data.latest && !latestIsToday) {
          renderFreshDay();
        } else if (cachedDate === getTodayDateKey() && cachedStatusText) {
          const cachedStatusClass = localStorage.getItem('ot_last_status_class');
          if (statusBanner && cachedStatusClass) statusBanner.className = cachedStatusClass;
          if (statusText) statusText.textContent = plainText(cachedStatusText);
          const cachedCheckin = localStorage.getItem('ot_last_checkin');
          if (checkinText && cachedCheckin) checkinText.textContent = shortTime(cachedCheckin);
          const cachedNet = localStorage.getItem('ot_last_network_text');
          if (networkText && cachedNet) networkText.textContent = plainText(cachedNet);
        } else {
          if (statusBanner) statusBanner.className = 'status-banner syncing';
          if (statusText) statusText.textContent = 'Connecting to server…';
          if (networkText) networkText.textContent = 'Checking office Wi-Fi…';
          if (checkinText) checkinText.textContent = '--:--';
        }
      }
      if (activeTimer) activeTimer.textContent = formatHMS(currentActiveSecs);
      consecutiveErrors = 0;
    } else {
      enrollSection.classList.remove('hidden');
      statusSection.classList.add('hidden');
      employeeBadge.textContent = 'Not Enrolled';
      try { localStorage.setItem('ot_enrolled', 'false'); } catch (_) {}
    }
  } catch (err) {
    console.error('refreshStatus error:', err);
    consecutiveErrors++;
    // Only display Reconnecting if persistent consecutive errors occur (prevent momentary flicker)
    if (consecutiveErrors >= 2) {
      if (statusBanner) statusBanner.className = 'status-banner syncing';
      if (statusText) statusText.textContent = 'Reconnecting…';
      if (networkText) networkText.textContent = 'Verifying network…';
    }
    try {
      if (localStorage.getItem('ot_enrolled') === 'true') {
        if (statusSection) statusSection.classList.remove('hidden');
        if (enrollSection) enrollSection.classList.add('hidden');
      } else {
        if (enrollSection) enrollSection.classList.remove('hidden');
        if (statusSection) statusSection.classList.add('hidden');
      }
    } catch (_) {
      if (enrollSection) enrollSection.classList.remove('hidden');
    }
  }
}

// Tick timer locally every second when actively working
clearInterval(timerInterval);
timerInterval = setInterval(() => {
  // Midnight rollover detection on local machine
  const nowDay = new Date().toDateString();
  if (nowDay !== lastLocalDay) {
    lastLocalDay = nowDay;
    dayView = null;
    dayAsOf = 0;
    currentActiveSecs = 0;
    lastSyncedServerSecs = -1;
    lastSyncedDateKey = '';
    renderFreshDay();
    refreshStatus();
    return;
  }

  if (isOnBreakState) {
    updateBreakCountdown();
  } else if (dayView) {
    renderDay();
    if (currentActiveSecs % 30 === 0) saveLocalProgress(currentActiveSecs);
  } else if (creditCounting && statusBanner && !statusBanner.classList.contains('away') && !statusBanner.classList.contains('offline')) {
    currentActiveSecs++;
    if (activeTimer) {
      activeTimer.textContent = formatHMS(currentActiveSecs);
    }
    if (currentActiveSecs % 5 === 0) {
      saveLocalProgress(currentActiveSecs);
      updateShiftTargetDisplay(currentActiveSecs);
    }
  }
}, 1000);

// Window Dragging Support for Frameless Window
const headerEl = document.querySelector('.header');
if (headerEl) {
  headerEl.addEventListener('mousedown', (e) => {
    // The version badge is excluded too: dragging swallowed its clicks, and it
    // opens the hidden developer options (7 clicks).
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a')
        || e.target.closest('#version-badge')) {
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
      enrollError.textContent = 'Please enter your Enrollment Code.';
      enrollError.style.color = '#f87171';
      return;
    }
    
    enrollBtn.disabled = true;
    enrollBtn.textContent = 'Pairing…';
    enrollError.textContent = '';

    try {
      await callBackend('enroll_device', { serverUrl: url, code });
      enrollError.style.color = '#34d399';
      enrollError.textContent = 'Paired. Starting your session…';
      setTimeout(() => {
        refreshStatus();
      }, 1000);
    } catch (e) {
      // Recovery check: In case the network request succeeded in Rust right around the timeout,
      // verify if the device is already marked enrolled in local state/config.
      try {
        const checkStatus = await callBackend('get_app_status');
        if (checkStatus && checkStatus.enrolled) {
          enrollError.style.color = '#34d399';
          enrollError.textContent = 'Paired. Starting your session…';
          setTimeout(() => {
            refreshStatus();
          }, 1000);
          return;
        }
      } catch (_) {}

      enrollError.style.color = '#f87171';
      enrollError.textContent = e.message || 'Enrollment failed. Invalid or expired code.';
    } finally {
      enrollBtn.disabled = false;
      enrollBtn.textContent = 'Pair this laptop';
    }
  });
}

if (minimizeBtn) {
  minimizeBtn.addEventListener('click', () => {
    const win = getTauriWindow();
    if (win && typeof win.minimize === 'function') {
      win.minimize();
    } else {
      window.blur();
    }
  });
}

if (closeBtn) {
  closeBtn.addEventListener('click', () => {
    const win = getTauriWindow();
    if (win && typeof win.hide === 'function') {
      win.hide();
    } else {
      window.close();
    }
  });
}

if (breakToggleBtn) {
  breakToggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (isTogglingBreak || breakStartTimer || breakToggleBtn.disabled || breakToggleBtn.classList.contains('disabled')) return;
    // Starting a break waits 5 seconds so a mis-click can be undone; ending one is immediate.
    if (isOnBreakState) applyBreak(false);
    else startBreakCountdown();
  });
}

function startBreakCountdown() {
  breakSecondsLeft = 5;
  if (undoBreakNum) undoBreakNum.textContent = '5';
  if (undoBreakWrap) undoBreakWrap.classList.remove('hidden');
  breakStartTimer = setInterval(() => {
    breakSecondsLeft--;
    if (undoBreakNum) undoBreakNum.textContent = String(breakSecondsLeft);
    if (breakSecondsLeft > 0) return;
    cancelBreakCountdown();
    // The shift may have ended, or a break started from the phone, while counting down.
    if (isOnBreakState || breakToggleBtn.disabled || breakToggleBtn.classList.contains('disabled')) return;
    applyBreak(true);
  }, 1000);
}

function cancelBreakCountdown() {
  if (breakStartTimer) {
    clearInterval(breakStartTimer);
    breakStartTimer = null;
  }
  if (undoBreakWrap) undoBreakWrap.classList.add('hidden');
}

if (undoBreakBtn) {
  undoBreakBtn.addEventListener('click', () => {
    cancelBreakCountdown();
    showFeedback('Break cancelled. Your shift continues.', false);
  });
}

async function applyBreak(targetIsBreak) {
  if (!breakToggleBtn || isTogglingBreak) return;
  {
    isTogglingBreak = true;
    breakToggleBtn.disabled = true;
    breakToggleBtn.classList.add('disabled');

    if (targetIsBreak) {
      isOnBreakState = true;
      breakStartedAtMs = Date.now();
      if (breakCountdownWrap) breakCountdownWrap.classList.remove('hidden');
      if (statusBanner) statusBanner.className = 'status-banner away';
      if (statusText) statusText.textContent = 'On break';
      breakToggleBtn.textContent = 'Starting break…';
      updateBreakCountdown();
    } else {
      isOnBreakState = false;
      breakStartedAtMs = null;
      if (breakCountdownWrap) breakCountdownWrap.classList.add('hidden');
      if (statusBanner) statusBanner.className = 'status-banner';
      if (statusText) statusText.textContent = 'Active · In office';
      breakToggleBtn.textContent = 'Break taken';
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
  }
}

// The shift's scheduled end as "7:00 PM", from the day view.
function shiftEndLabel() {
  if (!dayView || !dayView.shiftEndAt) return null;
  return new Date(dayView.shiftEndAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// End shift becomes Resume shift while a mistaken end can be undone
// (day.canResume: the employee ended it themselves and it is still the shift).
function updateCheckoutButton() {
  if (!checkoutBtn || checkoutCountdownTimer) return;
  const resume = Boolean(dayView && dayView.canResume);
  checkoutBtn.classList.toggle('resume', resume);
  checkoutBtn.textContent = resume ? 'Resume shift' : 'End shift';
  // Not before the server has sent today's day, not before the shift has run
  // an hour, not before arriving (the server refuses those: people pressed End
  // shift on arriving), and not once the day is over.
  const firstHourEndsAt = dayView && dayView.shiftStartAt ? dayView.shiftStartAt + 60 * 60 * 1000 : 0;
  let blocked = '';
  if (!resume) {
    if (!dayView) blocked = 'Waiting for today from the server';
    else if (dayView.checkedOut) blocked = 'Your shift has ended';
    else if (firstHourEndsAt && Date.now() < firstHourEndsAt) {
      blocked = `End shift is available from ${new Date(firstHourEndsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } else if (!dayView.checkInAt) blocked = "You haven't been recorded as arrived today";
  }
  checkoutBtn.disabled = Boolean(blocked);
  checkoutBtn.classList.toggle('disabled', Boolean(blocked));
  checkoutBtn.title = blocked;
}

async function resumeShift() {
  checkoutBtn.disabled = true;
  try {
    if (isTauri && tauriInvoke) {
      await tauriInvoke('resume_shift');
    } else {
      const res = await fetch('/api/resume', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Could not resume the shift');
    }
    showFeedback('Shift resumed. Time is counted again from now.', false);
    refreshStatus();
  } catch (err) {
    showFeedback((err && err.message) || 'Could not resume the shift. Please try again.');
  } finally {
    checkoutBtn.disabled = false;
  }
}

const endConfirmPanel = document.getElementById('end-confirm-panel');
const endConfirmText = document.getElementById('end-confirm-text');
document.getElementById('end-confirm-cancel')?.addEventListener('click', () => endConfirmPanel?.classList.add('hidden'));
document.getElementById('end-confirm-ok')?.addEventListener('click', () => {
  endConfirmPanel?.classList.add('hidden');
  startCheckoutCountdown();
});

if (checkoutBtn) {
  checkoutBtn.addEventListener('click', () => {
    if (checkoutCountdownTimer) return;
    if (dayView && dayView.canResume) { resumeShift(); return; }
    // Ending before the scheduled end asks first.
    if (dayView && dayView.shiftEndAt && Date.now() < dayView.shiftEndAt && endConfirmPanel) {
      const end = shiftEndLabel();
      if (endConfirmText) {
        endConfirmText.textContent = `Your shift ends at ${end}. If you end it now, no more time is counted today `
          + '(you can resume it later today if this was a mistake).';
      }
      endConfirmPanel.classList.remove('hidden');
      return;
    }
    startCheckoutCountdown();
  });
}

function startCheckoutCountdown() {
  if (!checkoutBtn || checkoutCountdownTimer) return;
  {
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
          showFeedback('Shift checked out.', false);
          refreshStatus();
        } catch (err) {
          // The server explains a refusal (e.g. too early in the shift).
          const msg = typeof err === 'string' ? err : (err && err.message);
          showFeedback(msg || 'Checkout failed. Please try again.');
        } finally {
          checkoutBtn.disabled = false;
          checkoutBtn.classList.remove('disabled');
          updateCheckoutButton();
        }
      }
    }, 1000);
  }
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
    showFeedback('Checkout cancelled. Your session continues.', false);
  });
}

// Listen for Tauri events if running under Tauri (robust retry loop to ensure binding)
async function initTauriEvents() {
  for (let i = 0; i < 30; i++) {
    const t = getTauri();
    if (t && t.event && typeof t.event.listen === 'function') {
      try {
        await t.event.listen('heartbeat-updated', () => {
          refreshStatus();
        });
        break;
      } catch (err) {
        console.warn('Failed to listen to heartbeat-updated:', err);
      }
    }
    await new Promise(r => setTimeout(r, 100));
  }
}
initTauriEvents();

if (activeTimer && currentActiveSecs > 0) {
  activeTimer.textContent = formatHMS(currentActiveSecs);
}
updateShiftTargetDisplay(currentActiveSecs);

refreshStatus();
setInterval(refreshStatus, 10000);

// ---------------------------------------------------------------------------
// Developer options: unpair this laptop.
//
// Hidden on purpose. Seven clicks on the version badge within three seconds
// open it, and it still asks for the word UNPAIR, so nobody stumbles into it.
// ---------------------------------------------------------------------------
(function setupDeveloperUnpair() {
  const badge = document.getElementById('version-badge');
  const panel = document.getElementById('dev-panel');
  const input = document.getElementById('dev-confirm-input');
  const unpairBtn = document.getElementById('dev-unpair-btn');
  const cancelBtn = document.getElementById('dev-cancel-btn');
  const errorEl = document.getElementById('dev-error');
  if (!badge || !panel || !input || !unpairBtn || !cancelBtn) return;

  let clicks = [];
  badge.addEventListener('click', () => {
    const now = Date.now();
    clicks = clicks.filter((t) => now - t < 3000);
    clicks.push(now);
    if (clicks.length >= 7) {
      clicks = [];
      input.value = '';
      unpairBtn.disabled = true;
      if (errorEl) errorEl.textContent = '';
      panel.classList.remove('hidden');
      input.focus();
    }
  });

  const close = () => panel.classList.add('hidden');
  cancelBtn.addEventListener('click', close);
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  input.addEventListener('input', () => {
    unpairBtn.disabled = input.value.trim().toUpperCase() !== 'UNPAIR';
  });

  unpairBtn.addEventListener('click', async () => {
    unpairBtn.disabled = true;
    unpairBtn.textContent = 'Unpairing…';
    try {
      await callBackend('developer_unpair');
      ['ot_enrolled', 'ot_emp_info', 'ot_last_checkin', 'ot_last_status_text', 'ot_last_status_class', 'ot_last_network_text']
        .forEach((k) => { try { localStorage.removeItem(k); } catch (_) {} });
      try { localStorage.setItem('ot_enrolled', 'false'); } catch (_) {}
      close();
      if (statusSection) statusSection.classList.add('hidden');
      if (enrollSection) enrollSection.classList.remove('hidden');
      if (employeeBadge) employeeBadge.textContent = 'Not Enrolled';
    } catch (err) {
      if (errorEl) errorEl.textContent = (err && err.message) || String(err);
      unpairBtn.disabled = false;
    } finally {
      unpairBtn.textContent = 'Unpair laptop';
    }
  });
})();
