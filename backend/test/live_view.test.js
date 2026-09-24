// Live screen view: request -> laptop notified -> first frame -> stop, and the
// reasons the viewer is given when a stream can't start.
//
// The clock is pinned (T.now) to a weekday afternoon inside the test office's
// 11:00-19:00 hours, because capture is only permitted during working hours.

const test = require('node:test');
const assert = require('node:assert');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('live_view');

const { app } = require('../src/server');
const T = require('../src/util/time');

const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
// Wednesday 23 Sep 2026, 14:00 in Asia/Karachi (UTC+5).
const WED_2PM = Date.UTC(2026, 8, 23, 9, 0, 0);
const FRAME = '/9j/' + 'A'.repeat(400);

let base;
let server;
let clock = WED_2PM;
const realNow = T.now;

test.before(async () => {
  T.now = () => clock;
  await prepareDatabase();
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  T.now = realNow;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  await dropDatabase();
});

const req = (method, url, { headers = {}, body } = {}) =>
  fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

const json = async (method, url, opts) => {
  const res = await req(method, url, opts);
  return { status: res.status, body: await res.json() };
};

async function enrolDesktop(name) {
  const emp = await json('POST', '/api/admin/employees', { headers: ADMIN, body: { name, role: 'Engineer' } });
  assert.equal(emp.status, 201);
  const code = await json('POST', `/api/admin/employees/${emp.body.employee.id}/enrollment-code`, { headers: ADMIN });
  const enrol = await json('POST', '/api/enroll', {
    body: { code: code.body.code, platform: 'windows', model: 'Latitude', label: 'Laptop' },
  });
  assert.equal(enrol.status, 201);
  return {
    employeeId: emp.body.employee.id,
    deviceId: enrol.body.deviceId,
    auth: { Authorization: `Bearer ${enrol.body.token}` },
  };
}

const heartbeat = (dev) => json('POST', '/api/desktop/heartbeat', {
  headers: dev.auth,
  body: { activeSeconds: 60, idleSeconds: 0, lockState: 'UNLOCKED', lockDurationSeconds: 0 },
});

test('a live-view session moves WAITING -> STARTING -> LIVE and stops cleanly', async () => {
  const dev = await enrolDesktop('Live Viewer Subject');

  const hb = await heartbeat(dev);
  assert.equal(hb.status, 200);
  assert.equal(hb.body.liveView.protocol, 2);
  assert.equal(hb.body.liveView.realtime, null, 'no Supabase Realtime in tests, so no doorbell config');

  // Frames nobody asked for are refused, and the agent is told to stop.
  const unasked = await json('POST', '/api/desktop/stream-frame', { headers: dev.auth, body: { frameBase64: FRAME } });
  assert.equal(unasked.body.continue, false);

  const requested = await json('POST', `/api/admin/workstations/${dev.deviceId}/request-stream`, { headers: ADMIN });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.doorbell, 'UNAVAILABLE');
  assert.equal(requested.body.frameStore, 'memory');

  let view = await json('GET', `/api/admin/workstations/${dev.deviceId}/live-frame`, { headers: ADMIN });
  assert.equal(view.body.phase, 'WAITING', 'the laptop has not checked in since the request');
  assert.equal(view.body.active, false);

  const status = await json('GET', '/api/desktop/stream-status', { headers: dev.auth });
  assert.equal(status.body.liveStreamRequested, true);

  view = await json('GET', `/api/admin/workstations/${dev.deviceId}/live-frame`, { headers: ADMIN });
  assert.equal(view.body.phase, 'STARTING', 'the laptop acknowledged; its first frame is on the way');
  assert.ok(view.body.ackAt);

  const sent = await json('POST', '/api/desktop/stream-frame', { headers: dev.auth, body: { frameBase64: FRAME } });
  assert.equal(sent.body.continue, true);

  view = await json('GET', `/api/admin/workstations/${dev.deviceId}/live-frame`, { headers: ADMIN });
  assert.equal(view.body.phase, 'LIVE');
  assert.equal(view.body.active, true);
  assert.equal(view.body.frameBase64, FRAME);
  const shownAt = view.body.lastFrameAt;

  // Asking "anything newer than what I'm showing?" of an unchanged frame
  // returns no image bytes.
  view = await json('GET', `/api/admin/workstations/${dev.deviceId}/live-frame?since=${shownAt}`, { headers: ADMIN });
  assert.equal(view.body.phase, 'LIVE');
  assert.equal(view.body.unchanged, true);
  assert.equal(view.body.frameBase64, null);

  // A static screen sends a keepalive instead of the same JPEG again.
  clock += 3000;
  const kept = await json('POST', '/api/desktop/stream-frame', { headers: dev.auth, body: { keepalive: true } });
  assert.equal(kept.body.continue, true);

  const stopped = await json('POST', `/api/admin/workstations/${dev.deviceId}/stop-stream`, { headers: ADMIN });
  assert.equal(stopped.status, 200);

  const after = await json('POST', '/api/desktop/stream-frame', { headers: dev.auth, body: { frameBase64: FRAME } });
  assert.equal(after.body.continue, false, 'the agent learns on its next frame that nobody is watching');

  view = await json('GET', `/api/admin/workstations/${dev.deviceId}/live-frame`, { headers: ADMIN });
  assert.equal(view.body.phase, 'ENDED');
});

test('a laptop that stopped sending heartbeats is reported OFFLINE, not left spinning', async () => {
  const dev = await enrolDesktop('Offline Laptop');
  await heartbeat(dev);

  clock += 10 * 60 * 1000; // ten minutes of silence, still inside working hours
  await json('POST', `/api/admin/workstations/${dev.deviceId}/request-stream`, { headers: ADMIN });

  const view = await json('GET', `/api/admin/workstations/${dev.deviceId}/live-frame`, { headers: ADMIN });
  assert.equal(view.body.phase, 'OFFLINE');
  assert.equal(typeof view.body.lastSeenAt, 'number', 'the heartbeat was recorded, so "last seen" is known');
  assert.ok(view.body.lastSeenAt < clock - 5 * 60 * 1000);
});

test('a break stops frames immediately and the viewer says why', async () => {
  const dev = await enrolDesktop('Break Taker');
  await heartbeat(dev);
  await json('POST', `/api/admin/workstations/${dev.deviceId}/request-stream`, { headers: ADMIN });
  await json('GET', '/api/desktop/stream-status', { headers: dev.auth });
  const first = await json('POST', '/api/desktop/stream-frame', { headers: dev.auth, body: { frameBase64: FRAME } });
  assert.equal(first.body.continue, true);

  const onBreak = await json('POST', '/api/desktop/break', { headers: dev.auth, body: { onBreak: true, reason: 'Lunch' } });
  assert.equal(onBreak.status, 200);

  // Not cached: the very next frame after the break starts is refused.
  const refused = await json('POST', '/api/desktop/stream-frame', { headers: dev.auth, body: { frameBase64: FRAME } });
  assert.equal(refused.body.status, 'PAUSED');
  assert.equal(refused.body.continue, false);
  assert.equal(refused.body.reason, 'ON_BREAK');

  const view = await json('GET', `/api/admin/workstations/${dev.deviceId}/live-frame`, { headers: ADMIN });
  assert.equal(view.body.phase, 'PAUSED_BREAK');
  assert.equal(view.body.isBreak, true);
});

test('outside working hours the request is explained, and frames are refused', async () => {
  const dev = await enrolDesktop('Evening Laptop');
  clock = Date.UTC(2026, 8, 23, 16, 0, 0); // 21:00 in Karachi
  await heartbeat(dev);
  await json('POST', `/api/admin/workstations/${dev.deviceId}/request-stream`, { headers: ADMIN });

  const status = await json('GET', '/api/desktop/stream-status', { headers: dev.auth });
  assert.equal(status.body.liveStreamRequested, false);
  assert.equal(status.body.outsideWorkingHours, true);

  const view = await json('GET', `/api/admin/workstations/${dev.deviceId}/live-frame`, { headers: ADMIN });
  assert.equal(view.body.phase, 'OUTSIDE_HOURS');
});

test('the health check reports where live frames are stored', async () => {
  const health = await json('GET', '/api/health');
  assert.deepEqual(health.body.liveView, { frameStore: 'memory', doorbell: false });
});
