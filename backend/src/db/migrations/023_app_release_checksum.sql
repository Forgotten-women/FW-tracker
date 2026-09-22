-- Migration 023: SHA-256 checksum for app releases.
--
-- The Android OTA path downloads an APK from an admin-supplied download_url
-- (which may not even be our own host -- a GitHub Release asset, Supabase
-- storage, etc.) and previously handed it straight to the system installer
-- with no integrity check. This column lets an admin (or the GitHub Actions
-- release job) record the expected SHA-256 of the artifact at publish time,
-- so the mobile client can verify the downloaded bytes actually match
-- before installing.

ALTER TABLE app_releases ADD COLUMN sha256 TEXT;
