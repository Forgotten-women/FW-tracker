// Tests for self-service employee profile and conditional salary gating API.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('profile');


const { app } = require('../src/server');
const { db } = require('../src/db');
const payroll = require('../src/domain/payroll');
const people = require('../src/domain/people');

const ADMIN = { 'X-Admin-Key': process.env.ADMIN_API_KEY };
let base;
let server;

test.before(prepareDatabase);
test.before(async () => {
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

test('Self-Service Profile & Salary Visibility API', async (t) => {
  // Create employee via admin endpoint
  const empRes = await req('POST', '/api/admin/employees', {
    headers: ADMIN,
    body: {
      name: 'Profile Tester',
      role: 'Staff',
      employeeNumber: 'FW-999',
      workEmail: 'tester@forgottenwomen.org',
    },
  });
  assert.strictEqual(empRes.status, 201);
  const empBody = await empRes.json();
  const empId = empBody.employee.id;

  // Set employment details
  await people.setEmployment({
    employeeId: empId,
    jobTitle: 'QA Lead',
    employmentType: 'Full-time',
    startDate: '2026-01-01',
    changeReason: 'Initial setup',
    actor: 'user:admin',
  });

  // Assign a salary
  await payroll.setSalary({
    employeeId: empId,
    amount: 120000,
    effectiveFrom: '2026-01-01',
    currency: 'PKR',
    reason: 'Offer letter rate',
    actor: 'user:admin',
  });

  // Generate enrollment code
  const codeRes = await req('POST', `/api/admin/employees/${empId}/enrollment-code`, {
    headers: ADMIN,
  });
  assert.strictEqual(codeRes.status, 201);
  const codeBody = await codeRes.json();

  // Enroll device to get auth token
  const enrolRes = await req('POST', '/api/enroll', {
    body: {
      code: codeBody.code,
      platform: 'android',
      model: 'TestPhone',
    },
  });
  assert.strictEqual(enrolRes.status, 201);
  const enrolBody = await enrolRes.json();
  const token = enrolBody.token;
  const AUTH = { Authorization: `Bearer ${token}` };

  await t.test('Profile returns basic details and salary is hidden by default', async () => {
    const res = await req('GET', '/api/people/mine/profile', { headers: AUTH });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'SUCCESS');
    assert.strictEqual(body.profile.name, 'Profile Tester');
    assert.strictEqual(body.profile.employment.jobTitle, 'QA Lead');
    assert.strictEqual(body.profile.salary.enabled, false);
    assert.match(body.profile.salary.message, /disabled by HR/i);
  });

  await t.test('Admin can update show_salary_to_employees org setting', async () => {
    const setRes = await req('POST', '/api/admin/settings', {
      headers: ADMIN,
      body: {
        key: 'show_salary_to_employees',
        value: '1',
        description: 'Allow staff to view personal salary in mobile app',
      },
    });
    assert.strictEqual(setRes.status, 200);
    const setBody = await setRes.json();
    assert.strictEqual(setBody.status, 'SUCCESS');
    assert.strictEqual(setBody.value, '1');
  });

  await t.test('Profile returns live salary breakdown when setting is enabled', async () => {
    const res = await req('GET', '/api/people/mine/profile', { headers: AUTH });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'SUCCESS');
    assert.strictEqual(body.profile.salary.enabled, true);
    assert.strictEqual(body.profile.salary.monthly, 120000);
    assert.strictEqual(body.profile.salary.annual, 1440000);
    assert.strictEqual(body.profile.salary.currency, 'PKR');
    assert.ok(body.profile.salary.daily > 0);
  });

  await t.test('Admin can toggle show_salary_to_employees off again', async () => {
    await req('POST', '/api/admin/settings', {
      headers: ADMIN,
      body: {
        key: 'show_salary_to_employees',
        value: '0',
      },
    });

    const res = await req('GET', '/api/people/mine/profile', { headers: AUTH });
    const body = await res.json();
    assert.strictEqual(body.status, 'SUCCESS');
    assert.strictEqual(body.profile.salary.enabled, false);
  });
});
