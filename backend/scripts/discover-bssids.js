#!/usr/bin/env node
// Discovers nearby access point radios and prints a config/office.json snippet.
//
//   npm run bssids            list everything visible
//   npm run bssids -- "Trans" only SSIDs containing "Trans"
//
// Why this exists: an SSID is a name anyone can copy, but a BSSID is the MAC of
// a specific access point radio. Checking it is what stops someone naming their
// home network after the office and being counted as present.
//
// Reading it by hand from `netsh` output is error-prone, and getting it wrong
// means real people silently stop being counted.

const { execSync } = require('child_process');
const os = require('os');

const filter = (process.argv[2] || '').toLowerCase();

const IS_CLI = require.main === module;

function parseWindows(text) {
  const networks = [];
  let current = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();

    const ssid = line.match(/^SSID\s+\d+\s*:\s*(.*)$/);
    if (ssid) {
      current = { ssid: ssid[1].trim(), radios: [] };
      networks.push(current);
      continue;
    }
    if (!current) continue;

    const bssid = line.match(/^BSSID\s+\d+\s*:\s*([0-9a-fA-F:]{17})/);
    if (bssid) {
      current.radios.push({ bssid: bssid[1].toLowerCase() });
      continue;
    }

    const radio = current.radios[current.radios.length - 1];
    if (!radio) continue;

    const band = line.match(/^Band\s*:\s*(.+)$/);
    if (band) radio.band = band[1].trim().replace(/\s*GHz$/i, '');

    const channel = line.match(/^Channel\s*:\s*(\d+)/);
    if (channel) radio.channel = Number(channel[1]);

    const signal = line.match(/^Signal\s*:\s*(\d+)%/);
    if (signal) radio.signal = Number(signal[1]);

    const stations = line.match(/^Connected Stations\s*:\s*(\d+)/);
    if (stations) radio.stations = Number(stations[1]);
  }

  return networks;
}

function scan() {
  if (os.platform() !== 'win32') {
    console.error('This helper uses `netsh`, which is Windows-only.');
    console.error('On macOS:  /System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -s');
    console.error('On Linux:  nmcli -f SSID,BSSID,CHAN,SIGNAL device wifi list');
    process.exit(1);
  }
  try {
    return execSync('netsh wlan show networks mode=bssid', {
      encoding: 'utf-8',
      windowsHide: true,
    });
  } catch (err) {
    console.error('Could not scan for networks:', err.message);
    console.error('Make sure Wi-Fi is enabled and the WLAN service is running.');
    process.exit(1);
  }
}

if (!IS_CLI) {
  module.exports = { parseWindows };
  return;
}

const networks = parseWindows(scan())
  .filter(n => n.ssid && n.radios.length)
  .filter(n => !filter || n.ssid.toLowerCase().includes(filter));

if (!networks.length) {
  console.error(filter ? `No visible networks matching "${filter}".` : 'No networks visible.');
  console.error('netsh serves a CACHED scan, so radios can be missing. Toggle Wi-Fi off/on');
  console.error('or wait a few seconds and run this again.');
  process.exit(1);
}

console.error(
  '\nNote: netsh reports a cached scan, so a radio that exists may not appear in\n' +
  'any single run. Run this a few times, and check the router admin page too,\n' +
  'before deciding the list is complete.'
);

console.log('\nVisible access point radios\n');
for (const n of networks) {
  console.log(`  ${n.ssid}`);
  for (const r of n.radios) {
    const parts = [
      r.band ? `${r.band}GHz`.padEnd(7) : '?'.padEnd(7),
      r.channel !== undefined ? `ch${String(r.channel).padEnd(3)}` : '     ',
      r.signal !== undefined ? `${String(r.signal).padStart(3)}%` : '    ',
      r.stations !== undefined ? `${r.stations} station(s)` : '',
    ];
    console.log(`    ${r.bssid}   ${parts.join('  ')}`);
  }
  console.log('');
}

// Radios that share an OUI-and-prefix almost always belong to one physical AP.
// Surfacing that helps spot an SSID that is quietly on a band you did not
// expect, or a factory SSID still enabled alongside the renamed one.
const byPrefix = new Map();
for (const n of networks) {
  for (const r of n.radios) {
    const prefix = r.bssid.slice(0, 14); // first 5 octets
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push({ ssid: n.ssid, ...r });
  }
}
for (const [prefix, radios] of byPrefix) {
  if (radios.length < 2) continue;
  const names = [...new Set(radios.map(r => r.ssid))];
  if (names.length < 2) continue;
  console.log(`  Note: ${prefix}xx carries ${radios.length} radios across ${names.length} SSIDs`);
  console.log(`        (${names.join(', ')}) - these are one physical access point.\n`);
}

const snippet = networks.map(n => {
  const byBand = new Map();
  for (const r of n.radios) {
    const key = r.band ?? '?';
    if (!byBand.has(key)) byBand.set(key, []);
    byBand.get(key).push(r);
  }
  return [...byBand.entries()].map(([band, radios]) => ({
    name: `${n.ssid} (${band}GHz radio)`,
    ssid: n.ssid,
    band,
    channel: radios[0].channel,
    bssids: radios.map(r => r.bssid),
    subnets: ['192.168.18.0/24'],
  }));
}).flat();

console.log('Snippet for config/office.json (check the subnets before pasting):\n');
console.log(JSON.stringify({ networks: snippet }, null, 2));
console.log(
  '\nList every radio your staff actually connect to, restart the server, and\n' +
  'confirm the dashboard shows people as verified. Only then set\n' +
  '"enforceBssid": true - enabling it with a radio missing silently stops\n' +
  'counting anyone connected to that radio.\n'
);
