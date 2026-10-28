// Namaz (prayer) times for the office, worked out from its location every day.
//
// Times move a minute or two each day, so they are calculated, not stored:
// the standard astronomical method (as PrayTimes.org, MIT), with the
// University of Islamic Sciences, Karachi parameters (Fajr and Isha at 18°)
// and Hanafi Asr (shadow twice an object's length), as agreed with HR on
// 2026-10-28 for the Islamabad office. Remote staff use the office's times.
//
// The desktop agent shows a small notification at each prayer inside working
// hours (Zuhr, Asr, Maghrib; on Fridays Jumu'ah at 13:00), and for the next
// NAMAZ_WINDOW_MINUTES laptop idle / lock / stepping out is not idle or
// missing time (schedule.prayerRanges). A break stays a break.

const T = require('../util/time');
const { config } = require('../config');

const settings = {
  latitude: 33.6844,      // Islamabad
  longitude: 73.0479,
  fajrAngle: 18,
  ishaAngle: 18,
  asrFactor: 2,           // Hanafi
  windowMinutes: 15,
  ...((config.office && config.office.namaz) || {}),
};

const DEG = Math.PI / 180;
const sin = (d) => Math.sin(d * DEG);
const cos = (d) => Math.cos(d * DEG);
const tan = (d) => Math.tan(d * DEG);
const arcsin = (x) => Math.asin(x) / DEG;
const arccos = (x) => Math.acos(Math.max(-1, Math.min(1, x))) / DEG;
const arctan2 = (y, x) => Math.atan2(y, x) / DEG;
const arccot = (x) => Math.atan(1 / x) / DEG;
const fix = (a, b) => { a -= b * Math.floor(a / b); return a < 0 ? a + b : a; };
const fixAngle = (a) => fix(a, 360);
const fixHour = (a) => fix(a, 24);

function julian(year, month, day) {
  if (month <= 2) { year -= 1; month += 12; }
  const A = Math.floor(year / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + B - 1524.5;
}

function sunPosition(jd) {
  const D = jd - 2451545.0;
  const g = fixAngle(357.529 + 0.98560028 * D);
  const q = fixAngle(280.459 + 0.98564736 * D);
  const L = fixAngle(q + 1.915 * sin(g) + 0.020 * sin(2 * g));
  const e = 23.439 - 0.00000036 * D;
  const RA = arctan2(cos(e) * sin(L), cos(L)) / 15;
  return { declination: arcsin(sin(e) * sin(L)), equation: q / 15 - fixHour(RA) };
}

/** Local clock hours (office time zone) of each prayer on dateKey. */
function prayerHours(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const lat = settings.latitude;
  const lng = settings.longitude;
  const jDate = julian(y, m, d) - lng / (15 * 24);
  const midDay = (t) => fixHour(12 - sunPosition(jDate + t).equation);
  const sunAngleTime = (angle, t, ccw = false) => {
    const decl = sunPosition(jDate + t).declination;
    const noon = midDay(t);
    const h = arccos((-sin(angle) - sin(decl) * sin(lat)) / (cos(decl) * cos(lat))) / 15;
    return noon + (ccw ? -h : h);
  };
  const asrTime = (factor, t) => {
    const decl = sunPosition(jDate + t).declination;
    return sunAngleTime(-arccot(factor + tan(Math.abs(lat - decl))), t);
  };
  const tz = utcOffsetHours(dateKey);
  const adj = (h) => h + tz - lng / 15;
  return {
    fajr: adj(sunAngleTime(settings.fajrAngle, 5 / 24, true)),
    sunrise: adj(sunAngleTime(0.833, 6 / 24, true)),
    dhuhr: adj(midDay(12 / 24)),
    asr: adj(asrTime(settings.asrFactor, 13 / 24)),
    maghrib: adj(sunAngleTime(0.833, 18 / 24)),
    isha: adj(sunAngleTime(settings.ishaAngle, 18 / 24)),
  };
}

/** The office time zone's offset from UTC on dateKey, in hours. */
function utcOffsetHours(dateKey) {
  return (T.wallClockToEpoch(dateKey, '12:00') - Date.UTC(...dateKey.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))), 12)) / -3600000;
}

const hhmm = (h) => {
  const mins = Math.round(fixHour(h) * 60);
  return `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};

/** Every prayer time of the day as "HH:MM" office time. */
function prayerTimes(dateKey) {
  const h = prayerHours(dateKey);
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, hhmm(v)]));
}

/**
 * The prayers the agent notifies for and protects, with their windows:
 * Zuhr, Asr, Maghrib; on Friday, Jumu'ah at 13:00 (covered by the existing
 * 13:00-14:00 Friday hour) instead of Zuhr. Fajr and Isha fall outside the
 * working day.
 */
function namazWindows(dateKey) {
  const t = prayerTimes(dateKey);
  const friday = require('./schedule').weekdayKey(dateKey) === 'fri';
  const list = [
    friday ? { name: "Jumu'ah", key: 'jumuah', time: '13:00' } : { name: 'Zuhr', key: 'zuhr', time: t.dhuhr },
    { name: 'Asr', key: 'asr', time: t.asr },
    { name: 'Maghrib', key: 'maghrib', time: t.maghrib },
  ];
  return list.map((p) => {
    const at = T.wallClockToEpoch(dateKey, p.time);
    return { ...p, at, until: at + settings.windowMinutes * 60 * 1000 };
  });
}

module.exports = { prayerTimes, namazWindows, settings };
