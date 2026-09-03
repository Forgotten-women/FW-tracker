// ARP table sensor - LOW CONFIDENCE corroboration only.
//
// Read the caveat before trusting anything this produces. The ARP cache is a
// cache, not a device inventory:
//   - entries persist for minutes AFTER a device leaves  (false "present")
//   - entries are evicted while a device is still connected but idle
//     (false "away")
//   - it only contains hosts this machine recently talked to
//
// It also cannot identify anyone: MAC randomisation (iOS 14+, Android 10+,
// rotating on iOS 18 / Android 14) and DHCP lease reuse make MAC-to-person and
// IP-to-person mapping unsound. The original code matched employees on exactly
// those two fields, which could attribute one person's presence to another.
//
// So this sensor records unattributed sightings at confidence 0.3. They show
// network activity on the dashboard. They never create attendance.

const { exec } = require('child_process');
const { config } = require('../config');
const P = require('../domain/presence');
const T = require('../util/time');

const SCAN_INTERVAL_MS = 30000;

// IP and MAC are located independently on each line, because the surrounding
// text differs by platform:
//   Windows : "  192.168.18.14   14-85-7f-6b-9c-16   dynamic"
//   macOS   : "? (192.168.18.14) at 14:85:7f:6b:9c:16 on en0 ifscope [ethernet]"
//   Linux   : "? (192.168.18.14) at 14:85:7f:6b:9c:16 [ether] on wlan0"
// The old regex was anchored to line start and hardcoded to 192.168.18.x, so it
// matched only the Windows form on the one subnet.
const IP_RE = /(\d{1,3}(?:\.\d{1,3}){3})/;
const MAC_RE = /([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})/;
const STATIC_RE = /\b(static|permanent)\b/i;

/**
 * Pure parser, separated so it can be tested against captured fixtures rather
 * than requiring a live network.
 */
function parseArpOutput(stdout) {
  const out = [];
  const seen = new Set();

  for (const line of String(stdout).split('\n')) {
    const ipMatch = line.match(IP_RE);
    const macMatch = line.match(MAC_RE);
    if (!ipMatch || !macMatch) continue;

    const ip = ipMatch[1];
    const mac = macMatch[1].toLowerCase().replace(/-/g, ':');

    // Static and permanent entries are configured, not observed, so they say
    // nothing about who is currently present.
    if (STATIC_RE.test(line)) continue;
    // Multicast and broadcast MACs are not devices.
    if (mac === 'ff:ff:ff:ff:ff:ff') continue;
    if (mac.startsWith('01:00:5e') || mac.startsWith('33:33')) continue;
    if (!config.isOfficeIp(ip)) continue;
    if (config.infrastructureIps.has(ip)) continue;
    if (seen.has(ip)) continue;

    seen.add(ip);
    out.push({ ip, mac });
  }
  return out;
}

let scanning = false;
let timer = null;

function scanOnce() {
  if (scanning) return;             // never let scans overlap
  scanning = true;

  exec('arp -a', { timeout: 15000, windowsHide: true }, async (err, stdout) => {
    scanning = false;
    if (err || !stdout) return;

    const nowMs = T.now();
    const touched = new Set();

    for (const d of parseArpOutput(stdout)) {
      const r = await P.recordEvent({
        employeeId: null,          // never guessed here - see header
        source: 'ARP',
        mac: d.mac,
        srcIp: d.ip,
        observedAt: nowMs,
      });
      // recordEvent may still resolve an employee, if this MAC was bound by an
      // authenticated app heartbeat. That is a lookup of a proved identity,
      // not the MAC-guessing this sensor deliberately avoids.
      if (r.employeeId) touched.add(r.employeeId);
    }

    const dayKey = T.dateKey(nowMs);
    for (const empId of touched) await P.recomputeDay(empId, dayKey, nowMs);
  });
}

function start() {
  // Deduplicated: several SSIDs share one subnet, and repeating it once per
  // network entry made the startup line look like four separate scans.
  const subnets = [...new Set((config.office.networks || []).flatMap(n => n.subnets || []))];
  console.log(
    `[sensor:arp] corroborating sightings on ${subnets.join(', ') || '(no subnets configured)'} ` +
    `every ${SCAN_INTERVAL_MS / 1000}s`
  );
  scanOnce();
  timer = setInterval(scanOnce, SCAN_INTERVAL_MS);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, parseArpOutput, scanOnce };
