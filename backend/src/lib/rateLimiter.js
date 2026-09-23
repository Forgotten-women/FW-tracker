// Cross-instance rate limiting, backed by Redis with an in-memory fallback.
//
// The original login throttle (auth.js) kept its per-IP attempt counter in a
// plain in-memory Map, which resets per Vercel container -- an attacker
// whose requests land across several cold/warm instances never sees a
// consistent count, so the throttle only worked by accident (a single warm
// instance handling all the traffic). This makes the counter shared.

const { getClient } = require('./redis');

const localFallback = new Map(); // "namespace:key" -> { count, resetAt }

function pruneLocalFallback(nowMs) {
  if (localFallback.size <= 5000) return;
  for (const [k, rec] of localFallback) {
    if (rec.resetAt < nowMs) localFallback.delete(k);
  }
}

function incrLocal(fullKey, windowSeconds) {
  const nowMs = Date.now();
  const rec = localFallback.get(fullKey);
  if (!rec || rec.resetAt < nowMs) {
    localFallback.set(fullKey, { count: 1, resetAt: nowMs + windowSeconds * 1000 });
    pruneLocalFallback(nowMs);
    return 1;
  }
  rec.count++;
  return rec.count;
}

/**
 * Increments the attempt counter for (namespace, key) and returns the new
 * count. The counter resets windowSeconds after its first increment.
 */
async function increment(namespace, key, windowSeconds) {
  const fullKey = `ratelimit:${namespace}:${key}`;
  const redis = getClient();
  if (!redis) return incrLocal(fullKey, windowSeconds);

  try {
    const count = await redis.incr(fullKey);
    if (count === 1) {
      // Only the first increment in a window needs to set the expiry.
      await redis.expire(fullKey, windowSeconds);
    }
    return count;
  } catch (err) {
    console.error(`[rateLimiter] increment(${fullKey}) Redis error, falling back to in-memory:`, err.message);
    return incrLocal(fullKey, windowSeconds);
  }
}

/**
 * Convenience wrapper: returns true if (namespace, key) has exceeded
 * maxCount within windowSeconds.
 */
async function isThrottled(namespace, key, maxCount, windowSeconds) {
  const count = await increment(namespace, key, windowSeconds);
  return count > maxCount;
}

module.exports = { increment, isThrottled };
