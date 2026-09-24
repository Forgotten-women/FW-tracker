// Instant "start streaming" signal for the desktop agent, over Supabase
// Realtime Broadcast.
//
// The agent used to discover a live-view request by polling
// /api/desktop/stream-status every 20s, 24/7, from every workstation: ~82K
// requests a day against Vercel and Postgres that almost never found
// anything, and still a 0-20s wait once HR did click. Vercel can't hold a
// connection open to push through, so instead the agent holds one WebSocket
// to Supabase Realtime and the backend "rings" that agent's topic when HR
// opens the viewer.
//
// The ring carries no data and grants nothing: on a ring the agent only makes
// its normal authenticated stream-status call, and that call decides. A topic
// leaking would at worst cost a wasted status check -- it is still an HMAC of
// the device id rather than the id itself.
//
// Needs SUPABASE_URL and SUPABASE_ANON_KEY (the public "anon"/publishable
// key, safe to hand to a client -- it is what the agent connects with). The
// ring itself is sent with the service-role key when present. Without the
// public key this whole module reports unconfigured and the agent falls back
// to polling, so nothing breaks; streams just start slower.

const crypto = require('crypto');

// 'live' = HR opened the live viewer. 'sync' = the employee's break changed on
// another device, so the agent should refresh its break state now rather than
// on its next minutely heartbeat. Either way the agent only re-reads over its
// normal authenticated API.
const EVENT = 'live';
const SYNC_EVENT = 'sync';

function projectUrl() {
  return String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
}

function publicKey() {
  return String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
}

function serverKey() {
  return String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim() || publicKey();
}

function topicSecret() {
  return process.env.LIVE_DOORBELL_SECRET || process.env.MAC_SALT || process.env.ADMIN_API_KEY || 'office-tracker-live';
}

function isConfigured() {
  return Boolean(projectUrl().startsWith('https://') && publicKey());
}

function topicFor(deviceId) {
  const digest = crypto.createHmac('sha256', topicSecret()).update(String(deviceId)).digest('hex');
  return `ot-live-${digest.slice(0, 32)}`;
}

/** What the agent needs to subscribe, delivered in its (authenticated) heartbeat response. */
function clientConfigFor(deviceId) {
  if (!isConfigured()) return null;
  return {
    url: projectUrl(),
    apiKey: publicKey(),
    topic: topicFor(deviceId),
    event: EVENT,
  };
}

/** Rings the device's doorbell. Resolves true if Supabase accepted the message. */
async function ring(deviceId, event = EVENT) {
  if (!isConfigured()) return false;
  try {
    const res = await fetch(`${projectUrl()}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        apikey: serverKey(),
        Authorization: `Bearer ${serverKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ topic: topicFor(deviceId), event, payload: { at: Date.now() } }],
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.error(`[liveDoorbell] ring(${deviceId}) rejected: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[liveDoorbell] ring(${deviceId}) failed:`, err.message);
    return false;
  }
}

/**
 * Tells every desktop agent of an employee (except the one that made the
 * change) that their break state changed. Best-effort and bounded: a failure
 * only means the laptop catches up on its next heartbeat instead.
 */
async function ringDesktopsOf(employeeId, { exceptDeviceId = null } = {}) {
  if (!isConfigured()) return 0;
  const { db } = require('../db');
  let devices = [];
  try {
    devices = await db.prepare(`
      SELECT id FROM devices
      WHERE employee_id = ? AND revoked_at IS NULL
        AND (device_type = 'desktop' OR LOWER(platform) IN ('windows', 'macos', 'darwin', 'linux'))
    `).all(employeeId);
  } catch (_) {
    return 0;
  }
  const targets = devices.map(d => d.id).filter(id => id !== exceptDeviceId);
  const results = await Promise.all(targets.map(id => ring(id, SYNC_EVENT)));
  return results.filter(Boolean).length;
}

module.exports = { isConfigured, topicFor, clientConfigFor, ring, ringDesktopsOf, SYNC_EVENT };
