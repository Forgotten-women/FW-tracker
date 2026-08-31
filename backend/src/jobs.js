// Scheduled maintenance.
//
// The original had one 30s interval (checkDepartures) that mutated shared state
// and only ever looked at the current day, so sessions left open across
// midnight were never closed. There was no retention policy and no backup.

const { db, tx, audit, backup } = require('./db');
const { config } = require('./config');
const P = require('./domain/presence');
const bindings = require('./domain/bindings');
const A = require('./domain/attendance');
const W = require('./domain/warnings');
const L = require('./domain/leave');
const AL = require('./domain/alerts');
const events = require('./events');
const T = require('./util/time');

const TICK_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const insertMovement = db.prepare(
  'INSERT INTO movements (at, type, employee_id, employee_name, details) VALUES (?,?,?,?,?)'
);

// ---------------------------------------------------------------------------
// Departure detection
// ---------------------------------------------------------------------------

// Status is derived, so nothing needs to be "marked" away - but a DEPARTED
// movement entry still has to be emitted once, when the transition happens.
const lastKnownStatus = new Map(); // employeeId -> status

function detectTransitions(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  const employees = db.prepare('SELECT id, name FROM employees WHERE active = 1').all();

  for (const emp of employees) {
    const d = P.deriveDay(emp.id, todayKey, nowMs);
    const prev = lastKnownStatus.get(emp.id);
    lastKnownStatus.set(emp.id, d.status);

    if (prev === undefined || prev === d.status) continue;

    if (d.status === 'AWAY' && (prev === 'IN_OFFICE' || prev === 'GRACE_PERIOD')) {
      insertMovement.run(nowMs, 'DEPARTED', emp.id, emp.name,
        `No activity for ${config.gracePeriodMinutes} mins`);
      events.broadcast('MOVEMENT', {
        type: 'DEPARTED', employeeId: emp.id, employeeName: emp.name,
        time: T.displayTime(nowMs),
      });
    }
    P.recomputeDay(emp.id, todayKey, nowMs);
    // Keeps late minutes, break excess and the deficit in step with presence,
    // so the HR dashboard is never a tick behind the live board.
    A.recomputeDay(emp.id, todayKey, nowMs);
  }
}

// ---------------------------------------------------------------------------
// Day rollover
// ---------------------------------------------------------------------------

let lastRolloverKey = null;

/**
 * At local midnight, finalise the day that just ended.
 *
 * Sessions are already bounded by the day window in the derivation, so nothing
 * can run away here - this marks the day closed and recomputes it one last
 * time so the cached row is final.
 */
function rollover(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastRolloverKey === null) { lastRolloverKey = todayKey; return; }
  if (lastRolloverKey === todayKey) return;

  const closedKey = lastRolloverKey;
  lastRolloverKey = todayKey;

  const employees = db.prepare('SELECT id, name FROM employees WHERE active = 1').all();
  let closed = 0;

  const run = tx(() => {
    for (const emp of employees) {
      const d = P.recomputeDay(emp.id, closedKey, nowMs);
      // Settles the day's deficit into the ledger now that it can no longer
      // change. Posting it while the day was still running would have written
      // a figure that kept moving.
      A.recomputeDay(emp.id, closedKey, nowMs);
      if (d.status === 'NOT_CHECKED_IN') continue;
      db.prepare('UPDATE attendance_days SET closed = 1 WHERE employee_id = ? AND date_key = ?')
        .run(emp.id, closedKey);
      closed++;
      if (d.exceededCap) {
        // A capped session almost always means a phone was left in the office.
        // Flagged rather than quietly recorded as a normal day.
        insertMovement.run(nowMs, 'NEEDS_REVIEW', emp.id, emp.name,
          `${closedKey}: session exceeded the ${config.maxSessionMinutes} min cap`);
      }
    }
    audit({ actor: 'system', action: 'DAY_ROLLOVER', targetType: 'date', targetId: closedKey,
            after: { closedDays: closed } });
  });
  run();

  lastKnownStatus.clear();
  console.log(`[jobs] rolled over ${closedKey}: ${closed} employee-day(s) closed`);
  
  try {
    const absRes = W.scanDailyAbsences(closedKey, nowMs);
    if (absRes && absRes.detectedCount > 0) {
      console.log(`[jobs] rollover absence scan flagged ${absRes.detectedCount} no-show(s) for ${closedKey}`);
    }
  } catch (e) {
    console.error('[jobs] rollover absence scan error:', e.message);
  }

  events.broadcast('DAY_ROLLOVER', { closedDate: closedKey });
}

// ---------------------------------------------------------------------------
// Warning evaluation
// ---------------------------------------------------------------------------

let lastWarningSweepKey = null;

/**
 * Raises lateness referrals and ages out expired warnings.
 *
 * Runs once a day rather than every minute: a referral is about a monthly
 * count, not a live signal, and re-evaluating constantly would only burn CPU.
 * evaluateLateness is idempotent regardless.
 */
function evaluateWarnings(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastWarningSweepKey === todayKey) return;
  lastWarningSweepKey = todayKey;

  try {
    const expired = W.expireWarnings(nowMs);
    if (expired) {
      console.log(`[jobs] ${expired} warning(s) expired - still counted toward escalation history`);
    }

    const raised = W.evaluateAll(todayKey, nowMs);
    for (const r of raised) {
      const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(r.employeeId);
      // A referral, not a warning. The wording matters because this text is
      // what HR sees first.
      insertMovement.run(nowMs, 'WARNING_TRIGGER', r.employeeId, emp?.name || null,
        'Lateness threshold reached - referred to HR for review');
      events.broadcast('WARNING_TRIGGER', {
        employeeId: r.employeeId,
        employeeName: emp?.name || null,
        triggerId: r.triggerId,
        time: T.displayTime(nowMs),
      });
    }
    if (raised.length) console.log(`[jobs] ${raised.length} lateness referral(s) raised for HR review`);
  } catch (err) {
    console.error('[jobs] warning evaluation failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Leave accrual
// ---------------------------------------------------------------------------

let lastAccrualKey = null;

/**
 * Credits monthly leave accrual. Runs once a day; accrue() is idempotent, so
 * the exact tick it lands on does not matter.
 *
 * Employees who cannot be assessed are LOGGED rather than skipped silently.
 * Under an anniversary-based holiday year an employee with no start date has no
 * computable balance, and quietly showing them zero days would be worse than
 * saying so.
 */
function accrueLeave(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastAccrualKey === todayKey) return;
  lastAccrualKey = todayKey;

  try {
    const r = L.accrueAll(todayKey);
    if (r.accrued) console.log(`[jobs] leave accrued for ${r.accrued} employee(s)`);
    if (r.blocked.length) {
      console.log(
        `[jobs] leave accrual BLOCKED for ${r.blocked.length} employee(s) - ` +
        'no employment start date, so their holiday year cannot be worked out',
      );
    }
  } catch (err) {
    console.error('[jobs] leave accrual failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Advanced HR alerts (spec 22)
// ---------------------------------------------------------------------------

let lastAlertKey = null;

// Notifies HR of contract, probation, document and review dates coming due.
// Once a day; notifyHr is keyed on (alert, value) so it never re-notifies the
// same date.
function notifyHrAlerts(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastAlertKey === todayKey) return;
  lastAlertKey = todayKey;
  try {
    const r = AL.notifyHr(todayKey, nowMs);
    if (r.notified) console.log(`[jobs] ${r.notified} HR alert(s) notified`);
  } catch (err) {
    console.error('[jobs] HR alert notification failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

let lastRetentionKey = null;

/**
 * Prune raw sensor data past its retention window.
 *
 * attendance_days is NEVER pruned - it is the payroll record. Only the raw
 * event stream and the hashed unknown-device table age out. The old system had
 * no retention at all: it kept the MAC of every visitor and neighbour phone
 * indefinitely, in a git-tracked file.
 */
function retention(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastRetentionKey === todayKey) return;
  lastRetentionKey = todayKey;

  const eventCutoff = nowMs - (config.retention.presenceEventDays || 90) * DAY_MS;
  const unknownCutoff = nowMs - (config.retention.unknownDeviceDays || 7) * DAY_MS;

  const run = tx(() => {
    const ev = db.prepare('DELETE FROM presence_events WHERE observed_at < ?').run(eventCutoff);
    const un = db.prepare('DELETE FROM unknown_devices WHERE last_seen_at < ?').run(unknownCutoff);
    if (ev.changes || un.changes) {
      audit({
        actor: 'system', action: 'RETENTION_PRUNE',
        after: { presenceEvents: ev.changes, unknownDevices: un.changes },
        note: `events older than ${config.retention.presenceEventDays}d, unknown devices older than ${config.retention.unknownDeviceDays}d`,
      });
      console.log(`[jobs] retention: pruned ${ev.changes} events, ${un.changes} unknown devices`);
    }
  });
  run();
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

let lastBackupKey = null;

async function nightlyBackup(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastBackupKey === todayKey) return;
  lastBackupKey = todayKey;
  try {
    const p = await backup();
    audit({ actor: 'system', action: 'BACKUP_CREATED', note: p });
    console.log(`[jobs] backup written: ${p}`);
  } catch (err) {
    console.error('[jobs] backup FAILED:', err.message);
  }
}

let lastAbsenceScanKey = null;

function scanAbsences(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastAbsenceScanKey === todayKey) return;
  lastAbsenceScanKey = todayKey;

  try {
    const result = W.scanDailyAbsences(todayKey, nowMs);
    if (result && result.detectedCount > 0) {
      console.log(`[jobs] absence sweep flagged ${result.detectedCount} suspected no-show(s) for ${todayKey}`);
    }
  } catch (err) {
    console.error('[jobs] absence sweep failed:', err.message);
  }
}

// ---------------------------------------------------------------------------

let timer = null;

function start() {
  const tick = () => {
    const nowMs = T.now();
    try {
      rollover(nowMs);
      // Before transitions, so an employee whose binding has just lapsed is
      // evaluated against the new reality rather than a stale one.
      const expired = bindings.expireStale(nowMs);
      if (expired) console.log(`[jobs] ${expired} MAC binding(s) expired without reconfirmation`);
      detectTransitions(nowMs);
      evaluateWarnings(nowMs);
      scanAbsences(nowMs);
      accrueLeave(nowMs);
      notifyHrAlerts(nowMs);
      retention(nowMs);
      void nightlyBackup(nowMs);
    } catch (err) {
      // A failing maintenance tick must never take the server down.
      console.error('[jobs] tick failed:', err.message);
    }
  };

  // Prime the status map so the first tick does not emit a burst of spurious
  // DEPARTED entries for everyone who is legitimately away.
  detectTransitions(T.now());
  lastRolloverKey = T.dateKey();

  timer = setInterval(tick, TICK_MS);
  timer.unref();
  console.log(`[jobs] maintenance running every ${TICK_MS / 1000}s (rollover, retention, backup)`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, rollover, retention, detectTransitions, evaluateWarnings, scanAbsences, accrueLeave, notifyHrAlerts, nightlyBackup };
