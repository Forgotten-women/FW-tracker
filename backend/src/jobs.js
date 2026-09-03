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
const N = require('./domain/notifications');
const schedule = require('./domain/schedule');
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

async function detectTransitions(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  const employees = await db.prepare('SELECT id, name FROM employees WHERE active = 1').all();

  for (const emp of employees) {
    const d = await P.deriveDay(emp.id, todayKey, nowMs);
    const prev = lastKnownStatus.get(emp.id);
    lastKnownStatus.set(emp.id, d.status);

    if (prev === undefined || prev === d.status) continue;

    if (d.status === 'AWAY' && (prev === 'IN_OFFICE' || prev === 'GRACE_PERIOD')) {
      await insertMovement.run(nowMs, 'DEPARTED', emp.id, emp.name,
        `No activity for ${config.gracePeriodMinutes} mins`);
      events.broadcast('MOVEMENT', {
        type: 'DEPARTED', employeeId: emp.id, employeeName: emp.name,
        time: T.displayTime(nowMs),
      });
    }
    await P.recomputeDay(emp.id, todayKey, nowMs);
    // Keeps late minutes, break excess and the deficit in step with presence,
    // so the HR dashboard is never a tick behind the live board.
    await A.recomputeDay(emp.id, todayKey, nowMs);
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
async function rollover(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastRolloverKey === null) { lastRolloverKey = todayKey; return; }
  if (lastRolloverKey === todayKey) return;

  const closedKey = lastRolloverKey;
  lastRolloverKey = todayKey;

  const employees = await db.prepare('SELECT id, name FROM employees WHERE active = 1').all();
  let closed = 0;

  await tx(async () => {
    for (const emp of employees) {
      const d = await P.recomputeDay(emp.id, closedKey, nowMs);
      // Settles the day's deficit into the ledger now that it can no longer
      // change. Posting it while the day was still running would have written
      // a figure that kept moving.
      await A.recomputeDay(emp.id, closedKey, nowMs);
      if (d.status === 'NOT_CHECKED_IN') continue;
      await db.prepare('UPDATE attendance_days SET closed = 1 WHERE employee_id = ? AND date_key = ?')
        .run(emp.id, closedKey);
      closed++;
      if (d.exceededCap) {
        // A capped session almost always means a phone was left in the office.
        // Flagged rather than quietly recorded as a normal day.
        await insertMovement.run(nowMs, 'NEEDS_REVIEW', emp.id, emp.name,
          `${closedKey}: session exceeded the ${config.maxSessionMinutes} min cap`);
      }
    }
    await audit({ actor: 'system', action: 'DAY_ROLLOVER', targetType: 'date', targetId: closedKey,
            after: { closedDays: closed } });
  });
  

  lastKnownStatus.clear();
  console.log(`[jobs] rolled over ${closedKey}: ${closed} employee-day(s) closed`);
  
  try {
    const absRes = await W.scanDailyAbsences(closedKey, nowMs);
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
async function evaluateWarnings(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastWarningSweepKey === todayKey) return;
  lastWarningSweepKey = todayKey;

  try {
    const expired = await W.expireWarnings(nowMs);
    if (expired) {
      console.log(`[jobs] ${expired} warning(s) expired - still counted toward escalation history`);
    }

    const raised = await W.evaluateAll(todayKey, nowMs);
    for (const r of raised) {
      const emp = await db.prepare('SELECT name FROM employees WHERE id = ?').get(r.employeeId);
      // A referral, not a warning. The wording matters because this text is
      // what HR sees first.
      await insertMovement.run(nowMs, 'WARNING_TRIGGER', r.employeeId, emp?.name || null,
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
async function accrueLeave(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastAccrualKey === todayKey) return;
  lastAccrualKey = todayKey;

  try {
    const r = await L.accrueAll(todayKey);
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
async function notifyHrAlerts(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastAlertKey === todayKey) return;
  lastAlertKey = todayKey;
  try {
    const r = await AL.notifyHr(todayKey, nowMs);
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
async function retention(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastRetentionKey === todayKey) return;
  lastRetentionKey = todayKey;

  const eventCutoff = nowMs - (config.retention.presenceEventDays || 90) * DAY_MS;
  const unknownCutoff = nowMs - (config.retention.unknownDeviceDays || 7) * DAY_MS;

  await tx(async () => {
    const ev = await db.prepare('DELETE FROM presence_events WHERE observed_at < ?').run(eventCutoff);
    const un = await db.prepare('DELETE FROM unknown_devices WHERE last_seen_at < ?').run(unknownCutoff);
    if (ev.changes || un.changes) {
      await audit({
        actor: 'system', action: 'RETENTION_PRUNE',
        after: { presenceEvents: ev.changes, unknownDevices: un.changes },
        note: `events older than ${config.retention.presenceEventDays}d, unknown devices older than ${config.retention.unknownDeviceDays}d`,
      });
      console.log(`[jobs] retention: pruned ${ev.changes} events, ${un.changes} unknown devices`);
    }
  });
  
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
    await audit({ actor: 'system', action: 'BACKUP_CREATED', note: p });
    console.log(`[jobs] backup written: ${p}`);
  } catch (err) {
    console.error('[jobs] backup FAILED:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Attendance Reminder Notifications (spec requirement: notify if auto-attendance fails)
// ---------------------------------------------------------------------------
//
// Check-in reminder: fires at 11:10 AM (the moment grace expires) if no check-in
// has been recorded yet for a scheduled working day.
//
// Check-out reminder: fires at 7:05 PM (5 mins after shift end) if no manual
// clock-out event has been recorded.
//
// Both fire ONCE per employee per day. Tracking is done via a simple in-memory
// Set keyed on "employeeId:dateKey" so server restart on the same day can
// re-send, but a normal day never double-fires.

const _sentCheckInReminder = new Set();   // "emp_id:date_key"
const _sentCheckOutReminder = new Set();  // "emp_id:date_key"

async function sendAttendanceReminders(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);

  const employees = await db.prepare('SELECT id, name FROM employees WHERE active = 1').all();

  for (const emp of employees) {
    try {
      const s = await schedule.resolve(emp.id, todayKey);

      // Skip weekends, public holidays, and non-working days for this employee.
      if (!s.isWorkingDay) continue;

      // -----------------------------------------------------------------------
      // 1. Check-In Reminder — at grace expiry (11:10 AM)
      // -----------------------------------------------------------------------
      const checkInKey = `${emp.id}:${todayKey}:checkin`;
      if (!_sentCheckInReminder.has(checkInKey) && nowMs >= s.latestOnTimeAt) {
        // Derive today's attendance to check if any check-in exists.
        const day = await A.deriveDay(emp.id, todayKey, nowMs);

        if (!day.firstInAt) {
          // No check-in recorded at all — send the reminder.
          _sentCheckInReminder.add(checkInKey);
          await N.notify({
            employeeId: emp.id,
            category: 'ATTENDANCE',
            title: '⏰ Attendance Not Recorded',
            body: 'Your check-in has not been detected yet today. If you have arrived, please ensure your phone is connected to the office Wi-Fi. If the sensor failed, open the app to confirm your attendance.',
            severity: 'warning',
            link: '/attendance',
            nowMs,
          });
          console.log(`[jobs] check-in reminder sent → ${emp.name} (${emp.id}) for ${todayKey}`);
        } else {
          // Already checked in — mark as sent so we don't re-check every minute.
          _sentCheckInReminder.add(checkInKey);
        }
      }

      // -----------------------------------------------------------------------
      // 2. Check-Out Reminder — at 7:05 PM (5 mins after scheduled end)
      // -----------------------------------------------------------------------
      const checkOutReminderAt = s.scheduledEndAt + 5 * 60 * 1000; // +5 mins
      const checkOutKey = `${emp.id}:${todayKey}:checkout`;
      if (!_sentCheckOutReminder.has(checkOutKey) && nowMs >= checkOutReminderAt) {
        // Check if a CLOCK_OUT attendance event exists for today.
        const clockOutEvent = await db.prepare(`
          SELECT id FROM attendance_events
          WHERE employee_id = ? AND date_key = ? AND event_type = 'CLOCK_OUT' AND voided_at IS NULL
          LIMIT 1
        `).get(emp.id, todayKey);

        if (!clockOutEvent) {
          // No manual clock-out — check if they were even present today before sending.
          const day = await A.deriveDay(emp.id, todayKey, nowMs);
          if (day.firstInAt) {
            // Was present but has not clocked out — send the reminder.
            _sentCheckOutReminder.add(checkOutKey);
            await N.notify({
              employeeId: emp.id,
              category: 'ATTENDANCE',
              title: '🔔 Clock-Out Reminder',
              body: 'It is 7:05 PM and your clock-out has not been recorded. If you have finished your working day, please clock out from the app so your attendance is accurately logged.',
              severity: 'info',
              link: '/attendance',
              nowMs,
            });
            console.log(`[jobs] clock-out reminder sent → ${emp.name} (${emp.id}) for ${todayKey}`);
          } else {
            // Not present today — skip silently.
            _sentCheckOutReminder.add(checkOutKey);
          }
        } else {
          // Already clocked out — mark as sent.
          _sentCheckOutReminder.add(checkOutKey);
        }
      }
    } catch (err) {
      console.error(`[jobs] attendance reminder error for employee ${emp.id}:`, err.message);
    }
  }
}

let lastAbsenceScanKey = null;

async function scanAbsences(nowMs = T.now()) {
  const todayKey = T.dateKey(nowMs);
  if (lastAbsenceScanKey === todayKey) return;
  lastAbsenceScanKey = todayKey;

  try {
    const result = await W.scanDailyAbsences(todayKey, nowMs);
    if (result && result.detectedCount > 0) {
      console.log(`[jobs] absence sweep flagged ${result.detectedCount} suspected no-show(s) for ${todayKey}`);
    }
  } catch (err) {
    console.error('[jobs] absence sweep failed:', err.message);
  }
}

// ---------------------------------------------------------------------------

let timer = null;

async function start() {
  const tick = async () => {
    const nowMs = T.now();
    try {
      await rollover(nowMs);
      // Before transitions, so an employee whose binding has just lapsed is
      // evaluated against the new reality rather than a stale one.
      const expired = await bindings.expireStale(nowMs);
      if (expired) console.log(`[jobs] ${expired} MAC binding(s) expired without reconfirmation`);
      await detectTransitions(nowMs);
      await evaluateWarnings(nowMs);
      await scanAbsences(nowMs);
      await sendAttendanceReminders(nowMs);
      await accrueLeave(nowMs);
      await notifyHrAlerts(nowMs);
      await retention(nowMs);
      void await nightlyBackup(nowMs);
    } catch (err) {
      // A failing maintenance tick must never take the server down.
      console.error('[jobs] tick failed:', err.message);
    }
  };

  // Prime the status map so the first tick does not emit a burst of spurious
  // DEPARTED entries for everyone who is legitimately away.
  await detectTransitions(T.now());
  lastRolloverKey = T.dateKey();

  timer = setInterval(tick, TICK_MS);
  timer.unref();
  console.log(`[jobs] maintenance running every ${TICK_MS / 1000}s (rollover, retention, backup)`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, rollover, retention, detectTransitions, evaluateWarnings, scanAbsences, accrueLeave, notifyHrAlerts, nightlyBackup, sendAttendanceReminders };
