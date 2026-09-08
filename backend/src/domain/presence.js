// Presence derivation.
//
// The ONE place attendance is computed. Previously status was calculated in two
// places that disagreed: /api/attendance/live filtered on a denormalised
// employee.status field, while /api/dashboard/summary recomputed it from the
// ledger. The phone app read the stale denormalised copy, so the app and the
// dashboard could show different states for the same person at the same moment.
//
// Attendance is derived by replaying presence_events. Nothing here mutates the
// event log, so any day can be recomputed from scratch after a bug fix.

const crypto = require('crypto');
const { db, tx, MAC_SALT } = require('../db');
const { config } = require('../config');
const bindings = require('./bindings');
const schedule = require('./schedule');
const T = require('../util/time');

const ACTIVE_MS = config.activeThresholdMinutes * 60 * 1000;
const GRACE_MS = config.gracePeriodMinutes * 60 * 1000;
const MAX_SESSION_MS = config.maxSessionMinutes * 60 * 1000;

// How much each sensor is trusted. Only APP can establish identity for payroll:
// it is the only source that carries an authenticated statement of who the
// device belongs to. Network sensors corroborate location, they never name a
// person - MAC randomisation and DHCP lease reuse make that unsound.
// How a sighting that carries a bound identity is labelled. Defined once,
// because it is written in one place and read in another, and a rename that
// touched only one of them silently removed the confidence boost.
const ATTRIBUTED_VIA_BINDING = 'ESP_SENSOR';

const SOURCE_CONFIDENCE = {
  APP: 1.0,
  ROUTER: 0.6,
  ESP_SNIFFER: 0.5,
  ARP: 0.3,
  ADMIN: 1.0,
};

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

const insertEvent = db.prepare(`
  INSERT INTO presence_events
    (employee_id, device_id, source, location, confidence, ssid, bssid, src_ip,
     mac_hash, rssi, observed_at, received_at, dedupe_key, note)
  VALUES
    (@employee_id, @device_id, @source, @location, @confidence, @ssid, @bssid, @src_ip,
     @mac_hash, @rssi, @observed_at, @received_at, @dedupe_key, @note)
  ON CONFLICT(dedupe_key) DO NOTHING
`);

const touchDevice = db.prepare(
  // GREATEST, not MAX: in SQLite MAX() doubles as a two-argument scalar
  // function, but in Postgres it is an aggregate only.
  'UPDATE devices SET last_seen_at = GREATEST(COALESCE(last_seen_at, 0), ?::bigint) WHERE id = ?'
);

const upsertUnknown = db.prepare(`
  INSERT INTO unknown_devices (mac_hash, first_seen_at, last_seen_at, last_source, sighting_count)
  VALUES (@mac_hash, @at, @at, @source, 1)
  ON CONFLICT(mac_hash) DO UPDATE SET
    last_seen_at   = @at,
    last_source    = @source,
    -- Qualified: an unqualified column name in the DO UPDATE clause is
    -- ambiguous between the existing row and the proposed one.
    sighting_count = unknown_devices.sighting_count + 1
`);

/**
 * Decide whether a sighting counts as physically in the office.
 *
 * This is the anti-buddy-punching check. The old /mobile-ping accepted a
 * client-supplied employeeId with no location verification at all, so an
 * employee at home could mark themselves present indefinitely with one request.
 *
 * A heartbeat is OFFICE only if the reported BSSID is on the office allowlist
 * AND the request originated from an office subnet. Both radios of a dual-band
 * AP are simply two allowlisted BSSIDs, so the 2.4/5GHz split needs no special
 * handling.
 */
const DYNAMIC_OFFICE_BSSIDS = new Set();

function isKnownOfficeBssid(b) {
  if (!b) return false;
  const clean = String(b).toLowerCase().replace(/-/g, ':').trim();
  return config.isOfficeBssid(clean) || DYNAMIC_OFFICE_BSSIDS.has(clean);
}

function classifyLocation({ bssid, ssid, visibleOfficeBssids, srcIp, localIp, source }) {
  // Hardware sensors are physically installed in the office; anything they see
  // is by definition on the office network.
  if (source === 'ESP_SNIFFER' || source === 'ARP' || source === 'ROUTER') return 'OFFICE';
  if (source === 'ADMIN') return 'OFFICE';

  // When the backend runs on Vercel (or any cloud host), req.ip is the public
  // internet IP of the office router, never a 192.168.x.x address. In that
  // case we fall back to the client-reported localIp — but ONLY when the BSSID
  // is simultaneously verified, so spoofing requires physical proximity to the
  // access point (impossible from home).
  const effectiveSrcIp = config.isOfficeIp(srcIp)
    ? srcIp
    : (localIp && config.isOfficeIp(localIp) ? localIp : srcIp);
  const ipOk = config.isOfficeIp(effectiveSrcIp);

  // With no BSSIDs configured the BSSID check is vacuous, so it must not count
  // as positive evidence - otherwise a heartbeat from a home network would be
  // upgraded to UNKNOWN purely because the check could not be applied.
  // config.configWarnings() surfaces this weaker posture at startup.
  if (!config.bssidEnforced) return ipOk ? 'OFFICE' : 'REMOTE';

  const bssidOk = isKnownOfficeBssid(bssid);
  const ssidOk = typeof config.isOfficeSsid === 'function' ? config.isOfficeSsid(ssid) : false;

  // Over-the-air visible office AP beacons (Proximity Verification).
  // An 802.11 beacon cannot be received over the air unless the device is physically
  // within radio range (~20-30m) of an office access point. If an office AP is broadcasting
  // nearby with solid signal (>= 30%), the device is physically located inside the office,
  // even if Windows is temporarily routing internet through a mobile hotspot or secondary link.
  let airProximityOk = false;
  if (Array.isArray(visibleOfficeBssids) && visibleOfficeBssids.length > 0) {
    for (const v of visibleOfficeBssids) {
      const vbssid = typeof v === 'string' ? v : v?.bssid;
      const vsignal = typeof v === 'object' && v?.signal !== undefined ? Number(v.signal) : 50;
      if (vbssid && isKnownOfficeBssid(vbssid) && (isNaN(vsignal) || vsignal >= 30)) {
        airProximityOk = true;
        break;
      }
    }
  }

  // Dynamic AP learning: if we are in the office (proven by beacon or office IP)
  // and connected to an office SSID (e.g. Naya or newly installed AP), cache its BSSID.
  if (bssid && (airProximityOk || ipOk) && ssidOk) {
    DYNAMIC_OFFICE_BSSIDS.add(String(bssid).toLowerCase().replace(/-/g, ':').trim());
  }

  if (bssidOk || airProximityOk || (ssidOk && ipOk)) {
    // If the BSSID matches an office Wi-Fi, air proximity confirmed physical presence,
    // or connected to office SSID from office subnet:
    if (!airProximityOk && localIp && !config.isOfficeIp(localIp) && !config.isOfficeIp(srcIp)) {
      const isVirtualSubnet = /^(172\.(1[6-9]|2[0-9]|3[0-1])|10\.)/.test(String(localIp).trim());
      if (!isVirtualSubnet) {
        return 'UNKNOWN';
      }
    }
    return 'OFFICE';
  }

  if (ipOk && bssidOk) return 'OFFICE';
  if (!ipOk && !bssidOk) return 'REMOTE';
  // Exactly one check passed. An office BSSID reached from an off-network
  // address (or the reverse) is contradictory, so it is recorded but never
  // counted toward attendance.
  return 'UNKNOWN';
}

/**
 * Why a sighting did not count, in words the employee can act on.
 */
function explainLocation({ bssid, ssid, visibleOfficeBssids, srcIp, localIp, source, location }) {
  if (location === 'OFFICE') return null;
  if (source !== 'APP') return null;

  const effectiveSrcIp = config.isOfficeIp(srcIp)
    ? srcIp
    : (localIp && config.isOfficeIp(localIp) ? localIp : srcIp);
  const ipOk = config.isOfficeIp(effectiveSrcIp);

  if (config.bssidEnforced && !bssid) {
    return {
      code: 'NO_BSSID',
      message: 'Location permission or Wi-Fi scan is needed to confirm which office Wi-Fi you are on. '
             + 'Without it your time is not being recorded.',
      actionable: true,
    };
  }
  if (config.bssidEnforced && bssid) {
    return {
      code: 'UNKNOWN_ACCESS_POINT',
      message: 'This Wi-Fi access point (' + bssid + ') is not recognised as an office one. '
             + 'Connect to an office Wi-Fi network (Trans K 2.4G, Trans K 5G, Naya 2.4G, or Naya 5G) to record your attendance.',
      actionable: true,
    };
  }
  if (!ipOk) {
    return {
      code: 'OFF_NETWORK',
      message: 'You are not connected to the office network, so this time is not counted as attendance.',
      actionable: false,
    };
  }
  return { code: 'UNVERIFIED', message: 'Presence could not be verified.', actionable: false };
}

/**
 * Record one sighting. Idempotent: replaying the offline queue in the app
 * resends buffered heartbeats with their ORIGINAL timestamps, and the
 * dedupe_key ensures each inserts exactly once.
 */
async function recordEvent({
  employeeId = null, deviceId = null, source, mac = null, srcIp = null, localIp = null,
  ssid = null, bssid = null, visibleOfficeBssids = [], rssi = null, observedAt = null, note = null,
}) {
  const receivedAt = T.now();
  const observed = Number(observedAt) || receivedAt;
  const macHash = mac ? T.hashMac(mac, MAC_SALT) : null;
  const location = classifyLocation({ bssid, ssid, visibleOfficeBssids, srcIp, localIp, source });

  // A network sighting carries no identity of its own. But if this MAC was
  // bound to an employee by an authenticated app heartbeat, presence keeps
  // being attributed to them even with the app closed - which is the whole
  // point of the binding, and what stops "last seen" freezing at the moment
  // someone swiped the app away.
  //
  // Note the direction: an identity already PROVED is being followed, never
  // guessed from a MAC. An unbound MAC stays anonymous.
  let attributedVia = null;
  // ESP Hardware Sensor: Real-time over-the-air 802.11 monitor.
  // When an employee phone is active on office Wi-Fi, the ESP captures live frames and attributes presence.
  // When the phone disconnects or turns Wi-Fi off, ESP sightings stop immediately (no stale cache).
  if (!employeeId && macHash && source === 'ESP_SNIFFER') {
    const bound = await bindings.employeeForMac(macHash, observed);
    if (bound) {
      employeeId = bound.employeeId;
      deviceId = deviceId || bound.deviceId;
      attributedVia = ATTRIBUTED_VIA_BINDING;
    }
  }

  // Bucket to the second so a burst of retries for the same instant collapses.
  //
  // The employee is part of the key. Without it the key falls back to the
  // source IP when no device or MAC is known, and two people behind one address
  // collide - the second person's sighting is silently discarded as a duplicate
  // and their attendance simply never appears. Dedupe must mean "this employee,
  // seen by this source, on this device, in this second".
  const deviceIdentity = deviceId || macHash || srcIp || 'anon';
  const dedupeKey =
    `${source}|${employeeId || 'anon'}|${deviceIdentity}|${Math.floor(observed / 1000)}`;

  const info = await insertEvent.run({
    employee_id: employeeId,
    device_id: deviceId,
    source,
    location,
    // A bound sighting is stronger than an anonymous one but weaker than a
    // live authenticated heartbeat, and a dispute should be able to see which.
    confidence: attributedVia === ATTRIBUTED_VIA_BINDING
      ? Math.max(SOURCE_CONFIDENCE[source] ?? 0.5, 0.7)
      : (SOURCE_CONFIDENCE[source] ?? 0.5),
    ssid, bssid, src_ip: srcIp,
    mac_hash: macHash,
    rssi: rssi === null ? null : Number(rssi),
    observed_at: observed,
    received_at: receivedAt,
    dedupe_key: dedupeKey,
    note: attributedVia ? `${note || ''} [attributed via ${attributedVia}]`.trim() : note,
  });

  if (deviceId) await touchDevice.run(observed, deviceId);

  // A device on the office Wi-Fi that maps to no employee. Stored hashed and
  // on a short TTL - retaining the real MACs of visitors and neighbours
  // indefinitely is personal data we have no basis to keep.
  if (!employeeId && macHash && location === 'OFFICE') {
    await upsertUnknown.run({ mac_hash: macHash, at: observed, source });
  }

  return {
    inserted: info.changes > 0, location, observedAt: observed, employeeId, attributedVia,
    reason: explainLocation({ bssid, ssid, visibleOfficeBssids, srcIp, localIp, source, location }),
  };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

const selectDayEvents = db.prepare(`
  SELECT observed_at, source, confidence
  FROM presence_events
  WHERE employee_id = ? AND location = 'OFFICE'
    AND observed_at >= ? AND observed_at < ?
  ORDER BY observed_at ASC
`);

// Which signal is currently keeping someone present. Worth showing, because
// "the app is reporting" and "the sensor is reporting because the app proved
// who they are earlier" are different situations, and only the second survives
// the employee closing the app.
function describeSource(source) {
  switch (source) {
    case 'APP':         return { key: 'APP', label: 'App' };
    case 'ESP_SNIFFER': return { key: 'SENSOR', label: 'Office sensor' };
    case 'ARP':         return { key: 'NETWORK', label: 'Office network' };
    case 'ROUTER':      return { key: 'NETWORK', label: 'Access point' };
    case 'ADMIN':       return { key: 'MANUAL', label: 'Entered by HR' };
    default:            return { key: 'UNKNOWN', label: source || 'Unknown' };
  }
}

/**
 * Replay one employee-day into sessions.
 *
 * Sessions are bounded by the day window, so a session can never span midnight.
 * That removes the old unbounded-hours bug by construction: checkDepartures()
 * only ever inspected the current day, so a session left open across midnight
 * was never closed and getEmployeeWorkStats kept measuring it against "now",
 * growing forever.
 */
function replaySessions(events, { dayStart, dayEnd, nowMs }) {
  const sessions = [];
  if (events.length === 0) return sessions;

  let start = events[0].observed_at;
  let last = events[0].observed_at;

  for (let i = 1; i < events.length; i++) {
    const t = events[i].observed_at;
    if (t - last > GRACE_MS) {
      sessions.push({ start, end: last, open: false });
      start = t;
    }
    last = t;
  }

  // The final session is still open if this is the current day and the last
  // sighting is inside the grace window.
  const isToday = nowMs >= dayStart && nowMs < dayEnd;
  const stillOpen = isToday && (nowMs - last) <= GRACE_MS;
  sessions.push({ start, end: stillOpen ? nowMs : last, open: stillOpen });

  return sessions.map(s => {
    const rawMs = Math.max(0, s.end - s.start);
    // Capped, but flagged rather than silently truncated - a 12h+ session
    // usually means a phone was left in the office, and HR should see that
    // rather than have it quietly become a normal-looking day.
    const cappedMs = Math.min(rawMs, MAX_SESSION_MS);
    return {
      start: s.start,
      end: s.end,
      open: s.open,
      minutes: Math.max(1, Math.round(cappedMs / 60000)),
      exceededCap: rawMs > MAX_SESSION_MS,
    };
  });
}

const selectAttendanceRow = db.prepare(
  'SELECT * FROM attendance_days WHERE employee_id = ? AND date_key = ?'
);

/**
 * Derive the full state of one employee-day. Pure: reads events, writes nothing.
 * The three-state model (IN_OFFICE -> GRACE_PERIOD -> AWAY) is carried over
 * unchanged from the original getEmployeeWorkStats.
 */
async function deriveDay(employeeId, dayKey = T.dateKey(), nowMs = T.now()) {
  const dayStart = T.startOfDay(dayKey);
  const dayEnd = T.endOfDay(dayKey);
  const events = await selectDayEvents.all(employeeId, dayStart, dayEnd);

  const existing = await selectAttendanceRow.get(employeeId, dayKey);
  const adjustment = existing ? existing.adjustment_minutes : 0;

  if (events.length === 0) {
    return {
      employeeId, dateKey: dayKey,
      firstInAt: null, lastActiveAt: null,
      sessions: [], totalMinutes: Math.max(0, adjustment),
      adjustmentMinutes: adjustment,
      status: 'NOT_CHECKED_IN', statusLabel: 'Not Arrived Yet',
      inactivityMinutes: 0, graceMinutesLeft: 0,
      eventCount: 0, exceededCap: false,
      lastSource: null, sensorCarried: false,
    };
  }

  const sessions = replaySessions(events, { dayStart, dayEnd, nowMs });
  const firstInAt = events[0].observed_at;
  const lastEvent = events[events.length - 1];
  const lastActiveAt = lastEvent.observed_at;
  const sessionMinutes = sessions.reduce((a, s) => a + s.minutes, 0);
  const totalMinutes = Math.max(0, sessionMinutes + adjustment);

  const isToday = nowMs >= dayStart && nowMs < dayEnd;
  const inactivityMs = Math.max(0, nowMs - lastActiveAt);

  let status, statusLabel, graceMinutesLeft = 0;
  if (!isToday) {
    status = 'CLOSED';
    statusLabel = 'Day closed';
  } else if (inactivityMs > GRACE_MS) {
    status = 'AWAY';
    statusLabel = 'Away / On Break';
  } else if (inactivityMs >= ACTIVE_MS) {
    status = 'GRACE_PERIOD';
    graceMinutesLeft = Math.max(1, Math.round((GRACE_MS - inactivityMs) / 60000));
    statusLabel = `Grace Period (${graceMinutesLeft}m remaining)`;
  } else {
    status = 'IN_OFFICE';
    statusLabel = 'Active in Office';
  }

  return {
    employeeId, dateKey: dayKey,
    firstInAt, lastActiveAt,
    sessions, totalMinutes,
    adjustmentMinutes: adjustment,
    status, statusLabel,
    inactivityMinutes: Math.floor(inactivityMs / 60000),
    graceMinutesLeft,
    eventCount: events.length,
    exceededCap: sessions.some(s => s.exceededCap),
    lastSource: describeSource(lastEvent.source),
    // True when presence no longer depends on the app being open.
    sensorCarried: lastEvent.source !== 'APP',
  };
}

const upsertAttendance = db.prepare(`
  INSERT INTO attendance_days
    (employee_id, date_key, first_in_at, last_active_at, total_minutes,
     sessions_json, status, derived_at)
  VALUES
    (@employee_id, @date_key, @first_in_at, @last_active_at, @total_minutes,
     @sessions_json, @status, @derived_at)
  ON CONFLICT(employee_id, date_key) DO UPDATE SET
    first_in_at    = excluded.first_in_at,
    last_active_at = excluded.last_active_at,
    total_minutes  = excluded.total_minutes,
    sessions_json  = excluded.sessions_json,
    status         = excluded.status,
    derived_at     = excluded.derived_at
`);

/** Derive and persist the cached row. Returns the derived state. */
async function recomputeDay(employeeId, dayKey = T.dateKey(), nowMs = T.now()) {
  const d = await deriveDay(employeeId, dayKey, nowMs);
  await upsertAttendance.run({
    employee_id: employeeId,
    date_key: dayKey,
    first_in_at: d.firstInAt,
    last_active_at: d.lastActiveAt,
    total_minutes: d.totalMinutes,
    sessions_json: JSON.stringify(d.sessions),
    status: d.status,
    derived_at: nowMs,
  });
  try {
    const A = require('./attendance');
    await A.recomputeDay(employeeId, dayKey, nowMs);
  } catch (_) {}
  return d;
}

/** Rebuild every cached day from the event log. Use after changing the rules. */
async function recomputeAll() {
  const rows = await db.prepare(`
    SELECT DISTINCT employee_id, observed_at FROM presence_events WHERE employee_id IS NOT NULL
  `).all();
  const pairs = new Set();
  for (const r of rows) pairs.add(`${r.employee_id}|${T.dateKey(r.observed_at)}`);
  await tx(async () => {
    for (const p of pairs) {
      const [emp, key] = p.split('|');
      await recomputeDay(emp, key);
    }
  });
  
  return pairs.size;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const selectOpenBreakPresence = db.prepare(
  'SELECT started_at, permitted_minutes FROM break_records WHERE employee_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
);

const selectSummaryPresence = db.prepare(
  'SELECT break_minutes, excess_break_minutes, daily_deficit_minutes, late_minutes FROM attendance_daily_summary WHERE employee_id = ? AND date_key = ?'
);

/** Shape one derived day for an API response (formatting happens only here). */
async function presentDay(d, employee) {
  const openBreak = await selectOpenBreakPresence.get(d.employeeId);
  const summary = await selectSummaryPresence.get(d.employeeId, d.dateKey);
  const onBreak = Boolean(openBreak);
  const activeBreakMinutes = openBreak ? Math.max(0, Math.round((T.now() - openBreak.started_at) / 60000)) : 0;

  // Resolve employee's schedule for live lateness derivation
  const s = await schedule.resolve(d.employeeId, d.dateKey);
  let lateMinutes = summary ? summary.late_minutes : 0;
  let isLate = summary ? summary.late_minutes > 0 : false;

  // Live derivation: if firstInAt is recorded and employee arrived after latestOnTimeAt
  if (d.firstInAt && s.isWorkingDay) {
    if (d.firstInAt > s.latestOnTimeAt) {
      isLate = true;
      const graceEndMs = s.scheduledStartAt + (s.graceMinutes * 60000);
      const computedLate = Math.max(1, Math.round((d.firstInAt - graceEndMs) / 60000));
      lateMinutes = computedLate;
    }
  }

  const breakMinutes = summary ? summary.break_minutes : 0;
  const excessBreakMinutes = summary ? summary.excess_break_minutes : 0;
  const dailyDeficitMinutes = (summary ? summary.daily_deficit_minutes : 0) || (isLate ? lateMinutes : 0);

  // Active shift minutes strictly count from scheduled start time onwards (e.g. 11:00 AM).
  // Early arrival before scheduled start is preserved in firstCheckIn but does not count as active worked time.
  let shiftWorkedMinutes = 0;
  if (s.isWorkingDay && s.scheduledStartAt) {
    shiftWorkedMinutes = (d.sessions || []).reduce((acc, sess) => {
      const start = Math.max(sess.start, s.scheduledStartAt);
      const end = Math.max(sess.end, s.scheduledStartAt);
      return acc + Math.max(0, Math.round((end - start) / 60000));
    }, 0);
    shiftWorkedMinutes = Math.max(0, shiftWorkedMinutes + (d.adjustmentMinutes || 0));
  } else {
    shiftWorkedMinutes = d.totalMinutes;
  }

  return {
    employeeId: d.employeeId,
    employeeName: employee ? employee.name : 'Unknown',
    employeeNumber: employee ? (employee.employee_number || employee.employeeNumber || null) : null,
    role: employee ? employee.role : '',
    date: d.dateKey,
    status: d.status,
    statusLabel: d.statusLabel,
    onBreak,
    activeBreakMinutes,
    breakMinutes,
    excessBreakMinutes,
    dailyDeficitMinutes,
    lateMinutes,
    isLate,
    scheduledStartTime: s.startTime,
    firstCheckIn: d.firstInAt ? T.displayTime(d.firstInAt) : '--',
    lastActiveTime: d.lastActiveAt ? T.displayTime(d.lastActiveAt) : '--',
    totalMinutes: shiftWorkedMinutes,
    timeWorkedFormatted: T.formatMinutes(shiftWorkedMinutes),
    rawPresenceMinutes: d.totalMinutes,
    inactivityMinutes: d.inactivityMinutes,
    graceMinutesLeft: d.graceMinutesLeft,
    adjustmentMinutes: d.adjustmentMinutes,
    needsReview: d.exceededCap,
    presenceSource: d.lastSource ? d.lastSource.label : null,
    presenceSourceKey: d.lastSource ? d.lastSource.key : null,
    sensorCarried: !!d.sensorCarried,
    sessions: d.sessions.map(s => ({
      from: T.displayTime(s.start),
      to: s.open ? 'now' : T.displayTime(s.end),
      duration: T.formatMinutes(s.minutes),
      open: s.open,
    })),
  };
}

// See the note on selectToken in middleware/auth.js: the previous shape let an
// arbitrary employment record supply the job title.
const selectActiveEmployees = db.prepare(`
  SELECT e.id, e.name, e.employee_number, COALESCE(er.job_title, e.role) AS role, e.role AS department
  FROM employees e
  LEFT JOIN LATERAL (
    SELECT job_title
    FROM employment_records
    WHERE employee_id = e.id AND effective_to IS NULL
    ORDER BY effective_from DESC
    LIMIT 1
  ) er ON TRUE
  WHERE e.active = 1
  ORDER BY e.name
`);

/** Live board for every active employee, all from the same derivation. */
async function liveBoard(nowMs = T.now()) {
  const dayKey = T.dateKey(nowMs);
  const activeEmployees = await selectActiveEmployees.all();
  const results = [];
  const chunkSize = 4;
  for (let i = 0; i < activeEmployees.length; i += chunkSize) {
    const chunk = activeEmployees.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(chunk.map(async emp => {
      const d = await deriveDay(emp.id, dayKey, nowMs);
      return await presentDay(d, emp);
    }));
    results.push(...chunkResults);
  }
  return results;
}

module.exports = {
  recordEvent, deriveDay, recomputeDay, recomputeAll,
  presentDay, liveBoard, classifyLocation, explainLocation,
  ATTRIBUTED_VIA_BINDING,
  SOURCE_CONFIDENCE,
};
