// Dashboard summary. Reads only - every number here comes from the same
// derivation the app and the live board use, so the three can no longer
// disagree about the same person.

const express = require('express');
const router = express.Router();

const { db } = require('../db');
const { config } = require('../config');
const { requireAdmin } = require('../middleware/auth');
const P = require('../domain/presence');
const events = require('../events');
const T = require('../util/time');

router.use(requireAdmin);

router.get('/summary', async (req, res) => {
  const nowMs = T.now();
  const todayKey = T.dateKey(nowMs);
  const board = await P.liveBoard(nowMs);

  const inOffice = board.filter(e => e.status === 'IN_OFFICE');
  const grace = board.filter(e => e.status === 'GRACE_PERIOD');
  const away = board.filter(e => e.status === 'AWAY');
  const attended = board.filter(e => e.status !== 'NOT_CHECKED_IN');

  const totalMinutes = attended.reduce((a, e) => a + e.totalMinutes, 0);
  const avgMinutes = attended.length ? Math.round(totalMinutes / attended.length) : 0;

  // Unknown devices are stored as salted hashes on a short TTL, so this is a
  // count of distinct unrecognised devices - never a list of identifiers.
  //
  // Devices seen only once or twice are excluded. Before the firmware filtered
  // by office BSSID this number reached 175 for a team of about 50, because the
  // sniffer was reporting every device on all 13 neighbouring networks plus a
  // fresh randomised MAC for every phone that probed while walking past.
  // Two thirds of those rows had a single sighting.
  const dayAgo = nowMs - 24 * 60 * 60 * 1000;
  const minSightings = config.unknownDeviceMinSightings;

  const unknownCount = (await db.prepare(
    'SELECT COUNT(*) c FROM unknown_devices WHERE last_seen_at > ? AND sighting_count >= ?'
  ).get(dayAgo, minSightings)).c;

  // Kept visible so a return of the flood is obvious rather than silently
  // filtered away.
  const unknownTransient = (await db.prepare(
    'SELECT COUNT(*) c FROM unknown_devices WHERE last_seen_at > ? AND sighting_count < ?'
  ).get(dayAgo, minSightings)).c;

  const movements = await db.prepare('SELECT * FROM movements ORDER BY at DESC LIMIT 20').all();

  // Days where a session hit the cap, usually a phone left in the office
  // overnight. Surfaced rather than silently truncated, so HR can correct it.
  const needsReview = board.filter(e => e.needsReview);

  res.json({
    status: 'SUCCESS',
    timezone: config.timeZone,
    currentTime: T.displayTime(nowMs),
    currentDate: T.displayDate(nowMs),
    currentDateKey: todayKey,
    stats: {
      totalActiveEmployees: board.length,
      currentlyInOffice: inOffice.length,
      currentlyInGracePeriod: grace.length,
      currentlyAway: away.length,
      totalAttendeesToday: attended.length,
      unknownDevicesSeen24h: unknownCount,
      unknownDevicesTransient24h: unknownTransient,
      unknownDeviceMinSightings: minSightings,
      averageTimeWorkedToday: T.formatMinutes(avgMinutes),
      liveDashboardClients: events.clientCount(),
    },
    officeConfig: {
      officeName: config.office.officeName,
      networks: (config.office.networks || []).map(n => `${n.ssid} (${n.band}GHz)`),
      workHours: `${config.workStartTime} - ${config.workEndTime}`,
      requiredDailyWorkingHours: '8h 00m',
      requiredDailyWorkingMinutes: 480,
      activeThreshold: `${config.activeThresholdMinutes} mins`,
      gracePeriod: `${config.gracePeriodMinutes} mins`,
      // Three states, not two. "4 listed but not enforced" is a genuinely
      // different situation from "none configured", and reporting the first as
      // the second told the operator to redo work they had already done.
      bssidVerification: config.bssidEnforced
        ? 'enforced'
        : (config.bssidListed > 0 ? 'listed-not-enforced' : 'not-configured'),
      bssidListed: config.bssidListed,
    },
    inOffice, grace, away,
    notArrived: board.filter(e => e.status === 'NOT_CHECKED_IN'),
    todayAttendance: attended,
    needsReview,
    recentMovements: movements.map(m => ({
      id: m.id,
      time: T.displayTime(m.at),
      type: m.type,
      name: m.employee_name || 'Unknown',
      details: m.details || '',
    })),
  });
});

// GET /api/dashboard/history?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/history', async (req, res) => {
  const from = String(req.query.from || T.dateKey());
  const to = String(req.query.to || T.dateKey());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ status: 'ERROR', message: 'from and to must be YYYY-MM-DD.' });
  }

  const rows = await db.prepare(`
    SELECT a.*, e.name, e.role FROM attendance_days a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.date_key >= ? AND a.date_key <= ?
    ORDER BY a.date_key DESC, e.name
  `).all(from, to);

  res.json({
    status: 'SUCCESS',
    from, to,
    days: rows.map(r => ({
      date: r.date_key,
      employeeId: r.employee_id,
      employeeName: r.name,
      role: r.role,
      firstCheckIn: r.first_in_at ? T.displayTime(r.first_in_at) : '--',
      lastActive: r.last_active_at ? T.displayTime(r.last_active_at) : '--',
      timeWorked: T.formatMinutes(r.total_minutes),
      totalMinutes: r.total_minutes,
      adjustmentMinutes: r.adjustment_minutes,
      adjustmentNote: r.adjustment_note,
      status: r.status,
      sessions: JSON.parse(r.sessions_json || '[]').map(s => ({
        from: T.displayTime(s.start),
        to: s.open ? 'now' : T.displayTime(s.end),
        duration: T.formatMinutes(s.minutes),
      })),
    })),
  });
});

module.exports = router;
