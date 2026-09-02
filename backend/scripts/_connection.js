// The one place maintenance scripts get credentials.
//
// Every script here used to carry the live production connection string - and
// in one case the storage access keys - inline as a fallback. That put working
// credentials for the real HR database in the source tree, and meant a script
// run with no configuration silently operated on production instead of failing.
//
// Nothing is defaulted. A missing variable stops the script with a message
// naming what to set.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function required(name, hint) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    console.error(`\n  ${name} is not set.`);
    console.error(`  ${hint}\n`);
    process.exit(1);
  }
  return value;
}

/** Postgres connection string. Never defaulted to production. */
function databaseUrl() {
  return required(
    'DATABASE_URL',
    'Add it to backend/.env. Get it from Supabase > Project Settings > Database > Connection string.',
  );
}

/** Storage credentials for the document vault bucket. */
function storageCredentials() {
  return {
    endpoint: required('SUPABASE_S3_ENDPOINT', 'Supabase > Project Settings > Storage > S3 connection.'),
    region: process.env.SUPABASE_REGION || 'ap-northeast-1',
    bucket: process.env.SUPABASE_STORAGE_BUCKET || 'employee-documents',
    accessKeyId: required('SUPABASE_S3_ACCESS_KEY_ID', 'Supabase > Project Settings > Storage > S3 access keys.'),
    secretAccessKey: required('SUPABASE_S3_SECRET_ACCESS_KEY', 'Supabase > Project Settings > Storage > S3 access keys.'),
  };
}

/**
 * Refuses to run a destructive or production-touching script unless the
 * operator confirms, so a stray `npm run` cannot rewrite live data.
 */
function confirmTarget(url) {
  const host = (() => {
    try { return new URL(url).host; } catch { return 'unknown host'; }
  })();
  if (process.env.CONFIRM_TARGET === host) return;
  console.error(`\n  This script writes to: ${host}`);
  console.error(`  Re-run with CONFIRM_TARGET=${host} to proceed.\n`);
  process.exit(1);
}

module.exports = { databaseUrl, storageCredentials, confirmTarget };
