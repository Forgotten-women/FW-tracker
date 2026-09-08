// Single source of configuration. Replaces the values that were previously
// hardcoded in five separate places (firmware, server.js, store.js, the
// scanner.js regex, and the Flutter app).
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');

function loadOfficeConfig() {
  // OFFICE_CONFIG_FILE lets tests pin a known configuration. Without it the
  // suite depends on live production settings, so an operator legitimately
  // turning on BSSID enforcement would break unrelated tests - which is a
  // property of the tests, not a fault in their change.
  if (process.env.OFFICE_CONFIG_FILE) {
    const p = path.resolve(process.env.OFFICE_CONFIG_FILE);
    return { ...JSON.parse(fs.readFileSync(p, 'utf-8')), _source: path.basename(p) };
  }

  // office.local.json (gitignored) overrides office.json, so a machine can
  // differ without dirtying the repo.
  const localPath = path.join(CONFIG_DIR, 'office.local.json');
  const basePath = path.join(CONFIG_DIR, 'office.json');
  const chosen = fs.existsSync(localPath) ? localPath : basePath;
  return { ...JSON.parse(fs.readFileSync(chosen, 'utf-8')), _source: path.basename(chosen) };
}

const office = loadOfficeConfig();

// --- Subnet matching ---------------------------------------------------
// Replaces the hardcoded /^192\.168\.18\./ regex in scanner.js so additional
// office networks are a config edit rather than a code edit.

function ipToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const octet = Number(p);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n * 256) + octet;
  }
  return n;
}

function parseCidr(cidr) {
  const [base, bitsRaw] = String(cidr).split('/');
  const baseInt = ipToInt(base);
  const bits = Number(bitsRaw);
  if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return { network: (baseInt & mask) >>> 0, mask };
}

const OFFICE_SUBNETS = (office.networks || [])
  .flatMap(n => n.subnets || [])
  .map(parseCidr)
  .filter(Boolean);

/** True if `ip` falls inside any configured office subnet. */
function isOfficeIp(ip) {
  const n = ipToInt(ip);
  if (n === null) return false;
  return OFFICE_SUBNETS.some(s => ((n & s.mask) >>> 0) === s.network);
}

// --- BSSID matching ----------------------------------------------------
// The anti-spoofing check. Both radios of a dual-band AP are simply two
// allowlisted BSSIDs, which is how the 2.4/5GHz split is handled.

const OFFICE_BSSIDS = new Set(
  (office.networks || [])
    .flatMap(n => n.bssids || [])
    .map(b => String(b).toLowerCase().replace(/-/g, ':').trim())
    .filter(Boolean)
);

// Collecting BSSIDs and enforcing them are deliberately separate steps.
// Flipping enforcement on automatically as soon as one BSSID is listed would
// lock out everyone connected to a radio not yet in the list - on a dual-band
// router that is half the office. So: add every BSSID first, confirm the
// dashboard shows people as verified, THEN set enforceBssid to true.
const BSSID_ENFORCED = OFFICE_BSSIDS.size > 0 && office.enforceBssid === true;
const BSSID_LISTED = OFFICE_BSSIDS.size;

/** True if `bssid` belongs to a known office access point. */
function isOfficeBssid(bssid) {
  if (!BSSID_ENFORCED) return true; // not configured -> cannot enforce
  if (!bssid) return false;
  return OFFICE_BSSIDS.has(String(bssid).toLowerCase().replace(/-/g, ':').trim());
}

const OFFICE_SSIDS = new Set((office.networks || []).map(n => n.ssid).filter(Boolean));

function normalizeSsid(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-.]+/g, '').trim();
}

const NORMALIZED_OFFICE_SSIDS = new Set(
  [...OFFICE_SSIDS, 'Trans K 2.4G', 'Trans K 5G', 'Naya K 5G', 'Naya 5G', 'Naya 2.4G', 'Naya K 2.4G', 'HUAWEI-2.4G-2Jwu']
    .map(normalizeSsid)
);

function isOfficeSsid(ssid) {
  if (!ssid) return false;
  const norm = normalizeSsid(ssid);
  if (NORMALIZED_OFFICE_SSIDS.has(norm)) return true;
  if (norm.startsWith('transk') || norm.startsWith('nayak') || norm.startsWith('naya2') || norm.startsWith('naya5')) {
    return true;
  }
  return false;
}

// --- Secrets -----------------------------------------------------------

/** HMAC shared secret for a hardware sensor id, or null if not configured. */
function sensorSecret(sensorId) {
  if (!sensorId) return null;
  const key = 'SENSOR_SECRET_' + String(sensorId).replace(/[-.]/g, '_');
  const val = process.env[key];
  return val && val.trim() ? val.trim() : null;
}

const config = {
  port: Number(process.env.PORT) || 5000,
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5000')
    .split(',').map(s => s.trim()).filter(Boolean),
  adminApiKey: process.env.ADMIN_API_KEY || '',

  office,
  timeZone: office.timeZone || 'Asia/Karachi',
  activeThresholdMinutes: office.activeThresholdMinutes ?? 3,
  gracePeriodMinutes: office.gracePeriodMinutes ?? 15,
  maxSessionMinutes: office.maxSessionMinutes ?? 720,
  workStartTime: office.workStartTime || '09:00',
  workEndTime: office.workEndTime || '18:00',
  retention: office.retention || { presenceEventDays: 90, unknownDeviceDays: 7 },
  unknownDeviceMinSightings: office.unknownDeviceMinSightings ?? 3,

  // Lateness policy. Confirmed 2026-08-27.
  latenessGraceMinutes: office.latenessGraceMinutes ?? 0,
  latenessOccurrencesAllowed: office.latenessOccurrencesAllowed ?? 3,
  latenessMonitoringPeriod: office.latenessMonitoringPeriod || 'UNSET',

  // Warning policy. Confirmed 2026-08-27.
  warningEscalationSequence: office.warningEscalationSequence
    || ['INFORMAL_NOTICE', 'FIRST_WRITTEN', 'FINAL_WRITTEN'],
  warningExpiryMonths: office.warningExpiryMonths ?? null,
  escalateOnEveryOccurrence: office.escalateOnEveryOccurrence === true,
  // Leave policy. Confirmed 2026-08-27.
  leave: {
    annualEntitlementDays: 20,
    holidayYearBasis: 'EMPLOYMENT_ANNIVERSARY',
    accrualMethod: 'MONTHLY_ON_COMPLETION',
    carryOverDays: 0,
    allowNegativeBalance: true,
    negativeBalanceRequiresApproval: true,
    approvalRoute: ['HR'],
    ...(office.leave || {}),
  },

  // Advanced HR alert lead times, in days before the date. Confirmed 2026-08-27.
  alerts: {
    contractExpiryDays: 30,
    probationReviewDays: 7,
    documentExpiryDays: 30,
    performanceReviewDays: 14,
    ...(office.alerts || {}),
  },

  // Payroll policy. Confirmed 2026-08-27.
  payroll: {
    weeksPerYear: 52,
    workingDaysPerWeek: 5,
    monthsPerYear: 12,
    breakIsPaid: true,
    leaverSettlement: 'HR_DECIDES',
    currency: 'GBP',
    ...(office.payroll || {}),
  },

  // All three null means "no automatic consequence, HR decides case by case".
  unauthorisedAbsence: office.unauthorisedAbsence
    || { deductAnnualLeave: null, treatAsUnpaid: null, createWarningTrigger: null },
  infrastructureIps: new Set(office.infrastructureIps || []),

  isOfficeIp,
  isOfficeBssid,
  isOfficeSsid,
  bssidEnforced: BSSID_ENFORCED,
  bssidListed: BSSID_LISTED,
  officeSsids: OFFICE_SSIDS,
  sensorSecret,
};

/** Startup warnings for configuration that weakens the trust model. */
function configWarnings() {
  const w = [];
  if (!config.adminApiKey) {
    w.push('ADMIN_API_KEY is not set - admin endpoints will refuse all requests. Set it in backend/.env');
  }
  if (!BSSID_ENFORCED) {
    w.push(
      BSSID_LISTED === 0
        ? 'No office BSSIDs configured - anti-spoofing falls back to source-IP checking only. Run "npm run bssids" to discover them, then add them to config/office.json.'
        : `${BSSID_LISTED} BSSID(s) listed but enforceBssid is false - they are NOT being checked yet. Confirm every access point radio is listed, then set "enforceBssid": true in config/office.json.`
    );
  }
  if (OFFICE_SUBNETS.length === 0) {
    w.push('No office subnets configured - presence cannot be location-verified at all.');
  }
  if (config.latenessMonitoringPeriod === 'UNSET') {
    w.push('latenessMonitoringPeriod is UNSET - the warning engine will refuse to run rather than guess when the late count resets.');
  }
  return w;
}

module.exports = { config, configWarnings, isOfficeSsid };
