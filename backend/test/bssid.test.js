// Parser tests for the BSSID discovery helper.
//
// Pinned against real `netsh wlan show networks mode=bssid` output captured in
// the office on 2026-08-27. A live scan cannot be used here: netsh serves a
// CACHED result, so consecutive runs returned 13 networks and then 1.
//
// Getting this parse wrong has a real cost - a radio missed from the config
// means everyone connected to it silently stops being counted once
// enforceBssid is on.

const test = require('node:test');
const assert = require('node:assert');

const { parseWindows } = require('../scripts/discover-bssids');


// Trimmed to the entries that matter, verbatim in shape.
const NETSH_OUTPUT = `
Interface name : Wi-Fi
There are 13 networks currently visible.

SSID 1 : Mustafa Developers
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : 30:c5:0f:28:40:65
         Signal             : 26%
         Radio type         : 802.11ax
         Band               : 5 GHz
         Channel            : 157
         Bss Load:
             Connected Stations:         4
             Channel Utilization:        228 (89 %)
    BSSID 2                 : 30:c5:0f:28:40:60
         Signal             : 40%
         Radio type         : 802.11ax
         Band               : 2.4 GHz
         Channel            : 4
         Bss Load:
             Connected Stations:         5

SSID 8 : Trans K 5G
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : ba:9f:cc:db:52:5c
         Signal             : 86%
         Radio type         : 802.11ax
         Band               : 5 GHz
         Channel            : 40
         Bss Load:
             Connected Stations:         11

SSID 13 : Trans K 2.4G
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : ba:9f:cc:db:52:5e
         Signal             : 86%
         Radio type         : 802.11ax
         Band               : 5 GHz
         Channel            : 40
         Bss Load:
             Connected Stations:         5
    BSSID 2                 : ba:9f:cc:db:52:58
         Signal             : 78%
         Radio type         : 802.11ax
         Band               : 2.4 GHz
         Channel            : 11
         Bss Load:
             Connected Stations:         13
`;

const parsed = parseWindows(NETSH_OUTPUT);
const bySsid = (name) => parsed.find((n) => n.ssid === name);

test('parses every SSID in the scan', async () => {
  assert.equal(parsed.length, 3);
  assert.deepEqual(
    parsed.map((n) => n.ssid),
    ['Mustafa Developers', 'Trans K 5G', 'Trans K 2.4G'],
  );
});

test('captures both radios of a dual-band SSID', async () => {
  // The failure that matters: taking only BSSID 1 and missing BSSID 2 would
  // lock out the 13 people on the 2.4GHz radio.
  const trans = bySsid('Trans K 2.4G');
  assert.equal(trans.radios.length, 2);
  assert.deepEqual(
    trans.radios.map((r) => r.bssid),
    ['ba:9f:cc:db:52:5e', 'ba:9f:cc:db:52:58'],
  );
});

test('an SSID named "2.4G" can be on the 5GHz band', async () => {
  // The actual surprise in this office: the SSID name does not indicate the
  // band, so config must be driven by the scan and not by the name.
  const trans = bySsid('Trans K 2.4G');
  const [fiveGhz, twoFourGhz] = trans.radios;

  assert.equal(fiveGhz.band, '5');
  assert.equal(fiveGhz.channel, 40);
  assert.equal(twoFourGhz.band, '2.4');
  assert.equal(twoFourGhz.channel, 11);
});

test('reads signal and connected station counts', async () => {
  const trans = bySsid('Trans K 2.4G');
  assert.equal(trans.radios[1].signal, 78);
  assert.equal(trans.radios[1].stations, 13);
});

test('band is normalised without the GHz suffix', async () => {
  for (const n of parsed) {
    for (const r of n.radios) {
      assert.match(r.band, /^(2\.4|5|6)$/, `unexpected band: ${r.band}`);
    }
  }
});

test('attributes each radio to the right SSID', async () => {
  // Radio blocks are indented under their SSID; a naive line scan would leak
  // one network's BSSIDs into the next.
  assert.equal(bySsid('Trans K 5G').radios.length, 1);
  assert.equal(bySsid('Trans K 5G').radios[0].bssid, 'ba:9f:cc:db:52:5c');
  assert.equal(bySsid('Mustafa Developers').radios.length, 2);
});

test('the office access point is identifiable by shared BSSID prefix', async () => {
  // ba:9f:cc:db:52:5x is one physical AP serving several SSIDs. That is how a
  // still-enabled factory SSID gets noticed.
  const officeRadios = parsed
    .flatMap((n) => n.radios.map((r) => ({ ssid: n.ssid, ...r })))
    .filter((r) => r.bssid.startsWith('ba:9f:cc:db:52:'));

  assert.equal(officeRadios.length, 3);
  assert.equal(new Set(officeRadios.map((r) => r.ssid)).size, 2);
});

test('empty or malformed input yields nothing rather than throwing', async () => {
  assert.deepEqual(parseWindows(''), []);
  assert.deepEqual(parseWindows('no networks here\njust noise\n'), []);
});

