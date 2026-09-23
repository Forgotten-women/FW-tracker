// Cross-instance "claim once" helper, backed by Redis with an in-memory
// fallback.
//
// Vercel functions are stateless and multi-instance: a plain in-memory Set
// used as a "have I already done this today" guard resets on every cold
// container, so a cron tick landing on a fresh instance re-claims work that
// a different instance already did. This is exactly the bug that made
// attendance/break reminders re-send throughout the day (jobs.js) -- the
// in-memory Set only ever deduped within a single warm container's lifetime.
//
// claimOnce(namespace, key, ttlSeconds) returns true the first time a given
// (namespace, key) pair is claimed within the TTL window, and false on every
// repeat claim until it expires -- across ALL instances, once Redis is
// configured. Without Redis configured (local dev, or Upstash not set up
// yet) it falls back to the old in-memory-Set behaviour, which is no worse
// than before.

const { getClient } = require('./redis');

const localFallback = new Map(); // "namespace:key" -> expiresAtMs

function pruneLocalFallback(nowMs) {
  if (localFallback.size <= 5000) return;
  for (const [k, expiresAt] of localFallback) {
    if (expiresAt < nowMs) localFallback.delete(k);
  }
}

function claimOnceLocal(fullKey, ttlSeconds) {
  const nowMs = Date.now();
  const expiresAt = localFallback.get(fullKey);
  if (expiresAt && expiresAt > nowMs) return false;
  localFallback.set(fullKey, nowMs + ttlSeconds * 1000);
  pruneLocalFallback(nowMs);
  return true;
}

async function claimOnce(namespace, key, ttlSeconds) {
  const fullKey = `dedupe:${namespace}:${key}`;
  const redis = getClient();
  if (!redis) return claimOnceLocal(fullKey, ttlSeconds);

  try {
    const result = await redis.set(fullKey, '1', { nx: true, ex: ttlSeconds });
    return result === 'OK';
  } catch (err) {
    console.error(`[dedupe] claimOnce(${fullKey}) Redis error, falling back to in-memory:`, err.message);
    return claimOnceLocal(fullKey, ttlSeconds);
  }
}

const localValues = new Map(); // "namespace:key" -> value

/**
 * Atomically swaps in `newValue` for (namespace, key) and returns whatever
 * value was stored before (undefined if none). Used for cross-instance
 * "what was the last state I saw" comparisons -- e.g. detecting a
 * IN_OFFICE -> AWAY transition -- where an in-memory Map would silently
 * reset (and therefore stop detecting transitions) every time a cron tick
 * landed on a different/cold Lambda instance.
 */
async function swap(namespace, key, newValue, ttlSeconds) {
  const fullKey = `dedupe:${namespace}:${key}`;
  const redis = getClient();
  if (!redis) {
    const prev = localValues.get(fullKey);
    localValues.set(fullKey, newValue);
    return prev;
  }

  try {
    const prev = await redis.getset(fullKey, newValue);
    await redis.expire(fullKey, ttlSeconds);
    return prev === null ? undefined : prev;
  } catch (err) {
    console.error(`[dedupe] swap(${fullKey}) Redis error, falling back to in-memory:`, err.message);
    const prev = localValues.get(fullKey);
    localValues.set(fullKey, newValue);
    return prev;
  }
}

module.exports = { claimOnce, swap };
