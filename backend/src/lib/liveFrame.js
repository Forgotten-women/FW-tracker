// Storage for live-screen-stream state (desktop agent -> HR dashboard).
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
// Four short-lived keys per device, all read by the viewer in ONE MGET per
// poll so a watch session costs one Redis command a second on the read side:
//   frame  {at, img}       the latest JPEG (base64), written ~1/s while live
//   alive  at              "screen unchanged, still streaming" keepalive, so
//                          a static screen doesn't re-upload identical frames
//   ack    at              the agent has seen the request (set by its
//                          stream-status call), i.e. "laptop notified"
//   agent  {version, ...}  what the agent last said about itself, so the
//                          viewer can explain an old agent's slower start
//
// Falls back to an in-memory Map when Redis is not configured, so local dev
// works. On Vercel that fallback is NOT shared between instances -- the frame
// upload and the viewer's reads usually land on different instances -- which
// is why storeKind() is surfaced to the viewer and /api/health.

const { getClient } = require('./redis');

const FRAME_TTL_SECONDS = 8; // a bit more than the ~1s capture interval, so one missed beat isn't visible as a gap
const ACK_TTL_SECONDS = 30;
const AGENT_TTL_SECONDS = 7 * 24 * 60 * 60;

const local = new Map(); // key -> { value, expiresAtMs }

const k = {
  frame: (id) => `live:frame:${id}`,
  alive: (id) => `live:alive:${id}`,
  ack: (id) => `live:ack:${id}`,
  agent: (id) => `live:agent:${id}`,
};

function storeKind() {
  return getClient() ? 'redis' : 'memory';
}

async function put(key, value, ttlSeconds) {
  const redis = getClient();
  if (!redis) {
    local.set(key, { value, expiresAtMs: Date.now() + ttlSeconds * 1000 });
    return;
  }
  try {
    await redis.set(key, value, { ex: ttlSeconds });
  } catch (err) {
    console.error(`[liveFrame] set(${key}) Redis error:`, err.message);
  }
}

async function getMany(keys) {
  const redis = getClient();
  if (!redis) {
    const now = Date.now();
    return keys.map((key) => {
      const entry = local.get(key);
      return entry && entry.expiresAtMs >= now ? entry.value : null;
    });
  }
  try {
    return await redis.mget(...keys);
  } catch (err) {
    console.error('[liveFrame] mget Redis error:', err.message);
    return keys.map(() => null);
  }
}

async function remove(keys) {
  const redis = getClient();
  if (!redis) {
    for (const key of keys) local.delete(key);
    return;
  }
  try {
    await redis.del(...keys);
  } catch (err) {
    console.error('[liveFrame] del Redis error:', err.message);
  }
}

// A frame written by the previous version of this module was the bare base64
// string rather than {at, img}; read both so a deploy mid-stream doesn't blank
// the viewer.
function normaliseFrame(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return { at: null, img: raw };
  if (typeof raw === 'object' && typeof raw.img === 'string') return { at: Number(raw.at) || null, img: raw.img };
  return null;
}

async function setFrame(deviceId, frameBase64, atMs = Date.now()) {
  await put(k.frame(deviceId), { at: atMs, img: frameBase64 }, FRAME_TTL_SECONDS);
}

async function markAlive(deviceId, atMs = Date.now()) {
  await put(k.alive(deviceId), atMs, FRAME_TTL_SECONDS);
}

async function setAck(deviceId, atMs = Date.now()) {
  await put(k.ack(deviceId), atMs, ACK_TTL_SECONDS);
}

async function setAgentInfo(deviceId, info) {
  await put(k.agent(deviceId), { ...info, at: Date.now() }, AGENT_TTL_SECONDS);
}

/** Everything the viewer needs, in one round trip. */
async function getState(deviceId) {
  const [frame, alive, ack, agent] = await getMany([
    k.frame(deviceId), k.alive(deviceId), k.ack(deviceId), k.agent(deviceId),
  ]);
  const f = normaliseFrame(frame);
  return {
    frame: f,
    aliveAt: Number(alive) || null,
    ackAt: Number(ack) || null,
    agent: agent && typeof agent === 'object' ? agent : null,
  };
}

async function getFrame(deviceId) {
  const [frame] = await getMany([k.frame(deviceId)]);
  const f = normaliseFrame(frame);
  return f ? f.img : null;
}

/** Ends a session: the frame, keepalive and ack go; what the agent said about itself stays. */
async function clearFrame(deviceId) {
  await remove([k.frame(deviceId), k.alive(deviceId), k.ack(deviceId)]);
}

module.exports = {
  FRAME_TTL_SECONDS,
  storeKind, setFrame, markAlive, setAck, setAgentInfo, getState, getFrame, clearFrame,
};
