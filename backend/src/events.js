// Server-Sent Events for the live dashboard.
//
// The original broadcast called client.write() with no try/catch and no
// res.on('error'), had no retry directive and no keepalive frame - so an idle
// proxy timeout silently killed the stream and the dashboard went stale with
// no indication that it had stopped updating.

const T = require('./util/time');

const clients = new Set();
const KEEPALIVE_MS = 20000;

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

  const cleanup = () => clients.delete(res);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

function broadcast(type, data) {
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
