// The AltStore / SideStore source at GET /api/app/ios/source.json.
//
// GitHub is never contacted: IosSource.deps.fetch is replaced with a stub that
// answers the handful of URLs the source reads.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('ios_source');

const OTA = require('../src/domain/ota');
const IosSource = require('../src/domain/ios_source');

const REPO = 'https://github.com/Forgotten-women/FW-tracker/releases/download';
const RAW = 'https://raw.githubusercontent.com/Forgotten-women/FW-tracker';

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleVersion</key><string>$(FLUTTER_BUILD_NUMBER)</string>
  <key>NSLocationWhenInUseUsageDescription</key>
  <string>Checks the office Wi-Fi &amp; nothing else.</string>
  <key>NSLocationAlwaysUsageDescription</key>
  <string>Records arrival and departure.</string>
</dict></plist>`;

function githubRelease(tag, assets, extra = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T10:30:00Z',
    body: `Release ${tag}`,
    assets: assets.map(([name, size]) => ({
      name,
      size,
      browser_download_url: `${REPO}/${tag}/${name}`,
    })),
    ...extra,
  };
}

const RELEASES = [
  githubRelease('desktop-v1.0.99', [['OfficeTracker.ipa', 1]]),
  githubRelease('v1.0.40', [['OfficeTracker.ipa', 2]], { draft: true }),
  githubRelease('v1.0.39', [['OfficeTracker.ipa', 3]], { prerelease: true }),
  githubRelease('v1.0.9', [['OfficeTracker.ipa', 4], ['app-release.apk', 5]]),
  githubRelease('v1.0.30', [['OfficeTracker.ipa', 9598751], ['app-release.apk', 60015022]]),
  githubRelease('v1.0.31', [['app-release.apk', 60015022]]), // no IPA
];

let calls = [];
function stubFetch(routes) {
  calls = [];
  IosSource.deps.fetch = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    calls.push(`${method} ${url}`);
    const hit = routes[`${method} ${url}`];
    if (!hit) return new Response('not found', { status: 404 });
    return hit();
  };
}

test.before(prepareDatabase);
test.after(dropDatabase);
test.beforeEach(() => IosSource.resetCache());

test('pickGithubIpaRelease ignores desktop tags, drafts, prereleases and releases without the IPA', () => {
  const picked = IosSource.pickGithubIpaRelease(RELEASES);
  assert.strictEqual(picked.tag, 'v1.0.30');
  assert.strictEqual(picked.size, 9598751);
  assert.strictEqual(picked.downloadUrl, `${REPO}/v1.0.30/OfficeTracker.ipa`);
  assert.strictEqual(IosSource.pickGithubIpaRelease([]), null);
  assert.strictEqual(IosSource.pickGithubIpaRelease({ message: 'rate limited' }), null);
});

test('pubspec and Info.plist parsing', () => {
  assert.deepStrictEqual(IosSource.parsePubspecVersion('name: x\nversion: 1.0.30+13\n'), { name: '1.0.30', build: '13' });
  assert.strictEqual(IosSource.parsePubspecVersion('version: 1.0.30\n'), null);
  assert.deepStrictEqual(IosSource.privacyFromInfoPlist(INFO_PLIST), {
    NSLocationWhenInUseUsageDescription: 'Checks the office Wi-Fi & nothing else.',
    NSLocationAlwaysUsageDescription: 'Records arrival and departure.',
  });
});

test('falls back to the newest GitHub vX.Y.Z release with an IPA when none is registered', async () => {
  stubFetch({
    'GET https://api.github.com/repos/Forgotten-women/FW-tracker/releases?per_page=30': () => Response.json(RELEASES),
    [`GET ${RAW}/v1.0.30/forgottenwomen/pubspec.yaml`]: () => new Response('version: 1.0.30+13\n'),
    [`GET ${RAW}/v1.0.30/forgottenwomen/ios/Runner/Info.plist`]: () => new Response(INFO_PLIST),
  });

  const source = await IosSource.getSource();
  assert.strictEqual(source.name, 'Office Tracker');
  assert.strictEqual(source.identifier, 'org.rethinkcharity.officetracker.source');
  assert.strictEqual(source.apps.length, 1);

  const app = source.apps[0];
  assert.strictEqual(app.name, 'Office Tracker');
  assert.strictEqual(app.bundleIdentifier, 'com.example.forgottenwomen');
  assert.strictEqual(app.developerName, 'Forgotten Women');
  assert.ok(app.localizedDescription.length > 0);
  assert.strictEqual(app.iconURL, `${RAW}/main/forgottenwomen/assets/icon/app_icon.png`);
  assert.deepStrictEqual(app.appPermissions.entitlements, []);
  assert.strictEqual(app.appPermissions.privacy.NSLocationAlwaysUsageDescription, 'Records arrival and departure.');

  assert.deepStrictEqual(app.versions, [{
    version: '1.0.30',
    buildVersion: '13',
    date: '2026-10-01T10:30:00.000Z',
    localizedDescription: 'Version 1.0.30 (build 13)',
    downloadURL: `${REPO}/v1.0.30/OfficeTracker.ipa`,
    size: 9598751,
  }]);
  // The size came from the asset listing, so no HEAD request was needed.
  assert.ok(!calls.some(c => c.startsWith('HEAD ')));
});

test('a registered iOS release wins, its size comes from a HEAD request, and the result is cached', async () => {
  await OTA.recordRelease({
    versionName: '1.0.31',
    versionCode: 14,
    platform: 'ios',
    downloadUrl: `${REPO}/v1.0.31/OfficeTracker.ipa`,
    releaseNotes: 'Release v1.0.31 (iOS)',
    actor: 'ci',
  });

  let heads = 0;
  stubFetch({
    [`HEAD ${REPO}/v1.0.31/OfficeTracker.ipa`]: () => {
      heads++;
      return new Response(null, { status: 200, headers: { 'Content-Length': '9600000' } });
    },
    [`GET ${RAW}/v1.0.31/forgottenwomen/ios/Runner/Info.plist`]: () => new Response(INFO_PLIST),
  });

  const first = await IosSource.getSource();
  const v = first.apps[0].versions[0];
  assert.strictEqual(v.version, '1.0.31');
  assert.strictEqual(v.buildVersion, '14');
  assert.strictEqual(v.downloadURL, `${REPO}/v1.0.31/OfficeTracker.ipa`);
  assert.strictEqual(v.size, 9600000);
  assert.strictEqual(v.localizedDescription, 'Release v1.0.31 (iOS)');
  assert.strictEqual(first.apps[0].downloadURL, v.downloadURL);
  assert.ok(!calls.some(c => c.includes('api.github.com')), 'GitHub listing is not needed');

  const second = await IosSource.getSource();
  assert.strictEqual(second, first, 'served from the in-memory cache');
  assert.strictEqual(heads, 1);

  // The version check exposes the raw IPA link for the app.
  const check = await OTA.getLatestRelease({ platform: 'ios', currentVersionCode: 13 });
  assert.strictEqual(check.updateAvailable, true);
  assert.strictEqual(check.latestRelease.ipaUrl, `${REPO}/v1.0.31/OfficeTracker.ipa`);
});

test('GET /api/app/ios/source.json serves the source, and 503 when there is no release at all', async () => {
  const app = express();
  app.use('/api/app', require('../src/routes/ota'));
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    stubFetch({
      [`HEAD ${REPO}/v1.0.31/OfficeTracker.ipa`]: () =>
        new Response(null, { status: 200, headers: { 'Content-Length': '9600000' } }),
    });
    const ok = await fetch(`${base}/api/app/ios/source.json`);
    assert.strictEqual(ok.status, 200);
    const body = await ok.json();
    assert.strictEqual(body.apps[0].versions[0].version, '1.0.31');
    // Info.plist was unreachable, so the built-in usage descriptions are used.
    assert.ok(body.apps[0].appPermissions.privacy.NSLocationWhenInUseUsageDescription);

    for (const r of await OTA.listReleases()) await OTA.deleteRelease(r.id, 'test');
    IosSource.resetCache();
    stubFetch({}); // GitHub unreachable too
    const none = await fetch(`${base}/api/app/ios/source.json`);
    assert.strictEqual(none.status, 503);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
