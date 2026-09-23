// Storage for live-screen-stream frames (desktop agent -> HR dashboard).
//
// Previously each frame overwrote a `frame_base64` column in a Postgres row
// (workstation_live_streams), read back by the dashboard's polling viewer.
// A screenshot is 10s-100s of KB, the desktop agent pushed one every 250ms
// while streaming, and the dashboard polled for one every 300ms -- every one
// of those bytes counted as Supabase "egress" (data served out of the
// database), and this single feature was very likely the dominant
// contributor to a Supabase Free plan quota breach (181% of the egress
// quota in one billing cycle). A live frame is inherently ephemeral --
// nothing needs it more than a few seconds after it was captured -- so it
// never belonged in a relational database in the first place. Redis (with a
// short TTL) is a strict improvement on every axis: no Supabase egress at
// all, no Postgres row churn, and the data expires itself.
//
// Falls back to an in-memory Map (single instance only, same limitation the
// old Postgres-backed version effectively had in practice) when Redis is
// not configured, so local dev and an as-yet-unconfigured deployment still
// work -- just without cross-instance delivery.

const { getClient } = require('./redis');

const FRAME_TTL_SECONDS = 8; // a bit more than the ~1s capture interval, so one missed beat isn't visible as a gap
const localFrames = new Map(); // deviceId -> { frameBase64, expiresAtMs }

function key(deviceId) {
  return `live:frame:${deviceId}`;
}

async function setFrame(deviceId, frameBase64) {
  const redis = getClient();
  if (!redis) {
    localFrames.set(deviceId, { frameBase64, expiresAtMs: Date.now() + FRAME_TTL_SECONDS * 1000 });
    return;
  }
  try {
    await redis.set(key(deviceId), frameBase64, { ex: FRAME_TTL_SECONDS });
  } catch (err) {
    console.error(`[liveFrame] setFrame(${deviceId}) Redis error:`, err.message);
  }
}

async function getFrame(deviceId) {
  const redis = getClient();
  if (!redis) {
    const entry = localFrames.get(deviceId);
    if (!entry || entry.expiresAtMs < Date.now()) return null;
    return entry.frameBase64;
  }
  try {
    return await redis.get(key(deviceId));
  } catch (err) {
    console.error(`[liveFrame] getFrame(${deviceId}) Redis error:`, err.message);
    return null;
  }
}

async function clearFrame(deviceId) {
  const redis = getClient();
  if (!redis) {
    localFrames.delete(deviceId);
    return;
  }
  try {
    await redis.del(key(deviceId));
  } catch (err) {
    console.error(`[liveFrame] clearFrame(${deviceId}) Redis error:`, err.message);
  }
}

module.exports = { setFrame, getFrame, clearFrame };
