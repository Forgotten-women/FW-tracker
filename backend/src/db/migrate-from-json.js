#!/usr/bin/env node
// One-time import of the legacy backend/data/db.json into SQLite.
//
//   node src/db/migrate-from-json.js [--force] [--file <path>]
//
// The legacy file mixes two incompatible attendance shapes under the same key,
// because processDeviceSeen() and the register-device route each wrote their
// own:
//   A) { firstCheckIn, lastActive, sessions[], currentSessionStart, status }
//   B) { checkIn, checkOut, totalMinutes, status: 'PRESENT' }
// Both are handled here. It also mixes timestamp formats within a single record
// ("...+05:00" alongside "...Z"); Date.parse reads both correctly and
// everything is normalised to UTC epoch ms on the way in.

const fs = require('fs');
const path = require('path');

const { db, tx, audit } = require('./index');
const T = require('../util/time');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const fileArg = args.indexOf('--file');
const JSON_FILE = fileArg !== -1
  ? args[fileArg + 1]
  : path.join(__dirname, '..', '..', 'data', 'db.json');

// Legacy sessions are stored as start/end pairs. Replay needs events, so each
// session is expanded into a sighting every few minutes. That way the derived
// attendance reproduces the original session boundaries and minutes, and the
// day stays recomputable from the event log like any other.
const SYNTH_INTERVAL_MS = 5 * 60 * 1000;

function parseTs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

function main() {
  if (!fs.existsSync(JSON_FILE)) {
    console.error(`[migrate] No legacy file at ${JSON_FILE} - nothing to import.`);
    process.exit(0);
  }

  const existing = db.prepare('SELECT COUNT(*) c FROM employees').get().c;
  if (existing > 0 && !FORCE) {
    console.error(`[migrate] Refusing to run: the database already has ${existing} employee(s).`);
    console.error('[migrate] Re-run with --force only if you intend to merge into it.');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'));
  const nowMs = T.now();

  const stats = {
    employees: 0, devices: 0, events: 0, days: 0, movements: 0,
    skippedUnknownDevices: 0, warnings: [],
  };

  const insertEmployee = db.prepare(`
    INSERT INTO employees (id, name, role, active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, updated_at = excluded.updated_at
  `);
  const insertDevice = db.prepare(`
    INSERT INTO devices (id, employee_id, platform, model, label, enrolled_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertEvent = db.prepare(`
    INSERT INTO presence_events
      (employee_id, device_id, source, location, confidence, src_ip, observed_at, received_at, dedupe_key, note)
    VALUES (?, ?, 'APP', 'OFFICE', 0.5, ?, ?, ?, ?, 'imported from legacy db.json')
    ON CONFLICT(dedupe_key) DO NOTHING
  `);
  const insertMovement = db.prepare(`
    INSERT INTO movements (at, type, employee_id, employee_name, details) VALUES (?, ?, ?, ?, ?)
  `);

  const run = tx(() => {
    // --- employees + their single legacy device -----------------------------
    for (const e of raw.employees || []) {
      if (!e || !e.id || !e.name) continue;
      const created = parseTs(e.firstSeenToday) || nowMs;
      insertEmployee.run(e.id, e.name, e.role || 'Team Member', created, nowMs);
      stats.employees++;

      // The legacy model allowed exactly one device per employee, keyed on a
      // randomising MAC and a rotating DHCP lease. The device row is carried
      // over for continuity, but it has NO token: every phone must re-enrol
      // through the new flow before it can report presence again.
      if (e.deviceIp || e.deviceMac) {
        const deviceId = `legacy_${e.id}`;
        insertDevice.run(
          deviceId, e.id, 'unknown', e.deviceModel || '',
          'Imported (re-enrolment required)',
          created, parseTs(e.lastSeen)
        );
        stats.devices++;
      }
    }

    // --- attendance -> synthesized events ------------------------------------
    for (const [dateKey, byEmployee] of Object.entries(raw.attendanceRecords || {})) {
      for (const [employeeId, ledger] of Object.entries(byEmployee || {})) {
        if (!ledger) continue;
        const exists = db.prepare('SELECT 1 FROM employees WHERE id = ?').get(employeeId);
        if (!exists) {
          stats.warnings.push(`attendance for unknown employee ${employeeId} on ${dateKey} - skipped`);
          continue;
        }
        const deviceId = db.prepare('SELECT id FROM devices WHERE employee_id = ?').get(employeeId)?.id || null;

        // Shape A sessions, plus any still-open session, plus shape B.
        const spans = [];
        for (const s of ledger.sessions || []) {
          const a = parseTs(s.start), b = parseTs(s.end);
          if (a !== null && b !== null && b >= a) spans.push([a, b]);
        }
        if (ledger.currentSessionStart) {
          const a = parseTs(ledger.currentSessionStart);
          const b = parseTs(ledger.lastActive);
          if (a !== null && b !== null && b >= a) spans.push([a, b]);
        }
        if (spans.length === 0) {
          // Shape B, or a shape A ledger with no session list yet.
          const a = parseTs(ledger.firstCheckIn) ?? parseTs(ledger.checkIn);
          const b = parseTs(ledger.lastActive) ?? parseTs(ledger.checkOut) ?? a;
          if (a !== null && b !== null && b >= a) spans.push([a, b]);
        }

        for (const [start, end] of spans) {
          for (let t = start; t < end; t += SYNTH_INTERVAL_MS) {
            insertEvent.run(employeeId, deviceId, null, t, nowMs, `IMPORT|${employeeId}|${Math.floor(t / 1000)}`);
            stats.events++;
          }
          insertEvent.run(employeeId, deviceId, null, end, nowMs, `IMPORT|${employeeId}|${Math.floor(end / 1000)}`);
          stats.events++;
        }
      }
    }

    // --- movement feed -------------------------------------------------------
    for (const m of raw.movements || []) {
      const at = parseTs(m.timestamp);
      if (at === null) continue;
      const empId = m.employeeId && db.prepare('SELECT 1 FROM employees WHERE id = ?').get(m.employeeId)
        ? m.employeeId : null;
      insertMovement.run(at, m.type || 'UNKNOWN', empId, m.employeeName || null, m.details || null);
      stats.movements++;
    }

    // Unassigned devices are deliberately NOT imported: they are the MACs of
    // visitors and neighbours, kept in plaintext with no retention limit and no
    // lawful basis. The new table stores only salted hashes on a short TTL and
    // will repopulate itself from live sightings.
    stats.skippedUnknownDevices = Object.keys(raw.unassignedDevices || {}).length;

    audit({
      actor: 'migration',
      action: 'IMPORT_LEGACY_JSON',
      targetType: 'database',
      targetId: path.basename(JSON_FILE),
      after: { employees: stats.employees, devices: stats.devices, events: stats.events },
      note: 'One-time import from db.json',
    });
  });

  run();

  // Derive attendance for every imported day from the event log.
  const P = require('../domain/presence');
  stats.days = P.recomputeAll();

  console.log('\n[migrate] Import complete');
  console.log(`  employees          : ${stats.employees}`);
  console.log(`  devices            : ${stats.devices} (all require re-enrolment)`);
  console.log(`  presence events    : ${stats.events} (synthesized from legacy sessions)`);
  console.log(`  attendance days    : ${stats.days} (derived)`);
  console.log(`  movement entries   : ${stats.movements}`);
  console.log(`  unknown devices    : ${stats.skippedUnknownDevices} skipped by design (visitor MACs, no lawful basis to retain)`);
  for (const w of stats.warnings) console.log(`  WARNING: ${w}`);
  console.log('');
}

main();
