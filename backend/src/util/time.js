// All timestamps are stored as UTC epoch milliseconds (INTEGER).
//
// This replaces store.js's getPktIsoString(), which added 5 hours to a UTC
// instant and then relabelled the "Z" suffix as "+05:00". That round-tripped
// correctly only by double negation, and it coexisted with an Intl-based path
// for the same job. The drift is visible in the old db.json, which holds
// "...+05:00" and "...Z" timestamps inside the same record.
//
// Formatting happens only at the response edge, never in storage.

const crypto = require('crypto');
const { config } = require('../config');

const TZ = config.timeZone;

/** Current instant, UTC epoch ms. */
function now() {
  return Date.now();
}

/**
 * Offset in ms between the given time zone and UTC at a specific instant.
 * Derived from Intl rather than hardcoded, so it stays correct if the office
 * ever moves to a zone that observes DST.
 */
function tzOffsetMs(epochMs, timeZone = TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(epochMs))) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour) % 24, Number(map.minute), Number(map.second)
  );
  return asUTC - epochMs;
}

/** Local calendar day for an instant, as "YYYY-MM-DD". */
function dateKey(epochMs = now(), timeZone = TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(epochMs));
}

/** Human clock time for an instant, e.g. "2:35:04 PM". */
function displayTime(epochMs, timeZone = TZ) {
  if (epochMs === null || epochMs === undefined) return '--:--';
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
  }).format(new Date(epochMs));
}

/** Full human date, e.g. "Wednesday, August 27, 2026". */
function displayDate(epochMs = now(), timeZone = TZ) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }).format(new Date(epochMs));
}

/**
 * The instant at which a given local wall-clock time occurs on a given local
 * day. Used to clamp sessions to workEndTime at day rollover.
 *   wallClockToEpoch('2026-08-27', '18:00') -> epoch ms of 6pm local
 */
function wallClockToEpoch(dayKey, hhmm, timeZone = TZ) {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0);
  // Two passes: the offset must be sampled at the resulting instant, not the
  // naive one, or times near a DST transition land an hour out.
  let epoch = naive - tzOffsetMs(naive, timeZone);
  epoch = naive - tzOffsetMs(epoch, timeZone);
  return epoch;
}

/** Midnight at the start of a local day, as epoch ms. */
function startOfDay(dayKey, timeZone = TZ) {
  return wallClockToEpoch(dayKey, '00:00', timeZone);
}

/** Midnight at the end of a local day (exclusive), as epoch ms. */
function endOfDay(dayKey, timeZone = TZ) {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextKey = next.toISOString().slice(0, 10);
  return startOfDay(nextKey, timeZone);
}

/** "1h 25m" / "42 mins" — unchanged behaviour from the original store.js. */
function formatMinutes(totalMins) {
  const mins = Math.max(0, Math.round(totalMins || 0));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} mins`;
  return `${h}h ${m}m`;
}

// --- Identifier normalisation (carried over from store.js) --------------

function normalizeIp(ip) {
  if (!ip) return '';
  // Strips the ::ffff: prefix Node puts on IPv4-mapped remote addresses.
  return String(ip).replace(/^.*:/, '').trim();
}

function normalizeMac(mac) {
  if (!mac) return '';
  return String(mac).toLowerCase().replace(/-/g, ':').trim();
}

/**
 * Stable pseudonym for a MAC belonging to someone who is not an employee.
 * Unknown devices are recorded so network hygiene is visible, but storing the
 * real MACs of visitors' and neighbours' phones indefinitely is personal data
 * we have no basis to keep. Hashing keeps "same device seen again" working
 * without retaining the identifier itself.
 */
function hashMac(mac, salt) {
  const clean = normalizeMac(mac);
  if (!clean) return '';
  return crypto.createHmac('sha256', salt).update(clean).digest('hex').slice(0, 32);
}

module.exports = {
  now, tzOffsetMs, dateKey, displayTime, displayDate,
  wallClockToEpoch, startOfDay, endOfDay,
  formatMinutes, normalizeIp, normalizeMac, hashMac,
  TZ,
};
