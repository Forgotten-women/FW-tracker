const express = require('express');
const router = express.Router();
const { db, saveDb, normalizeIp, getPktTime, getPktDateKey, getPktIsoString, logMovement, processDeviceSeen, broadcastEvent } = require('../store');

// 1. ESP8266 Subnet Sweep Heartbeat Inbound
router.post('/heartbeat', (req, res) => {
  const { office_id, devices = [] } = req.body;

  const results = [];
  for (const device of devices) {
    if (device.ip) {
      const result = processDeviceSeen(device.ip, device.mac || '', 'ESP8266_SWEEP');
      if (!result.isIgnored) {
        results.push({ ip: normalizeIp(device.ip), employee: result.employee ? result.employee.name : null });
      }
    }
  }

  res.status(200).json({
    status: 'SUCCESS',
    timestamp: getPktIsoString(),
    displayTime: getPktTime(),
    processedCount: results.length,
    devices: results
  });
});

// 2. Mobile App Direct Heartbeat / Check-in Ping
router.post('/mobile-ping', (req, res) => {
  const { employeeId, employeeName, employeeRole, deviceModel, localIp } = req.body;
  const rawIp = localIp || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const clientIp = normalizeIp(rawIp);
  const now = new Date();
  const pktIso = getPktIsoString(now);
  const pktTimeStr = getPktTime(now);

  if (!db.employees) db.employees = [];
  let employee = db.employees.find(e => (employeeId && e.id === employeeId) || (clientIp && e.deviceIp === clientIp));

  if (!employee && employeeName) {
    employee = {
      id: employeeId || 'emp_' + Date.now(),
      name: employeeName,
      role: employeeRole || 'Team Member',
      deviceModel: deviceModel || 'Mobile Device',
      deviceIp: clientIp,
      deviceMac: '',
      isRegistered: true,
      lastSeen: pktIso,
      firstSeenToday: pktIso,
      status: 'IN_OFFICE'
    };
    db.employees.push(employee);
    if (db.unassignedDevices && db.unassignedDevices[clientIp]) {
      delete db.unassignedDevices[clientIp];
    }
    saveDb();
    logMovement('EMPLOYEE_REGISTERED', employee, clientIp, '', 'Registered from Mobile App (' + pktTimeStr + ')');
  }

  if (employee) {
    if (clientIp) employee.deviceIp = clientIp;
    processDeviceSeen(employee.deviceIp, employee.deviceMac, 'MOBILE_APP_PING');
  }

  const todayKey = getPktDateKey();
  const todayRecord = employee ? (db.attendanceRecords && db.attendanceRecords[todayKey] ? db.attendanceRecords[todayKey][employee.id] : null) : null;

  res.status(200).json({
    status: 'SUCCESS',
    message: 'Presence confirmed',
    employee,
    todayAttendance: todayRecord,
    serverTimePkt: pktTimeStr,
    timestamp: pktIso
  });
});

// 3. Register or Assign Device to Employee (Admin or Mobile)
router.post('/register-device', (req, res) => {
  const { id, name, role, deviceModel, deviceIp, deviceMac } = req.body;
  const rawIp = deviceIp || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const cleanIp = normalizeIp(rawIp);
  const now = new Date();
  const pktIso = getPktIsoString(now);
  const pktTimeStr = getPktTime(now);
  const todayKey = getPktDateKey(now);

  if (!name) {
    return res.status(400).json({ status: 'ERROR', message: 'Employee name is required' });
  }

  if (!db.employees) db.employees = [];
  let employee = db.employees.find(e => (id && e.id === id) || (cleanIp && e.deviceIp === cleanIp));

  if (employee) {
    employee.name = name;
    if (role) employee.role = role;
    if (deviceModel) employee.deviceModel = deviceModel;
    if (cleanIp) employee.deviceIp = cleanIp;
    if (deviceMac) employee.deviceMac = deviceMac;
    employee.status = 'IN_OFFICE';
    employee.lastSeen = pktIso;
    if (!employee.firstSeenToday) employee.firstSeenToday = pktIso;
  } else {
    employee = {
      id: id || 'emp_' + Date.now(),
      name,
      role: role || 'Team Member',
      deviceModel: deviceModel || 'Device',
      deviceIp: cleanIp || '',
      deviceMac: deviceMac || '',
      isRegistered: true,
      lastSeen: pktIso,
      firstSeenToday: pktIso,
      status: 'IN_OFFICE'
    };
    db.employees.push(employee);
  }

  if (cleanIp && db.unassignedDevices && db.unassignedDevices[cleanIp]) {
    delete db.unassignedDevices[cleanIp];
  }

  if (!db.attendanceRecords[todayKey]) db.attendanceRecords[todayKey] = {};
  if (!db.attendanceRecords[todayKey][employee.id]) {
    db.attendanceRecords[todayKey][employee.id] = {
      employeeId: employee.id,
      employeeName: employee.name,
      role: employee.role,
      checkIn: pktIso,
      checkInDisplay: pktTimeStr,
      checkOut: pktIso,
      checkOutDisplay: pktTimeStr,
      totalMinutes: 1,
      status: 'PRESENT'
    };
  }

  saveDb();
  logMovement('DEVICE_REGISTERED', employee, employee.deviceIp, employee.deviceMac, 'Device paired at ' + pktTimeStr);
  broadcastEvent('EMPLOYEE_REGISTERED', employee);

  res.status(200).json({
    status: 'SUCCESS',
    message: 'Employee registered successfully',
    employee,
    todayAttendance: db.attendanceRecords[todayKey][employee.id]
  });
});

// 4. Complete Fresh Reset
router.post('/reset-logs', (req, res) => {
  db.employees = [];
  db.movements = [];
  db.attendanceRecords = {};
  db.unassignedDevices = {};
  saveDb();
  res.status(200).json({ status: 'SUCCESS', message: 'All employees, logs, and attendance wiped clean.' });
});

// 5. Get Real-time Live Presence Board
router.get('/live', (req, res) => {
  const employees = db.employees || [];
  const present = employees.filter(e => e.status === 'IN_OFFICE');
  const away = employees.filter(e => e.status !== 'IN_OFFICE');

  res.status(200).json({
    status: 'SUCCESS',
    presentCount: present.length,
    awayCount: away.length,
    present,
    away,
    unassignedDevices: Object.values(db.unassignedDevices || {})
  });
});

// 6. Get Recent Logs
router.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const movements = db.movements || [];
  res.status(200).json({
    status: 'SUCCESS',
    totalLogs: movements.length,
    logs: movements.slice(0, limit)
  });
});

module.exports = router;