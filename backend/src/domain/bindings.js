// Device-to-employee MAC bindings.
//
// See migrations/005 for the reasoning. In short: the app proves who someone
// is, the network sensors then keep tracking them without needing the app to
// stay running.

const crypto = require('crypto');
const { db, tx, MAC_SALT } = require('../db');
const T = require('../util/time');

// How long a binding stays valid without the app re-proving it. Long enough
// that someone can leave the app closed all week, short enough that a rotated
// MAC or a recycled DHCP lease cannot keep attributing presence indefinitely.
const BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// How recently a network sensor must have seen an IP for an authenticated ping
// from that IP to be correlated with it. Tight, because the whole correctness
// of the binding rests on the two observations describing the same moment.
const CORRELATION_WINDOW_MS = 3 * 60 * 1000;

const logBindingEvent = db.prepare(`
  INSERT INTO mac_binding_events (binding_id, employee_id, mac_hash, at, event_type, detail)
  VALUES (?,?,?,?,?,?)
`);

const selectActiveByMac = db.prepare(`
  SELECT * FROM device_mac_bindings
  WHERE mac_hash = ? AND revoked_at IS NULL AND expires_at > ?
`);

const selectActiveByEmployee = db.prepare(`
  SELECT * FROM device_mac_bindings
  WHERE employee_id = ? AND revoked_at IS NULL AND expires_at > ?
  ORDER BY last_confirmed_at DESC
`);

/**
 * The employee a passively-observed MAC belongs to, or null.
 *
 * This is a LOOKUP of an identity already proved, never a guess. An unbound MAC
 * returns null and stays unattributed.
 */
async function employeeForMac(macHash, nowMs = T.now()) {
  if (!macHash) return null;
  const row = await selectActiveByMac.get(macHash, nowMs);
  return row ? { employeeId: row.employee_id, deviceId: row.device_id, confidence: row.confidence } : null;
}

/**
 * Finds the MAC currently using `ip`, from what the sensors have just seen.
 *
 * Only ARP sightings carry both an IP and a MAC; the ESP sniffer sees MACs
 * without IPs. So ARP - unreliable as a presence signal on its own - is exactly
 * the right tool for this one job.
 */
const selectRecentMacForIp = db.prepare(`
  SELECT mac_hash, MAX(observed_at) AS seen_at
  FROM presence_events
  WHERE src_ip = ? AND mac_hash IS NOT NULL AND observed_at >= ?
  GROUP BY mac_hash
  ORDER BY seen_at DESC
  LIMIT 2
`);

/**
 * Called on every authenticated app heartbeat.
 *
 * If the source IP can be matched to a MAC the sensors just saw, that MAC is
 * bound to this employee. Cheap when a binding already exists - it just moves
 * the expiry forward.
 *
 * Returns a short description of what happened, for the ping response.
 */
async function bindFromAuthenticatedPing({ employeeId, deviceId, srcIp, nowMs = T.now() }) {
  if (!employeeId || !srcIp) return { bound: false, reason: 'NO_IP' };

  const candidates = await selectRecentMacForIp.all(srcIp, nowMs - CORRELATION_WINDOW_MS);

  if (candidates.length === 0) {
    // Normal on a quiet network: nothing has spoken to the server recently
    // enough for its IP to be in the ARP table. The next ping usually works.
    return { bound: false, reason: 'NO_RECENT_SIGHTING' };
  }
  if (candidates.length > 1) {
    // Two MACs claiming one IP inside the window means a recycled lease or a
    // conflict. Binding either one could attribute presence to the wrong
    // person, so bind neither.
    await logBindingEvent.run(null, employeeId, null, nowMs, 'CONFLICT',
      `${candidates.length} MACs seen on ${srcIp} within the correlation window`);
    return { bound: false, reason: 'AMBIGUOUS_IP' };
  }

  const macHash = candidates[0].mac_hash;
  const existing = await selectActiveByMac.get(macHash, nowMs);

  // Already bound to this employee: just extend it.
  if (existing && existing.employee_id === employeeId) {
    await db.prepare(`
      UPDATE device_mac_bindings
      SET last_confirmed_at = ?, expires_at = ?, bound_ip = ?, device_id = COALESCE(device_id, ?)
      WHERE id = ?
    `).run(nowMs, nowMs + BINDING_TTL_MS, srcIp, deviceId, existing.id);
    await logBindingEvent.run(existing.id, employeeId, macHash, nowMs, 'CONFIRMED', null);
    return { bound: true, reason: 'CONFIRMED', bindingId: existing.id };
  }

  const bindingId = 'bind_' + crypto.randomBytes(8).toString('hex');

  await tx(async () => {
    // The same MAC now proving a different employee means the phone changed
    // hands, or a lease was recycled. The newly proved identity wins, because
    // it is the one with live authentication behind it.
    if (existing) {
      await db.prepare('UPDATE device_mac_bindings SET revoked_at = ?, revoked_reason = ? WHERE id = ?')
        .run(nowMs, 'Superseded by a newer authenticated proof', existing.id);
      await logBindingEvent.run(existing.id, existing.employee_id, macHash, nowMs, 'REBOUND',
        `Reassigned to ${employeeId}`);
    }

    // One device, one MAC. An older binding for this employee is stale once
    // their phone rotates its address.
    for (const old of await selectActiveByEmployee.all(employeeId, nowMs)) {
      if (old.mac_hash === macHash) continue;
      if (deviceId && old.device_id && old.device_id !== deviceId) continue;
      await db.prepare('UPDATE device_mac_bindings SET revoked_at = ?, revoked_reason = ? WHERE id = ?')
        .run(nowMs, 'Device address rotated', old.id);
      await logBindingEvent.run(old.id, employeeId, old.mac_hash, nowMs, 'REVOKED', 'Address rotated');
    }

    await db.prepare(`
      INSERT INTO device_mac_bindings
        (id, employee_id, device_id, mac_hash, bound_at, last_confirmed_at,
         expires_at, bound_via, bound_ip, confidence)
      VALUES (?,?,?,?,?,?,?,'IP_CORRELATION',?,0.7)
    `).run(bindingId, employeeId, deviceId, macHash, nowMs, nowMs, nowMs + BINDING_TTL_MS, srcIp);

    await logBindingEvent.run(bindingId, employeeId, macHash, nowMs, 'BOUND',
      `Correlated with ${srcIp} from an authenticated heartbeat`);
  });

  return { bound: true, reason: 'BOUND', bindingId };
}

/** Revokes every binding for an employee, e.g. when a device is unpaired. */
async function revokeForEmployee(employeeId, reason = 'Revoked') {
  const nowMs = T.now();
  const rows = await selectActiveByEmployee.all(employeeId, nowMs);
  for (const r of rows) {
    await db.prepare('UPDATE device_mac_bindings SET revoked_at = ?, revoked_reason = ? WHERE id = ?')
      .run(nowMs, reason, r.id);
    await logBindingEvent.run(r.id, employeeId, r.mac_hash, nowMs, 'REVOKED', reason);
  }
  return rows.length;
}

async function revokeForDevice(deviceId, reason = 'Device revoked') {
  const nowMs = T.now();
  const rows = await db.prepare(
    'SELECT * FROM device_mac_bindings WHERE device_id = ? AND revoked_at IS NULL'
  ).all(deviceId);
  for (const r of rows) {
    await db.prepare('UPDATE device_mac_bindings SET revoked_at = ?, revoked_reason = ? WHERE id = ?')
      .run(nowMs, reason, r.id);
    await logBindingEvent.run(r.id, r.employee_id, r.mac_hash, nowMs, 'REVOKED', reason);
  }
  return rows.length;
}

/** Ages out expired bindings. Called by the maintenance tick. */
async function expireStale(nowMs = T.now()) {
  const rows = await db.prepare(
    'SELECT * FROM device_mac_bindings WHERE revoked_at IS NULL AND expires_at <= ?'
  ).all(nowMs);
  for (const r of rows) {
    await db.prepare('UPDATE device_mac_bindings SET revoked_at = ?, revoked_reason = ? WHERE id = ?')
      .run(nowMs, 'Expired without reconfirmation', r.id);
    await logBindingEvent.run(r.id, r.employee_id, r.mac_hash, nowMs, 'EXPIRED', null);
  }
  return rows.length;
}

/** For the dashboard: how presence is currently being carried per employee. */
async function statusForEmployee(employeeId, nowMs = T.now()) {
  const rows = await selectActiveByEmployee.all(employeeId, nowMs);
  if (rows.length === 0) return { bound: false };
  const b = rows[0];
  return {
    bound: true,
    boundVia: b.bound_via,
    boundAt: b.bound_at,
    lastConfirmedAt: b.last_confirmed_at,
    expiresAt: b.expires_at,
  };
}

async function bindDirectMac({ employeeId, deviceId = null, mac, nowMs = T.now() }) {
  const cleanMac = T.normalizeMac(mac);
  if (!cleanMac) return { bound: false, reason: 'INVALID_MAC' };
  const macHash = T.hashMac(cleanMac, MAC_SALT);
  const existing = await selectActiveByMac.get(macHash, nowMs);
  if (existing && existing.employee_id === employeeId) {
    await db.prepare("UPDATE device_mac_bindings SET last_confirmed_at = ?, expires_at = ? WHERE id = ?")
      .run(nowMs, nowMs + BINDING_TTL_MS, existing.id);
    return { bound: true, bindingId: existing.id, macHash };
  }
  const bindingId = 'bind_' + crypto.randomBytes(8).toString('hex');
  await db.prepare(`
    INSERT INTO device_mac_bindings
      (id, employee_id, device_id, mac_hash, bound_at, last_confirmed_at,
       expires_at, bound_via, bound_ip, confidence)
    VALUES (?,?,?,?,?,?,?,'DIRECT',null,0.9)
  `).run(bindingId, employeeId, deviceId, macHash, nowMs, nowMs, nowMs + BINDING_TTL_MS);
  return { bound: true, bindingId, macHash };
}

module.exports = {
  employeeForMac, bindFromAuthenticatedPing, bindDirectMac,
  revokeForEmployee, revokeForDevice, expireStale, statusForEmployee,
  BINDING_TTL_MS, CORRELATION_WINDOW_MS,
};
