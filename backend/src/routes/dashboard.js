const express = require('express');
const router = express.Router();
const { db, getPktDateKey, getPktTime, getPktIsoString, formatMinutes, getEmployeeWorkStats } = require('../store');

// GET /api/dashboard/summary
router.get('/summary', (req, res) => {
  const employees = db.employees || [];
  const movements = db.movements || [];
  const unassignedDevices = db.unassignedDevices || {};

  const now = new Date();
  const todayKey = getPktDateKey(now);

  const presentEmployees = [];
  const graceEmployees = [];
  const awayEmployees = [];
  const todayAttendance = [];

  let totalMinutesSum = 0;
  let attendeesCount = 0;

  employees.forEach(emp => {
    const stats = getEmployeeWorkStats(emp.id, todayKey, now);

    const empObj = {
      id: emp.id,
      name: stats.employeeName,
      role: stats.role,
      deviceModel: stats.deviceModel,
      deviceIp: stats.deviceIp,
      status: stats.presenceStatus,
      statusLabel: stats.statusLabel,
      inactivityMinutes: stats.inactivityMinutes,
      graceMinutesLeft: stats.graceMinutesLeft,
      firstCheckIn: stats.firstCheckIn,
      lastActiveTime: stats.lastActiveTime,
      timeWorkedToday: stats.timeWorkedFormatted,
      totalMinutes: stats.totalMinutes
    };

    if (stats.presenceStatus === 'IN_OFFICE') {
      presentEmployees.push(empObj);
    } else if (stats.presenceStatus === 'GRACE_PERIOD') {
      graceEmployees.push(empObj);
    } else if (stats.presenceStatus === 'AWAY') {
      empObj.departureTime = stats.lastActiveTime;
      awayEmployees.push(empObj);
    }

    if (stats.presenceStatus !== 'NOT_CHECKED_IN') {
      attendeesCount++;
      totalMinutesSum += stats.totalMinutes;
      todayAttendance.push({
        employeeId: emp.id,
        employeeName: stats.employeeName,
        role: stats.role,
        firstCheckIn: stats.firstCheckIn,
        lastActiveTime: stats.lastActiveTime,
        sessions: (stats.sessions || []).map(s => ({
          from: s.startDisplay || getPktTime(s.start),
          to: s.endDisplay || getPktTime(s.end),
          duration: formatMinutes(s.minutes)
        })),
        timeWorkedFormatted: stats.timeWorkedFormatted,
        totalMinutes: stats.totalMinutes,
        presenceStatus: stats.presenceStatus,
        statusLabel: stats.statusLabel
      });
    }
  });

  const avgMins = attendeesCount > 0 ? Math.round(totalMinutesSum / attendeesCount) : 0;
  const dateOptions = { timeZone: 'Asia/Karachi', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const dateFormatted = new Intl.DateTimeFormat('en-US', dateOptions).format(now);

  res.status(200).json({
    status: 'SUCCESS',
    timezone: 'Asia/Karachi (PKT, UTC+5)',
    currentTimePkt: getPktTime(now),
    currentDatePkt: dateFormatted,
    currentDateKey: todayKey,
    stats: {
      totalRegisteredEmployees: employees.length,
      currentlyInOffice: presentEmployees.length,
      currentlyInGracePeriod: graceEmployees.length,
      currentlyAway: awayEmployees.length,
      unassignedDevicesFound: Object.keys(unassignedDevices).length,
      totalAttendeesToday: attendeesCount,
      averageTimeWorkedToday: formatMinutes(avgMins),
      officeConfig: {
        officeName: db.officeConfig?.officeName || 'Main Office',
        ssid: db.officeConfig?.ssid || 'Trans K 2.4G',
        workHours: `${db.officeConfig?.workStartTime || '09:00 AM'} - ${db.officeConfig?.workEndTime || '06:00 PM'}`,
        activeThreshold: `${db.officeConfig?.activeThresholdMinutes || 3} mins`,
        gracePeriod: `${db.officeConfig?.gracePeriodMinutes || 15} mins`
      }
    },
    presentEmployees,
    graceEmployees,
    awayEmployees,
    todayAttendance,
    recentMovements: movements.slice(0, 20).map(m => ({
      id: m.id,
      time: m.displayTime,
      type: m.type,
      name: m.employeeName,
      device: m.deviceModel || '',
      ip: m.ip || '',
      details: m.details || ''
    })),
    unassignedDevices: Object.values(unassignedDevices).map(d => ({
      ip: d.ip,
      firstSeen: getPktTime(d.firstSeen),
      lastSeen: getPktTime(d.lastSeen),
      source: d.source
    }))
  });
});

module.exports = router;