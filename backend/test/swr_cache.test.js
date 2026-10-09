// The stale-while-revalidate cache behind the slow HR views.
const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.SWR_CACHE_IN_TESTS = '1';
const cache = require('../src/lib/swrCache');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('concurrent misses share one computation; fresh values are served from memory', async () => {
  let calls = 0;
  const fn = async () => { calls++; await sleep(20); return calls; };
  const [a, b] = await Promise.all([cache.swr('k1', 1000, fn), cache.swr('k1', 1000, fn)]);
  assert.equal(a, 1); assert.equal(b, 1); assert.equal(calls, 1);
  assert.equal(await cache.swr('k1', 1000, fn), 1);
  assert.equal(calls, 1);
});

test('a stale value is served at once while one refresh runs', async () => {
  let n = 0;
  const fn = async () => { n++; await sleep(20); return n; };
  await cache.swr('k2', 10, fn);
  await sleep(15);
  assert.equal(await cache.swr('k2', 10, fn), 1, 'stale served immediately');
  await sleep(40);
  assert.equal(await cache.swr('k2', 10, fn), 2, 'refreshed in the background');
});

test('invalidate drops the value, and a refresh started before it is not stored', async () => {
  let v = 'old';
  const slow = async () => { const x = v; await sleep(30); return x; };
  const p = cache.swr('leave:x', 1000, slow);
  v = 'new';
  cache.invalidate('leave:');
  await p;
  assert.equal(await cache.swr('leave:x', 1000, slow), 'new');
});
