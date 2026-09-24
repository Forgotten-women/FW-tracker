// Desktop agent <-> phone consistency: break state read by the agent after a
// phone break, the start-up status probe booking no time, the reason the
// widget is (not) counting, and an Exit being put on the record.

const test = require('node:test');
const assert = require('node:assert');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('desktop_sync');

const { app } = require('../src/server');
const { db } = require('../src/db');
const T = require('../src/util/time');

const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
// Wednesday 23 Sep 2026, 14:00 in Asia/Karachi -- inside the 11:00-19:00 test hours.
let clock = Date.UTC(2026, 8, 23, 9, 0, 0);
const realNow = T.now;

let base;
let server;

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

const json = async (method, url, { headers = {}, body } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

async function enrolPair(name) {
  const emp = await json('POST', '/api/admin/employees', { headers: ADMIN, body: { name, role: 'Engineer' } });
  const code = await json('POST', `/api/admin/employees/${emp.body.employee.id}/enrollment-code`, { headers: ADMIN });
  const phone = await json('POST', '/api/enroll', { body: { code: code.body.code, platform: 'android', model: 'Pixel' } });
  const laptop = await json('POST', '/api/enroll', { body: { code: code.body.code, platform: 'windows', model: 'Latitude' } });
  return {
    employeeId: emp.body.employee.id,
    phone: { Authorization: `Bearer ${phone.body.token}` },
    laptop: { Authorization: `Bearer ${laptop.body.token}` },
    laptopId: laptop.body.deviceId,
  };
}

const heartbeat = (auth, body) => json('POST', '/api/desktop/heartbeat', {
  headers: auth,
  body: { lockState: 'UNLOCKED', lockDurationSeconds: 0, ...body },
});

test('a break started on the phone is what the laptop reads back', async () => {
  const p = await enrolPair('Phone Breaker');

  let state = await json('GET', '/api/desktop/break-state', { headers: p.laptop });
  assert.equal(state.body.onBreak, false);

  const started = await json('POST', '/api/attendance/break/start', { headers: p.phone });
  assert.equal(started.status, 201);

  state = await json('GET', '/api/desktop/break-state', { headers: p.laptop });
  assert.equal(state.body.onBreak, true);
  assert.equal(state.body.breakStartedAt, clock);
  assert.equal(state.body.breakDueBackAt, clock + state.body.breakPermittedMinutes * 60 * 1000);

  clock += 20 * 60 * 1000;
  const ended = await json('POST', '/api/attendance/break/end', { headers: p.phone });
  assert.equal(ended.status, 200);

  state = await json('GET', '/api/desktop/break-state', { headers: p.laptop });
  assert.equal(state.body.onBreak, false);
  assert.equal(state.body.breakAlreadyTaken, true);
});

test("the agent's zero-length status probe books no time, even during a break", async () => {
  const p = await enrolPair('Probe Sender');
  await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0 });
  await json('POST', '/api/attendance/break/start', { headers: p.phone });

  const before = await db.prepare('SELECT break_seconds, idle_seconds FROM workstation_sessions WHERE device_id = ?').get(p.laptopId);
  const probe = await heartbeat(p.laptop, { activeSeconds: 0, idleSeconds: 0 });
  assert.equal(probe.status, 200);
  const after = await db.prepare('SELECT break_seconds, idle_seconds FROM workstation_sessions WHERE device_id = ?').get(p.laptopId);

  assert.equal(Number(after.idle_seconds), Number(before.idle_seconds));
  // break_seconds may be topped up from the break record's real elapsed time,
  // but never by a phantom 60s for the probe itself.
  assert.ok(Number(after.break_seconds) < Number(before.break_seconds) + 60);
});

test('the heartbeat says why time is or is not being counted', async () => {
  const p = await enrolPair('Credit Reader');
  const hb = await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0 });
  // No office network in the test fixture and not a remote worker.
  assert.equal(hb.body.creditState, 'UNVERIFIED');

  const evening = clock;
  clock = Date.UTC(2026, 8, 23, 16, 0, 0); // 21:00 Karachi
  const late = await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0 });
  assert.equal(late.body.creditState, 'OUTSIDE_HOURS');
  clock = evening;
});

test('exiting the agent is recorded rather than looking like missing data', async () => {
  const p = await enrolPair('Agent Quitter');
  await heartbeat(p.laptop, { activeSeconds: 60, idleSeconds: 0 });

  const stopped = await json('POST', '/api/desktop/agent-stopped', { headers: p.laptop, body: { reason: 'Exited from the tray menu' } });
  assert.equal(stopped.status, 200);

  const movement = await db.prepare(
    "SELECT * FROM movements WHERE employee_id = ? AND type = 'DESKTOP_AGENT_STOPPED'"
  ).get(p.employeeId);
  assert.ok(movement, 'the stop is in the movements feed');
  const session = await db.prepare('SELECT status FROM workstation_sessions WHERE device_id = ?').get(p.laptopId);
  assert.equal(session.status, 'AGENT_STOPPED');
});
