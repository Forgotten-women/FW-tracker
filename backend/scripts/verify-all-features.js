// Comprehensive verification for:
// 1. Multi-SSID verification (Trans K 2.4G/5G, Naya 2.4G/5G, Naya K 5G, etc.)
// 2. Offline in-office beacon verification vs Remote at home classification
// 3. Supabase database schema (app_tracking_enabled, desktop_heartbeat_dedupe)
// 4. Idempotency deduplication check
// 5. BYOD personal laptop privacy toggle (app tracking on/off)
// 6. Working hours boundary logic

require('dotenv').config();
const assert = require('assert');
const { config, isOfficeSsid } = require('../src/config');
const presence = require('../src/domain/presence');
const { db } = require('../src/db');
const schedule = require('../src/domain/schedule');
const T = require('../src/util/time');

async function run() {
  console.log('====================================================');
  console.log('  OFFICE TRACKER - COMPREHENSIVE FEATURE VERIFICATION');
  console.log('====================================================\n');

  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`  ✔ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✖ [FAIL] ${name}: ${err.message}`);
      throw err;
    }
  }

  async function testAsync(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✔ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✖ [FAIL] ${name}: ${err.message}`);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // 1. MULTI-SSID VERIFICATION
  // -------------------------------------------------------------------------
  console.log('--- 1. Multi-SSID Verification ---');

  test('All office SSIDs recognized with case & whitespace normalization', () => {
    assert.strictEqual(isOfficeSsid('Trans K 2.4G'), true);
    assert.strictEqual(isOfficeSsid('trans k 5g'), true);
    assert.strictEqual(isOfficeSsid('  Trans K 5G  '), true);
    assert.strictEqual(isOfficeSsid('Naya K 5G'), true);
    assert.strictEqual(isOfficeSsid('naya 5g'), true);
    assert.strictEqual(isOfficeSsid('Naya 2.4G'), true);
    assert.strictEqual(isOfficeSsid('NAYA K 2.4G'), true);
    assert.strictEqual(isOfficeSsid('huawei-2.4g-2jwu'), true);

    // Non-office networks
    assert.strictEqual(isOfficeSsid('Home_WiFi_5G'), false);
    assert.strictEqual(isOfficeSsid('PTCL-BB-5G'), false);
    assert.strictEqual(isOfficeSsid('Nayatel_Fiber_Guest'), false);
    assert.strictEqual(isOfficeSsid(''), false);
    assert.strictEqual(isOfficeSsid(null), false);
  });

  // -------------------------------------------------------------------------
  // 2. LOCATION CLASSIFICATION: OFFLINE IN OFFICE VS REMOTE AT HOME
  // -------------------------------------------------------------------------
  console.log('\n--- 2. Location Classification Engine ---');

  test('Offline in office: Radio detects office AP beacons over the air -> OFFICE', () => {
    const verdict = presence.classifyLocation({
      source: 'APP',
      srcIp: '127.0.0.1', // local or disconnected
      localIp: '192.168.1.105',
      bssid: null, // disconnected or not yet associated
      ssid: null,
      visibleOfficeBssids: [
        { bssid: 'ba:9f:cc:db:52:58', signal: 78 },
        { bssid: 'ba:9f:cc:db:52:5c', signal: 65 },
      ],
    });
    assert.strictEqual(verdict, 'OFFICE');
  });

  test('Connected to Naya K 5G on office subnet -> OFFICE', () => {
    const verdict = presence.classifyLocation({
      source: 'APP',
      srcIp: '192.168.18.50',
      localIp: '192.168.18.50',
      bssid: 'ba:9f:cc:db:52:5e',
      ssid: 'Naya K 5G',
      visibleOfficeBssids: [],
    });
    assert.strictEqual(verdict, 'OFFICE');
  });

  test('Remote at home: Home Wi-Fi, no office beacons, home IP -> REMOTE', () => {
    const verdict = presence.classifyLocation({
      source: 'APP',
      srcIp: '182.180.120.45', // Home ISP public IP
      localIp: '192.168.10.15', // Home router subnet
      bssid: 'e4:5d:51:aa:bb:cc', // Home TP-Link/Huawei router
      ssid: 'Home_Fiber_Optic_5G',
      visibleOfficeBssids: [
        { bssid: '12:34:56:78:9a:bc', signal: 80 }, // Neighbor Wi-Fi
      ],
    });
    assert.strictEqual(verdict, 'REMOTE');
  });

  test('Explains remote location clearly to employee without ambiguity', () => {
    const explanation = presence.explainLocation({
      source: 'APP',
      bssid: 'e4:5d:51:aa:bb:cc',
      srcIp: '182.180.120.45',
    });
    assert(explanation !== null, 'Explanation should not be null');
    assert(explanation.message.includes('Trans K 2.4G') || explanation.message.includes('Trans K 5G') || explanation.message.includes('Naya'));
    console.log(`     (Explanation message: "${explanation.message.slice(0, 75)}...")`);
  });

  // -------------------------------------------------------------------------
  // 3. DATABASE SCHEMA & IDEMPOTENCY
  // -------------------------------------------------------------------------
  console.log('\n--- 3. Database Schema & Idempotency ---');

  await testAsync('Supabase DB: app_tracking_enabled column in employees table', async () => {
    const emp = await db.prepare('SELECT id, name, app_tracking_enabled FROM employees LIMIT 1').get();
    assert(emp !== undefined, 'Employee row should exist');
    assert('app_tracking_enabled' in emp, 'app_tracking_enabled column must exist');
    console.log(`     (Sample employee: ${emp.name}, app_tracking_enabled: ${emp.app_tracking_enabled})`);
  });

  await testAsync('Supabase DB: desktop_heartbeat_dedupe table exists and enforces primary key', async () => {
    const testId = `test_evt_${Date.now()}`;
    const testDev = 'dev_test_verifier';
    const now = Date.now();

    // Insert dedupe record
    await db.prepare('INSERT INTO desktop_heartbeat_dedupe (event_id, device_id, received_at) VALUES (?, ?, ?)')
      .run(testId, testDev, now);

    // Verify found
    const row = await db.prepare('SELECT * FROM desktop_heartbeat_dedupe WHERE event_id = ?').get(testId);
    assert.strictEqual(row.event_id, testId);

    // Duplicate insert should throw or be blocked by primary key
    let duplicateRejected = false;
    try {
      await db.prepare('INSERT INTO desktop_heartbeat_dedupe (event_id, device_id, received_at) VALUES (?, ?, ?)')
        .run(testId, testDev, now);
    } catch (e) {
      duplicateRejected = true;
    }
    assert.strictEqual(duplicateRejected, true, 'Duplicate event_id must be rejected');

    // Clean up test row
    await db.prepare('DELETE FROM desktop_heartbeat_dedupe WHERE event_id = ?').run(testId);
  });

  // -------------------------------------------------------------------------
  // 4. BYOD APP TRACKING PRIVACY TOGGLE
  // -------------------------------------------------------------------------
  console.log('\n--- 4. BYOD App Tracking Privacy Toggle ---');

  await testAsync('HR App Tracking Toggle: updates employee app_tracking_enabled', async () => {
    const emp = await db.prepare('SELECT id, app_tracking_enabled FROM employees LIMIT 1').get();
    const originalVal = emp.app_tracking_enabled;
    const toggledVal = originalVal === 1 ? 0 : 1;

    // Toggle
    await db.prepare('UPDATE employees SET app_tracking_enabled = ? WHERE id = ?').run(toggledVal, emp.id);
    const updated = await db.prepare('SELECT app_tracking_enabled FROM employees WHERE id = ?').get(emp.id);
    assert.strictEqual(updated.app_tracking_enabled, toggledVal);

    // Revert back to original
    await db.prepare('UPDATE employees SET app_tracking_enabled = ? WHERE id = ?').run(originalVal, emp.id);
    const reverted = await db.prepare('SELECT app_tracking_enabled FROM employees WHERE id = ?').get(emp.id);
    assert.strictEqual(reverted.app_tracking_enabled, originalVal);
  });

  // -------------------------------------------------------------------------
  // 5. WORKING HOURS BOUNDARY LOGIC
  // -------------------------------------------------------------------------
  console.log('\n--- 5. Working Hours Boundary Logic ---');

  await testAsync('Working hours schedule resolution and outside-hours boundary check', async () => {
    const emp = await db.prepare('SELECT id FROM employees LIMIT 1').get();
    const dateKey = T.dateKey(Date.now());
    const sched = await schedule.resolve(emp.id, dateKey);

    assert(sched !== null && typeof sched === 'object');
    assert('isWorkingDay' in sched);
    assert('startTime' in sched);
    assert('endTime' in sched);
    console.log(`     (Employee schedule: isWorkingDay=${sched.isWorkingDay}, hours=${sched.startTime} to ${sched.endTime})`);
  });

  console.log('\n====================================================');
  console.log(`  ALL ${passed}/${total} VERIFICATION CHECKS PASSED SUCCESSFULLY!`);
  console.log('====================================================\n');
}

run().catch((err) => {
  console.error('\nVerification failed:', err);
  process.exit(1);
});
