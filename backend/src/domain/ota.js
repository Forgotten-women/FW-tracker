// Domain logic for Mobile App Releases & Over-The-Air (OTA) Updates
//
// Manages version checks, dual-mode (optional vs mandatory) enforcement,
// GitHub Releases CDN synchronization, and iOS wireless manifest generation.

const crypto = require('crypto');
const { db, tx, audit } = require('../db');
const T = require('../util/time');

function getOrgSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM org_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setOrgSetting(key, value, actor = 'admin') {
  db.prepare(`
    INSERT INTO org_settings (key, value, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(key, String(value), T.now(), actor);
}

/**
 * Resolves the latest active release and checks if an update is required or available.
 */
function getLatestRelease({ platform = 'android', currentVersionCode = 0 } = {}) {
  const normPlatform = String(platform || 'android').toLowerCase();
  
  // Find highest version_code release for this platform or universal
  let release = db.prepare(`
    SELECT * FROM app_releases
    WHERE active = 1 AND (platform = ? OR platform = 'universal')
    ORDER BY version_code DESC
    LIMIT 1
  `).get(normPlatform);

  if (!release && normPlatform === 'ios') {
    // Fallback to latest general release to supply version name and notes for iOS
    release = db.prepare(`
      SELECT * FROM app_releases
      WHERE active = 1
      ORDER BY version_code DESC
      LIMIT 1
    `).get();
  }

  const minVersionStr = getOrgSetting('min_supported_version_code', '1');
  const minVersionCode = parseInt(minVersionStr, 10) || 1;
  const iosTestflightUrl = getOrgSetting('ios_testflight_url', '');
  const iosManifestUrl = getOrgSetting('ios_enterprise_manifest_url', '');

  const clientVersion = parseInt(currentVersionCode, 10) || 0;

  if (!release) {
    return {
      updateAvailable: false,
      mandatory: false,
      minSupportedVersionCode: minVersionCode,
      currentVersionCode: clientVersion,
      latestRelease: null,
      ios: {
        testflightUrl: iosTestflightUrl,
        manifestUrl: iosManifestUrl,
      },
    };
  }

  const isNewer = release.version_code > clientVersion;
  const isMandatory = !!release.mandatory || (clientVersion > 0 && clientVersion < minVersionCode);

  let downloadUrl = release.download_url;
  // If downloadUrl is relative or empty for iOS, supply manifest or testflight link
  if (normPlatform === 'ios') {
    if (iosTestflightUrl) {
      downloadUrl = iosTestflightUrl;
    } else if (iosManifestUrl) {
      downloadUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(iosManifestUrl)}`;
    }
  }

  return {
    updateAvailable: isNewer,
    mandatory: isMandatory,
    minSupportedVersionCode: minVersionCode,
    currentVersionCode: clientVersion,
    latestRelease: {
      id: release.id,
      versionName: release.version_name,
      versionCode: release.version_code,
      platform: release.platform,
      fileName: release.file_name,
      fileSize: release.file_size,
      downloadUrl,
      releaseNotes: release.release_notes || '',
      downloadCount: release.download_count,
      publishedAt: T.displayTime(release.published_at),
      publishedAtMs: release.published_at,
    },
    ios: {
      testflightUrl: iosTestflightUrl,
      manifestUrl: iosManifestUrl,
    },
  };
}

/**
 * Registers or updates an app release.
 */
function recordRelease({
  id,
  versionName,
  versionCode,
  platform = 'android',
  fileName,
  fileSize = 0,
  downloadUrl,
  releaseNotes = '',
  mandatory = false,
  actor = 'admin',
}) {
  if (!versionName || !String(versionName).trim()) {
    throw new Error('versionName is required.');
  }
  const vCode = parseInt(versionCode, 10);
  if (isNaN(vCode) || vCode <= 0) {
    throw new Error('A valid positive integer versionCode is required.');
  }
  if (!downloadUrl || !String(downloadUrl).trim()) {
    throw new Error('downloadUrl is required.');
  }

  const releaseId = id || 'rel_' + crypto.randomBytes(6).toString('hex');
  const nowMs = T.now();

  const record = {
    id: releaseId,
    version_name: String(versionName).trim(),
    version_code: vCode,
    platform: String(platform || 'android').toLowerCase(),
    file_name: fileName ? String(fileName).trim() : null,
    file_size: parseInt(fileSize, 10) || 0,
    download_url: String(downloadUrl).trim(),
    release_notes: String(releaseNotes || '').trim(),
    mandatory: mandatory ? 1 : 0,
    published_at: nowMs,
    created_by: actor,
  };

  const run = tx(() => {
    db.prepare(`
      INSERT INTO app_releases
        (id, version_name, version_code, platform, file_name, file_size, download_url, release_notes, mandatory, active, published_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version_name = excluded.version_name,
        version_code = excluded.version_code,
        platform = excluded.platform,
        file_name = excluded.file_name,
        file_size = excluded.file_size,
        download_url = excluded.download_url,
        release_notes = excluded.release_notes,
        mandatory = excluded.mandatory,
        published_at = excluded.published_at
    `).run(
      record.id,
      record.version_name,
      record.version_code,
      record.platform,
      record.file_name,
      record.file_size,
      record.download_url,
      record.release_notes,
      record.mandatory,
      record.published_at,
      record.created_by
    );

    audit({
      actor,
      action: 'APP_RELEASE_RECORDED',
      targetType: 'app_release',
      targetId: releaseId,
      after: record,
    });
  });
  run();

  return record;
}

/**
 * Lists all registered releases.
 */
function listReleases() {
  const rows = db.prepare('SELECT * FROM app_releases ORDER BY version_code DESC, published_at DESC').all();
  return rows.map((r) => ({
    id: r.id,
    versionName: r.version_name,
    versionCode: r.version_code,
    platform: r.platform,
    fileName: r.file_name,
    fileSize: r.file_size,
    downloadUrl: r.download_url,
    releaseNotes: r.release_notes,
    mandatory: !!r.mandatory,
    downloadCount: r.download_count,
    active: !!r.active,
    publishedAt: T.displayTime(r.published_at),
    publishedAtMs: r.published_at,
    createdBy: r.created_by,
  }));
}

/**
 * Updates release active status or mandatory flag.
 */
function updateRelease(id, { active, mandatory, releaseNotes, actor = 'admin' } = {}) {
  const before = db.prepare('SELECT * FROM app_releases WHERE id = ?').get(id);
  if (!before) throw new Error('Release not found.');

  const nextActive = active !== undefined ? (active ? 1 : 0) : before.active;
  const nextMandatory = mandatory !== undefined ? (mandatory ? 1 : 0) : before.mandatory;
  const nextNotes = releaseNotes !== undefined ? String(releaseNotes) : before.release_notes;

  const run = tx(() => {
    db.prepare('UPDATE app_releases SET active = ?, mandatory = ?, release_notes = ? WHERE id = ?')
      .run(nextActive, nextMandatory, nextNotes, id);
    audit({
      actor,
      action: 'APP_RELEASE_UPDATED',
      targetType: 'app_release',
      targetId: id,
      before,
      after: { id, active: !!nextActive, mandatory: !!nextMandatory, releaseNotes: nextNotes },
    });
  });
  run();

  return { id, active: !!nextActive, mandatory: !!nextMandatory, releaseNotes: nextNotes };
}

/**
 * Deletes a release record.
 */
function deleteRelease(id, actor = 'admin') {
  const before = db.prepare('SELECT * FROM app_releases WHERE id = ?').get(id);
  if (!before) throw new Error('Release not found.');

  const run = tx(() => {
    db.prepare('DELETE FROM app_releases WHERE id = ?').run(id);
    audit({
      actor,
      action: 'APP_RELEASE_DELETED',
      targetType: 'app_release',
      targetId: id,
      before,
    });
  });
  run();

  return { success: true, id };
}

/**
 * Increments download count for metrics.
 */
function incrementDownload(id) {
  if (!id) return;
  db.prepare('UPDATE app_releases SET download_count = download_count + 1 WHERE id = ?').run(id);
}

/**
 * Generates an Apple iOS Wireless Installation Manifest XML (`manifest.plist`).
 */
function generateIosManifest({
  bundleId = 'com.rethink.officetracker',
  versionName = '1.0.0',
  title = 'Office Tracker',
  ipaUrl,
} = {}) {
  if (!ipaUrl) throw new Error('ipaUrl is required for iOS manifest.');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${ipaUrl}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${bundleId}</string>
        <key>bundle-version</key>
        <string>${versionName}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${title}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;
}

module.exports = {
  getOrgSetting,
  setOrgSetting,
  getLatestRelease,
  recordRelease,
  listReleases,
  updateRelease,
  deleteRelease,
  incrementDownload,
  generateIosManifest,
};
