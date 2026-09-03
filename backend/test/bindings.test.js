// Tests for presence surviving the app being closed.
//
// The reported flaw: "when i close the application it counts my seen time as
// time i closed the app". These tests pin the fix - once an authenticated
// heartbeat has bound the phone's address, passive sensor sightings keep
// carrying that employee's presence with no app running.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `office-bind-test-${process.pid}.db`);
process.env.DB_FILE = TMP;
process.env.ADMIN_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.OFFICE_CONFIG_FILE = require('path').join(__dirname, 'fixtures', 'office.test.json');

const { db, MAC_SALT } = require('../src/db');
const P = require('../src/domain/presence');
const bindings = require('../src/domain/bindings');
const T = require('../src/util/time');

const MIN = 60 * 1000;
const OFFICE_IP = '192.168.18.59';
const PHONE_MAC = 'aa:bb:cc:11:22:33';

async function makeEmployee(id, name = 'Test Person') {
  await db.prepare(
    'INSERT OR REPLACE INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?)'
  ).run(id, name, 'Engineering', T.now(), T.now());
  return id;
}
async function makeDevice(deviceId, employeeId) {
  await db.prepare(
    'INSERT OR REPLACE INTO devices (id, employee_id, platform, model, enrolled_at) VALUES (?,?,?,?,?)'
  ).run(deviceId, employeeId, 'android', 'TestPhone', T.now());
  return deviceId;
}

/** What the ARP sensor does: reports an IP together with its MAC. */
async function arpSighting(mac, ip, atMs) {
  return await P.recordEvent({ employeeId: null, source: 'ARP', mac, srcIp: ip, observedAt: atMs });
}
/** What the ESP sniffer does: a MAC with no IP at all. */
async function espSighting(mac, atMs) {
  return await P.recordEvent({ employeeId: null, source: 'ESP_SNIFFER', mac, observedAt: atMs });
}
/** An authenticated app heartbeat. */
async function appPing(employeeId, deviceId, atMs) {
  return await P.recordEvent({
    employeeId, deviceId, source: 'APP', srcIp: OFFICE_IP, observedAt: atMs,
  });
}

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP + s); } catch {} }
});

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

test('an authenticated ping binds the phone address seen on the same IP', async () => {
  const emp = await makeEmployee('emp_bind');
  const dev = await makeDevice('dev_bind', emp);
  const now = T.wallClockToEpoch(T.dateKey(), '11:00');

  await arpSighting(PHONE_MAC, OFFICE_IP, now);
  await appPing(emp, dev, now);

  const result = await bindings.bindFromAuthenticatedPing({
    employeeId: emp, deviceId: dev, srcIp: OFFICE_IP, nowMs: now,
  });

  assert.equal(result.bound, true);
  assert.equal(result.reason, 'BOUND');

  const resolved = await bindings.employeeForMac(T.hashMac(PHONE_MAC, MAC_SALT), now);
  assert.equal(resolved.employeeId, emp);
});

test('an unbound address stays anonymous', async () => {
  const resolved = await bindings.employeeForMac(T.hashMac('99:99:99:99:99:99', MAC_SALT));
  assert.equal(resolved, null, 'a MAC nobody proved must never be attributed');
});

test('binding is refused when two addresses share one IP', async () => {
  const emp = await makeEmployee('emp_ambig');
  const dev = await makeDevice('dev_ambig', emp);
  const ip = '192.168.18.77';
  const now = T.wallClockToEpoch(T.dateKey(), '12:00');

  // A recycled DHCP lease: two MACs on one address inside the window.
  await arpSighting('11:11:11:11:11:11', ip, now - 30 * 1000);
  await arpSighting('22:22:22:22:22:22', ip, now - 10 * 1000);

  const result = await bindings.bindFromAuthenticatedPing({
    employeeId: emp, deviceId: dev, srcIp: ip, nowMs: now,
  });

  assert.equal(result.bound, false);
  assert.equal(result.reason, 'AMBIGUOUS_IP',
    'binding either one could put this persons hours on someone elses record');
});

test('binding is refused when nothing was seen on that IP recently', async () => {
  const emp = await makeEmployee('emp_nosight');
  const result = await bindings.bindFromAuthenticatedPing({
    employeeId: emp, deviceId: null, srcIp: '192.168.18.201', nowMs: T.now(),
  });
  assert.equal(result.bound, false);
  assert.equal(result.reason, 'NO_RECENT_SIGHTING');
});

// ---------------------------------------------------------------------------
// The actual reported bug
// ---------------------------------------------------------------------------

test('presence continues after the app is closed', async () => {
  const emp = await makeEmployee('emp_closed');
  const dev = await makeDevice('dev_closed', emp);
  const mac = 'de:ad:be:ef:00:01';
  const ip = '192.168.18.60';

  const arrive = T.wallClockToEpoch(T.dateKey(), '11:00');

  // 11:00 - arrives, opens the app. Identity is proved and the address bound.
  await arpSighting(mac, ip, arrive);
  await appPing(emp, dev, arrive);
  await bindings.bindFromAuthenticatedPing({ employeeId: emp, deviceId: dev, srcIp: ip, nowMs: arrive });

  // 11:05 - closes the app. No further heartbeats, ever.
  const appClosed = arrive + 5 * MIN;
  await appPing(emp, dev, appClosed);

  // 11:05 to 15:00 - only the ESP, which cannot see the app at all.
  for (let m = 10; m <= 240; m += 10) {
    await espSighting(mac, arrive + m * MIN);
  }

  // One minute after the most recent sighting, so this tests the binding and
  // not the ordinary activity threshold.
  const now = arrive + 241 * MIN;   // 15:01
  const day = await P.deriveDay(emp, T.dateKey(arrive), now);

  // Before the fix this read 5 minutes: the last app heartbeat, and nothing
  // after it.
  assert.equal(day.status, 'IN_OFFICE', 'still in the office four hours after closing the app');
  assert.ok(day.totalMinutes >= 235,
    `expected roughly 4 hours, got ${day.totalMinutes} minutes - presence is still following the app`);
  assert.ok(day.lastActiveAt > appClosed,
    'last seen must advance past the moment the app was closed');

  // A binding does not exempt anyone from the normal thresholds - it only
  // changes WHICH signal keeps them alive.
  const quiet = await P.deriveDay(emp, T.dateKey(arrive), arrive + 250 * MIN);
  assert.equal(quiet.status, 'GRACE_PERIOD', '10 minutes after the last sighting');
  const gone = await P.deriveDay(emp, T.dateKey(arrive), arrive + 300 * MIN);
  assert.equal(gone.status, 'AWAY', 'an hour after the last sighting');
});

test('leaving the office does end presence', async () => {
  const emp = await makeEmployee('emp_left');
  const dev = await makeDevice('dev_left', emp);
  const mac = 'de:ad:be:ef:00:02';
  const ip = '192.168.18.61';

  const arrive = T.wallClockToEpoch(T.dateKey(), '11:00');
  await arpSighting(mac, ip, arrive);
  await appPing(emp, dev, arrive);
  await bindings.bindFromAuthenticatedPing({ employeeId: emp, deviceId: dev, srcIp: ip, nowMs: arrive });

  // Present until 13:00, then the phone leaves the network entirely.
  for (let m = 0; m <= 120; m += 10) await espSighting(mac, arrive + m * MIN);

  const now = arrive + 180 * MIN;   // 14:00, an hour after the last sighting
  const day = await P.deriveDay(emp, T.dateKey(arrive), now);

  // The fix must not make people permanently present.
  assert.equal(day.status, 'AWAY', 'no sightings for an hour means they have actually gone');
  assert.ok(day.totalMinutes <= 125, `worked time should stop at the last sighting, got ${day.totalMinutes}`);
});

test('a sensor sighting of a bound address is recorded against that employee', async () => {
  const emp = await makeEmployee('emp_attr');
  const dev = await makeDevice('dev_attr', emp);
  const mac = 'de:ad:be:ef:00:03';
  const ip = '192.168.18.62';
  const now = T.wallClockToEpoch(T.dateKey(), '11:00');

  await arpSighting(mac, ip, now);
  await bindings.bindFromAuthenticatedPing({ employeeId: emp, deviceId: dev, srcIp: ip, nowMs: now });

  const r = await espSighting(mac, now + MIN);
  assert.equal(r.employeeId, emp);
  assert.equal(r.attributedVia, P.ATTRIBUTED_VIA_BINDING);

  // Recorded honestly: stronger than an anonymous sighting, weaker than a live
  // authenticated heartbeat.
  const row = await db.prepare(
    'SELECT confidence, note FROM presence_events WHERE employee_id = ? ORDER BY id DESC LIMIT 1'
  ).get(emp);
  assert.ok(row.confidence >= 0.7 && row.confidence < 1.0);
  assert.match(row.note, new RegExp(P.ATTRIBUTED_VIA_BINDING));
});

// ---------------------------------------------------------------------------
// Bindings must not outlive their proof
// ---------------------------------------------------------------------------

test('an expired binding stops attributing', async () => {
  const emp = await makeEmployee('emp_expire');
  const dev = await makeDevice('dev_expire', emp);
  const mac = 'de:ad:be:ef:00:04';
  const ip = '192.168.18.63';
  const now = T.now();

  await arpSighting(mac, ip, now);
  await bindings.bindFromAuthenticatedPing({ employeeId: emp, deviceId: dev, srcIp: ip, nowMs: now });

  const macHash = T.hashMac(mac, MAC_SALT);
  assert.ok(await bindings.employeeForMac(macHash, now));

  // Well past the TTL, with the app never reopened.
  const later = now + bindings.BINDING_TTL_MS + MIN;
  assert.equal(await bindings.employeeForMac(macHash, later), null,
    'a binding must not follow a rotated or reassigned address forever');

  await bindings.expireStale(later);
  const row = await db.prepare('SELECT revoked_reason FROM device_mac_bindings WHERE mac_hash = ?').get(macHash);
  assert.match(row.revoked_reason, /Expired/);
});

test('revoking a device revokes its binding', async () => {
  const emp = await makeEmployee('emp_revoke');
  const dev = await makeDevice('dev_revoke', emp);
  const mac = 'de:ad:be:ef:00:05';
  const ip = '192.168.18.64';
  const now = T.now();

  await arpSighting(mac, ip, now);
  await bindings.bindFromAuthenticatedPing({ employeeId: emp, deviceId: dev, srcIp: ip, nowMs: now });
  assert.ok(await bindings.employeeForMac(T.hashMac(mac, MAC_SALT), now));

  await bindings.revokeForDevice(dev, 'Device revoked by administrator');

  assert.equal(await bindings.employeeForMac(T.hashMac(mac, MAC_SALT), now), null,
    'a handed-back phone must not keep clocking in its old owner');
});

test('a newer authenticated proof takes the address from the older one', async () => {
  const first = await makeEmployee('emp_first', 'First Owner');
  const second = await makeEmployee('emp_second', 'Second Owner');
  const devA = await makeDevice('dev_first', first);
  const devB = await makeDevice('dev_second', second);
  const mac = 'de:ad:be:ef:00:06';
  const ip = '192.168.18.65';
  const now = T.now();

  await arpSighting(mac, ip, now);
  await bindings.bindFromAuthenticatedPing({ employeeId: first, deviceId: devA, srcIp: ip, nowMs: now });
  assert.equal(await (await bindings.employeeForMac(T.hashMac(mac, MAC_SALT), now)).employeeId, first);

  // The address is reassigned and a different employee proves it.
  const later = now + 10 * MIN;
  await arpSighting(mac, ip, later);
  await bindings.bindFromAuthenticatedPing({ employeeId: second, deviceId: devB, srcIp: ip, nowMs: later });

  assert.equal(await (await bindings.employeeForMac(T.hashMac(mac, MAC_SALT), later)).employeeId, second,
    'live authentication beats a stale binding');

  const events = (await db.prepare(
    "SELECT event_type FROM mac_binding_events WHERE mac_hash = ? ORDER BY id"
  ).all(T.hashMac(mac, MAC_SALT))).map(r => r.event_type);
  assert.ok(events.includes('REBOUND'), 'the handover must be visible in the audit trail');
});

test('every binding change is recorded', async () => {
  const types = (await db.prepare('SELECT DISTINCT event_type FROM mac_binding_events').all()).map(r => r.event_type);
  for (const expected of ['BOUND', 'REVOKED', 'EXPIRED', 'REBOUND', 'CONFLICT']) {
    assert.ok(types.includes(expected), `missing binding event type: ${expected}`);
  }
});
