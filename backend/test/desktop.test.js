const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('desktop');


const { app } = require('../src/server');
const { db } = require('../src/db');
const T = require('../src/util/time');

const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
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
    body: body ? JSON.stringify(body) : undefined,
  });

test('Desktop Workstation Agent & Unified Multi-Device Pairing', async () => {
  // 1. Create an employee and get an enrollment code
  const empRes = await req('POST', '/api/admin/employees', {
    headers: ADMIN,
    body: { name: 'Desktop Test User', role: 'Software Engineer' },
  });
  assert.equal(empRes.status, 201);
  const empData = await empRes.json();
  const employeeId = empData.employee.id;

  const codeRes = await req('POST', `/api/admin/employees/${employeeId}/enrollment-code`, {
    headers: ADMIN,
  });
  assert.equal(codeRes.status, 201);
  const codeData = await codeRes.json();
  const code = codeData.code;

  // 2. Enroll Mobile App with code
  const mobileRes = await req('POST', '/api/enroll', {
    body: { code, platform: 'android', model: 'CPH2119', label: 'Work Phone' },
  });
  assert.equal(mobileRes.status, 201);
  const mobileData = await mobileRes.json();
  assert.equal(mobileData.status, 'SUCCESS');
  const mobileToken = mobileData.token;

  // 3. Enroll Desktop Agent with SAME code (Unified Multi-Device Pairing)
  const desktopRes = await req('POST', '/api/enroll', {
    body: { code, platform: 'windows', model: 'Dell Latitude 7420', label: 'Work Laptop' },
  });
  assert.equal(desktopRes.status, 201);
  const desktopData = await desktopRes.json();
  assert.equal(desktopData.status, 'SUCCESS');
  const desktopToken = desktopData.token;
  const desktopDeviceId = desktopData.deviceId;

  // 4. Verify a 3rd attempt on same platform (desktop again) is rejected
  const thirdRes = await req('POST', '/api/enroll', {
    body: { code, platform: 'windows', model: 'Rogue Laptop' },
  });
  assert.equal(thirdRes.status, 401);

  // 5. Send Desktop Heartbeat (Active, Unlocked, In Office)
  const hbRes = await req('POST', '/api/desktop/heartbeat', {
    headers: { 'Authorization': `Bearer ${desktopToken}` },
    body: {
      activeSeconds: 60,
      idleSeconds: 0,
      lockState: 'UNLOCKED',
      lockDurationSeconds: 0,
      connectedBssid: '00:11:22:33:44:55',
    },
  });
  assert.equal(hbRes.status, 200);
  const hbData = await hbRes.json();
  assert.equal(hbData.status, 'SUCCESS');
  assert.equal(hbData.workstationStatus, 'ACTIVE');

  // 6. Test Screen Lock Grace Period (Locked for 2 mins <= 5 min grace -> still ACTIVE)
  const lockGraceRes = await req('POST', '/api/desktop/heartbeat', {
    headers: { 'Authorization': `Bearer ${desktopToken}` },
    body: {
      activeSeconds: 60,
      idleSeconds: 0,
      lockState: 'LOCKED',
      lockDurationSeconds: 120, // 2 minutes
    },
  });
  assert.equal(lockGraceRes.status, 200);
  const lockGraceData = await lockGraceRes.json();
  assert.equal(lockGraceData.workstationStatus, 'ACTIVE');

  // 7. Test Screen Lock Beyond Grace Period (Locked for 6 mins > 5 min grace -> AWAY)
  const lockAwayRes = await req('POST', '/api/desktop/heartbeat', {
    headers: { 'Authorization': `Bearer ${desktopToken}` },
    body: {
      activeSeconds: 0,
      idleSeconds: 0,
      lockState: 'LOCKED',
      lockDurationSeconds: 360, // 6 minutes
    },
  });
  assert.equal(lockAwayRes.status, 200);
  const lockAwayData = await lockAwayRes.json();
  assert.equal(lockAwayData.workstationStatus, 'AWAY');

  // 8. Test Idle Threshold (> 300s idle -> IDLE)
  const idleRes = await req('POST', '/api/desktop/heartbeat', {
    headers: { 'Authorization': `Bearer ${desktopToken}` },
    body: {
      activeSeconds: 0,
      idleSeconds: 360, // 6 minutes idle
      lockState: 'UNLOCKED',
    },
  });
  assert.equal(idleRes.status, 200);
  const idleData = await idleRes.json();
  assert.equal(idleData.workstationStatus, 'IDLE');

  // 9. Test Manual Break
  const breakRes = await req('POST', '/api/desktop/break', {
    headers: { 'Authorization': `Bearer ${desktopToken}` },
    body: { onBreak: true, reason: 'Lunch Break' },
  });
  assert.equal(breakRes.status, 200);
  const breakData = await breakRes.json();
  assert.equal(breakData.workstationStatus, 'ON_BREAK');

  // 10. Test Anomaly Reporting
  const anomRes = await req('POST', '/api/desktop/anomaly', {
    headers: { 'Authorization': `Bearer ${desktopToken}` },
    body: {
      processName: 'suspicious_autoclicker.exe',
      durationSeconds: 900,
      windowTitle: 'Auto Clicker v3.2',
    },
  });
  assert.equal(anomRes.status, 201);
  const anomData = await anomRes.json();
  assert.ok(anomData.anomalyId);

  // 11. Test Desktop Status Endpoint
  const statusRes = await req('GET', '/api/desktop/status', {
    headers: { 'Authorization': `Bearer ${desktopToken}` },
  });
  assert.equal(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.equal(statusData.employee.id, employeeId);
  assert.ok(statusData.workstation);
  assert.ok(statusData.policy);
});
