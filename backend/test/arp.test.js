// Parser tests for the ARP sensor, run against captured fixtures so they need
// no live network.
//
// The original regex was /^(192\.168\.18\.\d+)\s+([0-9a-fA-F\-]{17})\s+(\w+)/ -
// hardcoded to one subnet, anchored to line start, and Windows-only. A second
// office network would have been invisible to it.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_FILE = path.join(os.tmpdir(), `office-arp-test-${process.pid}.db`);
process.env.ADMIN_API_KEY = 'test';
process.env.OFFICE_CONFIG_FILE = require('path').join(__dirname, 'fixtures', 'office.test.json');

const { parseArpOutput } = require('../src/sensors/arp');

const WINDOWS_OUTPUT = `
Interface: 192.168.18.68 --- 0x11
  Internet Address      Physical Address      Type
  192.168.18.1          f8-1a-67-11-22-33     dynamic
  192.168.18.14         14-85-7f-6b-9c-16     dynamic
  192.168.18.59         66-7a-29-fb-69-ac     dynamic
  192.168.18.90         aa-bb-cc-dd-ee-ff     static
  192.168.18.255        ff-ff-ff-ff-ff-ff     static
  224.0.0.22            01-00-5e-00-00-16     static
  10.20.30.40           de-ad-be-ef-00-01     dynamic
`;

const UNIX_OUTPUT = `
router.lan (192.168.18.1) at f8:1a:67:11:22:33 on en0 ifscope [ethernet]
? (192.168.18.14) at 14:85:7f:6b:9c:16 on en0 ifscope [ethernet]
? (192.168.18.59) at 66:7a:29:fb:69:ac on en0 ifscope [ethernet]
`;

test('parses Windows arp -a output', () => {
  const found = parseArpOutput(WINDOWS_OUTPUT);
  const ips = found.map(d => d.ip);

  assert.ok(ips.includes('192.168.18.14'));
  assert.ok(ips.includes('192.168.18.59'));
  assert.equal(found.find(d => d.ip === '192.168.18.59').mac, '66:7a:29:fb:69:ac',
    'Windows dash-separated MACs must be normalised to colons');
});

test('excludes infrastructure, static entries, multicast and off-subnet hosts', () => {
  const ips = parseArpOutput(WINDOWS_OUTPUT).map(d => d.ip);

  assert.ok(!ips.includes('192.168.18.1'), 'the gateway is not a person');
  assert.ok(!ips.includes('192.168.18.255'), 'broadcast is not a person');
  assert.ok(!ips.includes('192.168.18.90'), 'static entries are configured, not observed');
  assert.ok(!ips.includes('224.0.0.22'), 'multicast is not a device');
  assert.ok(!ips.includes('10.20.30.40'), 'hosts outside the configured subnets are ignored');
});

test('parses Unix arp -a output, which the old regex could not', () => {
  const found = parseArpOutput(UNIX_OUTPUT);
  const ips = found.map(d => d.ip);
  assert.ok(ips.includes('192.168.18.14'));
  assert.ok(ips.includes('192.168.18.59'));
  assert.ok(!ips.includes('192.168.18.1'), 'gateway still excluded');
});

test('empty or malformed input yields nothing rather than throwing', () => {
  assert.deepEqual(parseArpOutput(''), []);
  assert.deepEqual(parseArpOutput('garbage\nno addresses here\n'), []);
});
