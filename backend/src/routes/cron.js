// Scheduled maintenance trigger for Vercel Cron.
//
// backend/src/jobs.js's setInterval loop only ever starts from server.js's
// start(), which the Vercel serverless entrypoint (backend/api/index.js)
// never calls -- there is no persistent process for a loop to run in. That
// meant day rollover, lateness/warning evaluation, leave accrual, absence
// sweeps and retention pruning silently never ran in production: every
// attendance_days / attendance_daily_summary cache stayed perpetually empty,
// so every mobile home-summary request fell back to deriving each of the
// past 7 days from raw presence events from scratch on every single load --
// slow on a good day, and prone to timing out outright under any real load
// against the connection-pool limits a serverless Postgres setup has.
//
// This route gives Vercel Cron (configured in vercel.json) something to hit
// once a day. Vercel's own Cron is not frequent enough on its own, though:
// day rollover genuinely only needs once/day, but the time-sensitive
// reminders inside runMaintenanceTick (check-in/check-out/break reminders,
// jobs.js) need evaluating every few minutes to fire anywhere near their
// intended time of day. .github/workflows/cron-ping.yml pings this same
// route every 10 minutes as a free supplement. It is not a general-purpose
// admin endpoint: the only legitimate callers are Vercel's own cron
// scheduler and that GitHub Actions workflow, both authenticated the same
// way -- a CRON_SECRET environment variable, sent back as
// `Authorization: Bearer <secret>`, so a request lacking that exact header
// is rejected outright rather than allowed to run maintenance jobs
// (including day rollover, which finalises payroll-relevant figures) on
// demand. Every individual job inside runMaintenanceTick is independently
// idempotent (see jobs.js), so calling this far more often than "daily" is
// safe by construction, not just by convention.

const express = require('express');
const router = express.Router();

const jobs = require('../jobs');
const T = require('../util/time');

router.get('/daily', async (req, res) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fails closed: an unconfigured secret must never be treated as "no
    // auth required", or anyone who finds this path could trigger
    // maintenance jobs (including day rollover) on demand.
    console.error('[cron] CRON_SECRET is not set -- refusing to run.');
    return res.status(500).json({ status: 'ERROR', message: 'CRON_SECRET is not configured.' });
  }

  const supplied = req.headers.authorization || '';
  if (supplied !== `Bearer ${expected}`) {
    return res.status(401).json({ status: 'ERROR', message: 'Unauthorized.' });
  }

  const startedAt = T.now();
  try {
    await jobs.runMaintenanceTick(startedAt);
    res.json({ status: 'SUCCESS', ranAt: T.displayTime(startedAt), durationMs: T.now() - startedAt });
  } catch (err) {
    // runMaintenanceTick already catches and logs internally so a single
    // failing job can't take the rest down; this catch is only for something
    // going wrong outside that (e.g. jobs.js itself failing to load).
    console.error('[cron] daily maintenance failed:', err.message);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;
