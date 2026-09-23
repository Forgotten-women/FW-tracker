// Upstash Redis (REST) client.
//
// The REST client, not a persistent TCP connection: Vercel functions are
// short-lived, and Upstash's REST API is billed per command with no
// idle-connection cost, which is the shape that actually fits serverless.
//
// Every caller must treat Redis as optional -- unset env vars (Upstash not
// configured yet, e.g. in local dev) or a transient Upstash outage must
// degrade, never take a request down. getClient() returns null rather than
// throwing so call sites can fall back.

const { Redis } = require('@upstash/redis');

let client;
let attempted = false;

function getClient() {
  if (attempted) return client;
  attempted = true;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    client = null;
    return client;
  }

  client = new Redis({ url, token });
  return client;
}

module.exports = { getClient };
