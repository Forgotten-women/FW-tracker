const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const { config, configWarnings } = require('./config');
const { db, close: closeDb } = require('./db');
const events = require('./events');
const jobs = require('./jobs');
const arpSensor = require('./sensors/arp');
const { requireAdmin, consumeSseTicket } = require('./middleware/auth');
const { wrapRouter } = require('./util/async-routes');

const app = express();

// Location verification depends on the source address, so X-Forwarded-For must
// NOT be trusted by default: with `trust proxy` on, any client can set that
// header and claim an office IP, which would defeat the anti-spoofing check
// entirely. This server normally sits directly on the LAN with no proxy, so the
// real socket address is the honest one.
// Set TRUST_PROXY only if you actually put a reverse proxy in front, and give
// it that proxy's address rather than `true`.
function trustProxySetting() {
  const v = (process.env.TRUST_PROXY || '').trim();
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true' || v === '1') return true;
  return v; // an address or comma-separated list of trusted proxies
}
app.set('trust proxy', trustProxySetting());

// CORS is restricted to the dashboard origin. It used to be bare cors(), i.e.
// "*", which let any page open in any browser on the LAN call the API - at a
// time when none of it required authentication.
app.use(cors({
  origin: config.corsOrigin,
  credentials: true,
}));

// The raw body is captured for HMAC verification of hardware sensor requests,
// which sign "<timestamp>.<raw body>".
app.use(express.json({
  limit: '256kb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ status: 'ERROR', message: 'Malformed JSON body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ status: 'ERROR', message: 'Request body too large' });
  }
  return next(err);
});

morgan.token('actor', req => (req.auth ? req.auth.kind : '-'));
app.use(morgan(':date[iso] :method :url :status :actor :response-time ms'));

// There is no hydration step any more.
//
// Every request used to copy nine tables out of Postgres into a SQLite file
// that belonged to this container alone, at most every fifteen seconds. That is
// what made the dashboard flicker - two consecutive requests would be served by
// different containers holding different data - and what made a freshly issued
// device token come back as BAD_TOKEN on the very next call. Handlers now read
// and write the one shared database directly.

// No static dashboard is served from here any more. The dashboard is a separate
// Next.js app in /dashboard, which proxies /api/* to this server, so the browser
// stays same-origin with it and this server's CORS stays locked down.

// --- health ----------------------------------------------------------------

// --- health ----------------------------------------------------------------

const healthHandler = async (req, res) => {
  try {
    const activeEmployees = (await db.prepare('SELECT COUNT(*) c FROM employees WHERE active = 1').get())?.c || 0;
    const totalEvents = (await db.prepare('SELECT COUNT(*) c FROM presence_events').get())?.c || 0;
    res.json({
      status: 'OK',
      service: 'office-tracker-backend',
      environment: process.env.NODE_ENV || 'production',
      serverless: Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
      time: new Date().toISOString(),
      employees: activeEmployees,
      events: totalEvents,
      sseClients: events.clientCount(),
      bssidVerification: config.bssidEnforced ? 'enforced' : 'not-configured',
    });
  } catch (err) {
    res.status(200).json({
      status: 'OK',
      service: 'office-tracker-backend',
      time: new Date().toISOString(),
      note: 'Server is running',
    });
  }
};

app.get('/health', healthHandler);
app.get('/api/health', healthHandler);
app.get('/', healthHandler);

// --- live stream -----------------------------------------------------------

// EventSource cannot set request headers, so the dashboard first exchanges its
// admin key for a single-use, short-lived ticket (POST /api/admin/sse-ticket)
// and passes that instead. That keeps the long-lived admin key out of URLs,
// server logs and browser history.
app.get('/api/events', (req, res) => {
  const ticket = String(req.query.ticket || '');
  if (!consumeSseTicket(ticket)) {
    return res.status(401).json({ status: 'ERROR', message: 'A valid SSE ticket is required.' });
  }
  events.register(res);
});

// --- routes ----------------------------------------------------------------

app.use('/api/auth', require('./routes/auth'));                 // sign-in and sessions
app.use('/api/enroll', require('./routes/enroll'));            // code-authenticated
app.use('/api/attendance', require('./routes/attendance'));    // presence ingest
app.use('/api/attendance', require('./routes/attendance-hr'));  // HR attendance engine
app.use('/api/warnings', require('./routes/warnings'));         // warning engine
app.use('/api/leave', require('./routes/leave'));              // leave engine
app.use('/api/payroll', require('./routes/payroll'));          // payroll preparation
app.use('/api/hr', require('./routes/hr'));                    // advanced HR alerts & reviews
app.use('/api/people', require('./routes/people'));            // master record & org structure
app.use('/api/documents', require('./routes/documents'));       // document vault
app.use('/api/complaints', require('./routes/complaints'));     // employee complaints & concerns
app.use('/api/notifications', require('./routes/notifications')); // notifications
app.use('/api/desktop', require('./routes/desktop'));             // desktop workstation agent
app.use('/api/app', require('./routes/ota'));                   // OTA app version & releases
app.use('/api', require('./routes/ota'));                       // admin OTA releases
app.use('/api/dashboard', require('./routes/dashboard'));      // admin
app.use('/api/admin', require('./routes/admin'));              // admin

// Express 4 ignores the promise an async handler returns, so a rejection
// leaves the request hanging with no response rather than producing a 500.
// Every handler is async now, so that has to be corrected once, here,
// after the routes are mounted. See util/async-routes.js.
wrapRouter(app._router || app.router);

// Unknown API routes return JSON, never the SPA shell - otherwise the phone
// app's jsonDecode throws a parse error instead of seeing a clean failure.
app.use('/api', (req, res) => {
  res.status(404).json({
    status: 'ERROR',
    message: `Unknown API endpoint: ${req.method} ${req.originalUrl}`,
  });
});

// Anything that is not an API route gets a pointer to the dashboard rather
// than a 404 with no explanation.
app.get('*', (req, res) => {
  res.status(404).json({
    status: 'ERROR',
    message: 'This is the Office Tracker API. The dashboard is the Next.js app in /dashboard (npm run dev, then http://localhost:3000).',
  });
});

// Last-resort handler so an unexpected throw returns JSON and is logged,
// rather than hanging the client.
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ status: 'ERROR', message: 'Internal server error' });
});

// --- start -----------------------------------------------------------------

let server = null;

/**
 * Start listening. Kept separate from module load so tests can mount the app
 * on their own port without also starting the background jobs and ARP sensor.
 */
function start(port = config.port) {
  server = app.listen(port, '0.0.0.0', async () => {
    const actual = server.address().port;
    console.log('');
    console.log('======================================================');
    console.log('  Office Presence Tracker');
    console.log(`  Dashboard : http://localhost:${actual}`);
    console.log(`  Office    : ${config.office.officeName} (${config.timeZone})`);
    console.log(`  Networks  : ${(config.office.networks || []).map(n => `${n.ssid} ${n.band}GHz`).join(', ')}`);
    console.log('======================================================');

    const warnings = configWarnings();
    if (warnings.length) {
      console.log('');
      console.log('  CONFIGURATION WARNINGS');
      for (const w of warnings) console.log(`   !  ${w}`);
      console.log('');
    }

    await jobs.start();
    arpSensor.start();
  });
  return server;
}

function shutdown(signal) {
  console.log('');
  console.log(`[server] ${signal} received, shutting down`);
  jobs.stop();
  arpSensor.stop();
  if (!server) { closeDb(); process.exit(0); return; }
  server.close(() => {
    // Checkpoints the WAL into the main database file so the on-disk state is
    // complete and self-contained.
    closeDb();
    console.log('[server] closed cleanly');
    process.exit(0);
  });
  // Do not hang forever on a stuck connection (SSE streams are long-lived).
  setTimeout(() => { closeDb(); process.exit(0); }, 5000).unref();
}

if (require.main === module) {
  start();
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { app, start, shutdown };
