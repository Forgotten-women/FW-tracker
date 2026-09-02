-- Mobile Application Releases & OTA Updates (Spec 2.15 & In-App OTA Updater)
CREATE TABLE IF NOT EXISTS app_releases (
  id TEXT PRIMARY KEY,
  version_name TEXT NOT NULL,
  version_code INTEGER NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android', -- 'android', 'ios', 'universal'
  file_name TEXT,
  file_size INTEGER DEFAULT 0,
  download_url TEXT NOT NULL,
  release_notes TEXT,
  mandatory INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  published_at INTEGER NOT NULL,
  created_by TEXT DEFAULT 'admin'
);

CREATE INDEX IF NOT EXISTS idx_app_releases_version ON app_releases(version_code DESC, active);

-- Default settings for OTA and iOS distribution
INSERT OR IGNORE INTO org_settings (key, value, updated_at, updated_by)
VALUES ('min_supported_version_code', '1', 0, 'system');

INSERT OR IGNORE INTO org_settings (key, value, updated_at, updated_by)
VALUES ('ios_testflight_url', '', 0, 'system');

INSERT OR IGNORE INTO org_settings (key, value, updated_at, updated_by)
VALUES ('ios_enterprise_manifest_url', '', 0, 'system');

INSERT OR IGNORE INTO org_settings (key, value, updated_at, updated_by)
VALUES ('github_repo_owner', 'Abdullah-rethink', 0, 'system');

INSERT OR IGNORE INTO org_settings (key, value, updated_at, updated_by)
VALUES ('github_repo_name', 'Office_tracker', 0, 'system');
