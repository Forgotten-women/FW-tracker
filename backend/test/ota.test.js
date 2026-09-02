const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `office-ota-test-${process.pid}.db`);
process.env.DB_FILE = TMP;
process.env.ADMIN_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.OFFICE_CONFIG_FILE = path.join(__dirname, 'fixtures', 'office.test.json');

const { db } = require('../src/db');
const OTA = require('../src/domain/ota');

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP + s); } catch {} }
});

test('Over-The-Air (OTA) Updates Domain Logic', async (t) => {
  await t.test('1. No releases returns updateAvailable = false', () => {
    const res = OTA.getLatestRelease({ platform: 'android', currentVersionCode: 1 });
    assert.strictEqual(res.updateAvailable, false);
    assert.strictEqual(res.latestRelease, null);
  });

  await t.test('2. Registering an APK release records in database', () => {
    const release = OTA.recordRelease({
      versionName: '1.0.1',
      versionCode: 2,
      platform: 'android',
      fileName: 'app-release.apk',
      fileSize: 24500000,
      downloadUrl: 'https://github.com/Abdullah-rethink/Office_tracker/releases/download/v1.0.1/app-release.apk',
      releaseNotes: '• Fixed salary calculation on working days\n• Dark theme fixes on enrollment',
      mandatory: false,
      actor: 'admin',
    });

    assert.ok(release.id);
    assert.strictEqual(release.version_name, '1.0.1');
    assert.strictEqual(release.version_code, 2);

    const list = OTA.listReleases();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].versionCode, 2);
  });

  await t.test('3. Client on version 1 detects updateAvailable = true, optional', () => {
    const check = OTA.getLatestRelease({ platform: 'android', currentVersionCode: 1 });
    assert.strictEqual(check.updateAvailable, true);
    assert.strictEqual(check.mandatory, false);
    assert.strictEqual(check.latestRelease.versionName, '1.0.1');
    assert.strictEqual(check.latestRelease.versionCode, 2);
    assert.ok(check.latestRelease.downloadUrl.includes('app-release.apk'));
  });

  await t.test('4. Client on version 2 detects updateAvailable = false', () => {
    const check = OTA.getLatestRelease({ platform: 'android', currentVersionCode: 2 });
    assert.strictEqual(check.updateAvailable, false);
  });

  await t.test('5. Setting min_supported_version_code triggers mandatory update on older clients', () => {
    OTA.setOrgSetting('min_supported_version_code', '2', 'admin');
    const check = OTA.getLatestRelease({ platform: 'android', currentVersionCode: 1 });
    assert.strictEqual(check.updateAvailable, true);
    assert.strictEqual(check.mandatory, true);
  });

  await t.test('6. iOS platform resolves TestFlight / Manifest link', () => {
    OTA.setOrgSetting('ios_testflight_url', 'https://testflight.apple.com/join/office123', 'admin');
    const check = OTA.getLatestRelease({ platform: 'ios', currentVersionCode: 1 });
    assert.strictEqual(check.ios.testflightUrl, 'https://testflight.apple.com/join/office123');
    assert.strictEqual(check.latestRelease.downloadUrl, 'https://testflight.apple.com/join/office123');
  });

  await t.test('7. generateIosManifest produces valid Apple wireless plist XML', () => {
    const plist = OTA.generateIosManifest({
      bundleId: 'com.rethink.officetracker',
      versionName: '1.0.1',
      title: 'Office Tracker',
      ipaUrl: 'https://example.com/app.ipa',
    });
    assert.ok(plist.includes('<key>bundle-identifier</key>'));
    assert.ok(plist.includes('<string>com.rethink.officetracker</string>'));
    assert.ok(plist.includes('https://example.com/app.ipa'));
  });

  await t.test('8. Updating and deleting release works', () => {
    const list = OTA.listReleases();
    const id = list[0].id;

    OTA.updateRelease(id, { mandatory: true, releaseNotes: 'Critical security patch' });
    const updated = OTA.getLatestRelease({ platform: 'android', currentVersionCode: 1 });
    assert.strictEqual(updated.latestRelease.releaseNotes, 'Critical security patch');

    OTA.deleteRelease(id);
    const afterDelete = OTA.listReleases();
    assert.strictEqual(afterDelete.length, 0);
  });
});
