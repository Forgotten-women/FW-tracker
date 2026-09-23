// Server-Sent Events for the live dashboard.
//
// The original broadcast called client.write() with no try/catch and no
// res.on('error'), had no retry directive and no keepalive frame - so an idle
// proxy timeout silently killed the stream and the dashboard went stale with
// no indication that it had stopped updating.
//
// broadcast() also only ever reached the clients connected to THIS Lambda
// instance's in-memory `clients` Set. On Vercel, requests are spread across
// many short-lived, independent instances -- a movement/notification/warning
// event raised while handling one request has no way to reach a dashboard
// client whose SSE connection happens to be held by a different instance.
// In practice this meant real-time updates were unreliable: whether a given
// browser tab saw an event at all depended on which instance handled both
// the write and its own SSE registration. Redis (see lib/redis.js) closes
// that gap: every broadcast is also pushed onto a small shared list, and
// each instance holding open SSE connections polls that list on an interval
// and relays anything it hasn't already delivered locally. Without Redis
// configured this degrades to the original single-instance-only behaviour,
// not a crash.

const crypto = require('crypto');
const T = require('./util/time');
const { getClient } = require('./lib/redis');

const clients = new Set();
const KEEPALIVE_MS = 20000;

// How often each instance checks Redis for events raised elsewhere. This is
// the propagation delay a dashboard in a different instance can see for an
// event it didn't originate locally -- 15s keeps command volume comfortably
// inside Upstash's free-tier daily budget even with a few SSE connections
// open across a working day, while still being a large improvement over
// "never," which is what happened before. Override via env var if you have
// headroom (a paid Upstash plan) and want fresher cross-instance updates.
const REMOTE_POLL_MS = Number(process.env.SSE_REDIS_POLL_MS) || 15000;
const REDIS_LIST_KEY = 'sse:events';
const REDIS_LIST_MAXLEN = 200;

// IDs this instance has already delivered locally, so the remote poller
// never re-delivers an event that was already written straight to clients
// by the broadcast() call that originated it (on this same instance), and
// so a slow/overlapping poll never double-delivers the same entry twice.
// Bounded FIFO so it can't grow without limit across a long-lived instance.
const deliveredIds = new Set();
const DELIVERED_IDS_MAX = 1000;
function markDelivered(id) {
  deliveredIds.add(id);
  if (deliveredIds.size > DELIVERED_IDS_MAX) {
    const oldest = deliveredIds.values().next().value;
    deliveredIds.delete(oldest);
  }
}

function register(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // stops nginx buffering the stream
  res.flushHeaders();

  // Tells the browser how long to wait before reconnecting if the stream drops.
  res.write('retry: 5000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', at: T.now() })}\n\n`);

  clients.add(res);
  ensureRemotePoll();

  const cleanup = () => {
    clients.delete(res);
    if (clients.size === 0) stopRemotePoll();
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// Writes a frame to every client connected to THIS instance only. broadcast()
// (below) is the cross-instance-aware entry point everything else should
// call; this is also reused by the remote poller to deliver events raised on
// other instances without re-publishing them back to Redis.
function writeLocal(type, data) {
  const frame = `data: ${JSON.stringify({ type, data, at: T.now() })}\n\n`;
  for (const res of [...clients]) {
    try {
      res.write(frame);
    } catch {
      // A dead client must not take down the broadcast for everyone else.
      clients.delete(res);
    }
  }
}

async function broadcast(type, data) {
  const id = crypto.randomBytes(8).toString('hex');
  writeLocal(type, data);
  markDelivered(id);

  const redis = getClient();
  if (!redis) return;
  try {
    await redis.lpush(REDIS_LIST_KEY, JSON.stringify({ id, type, data, at: T.now() }));
    await redis.ltrim(REDIS_LIST_KEY, 0, REDIS_LIST_MAXLEN - 1);
  } catch (err) {
    console.error('[events] failed to publish to Redis (other instances will miss this event):', err.message);
  }
}

let remotePollTimer = null;
function ensureRemotePoll() {
  if (remotePollTimer || !getClient()) return;
  remotePollTimer = setInterval(pollRemoteEvents, REMOTE_POLL_MS);
  remotePollTimer.unref();
}
function stopRemotePoll() {
  if (!remotePollTimer) return;
  clearInterval(remotePollTimer);
  remotePollTimer = null;
}

async function pollRemoteEvents() {
  const redis = getClient();
  if (!redis || clients.size === 0) return;
  try {
    const raw = await redis.lrange(REDIS_LIST_KEY, 0, REDIS_LIST_MAXLEN - 1);
    // Oldest-first, so a burst of events is delivered in the order it happened.
    for (const entry of [...raw].reverse()) {
      let parsed;
      try {
        parsed = typeof entry === 'string' ? JSON.parse(entry) : entry;
      } catch {
        continue;
      }
      if (!parsed || deliveredIds.has(parsed.id)) continue;
      markDelivered(parsed.id);
      writeLocal(parsed.type, parsed.data);
    }
  } catch (err) {
    console.error('[events] Redis poll failed:', err.message);
  }
}

// Comment frames keep intermediaries from treating the connection as idle.
const keepalive = setInterval(() => {
  for (const res of [...clients]) {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clients.delete(res);
    }
  }
}, KEEPALIVE_MS);
keepalive.unref();

function clientCount() {
  return clients.size;
}

module.exports = { register, broadcast, clientCount };
