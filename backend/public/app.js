// Office Presence Sentinel — Live Dashboard Frontend Logic

let dashboardData = null;
let currentFilter = 'all';

// Real-time Clock
function startLiveClock() {
  function updateClock() {
    const now = new Date();
    const timeStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(now);

    const dateStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi',
      weekday: 'long',
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }).format(now);

    const clockEl = document.getElementById('liveClock');
    const dateEl = document.getElementById('liveDate');
    if (clockEl) clockEl.textContent = timeStr;
    if (dateEl) dateEl.textContent = dateStr;
  }
  updateClock();
  setInterval(updateClock, 1000);
}

// Fetch Latest Summary
async function fetchSummary() {
  try {
    const res = await fetch('/api/dashboard/summary');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    dashboardData = data;
    renderDashboard(data);
  } catch (err) {
    console.error('[Dashboard] Error fetching summary:', err);
  }
}

// Render Dashboard
function renderDashboard(data) {
  if (!data || !data.stats) return;

  // 1. Metric Hero Cards
  const activeCount = (data.stats.currentlyInOffice || 0) + (data.stats.currentlyInGracePeriod || 0);
  document.getElementById('inOfficeCount').textContent = data.stats.currentlyInOffice || 0;
  if (document.getElementById('graceCount')) document.getElementById('graceCount').textContent = data.stats.currentlyInGracePeriod || 0;
  
  const graceText = data.stats.currentlyInGracePeriod > 0 
    ? ` (${data.stats.currentlyInGracePeriod} in grace period)` 
    : '';
  document.getElementById('inOfficeSub').textContent = `${data.stats.currentlyInOffice || 0} active${graceText} • ${data.stats.totalRegisteredEmployees || 0} total`;
  
  document.getElementById('awayCount').textContent = data.stats.currentlyAway || 0;
  document.getElementById('totalAttendeesCount').textContent = data.stats.totalAttendeesToday || 0;
  document.getElementById('avgTimeWorked').textContent = data.stats.averageTimeWorkedToday || '0 mins';
  document.getElementById('employeeCountBadge').textContent = `${data.stats.totalRegisteredEmployees || 0} Registered`;

  // 2. Render Employee Grid
  renderEmployees(data);

  // 3. Render Activity Feed
  renderTimeline(data.recentMovements || []);

  // 4. Render Unassigned Devices
  renderUnassigned(data.unassignedDevices || []);

  // 5. Render Office Config
  if (data.stats.officeConfig) {
    document.getElementById('cfgSsid').textContent = data.stats.officeConfig.ssid || 'Trans K 2.4G';
    document.getElementById('cfgGrace').textContent = `${data.stats.officeConfig.activeThreshold || '3 mins'} active / ${data.stats.officeConfig.gracePeriod || '15 mins'} grace`;
    document.getElementById('cfgHours').textContent = data.stats.officeConfig.workHours || '09:00 AM - 06:00 PM';
  }
}

function renderEmployees(data) {
  const grid = document.getElementById('employeeGrid');
  const allEmployees = [
    ...(data.presentEmployees || []),
    ...(data.graceEmployees || []),
    ...(data.awayEmployees || [])
  ];

  if (allEmployees.length === 0) {
    grid.innerHTML = `
      <div class="empty-text" style="grid-column: 1/-1;">
        <i class="fa-solid fa-user-slash" style="font-size: 32px; color: var(--text-dim); margin-bottom: 8px;"></i>
        <p>No registered employees checked in yet today.</p>
      </div>
    `;
    return;
  }

  let filtered = allEmployees;
  if (currentFilter === 'in_office') {
    filtered = allEmployees.filter(e => e.status === 'IN_OFFICE' || e.status === 'GRACE_PERIOD');
  } else if (currentFilter === 'away') {
    filtered = allEmployees.filter(e => e.status === 'AWAY');
  }

  if (filtered.length === 0) {
    grid.innerHTML = `<p class="empty-text" style="grid-column: 1/-1;">No employees match filter "${currentFilter}".</p>`;
    return;
  }

  grid.innerHTML = filtered.map(emp => {
    let cardClass = 'in-office';
    let statusPill = `<span class="status-pill online"><i class="fa-solid fa-circle-dot"></i> In Office</span>`;

    if (emp.status === 'GRACE_PERIOD') {
      cardClass = 'grace-period';
      statusPill = `<span class="status-pill grace"><i class="fa-solid fa-hourglass-half fa-spin"></i> Grace (${emp.graceMinutesLeft}m left)</span>`;
    } else if (emp.status === 'AWAY') {
      cardClass = 'away';
      statusPill = `<span class="status-pill away"><i class="fa-solid fa-person-walking"></i> Away (Break)</span>`;
    }

    const initials = emp.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();

    return `
      <div class="employee-card ${cardClass}" onclick="openEmployeeModal('${emp.id}')">
        <div class="emp-top-row">
          <div class="emp-profile">
            <div class="emp-avatar">${initials}</div>
            <div class="emp-name-role">
              <h4>${emp.name}</h4>
              <span class="emp-role">${emp.role || 'Engineering'}</span>
            </div>
          </div>
          ${statusPill}
        </div>

        <div class="emp-metrics-row">
          <div class="emp-metric-item">
            <span class="emp-metric-label">First Check-In</span>
            <span class="emp-metric-value">${emp.firstCheckIn || '--:--'}</span>
          </div>
          <div class="emp-metric-item">
            <span class="emp-metric-label">Work Time Today</span>
            <span class="emp-metric-value highlight">${emp.timeWorkedToday || '0 mins'}</span>
          </div>
        </div>

        <div class="emp-bottom-row">
          <span class="emp-device-tag">
            <i class="fa-solid fa-mobile-screen"></i>
            ${emp.deviceModel || 'Phone'} (${emp.deviceIp || 'Wi-Fi'})
          </span>
          <button class="btn-view-sessions" onclick="event.stopPropagation(); openEmployeeModal('${emp.id}')">
            View Sessions <i class="fa-solid fa-chevron-right"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function renderTimeline(movements) {
  const container = document.getElementById('movementTimeline');
  if (!movements || movements.length === 0) {
    container.innerHTML = '<p class="empty-text">No activity recorded yet today.</p>';
    return;
  }

  container.innerHTML = movements.map(m => {
    let iconClass = 'arrived';
    let icon = 'fa-arrow-right-to-bracket';

    if (m.type === 'DEPARTED') {
      iconClass = 'departed';
      icon = 'fa-person-walking-arrow-right';
    } else if (m.type === 'RECONNECTED') {
      iconClass = 'reconnected';
      icon = 'fa-rotate-right';
    } else if (m.type === 'DEVICE_DISCOVERED') {
      iconClass = 'discovered';
      icon = 'fa-wifi';
    } else if (m.type === 'DEVICE_REGISTERED') {
      iconClass = 'arrived';
      icon = 'fa-address-card';
    }

    return `
      <div class="timeline-item">
        <div class="timeline-icon ${iconClass}">
          <i class="fa-solid ${icon}"></i>
        </div>
        <div class="timeline-content">
          <div class="timeline-top">
            <span class="timeline-title">${m.name || 'Network Event'}</span>
            <span class="timeline-time">${m.time}</span>
          </div>
          <p class="timeline-desc">${m.details || m.type}</p>
        </div>
      </div>
    `;
  }).join('');
}

function renderUnassigned(devices) {
  const list = document.getElementById('unassignedList');
  const countBadge = document.getElementById('unassignedCountBadge');
  countBadge.textContent = `${devices.length} Devices`;

  if (devices.length === 0) {
    list.innerHTML = '<p class="empty-text">No unknown devices currently broadcasting sweeps.</p>';
    return;
  }

  list.innerHTML = devices.map(d => `
    <div class="unassigned-item">
      <div>
        <span class="unassigned-ip"><i class="fa-solid fa-network-wired"></i> ${d.ip}</span>
        <span class="unassigned-time" style="display:block;">Seen ${d.lastSeen} (${d.source || 'Wi-Fi'})</span>
      </div>
      <button class="btn-view-sessions" style="padding: 4px 10px; background: rgba(16,185,129,0.15); border-radius: 6px;" onclick="openPairModal('${d.ip}', '${d.mac || ''}')">
        <i class="fa-solid fa-plus"></i> Assign
      </button>
    </div>
  `).join('');
}

function openPairModal(ip, mac) {
  if (!dashboardData) return;
  const select = document.getElementById('pairEmployeeSelect');
  const allEmployees = [
    ...(dashboardData.presentEmployees || []),
    ...(dashboardData.graceEmployees || []),
    ...(dashboardData.awayEmployees || [])
  ];

  select.innerHTML = allEmployees.map(e => `
    <option value="${e.id}">${e.name} (${e.role || 'Engineering'})</option>
  `).join('');

  document.getElementById('pairTargetIp').value = ip;
  document.getElementById('pairTargetMac').value = mac;
  document.getElementById('pairModalIpSubtitle').textContent = `Assign IP: ${ip} ${mac ? '(MAC: ' + mac + ')' : ''}`;
  document.getElementById('pairDeviceModal').classList.add('active');
}

const pairForm = document.getElementById('pairDeviceForm');
if (pairForm) {
  pairForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const empId = document.getElementById('pairEmployeeSelect').value;
    const model = document.getElementById('pairDeviceModel').value || 'Mobile Device';
    const ip = document.getElementById('pairTargetIp').value;
    const mac = document.getElementById('pairTargetMac').value;

    const allEmployees = [
      ...(dashboardData.presentEmployees || []),
      ...(dashboardData.graceEmployees || []),
      ...(dashboardData.awayEmployees || [])
    ];
    const emp = allEmployees.find(e => e.id === empId);

    try {
      await fetch('/api/attendance/register-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: empId,
          name: emp ? emp.name : 'Employee',
          role: emp ? emp.role : 'Engineering',
          deviceModel: model,
          deviceIp: ip,
          deviceMac: mac
        })
      });
      document.getElementById('pairDeviceModal').classList.remove('active');
      fetchSummary();
    } catch (err) {
      alert('Error pairing device: ' + err.message);
    }
  });
}

const closePairBtn = document.getElementById('closePairModalBtn');
if (closePairBtn) {
  closePairBtn.addEventListener('click', () => {
    document.getElementById('pairDeviceModal').classList.remove('active');
  });
}

// Modal View
function openEmployeeModal(empId) {
  if (!dashboardData) return;
  const allEmployees = [
    ...(dashboardData.presentEmployees || []),
    ...(dashboardData.graceEmployees || []),
    ...(dashboardData.awayEmployees || [])
  ];
  const emp = allEmployees.find(e => e.id === empId);
  if (!emp) return;

  const attendance = (dashboardData.todayAttendance || []).find(a => a.employeeId === empId) || {};
  const sessions = attendance.sessions || [];

  document.getElementById('modalEmployeeName').textContent = emp.name;
  document.getElementById('modalEmployeeMeta').textContent = `${emp.role || 'Engineering'} • ${emp.deviceModel || 'Mobile'} (${emp.deviceIp || ''})`;
  document.getElementById('modalFirstCheckIn').textContent = emp.firstCheckIn || '--:--';
  document.getElementById('modalTotalTime').textContent = emp.timeWorkedToday || '0 mins';
  
  let statusText = '🟢 In Office (Active)';
  if (emp.status === 'GRACE_PERIOD') {
    statusText = `🟡 In Grace Period (${emp.graceMinutesLeft}m remaining)`;
  } else if (emp.status === 'AWAY') {
    statusText = '🔴 Away (On Break / Left Office)';
  }
  document.getElementById('modalStatusBadge').textContent = statusText;

  const sessionContainer = document.getElementById('modalSessionsList');
  if (sessions.length === 0) {
    if (emp.status === 'IN_OFFICE' || emp.status === 'GRACE_PERIOD') {
      sessionContainer.innerHTML = `
        <div class="session-row">
          <span class="session-times"><i class="fa-solid fa-play"></i> ${emp.firstCheckIn || 'Check-in'} → Present</span>
          <span class="session-duration">${emp.timeWorkedToday} (Active Session)</span>
        </div>
      `;
    } else {
      sessionContainer.innerHTML = '<p class="empty-text">No completed sessions logged yet.</p>';
    }
  } else {
    sessionContainer.innerHTML = sessions.map((s, idx) => `
      <div class="session-row">
        <span class="session-times"><i class="fa-solid fa-check"></i> Session ${idx + 1}: ${s.from} → ${s.to}</span>
        <span class="session-duration">${s.duration}</span>
      </div>
    `).join('') + (emp.status !== 'AWAY' ? `
      <div class="session-row" style="border-color: rgba(16,185,129,0.3);">
        <span class="session-times"><i class="fa-solid fa-play" style="color:#34D399;"></i> Active: ${emp.lastActiveTime} → Present</span>
        <span class="session-duration" style="background: rgba(16,185,129,0.2);">In Progress</span>
      </div>
    ` : '');
  }

  document.getElementById('sessionModal').classList.add('active');
}

// Close Modal
document.getElementById('closeModalBtn').addEventListener('click', () => {
  document.getElementById('sessionModal').classList.remove('active');
});

document.getElementById('sessionModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('sessionModal')) {
    document.getElementById('sessionModal').classList.remove('active');
  }
});

// Filter Tabs
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    if (dashboardData) renderEmployees(dashboardData);
  });
});

// Refresh Button
document.getElementById('refreshBtn').addEventListener('click', () => {
  const btn = document.getElementById('refreshBtn');
  btn.style.transform = 'rotate(180deg)';
  fetchSummary().then(() => {
    setTimeout(() => { btn.style.transform = 'none'; }, 300);
  });
});

// Server-Sent Events (SSE) for Instant Real-Time Push
function setupSSE() {
  try {
    const evtSource = new EventSource('/api/events');
    evtSource.onmessage = (e) => {
      console.log('[SSE Event]', e.data);
      fetchSummary();
    };
    evtSource.onerror = () => {
      console.warn('[SSE] Reconnecting SSE stream...');
    };
  } catch (_) {}
}

// Initialize on Load
window.addEventListener('DOMContentLoaded', () => {
  startLiveClock();
  fetchSummary();
  setupSSE();
  setInterval(fetchSummary, 5000);
});

