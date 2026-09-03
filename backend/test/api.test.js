// End-to-end API tests.
//
// These pin the security properties that were missing entirely: every one of
// the first four tests describes a request that USED to succeed.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('api');

process.env.SENSOR_SECRET_esp_test_01 = 'sensor-shared-secret';
// The tests need to simulate requests arriving from an office IP. In production
// this stays off so X-Forwarded-For cannot be used to fake a location.
process.env.TRUST_PROXY = 'true';

const { app } = require('../src/server');
const { db } = require('../src/db');

const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
const OFFICE_IP = { 'X-Forwarded-For': '192.168.18.59' };
const HOME_IP = { 'X-Forwarded-For': '203.0.113.77' };

let base;
let server;

test.before(prepareDatabase);
test.before(async () => {
  await prepareDatabase();
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  // closeAllConnections() first: fetch() keeps its sockets alive, and
  // server.close() waits for every open connection, so on its own it never
  // resolves and the file times out after every test has already passed.
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  await dropDatabase();
});

const req = (method, url, { headers = {}, body } = {}) =>
  fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// The holes that used to exist
// ---------------------------------------------------------------------------

test('the unauthenticated payroll-wipe endpoint no longer exists', async () => {
  const res = await req('POST', '/api/attendance/reset-logs');
  assert.equal(res.status, 404);
  // It must also not fall through to the SPA shell, or a client parsing JSON
  // gets a syntax error instead of a clean failure.
  assert.match(res.headers.get('content-type'), /application\/json/);
});

test('the archive replacement requires admin auth and explicit confirmation', async () => {
  assert.equal((await req('POST', '/api/admin/archive', { body: {} })).status, 401);

  const noConfirm = await req('POST', '/api/admin/archive', { headers: ADMIN, body: {} });
  assert.equal(noConfirm.status, 400, 'must refuse without the explicit confirm token');
});

test('presence cannot be reported without a device token', async () => {
  const res = await req('POST', '/api/attendance/ping', { body: { employeeId: 'emp_8619' } });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'NO_TOKEN');
});

test('employees cannot be created without admin auth', async () => {
  const res = await req('POST', '/api/admin/employees', { body: { name: 'Impostor' } });
  assert.equal(res.status, 401);
});

test('dashboard data requires admin auth', async () => {
  assert.equal((await req('GET', '/api/dashboard/summary')).status, 401);
  assert.equal((await req('GET', '/api/attendance/live')).status, 401);
  assert.equal((await req('GET', '/api/attendance/logs')).status, 401);
});

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

let employeeId;
let deviceToken;

test('admin can create an employee and issue a single-use enrolment code', async () => {
  const create = await req('POST', '/api/admin/employees', {
    headers: ADMIN, body: { name: 'Abdullah Shahid', role: 'Engineering' },
  });
  assert.equal(create.status, 201);
  employeeId = (await create.json()).employee.id;
  // The server generates the id now. The app used to invent its own as
  // emp_${millis % 10000} - a 10,000-value space, chosen client-side.
  assert.match(employeeId, /^emp_[0-9a-f]{12}$/);

  const codeRes = await req('POST', `/api/admin/employees/${employeeId}/enrollment-code`, { headers: ADMIN });
  assert.equal(codeRes.status, 201);
  const { code } = await codeRes.json();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const enroll = await req('POST', '/api/enroll', {
    body: { code, platform: 'android', model: 'CPH2119' },
  });
  assert.equal(enroll.status, 201);
  const enrolled = await enroll.json();
  deviceToken = enrolled.token;
  assert.equal(enrolled.employee.id, employeeId);

  // Second use of the same code must fail.
  const reuse = await req('POST', '/api/enroll', { body: { code, platform: 'android' } });
  assert.equal(reuse.status, 401);
  assert.equal((await reuse.json()).code, 'BAD_CODE');
});

test('a bad enrolment code is rejected', async () => {
  const res = await req('POST', '/api/enroll', { body: { code: 'ZZZZ-ZZZZ' } });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

test('an authenticated heartbeat from the office records attendance', async () => {
  const res = await req('POST', '/api/attendance/ping', {
    headers: { Authorization: `Bearer ${deviceToken}`, ...OFFICE_IP },
    body: { ssid: 'Trans K 2.4G' },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.accepted, 1);
  assert.equal(data.verified, true);
  assert.equal(data.attendance.status, 'IN_OFFICE');
});

// The buddy-punching case. Same valid token, but the request is not coming
// from the office network.
test('an authenticated heartbeat from outside the office does not count', async () => {
  const before = (await db.prepare(
    "SELECT COUNT(*) c FROM presence_events WHERE employee_id = ? AND location = 'OFFICE'"
  ).get(employeeId)).c;

  const res = await req('POST', '/api/attendance/ping', {
    headers: { Authorization: `Bearer ${deviceToken}`, ...HOME_IP },
    body: { ssid: 'Home WiFi', observedAt: Date.now() + 1000 },
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  // `verified` must describe THIS heartbeat, not whether the employee happens
  // to have attendance from earlier in the day - otherwise a remote ping
  // reports success once someone has been in the office at any point.
  assert.equal(body.verified, false, 'a remote heartbeat must not report as verified');
  assert.equal(body.location, 'REMOTE');

  const after = (await db.prepare(
    "SELECT COUNT(*) c FROM presence_events WHERE employee_id = ? AND location = 'OFFICE'"
  ).get(employeeId)).c;
  assert.equal(after, before, 'a remote ping must not add office presence');

  const remote = (await db.prepare(
    "SELECT COUNT(*) c FROM presence_events WHERE employee_id = ? AND location = 'REMOTE'"
  ).get(employeeId)).c;
  assert.ok(remote >= 1, 'but it is still recorded, as REMOTE');
});

test('a client cannot backdate attendance into an arbitrary day', async () => {
  const res = await req('POST', '/api/attendance/ping', {
    headers: { Authorization: `Bearer ${deviceToken}`, ...OFFICE_IP },
    body: {
      observations: [
        { observedAt: Date.now() - 400 * 24 * 3600 * 1000 }, // a year ago
        { observedAt: Date.now() + 90 * 24 * 3600 * 1000 },  // the future
      ],
    },
  });
  assert.equal((await res.json()).rejected, 2);
});

test('replaying the offline queue is idempotent', async () => {
  const at = Date.now() - 5 * 60 * 1000;
  const body = { observations: [{ observedAt: at }, { observedAt: at + 60000 }] };
  const opts = { headers: { Authorization: `Bearer ${deviceToken}`, ...OFFICE_IP }, body };

  const first = await (await req('POST', '/api/attendance/ping', opts)).json();
  const second = await (await req('POST', '/api/attendance/ping', opts)).json();

  assert.equal(first.accepted, 2);
  assert.equal(second.accepted, 0);
  assert.equal(second.duplicates, 2, 'a replayed batch must not double-count');
});

test('a revoked device stops authenticating immediately', async () => {
  const devices = await (await req('GET', '/api/admin/devices', { headers: ADMIN })).json();
  const device = devices.devices.find(d => d.employeeId === employeeId);

  await req('DELETE', `/api/admin/devices/${device.id}`, { headers: ADMIN });

  const res = await req('POST', '/api/attendance/ping', {
    headers: { Authorization: `Bearer ${deviceToken}`, ...OFFICE_IP },
    body: {},
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'REVOKED');
});

// ---------------------------------------------------------------------------
// Hardware sensor HMAC
// ---------------------------------------------------------------------------

function signed(bodyObj, { secret = 'sensor-shared-secret', sensorId = 'esp-test-01', ts = Date.now() } = {}) {
  const body = JSON.stringify(bodyObj);
  const signature = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return {
    headers: {
      'Content-Type': 'application/json',
      'X-Sensor-Id': sensorId,
      'X-Timestamp': String(ts),
      'X-Signature': signature,
    },
    body,
  };
}

test('an unsigned sensor report is rejected', async () => {
  const res = await req('POST', '/api/attendance/heartbeat', { body: { devices: [{ ip: '192.168.18.99' }] } });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'UNSIGNED');
});

test('a sensor report with a wrong signature is rejected', async () => {
  const { headers, body } = signed({ devices: [] }, { secret: 'wrong-secret' });
  const res = await fetch(base + '/api/attendance/heartbeat', { method: 'POST', headers, body });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'BAD_SIGNATURE');
});

test('a correctly signed sensor report is accepted', async () => {
  const { headers, body } = signed({ devices: [{ mac: 'aa:bb:cc:dd:ee:01', rssi: -55 }] });
  const res = await fetch(base + '/api/attendance/heartbeat', { method: 'POST', headers, body });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).recorded, 1);
});

test('a captured sensor request cannot be replayed', async () => {
  const { headers, body } = signed({ devices: [{ mac: 'aa:bb:cc:dd:ee:02' }] });
  const ok = await fetch(base + '/api/attendance/heartbeat', { method: 'POST', headers, body });
  assert.equal(ok.status, 200);

  const replay = await fetch(base + '/api/attendance/heartbeat', { method: 'POST', headers, body });
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).code, 'REPLAY');
});

test('a stale sensor timestamp is rejected', async () => {
  const { headers, body } = signed({ devices: [] }, { ts: Date.now() - 20 * 60 * 1000 });
  const res = await fetch(base + '/api/attendance/heartbeat', { method: 'POST', headers, body });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'STALE');
});

test('network sightings never carry an employee identity', async () => {
  const rows = await db.prepare("SELECT employee_id FROM presence_events WHERE source = 'ESP_SNIFFER'").all();
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => r.employee_id === null),
    'a MAC sighting must never be attributed to a person - MACs randomise');
});

test('unknown-device MACs are stored hashed, never in the clear', async () => {
  const rows = await db.prepare('SELECT mac_hash FROM unknown_devices').all();
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.match(r.mac_hash, /^[0-9a-f]{32}$/);
    assert.ok(!r.mac_hash.includes(':'), 'must not be a raw MAC');
  }
});

// ---------------------------------------------------------------------------
// Consistency and audit
// ---------------------------------------------------------------------------

test('the live board and the dashboard summary agree', async () => {
  const live = await (await req('GET', '/api/attendance/live', { headers: ADMIN })).json();
  const summary = await (await req('GET', '/api/dashboard/summary', { headers: ADMIN })).json();

  assert.equal(live.inOffice.length, summary.stats.currentlyInOffice);
  assert.equal(live.away.length, summary.stats.currentlyAway);

  const fromLive = [...live.inOffice, ...live.grace, ...live.away].find(e => e.employeeId === employeeId);
  const fromSummary = summary.todayAttendance.find(e => e.employeeId === employeeId);
  if (fromLive && fromSummary) {
    assert.equal(fromLive.status, fromSummary.status,
      'the two endpoints must never disagree about the same person');
    assert.equal(fromLive.totalMinutes, fromSummary.totalMinutes);
  }
});

test('admin actions are all audited', async () => {
  const res = await req('GET', '/api/admin/audit', { headers: ADMIN });
  const actions = (await res.json()).entries.map(e => e.action);
  for (const expected of ['EMPLOYEE_CREATED', 'ENROLLMENT_CODE_ISSUED', 'DEVICE_ENROLLED', 'DEVICE_REVOKED']) {
    assert.ok(actions.includes(expected), `missing audit entry: ${expected}`);
  }
});

test('an attendance correction requires a note and is recorded additively', async () => {
  const today = require('../src/util/time').dateKey();

  const noNote = await req('POST', `/api/admin/attendance/${employeeId}/${today}/adjust`, {
    headers: ADMIN, body: { minutes: 30 },
  });
  assert.equal(noNote.status, 400, 'an unexplained change to paid hours must be refused');

  const ok = await req('POST', `/api/admin/attendance/${employeeId}/${today}/adjust`, {
    headers: ADMIN, body: { minutes: 30, note: 'Off-site client meeting' },
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).attendance.adjustmentMinutes, 30);

  const audit = await (await req('GET', '/api/admin/audit', { headers: ADMIN })).json();
  const entry = audit.entries.find(e => e.action === 'ATTENDANCE_ADJUSTED');
  assert.ok(entry, 'the correction must be attributable after the fact');
  assert.equal(entry.note, 'Off-site client meeting');
});

test('SSE requires a ticket, and a ticket is single-use', async () => {
  assert.equal((await req('GET', '/api/events?ticket=nope')).status, 401);

  const { ticket } = await (await req('POST', '/api/admin/sse-ticket', { headers: ADMIN })).json();
  const ctrl = new AbortController();
  const stream = await fetch(`${base}/api/events?ticket=${ticket}`, { signal: ctrl.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  ctrl.abort();

  assert.equal((await req('GET', `/api/events?ticket=${ticket}`)).status, 401, 'ticket must not be reusable');
});

test('CSV export is produced for payroll', async () => {
  const today = require('../src/util/time').dateKey();
  const res = await req('GET', `/api/admin/export?from=${today}&to=${today}`, { headers: ADMIN });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.match(csv.split('\n')[0], /^date,employee_id,employee_name/);
  assert.ok(csv.includes('Abdullah Shahid'));
});
