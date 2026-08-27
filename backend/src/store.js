const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const TIMEZONE = 'Asia/Karachi'; // Pakistan Standard Time (UTC+5)

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeIp(ip) {
  if (!ip) return '';
  return ip.replace(/^.*:/, '').trim();
}

function normalizeMac(mac) {
  if (!mac) return '';
  return mac.toLowerCase().replace(/-/g, ':').trim();
}

function getPktIsoString(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const tzOffsetMs = 5 * 60 * 60 * 1000;
  const pktDate = new Date(d.getTime() + tzOffsetMs);
  return pktDate.toISOString().replace('Z', '+05:00');
}

function getPktTime(date = new Date()) {
  if (!date) return '--:--';
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(d);
}

function getPktDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

function formatMinutes(totalMins) {
  const mins = Math.max(0, Math.round(totalMins || 0));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} mins`;
  return `${h}h ${m}m`;
}

const initialData = {
  officeConfig: {
    officeName: 'Trans K Office (Pakistan)',
    ssid: 'Trans K 2.4G',
    timeZone: 'Asia/Karachi (UTC+5)',
    subnet: '192.168.18.0/24',
    gatewayIp: '192.168.18.1',
    serverIp: '192.168.18.68',
    espIp: '192.168.18.81',
    activeThresholdMinutes: 3,
    gracePeriodMinutes: 15,
    workStartTime: '09:00 AM',
    workEndTime: '06:00 PM'
  },
  ignoredIps: [
    '192.168.18.1',
    '192.168.18.68',
    '192.168.18.81',
    '192.168.18.255'
  ],
  employees: [],
  unassignedDevices: {},
  movements: [],
  attendanceRecords: {}
};

function loadDb() {
  let data = { ...initialData };
  try {
    if (fs.existsSync(DATA_FILE)) {
      const c = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(c);
      data = { ...initialData, ...parsed };
    }
  } catch (err) {
    console.error('[DB] Initializing fresh database');
  }
  data.ignoredIps = data.ignoredIps || initialData.ignoredIps;
  data.employees = data.employees || [];
  data.unassignedDevices = data.unassignedDevices || {};
  data.movements = data.movements || [];
  data.attendanceRecords = data.attendanceRecords || {};
  return data;
}

let db = loadDb();
let isDirty = false;

function saveDb() {
  isDirty = true;
}

setInterval(() => {
  if (isDirty) {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf-8');
      isDirty = false;
    } catch (err) {
      console.error('[DB] Error saving:', err.message);
    }
  }
}, 3000);

let sseClients = [];

function registerSseClient(res) {
  sseClients.push(res);
  res.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
}

function broadcastEvent(eventType, payload) {
  const payloadStr = JSON.stringify({ type: eventType, data: payload, timestamp: getPktIsoString() });
  sseClients.forEach(client => {
    client.write('data: ' + payloadStr + '\n\n');
  });
}

function logMovement(type, employee, ip, mac, details = '') {
  const cleanIp = normalizeIp(ip);
  const cleanMac = normalizeMac(mac);
  const movement = {
    id: 'mov_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    timestamp: getPktIsoString(),
    displayTime: getPktTime(),
    type,
    employeeId: employee ? employee.id : null,
    employeeName: employee ? employee.name : (cleanIp ? 'Device (' + cleanIp + ')' : 'Network Event'),
    deviceModel: employee ? employee.deviceModel : '',
    ip: cleanIp || (employee ? employee.deviceIp : ''),
    mac: cleanMac || (employee ? employee.deviceMac : ''),
    details
  };

  db.movements.unshift(movement);
  if (db.movements.length > 1000) db.movements.pop();

  saveDb();
  broadcastEvent('MOVEMENT_LOGGED', movement);
  return movement;
}

// 3-State Presence Calculator (IN_OFFICE -> GRACE_PERIOD -> AWAY)
function getEmployeeWorkStats(employeeId, dateKey = getPktDateKey(), now = new Date()) {
  const emp = (db.employees || []).find(e => e.id === employeeId);
  const dayLedger = (db.attendanceRecords[dateKey] && db.attendanceRecords[dateKey][employeeId]);

  if (!dayLedger) {
    return {
      employeeId,
      employeeName: emp ? emp.name : 'Unknown',
      role: emp ? emp.role : 'Engineering',
      deviceModel: emp ? emp.deviceModel : 'Phone',
      deviceIp: emp ? emp.deviceIp : '',
      firstCheckIn: '--',
      lastActiveTime: '--',
      totalMinutes: 0,
      timeWorkedFormatted: '0 mins',
      presenceStatus: 'NOT_CHECKED_IN',
      statusLabel: 'Not Arrived Yet',
      inactivityMinutes: 0,
      graceMinutesLeft: 0,
      sessions: []
    };
  }

  let pastMinutes = 0;
  const sessions = dayLedger.sessions || [];
  sessions.forEach(s => {
    pastMinutes += (s.minutes || 0);
  });

  const lastActiveDate = dayLedger.lastActive ? new Date(dayLedger.lastActive) : now;
  const inactivityMs = Math.max(0, now.getTime() - lastActiveDate.getTime());
  const inactivityMins = Math.floor(inactivityMs / 60000);

  const ACTIVE_THRESHOLD_MS = (db.officeConfig?.activeThresholdMinutes || 3) * 60 * 1000;
  const GRACE_PERIOD_MS = (db.officeConfig?.gracePeriodMinutes || 15) * 60 * 1000;

  let presenceStatus = 'IN_OFFICE';
  let statusLabel = 'In Office';
  let graceMinutesLeft = 0;

  if (dayLedger.status === 'AWAY' || inactivityMs > GRACE_PERIOD_MS) {
    presenceStatus = 'AWAY';
    statusLabel = 'Away / On Break';
  } else if (inactivityMs >= ACTIVE_THRESHOLD_MS) {
    presenceStatus = 'GRACE_PERIOD';
    graceMinutesLeft = Math.max(1, Math.round((GRACE_PERIOD_MS - inactivityMs) / 60000));
    statusLabel = `Grace Period (${graceMinutesLeft}m remaining)`;
  } else {
    presenceStatus = 'IN_OFFICE';
    statusLabel = 'Active in Office';
  }

  let activeSessionMinutes = 0;
  if (presenceStatus !== 'AWAY' && dayLedger.currentSessionStart) {
    const startDate = new Date(dayLedger.currentSessionStart);
    activeSessionMinutes = Math.max(1, Math.round((now.getTime() - startDate.getTime()) / 60000));
  }

  const totalMinutes = pastMinutes + activeSessionMinutes;

  return {
    employeeId,
    employeeName: emp ? emp.name : dayLedger.employeeName,
    role: emp ? emp.role : dayLedger.role,
    deviceModel: emp ? emp.deviceModel : 'Phone',
    deviceIp: emp ? emp.deviceIp : '',
    firstCheckIn: dayLedger.firstCheckInDisplay || getPktTime(dayLedger.firstCheckIn),
    lastActiveTime: dayLedger.lastActiveDisplay || getPktTime(dayLedger.lastActive),
    totalMinutes,
    timeWorkedFormatted: formatMinutes(totalMinutes),
    presenceStatus,
    statusLabel,
    inactivityMinutes: inactivityMins,
    graceMinutesLeft,
    sessions
  };
}

function processDeviceSeen(ip, mac = '', source = 'ESP8266_SWEEP') {
  const cleanIp = normalizeIp(ip);
  const cleanMac = normalizeMac(mac);
  if (!cleanIp && !cleanMac) return { employee: null, isNew: false };

  const ignored = db.ignoredIps || ['192.168.18.1', '192.168.18.68', '192.168.18.81', '192.168.18.255'];
  if (ignored.includes(cleanIp)) {
    return { employee: null, isIgnored: true };
  }

  const now = new Date();
  const todayKey = getPktDateKey(now);
  const pktIso = getPktIsoString(now);
  const pktTimeStr = getPktTime(now);
  
  if (!db.attendanceRecords[todayKey]) {
    db.attendanceRecords[todayKey] = {};
  }

  // Strict matching: Only match if MAC matches, or if IP explicitly matches employee's registered device
  let employee = (db.employees || []).find(e => {
    const macMatch = cleanMac && e.deviceMac && normalizeMac(e.deviceMac) === cleanMac;
    const ipMatch = cleanIp && e.deviceIp && e.deviceIp === cleanIp;
    return macMatch || ipMatch;
  });

  if (employee) {
    let dayLedger = db.attendanceRecords[todayKey][employee.id];
    const isFirstTimeToday = !dayLedger;

    if (isFirstTimeToday) {
      dayLedger = {
        employeeId: employee.id,
        employeeName: employee.name,
        role: employee.role,
        firstCheckIn: pktIso,
        firstCheckInDisplay: pktTimeStr,
        lastActive: pktIso,
        lastActiveDisplay: pktTimeStr,
        sessions: [],
        currentSessionStart: pktIso,
        status: 'IN_OFFICE'
      };
      db.attendanceRecords[todayKey][employee.id] = dayLedger;

      employee.status = 'IN_OFFICE';
      employee.lastSeen = pktIso;
      if (cleanIp) employee.deviceIp = cleanIp;
      if (cleanMac) employee.deviceMac = cleanMac;

      console.log('[Presence PKT] 🟢 ' + employee.name + ' ARRIVED at ' + pktTimeStr + ' (MAC: ' + cleanMac + ')');
      logMovement('ARRIVED', employee, cleanIp, cleanMac, 'Checked in via ' + source);
    } else {
      const wasAway = dayLedger.status === 'AWAY';

      if (wasAway) {
        dayLedger.status = 'IN_OFFICE';
        dayLedger.currentSessionStart = pktIso;
        employee.status = 'IN_OFFICE';
        console.log('[Presence PKT] 🟢 ' + employee.name + ' RECONNECTED / RETURNED at ' + pktTimeStr + ' (MAC: ' + cleanMac + ')');
        logMovement('RECONNECTED', employee, cleanIp, cleanMac, 'Returned from break (' + source + ')');
      }

      employee.status = 'IN_OFFICE';
      employee.lastSeen = pktIso;
      if (cleanIp) employee.deviceIp = cleanIp;
      if (cleanMac) employee.deviceMac = cleanMac;

      dayLedger.lastActive = pktIso;
      dayLedger.lastActiveDisplay = pktTimeStr;
    }

    if (db.unassignedDevices && db.unassignedDevices[cleanIp]) {
      delete db.unassignedDevices[cleanIp];
    }

    saveDb();
    broadcastEvent('EMPLOYEE_STATUS_UPDATED', employee);
    return { employee, isNew: isFirstTimeToday };
  } else {
    // Unassigned device on office network
    if (!db.unassignedDevices) db.unassignedDevices = {};
    if (cleanIp) {
      if (!db.unassignedDevices[cleanIp]) {
        db.unassignedDevices[cleanIp] = {
          ip: cleanIp,
          mac: cleanMac,
          firstSeen: pktIso,
          lastSeen: pktIso,
          source
        };
        console.log('[New Device PKT] 📱 Discovered other office device: ' + cleanIp + ' (MAC: ' + cleanMac + ')');
        logMovement('DEVICE_DISCOVERED', null, cleanIp, cleanMac, 'Other device on office Wi-Fi (' + source + ')');
      } else {
        db.unassignedDevices[cleanIp].lastSeen = pktIso;
        if (cleanMac) db.unassignedDevices[cleanIp].mac = cleanMac;
      }
      saveDb();
    }
    return { employee: null, isNew: false, unassignedIp: cleanIp };
  }
}

function checkDepartures() {
  const now = new Date();
  const graceMs = (db.officeConfig?.gracePeriodMinutes || 15) * 60 * 1000;
  const todayKey = getPktDateKey(now);

  (db.employees || []).forEach(emp => {
    const dayLedger = db.attendanceRecords[todayKey] && db.attendanceRecords[todayKey][emp.id];
    if (dayLedger && dayLedger.status !== 'AWAY' && dayLedger.lastActive) {
      const lastActiveDate = new Date(dayLedger.lastActive);
      if (now.getTime() - lastActiveDate.getTime() > graceMs) {
        dayLedger.status = 'AWAY';
        emp.status = 'AWAY';

        if (dayLedger.currentSessionStart) {
          const start = new Date(dayLedger.currentSessionStart);
          const sessionMins = Math.max(1, Math.round((lastActiveDate.getTime() - start.getTime()) / 60000));
          if (!dayLedger.sessions) dayLedger.sessions = [];
          dayLedger.sessions.push({
            start: getPktIsoString(start),
            startDisplay: getPktTime(start),
            end: getPktIsoString(lastActiveDate),
            endDisplay: getPktTime(lastActiveDate),
            minutes: sessionMins
          });
          dayLedger.currentSessionStart = null;
        }

        console.log('[Presence PKT] 🔴 ' + emp.name + ' marked AWAY (Last active: ' + getPktTime(lastActiveDate) + ')');
        logMovement('DEPARTED', emp, emp.deviceIp, emp.deviceMac, 'No Wi-Fi activity for ' + db.officeConfig.gracePeriodMinutes + ' mins');
        broadcastEvent('EMPLOYEE_STATUS_UPDATED', emp);
      }
    }
  });
  saveDb();
}

setInterval(checkDepartures, 30000);

module.exports = {
  db,
  saveDb,
  normalizeIp,
  normalizeMac,
  getPktTime,
  getPktDateKey,
  getPktIsoString,
  formatMinutes,
  getEmployeeWorkStats,
  logMovement,
  processDeviceSeen,
  registerSseClient,
  broadcastEvent
};