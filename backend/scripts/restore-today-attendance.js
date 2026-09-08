const path = require('path');
const backendDir = path.join(__dirname, '..');
require(path.join(backendDir, 'node_modules', 'dotenv')).config({ path: path.join(backendDir, '.env') });

const { Client } = require(path.join(backendDir, 'node_modules', 'pg'));
const presence = require(path.join(backendDir, 'src', 'domain', 'presence'));
const attendance = require(path.join(backendDir, 'src', 'domain', 'attendance'));
const T = require(path.join(backendDir, 'src', 'util', 'time'));

async function restore() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const employeeId = 'emp_8619';
  const deviceId = 'dev_84b2a24b3129a515';
  const dateKey = '2026-09-08';
  const arrivalMs = 1788848174614; // 11:16:14 AM PKT

  console.log(`[Restore] Restoring continuous arrival at ${new Date(arrivalMs).toLocaleTimeString()} for ${employeeId}...`);

  // 1. Insert reconciled presence events between 11:16:14 AM and 12:02:36 PM at 8-minute intervals
  const intermediateTimes = [
    1788848174614, // 11:16:14
    1788848654614, // 11:24:14
    1788849134614, // 11:32:14
    1788849614614, // 11:40:14
    1788850094614, // 11:48:14
    1788850574614, // 11:56:14
  ];

  for (const t of intermediateTimes) {
    const dedupeKey = `APP|${employeeId}|${deviceId}|${Math.floor(t / 1000)}`;
    await client.query(`
      INSERT INTO presence_events (
        employee_id, device_id, source, location, confidence, bssid, src_ip, observed_at, received_at, dedupe_key, note
      ) VALUES (
        $1, $2, 'APP', 'OFFICE', 1.0, 'ba:9f:cc:db:52:5e', '127.0.0.1', $3, $3, $4, 'Desktop Agent (Arrival Reconciled)'
      ) ON CONFLICT (dedupe_key) DO NOTHING
    `, [employeeId, deviceId, t, dedupeKey]);
  }

  console.log('[Restore] Inserted continuous arrival presence events from 11:16 AM.');

  // 2. Add the missing 46 minutes (2760 seconds) to workstation_sessions
  await client.query(`
    UPDATE workstation_sessions
    SET active_seconds = active_seconds + 2760,
        unverified_seconds = 0,
        in_office = 1
    WHERE device_id = $1 AND session_date = $2
  `, [deviceId, dateKey]);

  console.log('[Restore] Credited 46 minutes (2760 seconds) to workstation_sessions.');

  // 3. Recompute presence and attendance for today
  await presence.recomputeDay(employeeId, dateKey);
  await attendance.recomputeDay(employeeId, dateKey);

  console.log('[Restore] Recomputed attendance and presence.');

  // 4. Fetch updated attendance_days row
  const adRes = await client.query('SELECT * FROM attendance_days WHERE employee_id = $1 AND date_key = $2', [employeeId, dateKey]);
  console.log('\n--- UPDATED ATTENDANCE DAYS FOR TODAY ---');
  console.log(JSON.stringify(adRes.rows, null, 2));

  // 5. Fetch updated workstation_sessions row
  const wsRes = await client.query('SELECT * FROM workstation_sessions WHERE device_id = $1 AND session_date = $2', [deviceId, dateKey]);
  console.log('\n--- UPDATED WORKSTATION SESSION ---');
  console.log(JSON.stringify(wsRes.rows, null, 2));

  await client.end();
}

restore().catch(console.error);
