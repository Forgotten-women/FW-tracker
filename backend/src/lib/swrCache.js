// In-process stale-while-revalidate cache for slow, frequently polled reads.
//
// Every query is a round trip to the database (about 80 ms to Tokyo), and the
// heavy HR views run hundreds of them: the dashboard summary took ~10 s per
// 15-second poll. A cached value is served at once; once it is older than
// `ttlMs` the next caller still gets it immediately while ONE background
// refresh runs. Concurrent callers of a missing key share one computation.
// A value older than `maxStaleMs` is never served: the caller waits for fresh.
//
// The backend runs as a single process (Docker on the VPS), so memory is the
// right place; nothing here is needed for correctness, only speed.

const entries = new Map(); // key -> { value, at, pending }
// Bumped by invalidate(): a computation that started before a write must not
// store its (pre-write) result afterwards.
let generation = 0;

async function compute(key, fn) {
  const e = entries.get(key) || {};
  if (e.pending) return e.pending;
  const gen = generation;
  const pending = (async () => {
    try {
      const value = await fn();
      const cur = entries.get(key);
      if (gen === generation) entries.set(key, { value, at: Date.now(), pending: null });
      else if (cur && cur.pending === pending) entries.delete(key);
      return value;
    } catch (err) {
      const cur = entries.get(key);
      if (cur && cur.pending === pending) cur.pending = null;
      throw err;
    }
  })();
  entries.set(key, { ...e, pending });
  return pending;
}

/** The cached value for key, refreshed in the background once older than ttlMs. */
async function swr(key, ttlMs, fn, { maxStaleMs = 5 * 60 * 1000 } = {}) {
  // Tests move a fake clock and expect every read fresh.
  if (process.env.NODE_ENV === 'test' && process.env.SWR_CACHE_IN_TESTS !== '1') return fn();
  const e = entries.get(key);
  const age = e && e.at ? Date.now() - e.at : Infinity;
  if (age <= ttlMs) return e.value;
  if (age <= maxStaleMs) {
    compute(key, fn).catch(err => console.error(`[cache] refresh ${key}:`, err.message));
    return e.value;
  }
  return compute(key, fn);
}

/** Drops every key starting with prefix, so the next read is fresh. */
function invalidate(prefix = '') {
  generation++;
  for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k);
}

module.exports = { swr, invalidate };
