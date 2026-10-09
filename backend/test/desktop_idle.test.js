// Laptop idle as the day view counts it (workstation_idle_spans) must match
// the idle seconds the agent actually reported. The heartbeats at the edges of
// an away period are part idle, part active; their idle used to be dropped from
// the day view while still reaching the Telemetry counter (6 Oct 2026: 7 vs 3,
// 29 vs 20, 48 vs 39 minutes).

const test = require('node:test');
const assert = require('node:assert');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('desktop_idle');

const { app } = require('../src/server');
const { db } = require('../src/db');
const T = require('../src/util/time');

const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
// Wednesday 23 Sep 2026, 14:00 in Asia/Karachi -- inside the 11:00-19:00 test hours.
const START = Date.UTC(2026, 8, 23, 9, 0, 0);
let clock = START;
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

async function enrolLaptop(name) {
  const emp = await json('POST', '/api/admin/employees', { headers: ADMIN, body: { name, role: 'Engineer' } });
  const code = await json('POST', `/api/admin/employees/${emp.body.employee.id}/enrollment-code`, { headers: ADMIN });
  const laptop = await json('POST', '/api/enroll', { body: { code: code.body.code, platform: 'windows', model: 'Latitude' } });
  return { employeeId: emp.body.employee.id, auth: { Authorization: `Bearer ${laptop.body.token}` } };
}

/**
 * Sends one heartbeat a minute for `minutes` minutes, splitting each into the
 * agent's 10-second samples: a sample is idle once there has been no input for
 * 300 s (desktop/src-tauri/src/main.rs). `away` lists [stopsAtSecond, forSeconds].
 * Returns the idle seconds the agent reported and the last response.
 */
async function simulate(auth, { from, minutes, away, onBreak = () => false }) {
  const lastInput = (t) => {
    for (const [s, len] of away) if (t >= s && t < s + len) return s;
    return t;
  };
  let reportedIdle = 0;
  let last;
  for (let m = 0; m < minutes; m++) {
    let active = 0;
    let idle = 0;
    for (let k = 1; k <= 6; k++) {
      const t = m * 60 + k * 10;
      if (onBreak(t) || t - lastInput(t) >= 300) idle += 10; else active += 10;
    }
    reportedIdle += idle;
    clock = from + (m + 1) * 60000;
    last = await json('POST', '/api/desktop/heartbeat', {
      headers: auth,
      body: { lockState: 'UNLOCKED', lockDurationSeconds: 0, activeSeconds: active, idleSeconds: idle, localIp: '192.168.18.61' },
    });
  }
  return { reportedIdle, last };
}

const spansOf = (employeeId) => db.prepare(
  'SELECT start_at, end_at FROM workstation_idle_spans WHERE employee_id = ? ORDER BY start_at'
).all(employeeId);

test('the day view counts the idle at the edges of every away period', async () => {
  const p = await enrolLaptop('Edge Idle');
  // Away 6m40s (idle only after 5 min, split over two part-idle minutes),
  // 9m20s, and 15 min, none lined up with the minute boundaries.
  const away = [[620, 400], [1500, 560], [2400, 900]];
  const { reportedIdle, last } = await simulate(p.auth, { from: START, minutes: 60, away });

  const ws = await db.prepare('SELECT idle_seconds FROM workstation_sessions WHERE employee_id = ?').get(p.employeeId);
  assert.equal(Number(ws.idle_seconds), reportedIdle, 'the Telemetry counter holds every reported idle second');
  assert.equal(last.body.today.day.idleMinutes, Math.round(reportedIdle / 60),
    'the day view counts the same idle as the agent reported');

  // Three away periods give three spans, each exactly where the agent's idle
  // samples were: a sample covers the 10 s before it, so idle runs from the
  // tick before the 5-minute mark to the last tick before the person came back.
  const spans = await spansOf(p.employeeId);
  assert.equal(spans.length, 3);
  away.forEach(([s, len], i) => {
    assert.equal((Number(spans[i].start_at) - START) / 1000, s + 290, `span ${i} starts when idle began`);
    assert.equal((Number(spans[i].end_at) - START) / 1000, s + len - 10, `span ${i} ends when the person came back`);
  });
});

test('idle at the end of a break is not moved onto working time', async () => {
  const p = await enrolLaptop('Break Edge');
  const from = START + 2 * 3600 * 1000; // 16:00 PKT
  clock = from;
  // Break 16:00:00-16:02:30: the agent counts break samples as idle. The
  // heartbeat that covers the end of the break is part idle (the break) and
  // part active, and that idle sits at the START of its minute.
  await json('POST', '/api/desktop/break', { headers: p.auth, body: { onBreak: true } });
  const breakEnd = 150;
  for (let m = 0; m < 4; m++) {
    let active = 0;
    let idle = 0;
    for (let k = 1; k <= 6; k++) {
      if (m * 60 + k * 10 <= breakEnd) idle += 10; else active += 10;
    }
    clock = from + Math.min((m + 1) * 60, m * 60 + 60) * 1000;
    if (m === 2) {
      clock = from + breakEnd * 1000;
      await json('POST', '/api/desktop/break', { headers: p.auth, body: { onBreak: false } });
      clock = from + (m + 1) * 60000;
    }
    await json('POST', '/api/desktop/heartbeat', {
      headers: p.auth,
      body: { lockState: 'UNLOCKED', lockDurationSeconds: 0, activeSeconds: active, idleSeconds: idle, isManualBreak: m < 2, localIp: '192.168.18.62' },
    });
  }
  const spans = await spansOf(p.employeeId);
  for (const s of spans) {
    assert.ok(Number(s.end_at) <= from + breakEnd * 1000, `idle span ends by the end of the break, got +${(Number(s.end_at) - from) / 1000}s`);
  }
  const hb = await json('POST', '/api/desktop/heartbeat', {
    headers: p.auth,
    body: { lockState: 'UNLOCKED', lockDurationSeconds: 0, activeSeconds: 0, idleSeconds: 0, localIp: '192.168.18.62' },
  });
  assert.equal(hb.body.today.day.idleMinutes, 0, 'break time is never idle');
});

test('the first heartbeat after a night asleep puts the sleep before the work, not on the last minute', async () => {
  const p = await enrolLaptop('Morning Wake');
  const from = START + 3600 * 1000;   // 15:00 PKT on the test day: in hours
  clock = from;
  // The laptop slept for an hour, woke, and was used for 5 minutes: the agent
  // reports 3600 s idle (the sleep) and 300 s active in its first heartbeat.
  const r = await json('POST', '/api/desktop/heartbeat', {
    headers: p.auth,
    body: { lockState: 'UNLOCKED', lockDurationSeconds: 0, activeSeconds: 300, idleSeconds: 3600, localIp: '192.168.18.63' },
  });
  assert.equal(r.body.workstationStatus, 'ACTIVE');
  const spans = await spansOf(p.employeeId);
  for (const s of spans) {
    assert.ok(Number(s.end_at) <= from - 300 * 1000, `idle span ends before the 5 active minutes, got ${(from - Number(s.end_at)) / 1000}s before now`);
  }
  assert.notEqual(r.body.today.day.counting, false, 'counting: the person is working, not idle');
});

test('Friday prayers: idle or locked between 13:00 and 14:00 (office time) is active, not idle', async () => {
  const p = await enrolLaptop('Friday Prayer');
  // Friday 25 Sep 2026, 12:50 PKT (UTC+5) = 07:50 UTC.
  const from = Date.UTC(2026, 8, 25, 7, 50, 0);
  // No input from 12:50 to 14:05: idle from 12:54:50 until the person is back.
  const { last } = await simulate(p.auth, { from, minutes: 80, away: [[0, 4500]] });

  const prayerStart = Date.UTC(2026, 8, 25, 8, 0, 0);   // 13:00 PKT
  const prayerEnd = Date.UTC(2026, 8, 25, 9, 0, 0);     // 14:00 PKT
  const spans = await spansOf(p.employeeId);
  for (const s of spans) {
    assert.ok(Number(s.end_at) <= prayerStart || Number(s.start_at) >= prayerEnd, 'no idle span inside the prayer hour');
  }
  // Idle only outside the hour: 12:54:50-13:00 and 14:00-14:04:50.
  assert.equal(last.body.today.day.idleMinutes, 10);
  const ws = await db.prepare('SELECT idle_seconds, active_seconds FROM workstation_sessions WHERE employee_id = ?').get(p.employeeId);
  assert.equal(Number(ws.idle_seconds), 600, 'the laptop counter has the same idle');
  assert.equal(Number(ws.active_seconds), 80 * 60 - 600, 'the prayer hour is counted active');

  // Locked for 15 minutes at 13:30: still active.
  clock = Date.UTC(2026, 8, 25, 8, 30, 0);
  const locked = await json('POST', '/api/desktop/heartbeat', {
    headers: p.auth,
    body: { lockState: 'LOCKED', lockDurationSeconds: 900, activeSeconds: 0, idleSeconds: 0, localIp: '192.168.18.64' },
  });
  assert.equal(locked.body.workstationStatus, 'ACTIVE');
});
