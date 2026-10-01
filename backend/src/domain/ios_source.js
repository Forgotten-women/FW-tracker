// AltStore / SideStore source for the iOS app.
//
// The iOS build is an UNSIGNED IPA (build_ios.yml builds with
// CODE_SIGNING_ALLOWED=NO). Staff sideload it with SideStore or AltStore,
// which re-sign it with a free Apple ID. Those apps update an installed app
// from a "source": a JSON document in the format described at
// https://faq.altstore.io/developers/make-a-source. This module builds that
// document, so a phone that has added
//   https://api.fwtracker.tech/api/app/ios/source.json
// once is offered every new build from then on.
//
// Where the release comes from, in order:
//   1. the newest active iOS release registered with this backend (CI posts
//      one per tag, see build_ios.yml), then
//   2. the newest GitHub release tagged vX.Y.Z (not desktop-v...) that carries
//      OfficeTracker.ipa -- so the source still works if registration failed.
//
// AltStore refuses an install whose version, build number or permissions do
// not match the IPA, so those are read from the repository at the release's
// tag (pubspec.yaml and ios/Runner/Info.plist) rather than guessed.
//
// The backend is one long-lived process, so the finished document is cached
// in memory for a few minutes; asset sizes and per-tag files never change and
// are cached for the life of the process.

const { db } = require('../db');

const REPO = 'Forgotten-women/FW-tracker';
const GITHUB_RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}`;
const IPA_ASSET = 'OfficeTracker.ipa';
const PHONE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

// ios/Runner.xcodeproj/project.pbxproj, Runner target PRODUCT_BUNDLE_IDENTIFIER.
const BUNDLE_ID = 'com.example.forgottenwomen';
const SOURCE_URL = 'https://api.fwtracker.tech/api/app/ios/source.json';
const ICON_URL = `${RAW_BASE}/main/forgottenwomen/assets/icon/app_icon.png`;
const APP_DESCRIPTION =
  'Office Tracker records your time at the office for payroll, shows your '
  + 'attendance, leave and payslips, and lets you raise requests with HR.';

const CACHE_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

// The usage descriptions in ios/Runner/Info.plist today. Used only if the
// Info.plist at the release's tag cannot be fetched.
const DEFAULT_PRIVACY = {
  NSLocationWhenInUseUsageDescription:
    'Office Tracker checks which Wi-Fi network you are connected to, so your time at the office can be recorded for payroll.',
  NSLocationAlwaysAndWhenInUseUsageDescription:
    'Office Tracker needs background location to record when you arrive at and leave the office. It does not track where you are at other times.',
  NSLocationAlwaysUsageDescription:
    'Office Tracker needs background location to record when you arrive at and leave the office. It does not track where you are at other times.',
};

// Swappable in tests, so the suite never reaches GitHub.
const deps = {
  fetch: (...args) => globalThis.fetch(...args),
  now: () => Date.now(),
};

let cached = null;      // { at, value }
let inFlight = null;    // Promise of the value being built
const sizeCache = new Map();   // ipa url -> bytes
const refCache = new Map();    // `${tag}:${file}` -> text

function resetCache() {
  cached = null;
  inFlight = null;
  sizeCache.clear();
  refCache.clear();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await deps.fetch(url, {
      redirect: 'follow',
      ...options,
      headers: { 'User-Agent': 'office-tracker-backend', ...(options.headers || {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** A file from the repository at [ref]; tags are immutable, so cached. */
async function fetchRepoFile(ref, file) {
  const key = `${ref}:${file}`;
  if (refCache.has(key)) return refCache.get(key);
  const text = await fetchText(`${RAW_BASE}/${encodeURIComponent(ref)}/${file}`);
  if (text !== null && PHONE_TAG.test(ref)) refCache.set(key, text);
  return text;
}

/** `version: 1.0.30+13` -> { name: '1.0.30', build: '13' }. */
function parsePubspecVersion(text) {
  const m = /^version:\s*([0-9A-Za-z.\-]+)\+([0-9]+)\s*$/m.exec(String(text || ''));
  return m ? { name: m[1], build: m[2] } : null;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The NS...UsageDescription entries of an Info.plist, as AltStore's `privacy`. */
function privacyFromInfoPlist(xml) {
  const out = {};
  const re = /<key>\s*(NS[A-Za-z]+UsageDescription)\s*<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) out[m[1]] = decodeXml(m[2].trim());
  return out;
}

function tagFromDownloadUrl(url) {
  const m = /\/releases\/download\/([^/]+)\//.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]) : null;
}

function compareTags(a, b) {
  const pa = PHONE_TAG.exec(a).slice(1).map(Number);
  const pb = PHONE_TAG.exec(b).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * The newest published phone release (vX.Y.Z, not a draft or prerelease)
 * that has the IPA attached. [releases] is the GitHub API's array.
 */
function pickGithubIpaRelease(releases) {
  if (!Array.isArray(releases)) return null;
  const candidates = releases
    .filter(r => r && !r.draft && !r.prerelease && PHONE_TAG.test(String(r.tag_name || '')))
    .map(r => ({ release: r, ipa: (r.assets || []).find(a => a && a.name === IPA_ASSET) }))
    .filter(c => c.ipa && c.ipa.browser_download_url);
  candidates.sort((x, y) => compareTags(y.release.tag_name, x.release.tag_name));
  const best = candidates[0];
  if (!best) return null;
  return {
    tag: best.release.tag_name,
    downloadUrl: best.ipa.browser_download_url,
    size: Number(best.ipa.size) || 0,
    publishedAt: best.release.published_at || best.release.created_at || null,
  };
}

async function fetchGithubReleases() {
  try {
    const res = await fetchWithTimeout(GITHUB_RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

/** Size of the IPA in bytes: HEAD request, cached per URL. 0 if unknown. */
async function ipaSize(url) {
  if (sizeCache.has(url)) return sizeCache.get(url);
  let size = 0;
  try {
    const res = await fetchWithTimeout(url, { method: 'HEAD' });
    if (res.ok) size = parseInt(res.headers.get('content-length') || '0', 10) || 0;
  } catch { /* unknown */ }
  if (size > 0) sizeCache.set(url, size);
  return size;
}

async function newestRegisteredIosRelease() {
  const row = await db.prepare(`
    SELECT * FROM app_releases
    WHERE active = 1 AND platform = 'ios'
    ORDER BY version_code DESC, published_at DESC
    LIMIT 1
  `).get();
  if (!row || !/\.ipa(\?|$)/i.test(String(row.download_url || ''))) return null;
  return row;
}

function isoDate(value) {
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value || ''));
  return Number.isNaN(d.getTime()) ? new Date(deps.now()).toISOString() : d.toISOString();
}

/** Resolve the one version entry the source offers, or null if none exists. */
async function resolveVersion() {
  const row = await newestRegisteredIosRelease();
  if (row) {
    const tag = tagFromDownloadUrl(row.download_url);
    const size = Number(row.file_size) > 0
      ? Number(row.file_size)
      : sizeCache.get(row.download_url)
        || await ipaSize(row.download_url)
        || await sizeFromGithub(row.download_url);
    return {
      tag,
      version: String(row.version_name),
      buildVersion: String(row.version_code),
      date: isoDate(Number(row.published_at)),
      localizedDescription: row.release_notes || `Version ${row.version_name}`,
      downloadURL: row.download_url,
      size,
    };
  }

  const releases = await fetchGithubReleases();
  const gh = pickGithubIpaRelease(releases);
  if (!gh) return null;
  if (gh.size > 0) sizeCache.set(gh.downloadUrl, gh.size);

  // CFBundleShortVersionString / CFBundleVersion come from pubspec.yaml.
  const pubspec = parsePubspecVersion(await fetchRepoFile(gh.tag, 'forgottenwomen/pubspec.yaml'));
  if (!pubspec) return null;

  return {
    tag: gh.tag,
    version: pubspec.name,
    buildVersion: pubspec.build,
    date: isoDate(gh.publishedAt),
    // The GitHub release body is CI boilerplate (checksums, registration
    // steps), not something to show staff.
    localizedDescription: `Version ${pubspec.name} (build ${pubspec.build})`,
    downloadURL: gh.downloadUrl,
    size: gh.size || await ipaSize(gh.downloadUrl),
  };
}

async function sizeFromGithub(url) {
  const releases = await fetchGithubReleases();
  for (const r of releases || []) {
    for (const a of r.assets || []) {
      if (a && a.browser_download_url === url && Number(a.size) > 0) {
        sizeCache.set(url, Number(a.size));
        return Number(a.size);
      }
    }
  }
  return 0;
}

async function buildSource() {
  const version = await resolveVersion();
  if (!version) return null;

  const plist = await fetchRepoFile(version.tag || 'main', 'forgottenwomen/ios/Runner/Info.plist');
  const parsedPrivacy = privacyFromInfoPlist(plist);
  const privacy = Object.keys(parsedPrivacy).length ? parsedPrivacy : DEFAULT_PRIVACY;

  const { tag, ...entry } = version;
  return {
    name: 'Office Tracker',
    identifier: 'org.rethinkcharity.officetracker.source',
    sourceURL: SOURCE_URL,
    subtitle: 'Updates for the Office Tracker iPhone app.',
    iconURL: ICON_URL,
    nsfw: false,
    apps: [{
      name: 'Office Tracker',
      bundleIdentifier: BUNDLE_ID,
      developerName: 'Forgotten Women',
      subtitle: 'Attendance, leave and payslips.',
      localizedDescription: APP_DESCRIPTION,
      iconURL: ICON_URL,
      category: 'utilities',
      versions: [entry],
      // Older AltStore and SideStore builds read these top-level fields
      // instead of versions[].
      version: entry.version,
      versionDate: entry.date,
      versionDescription: entry.localizedDescription,
      downloadURL: entry.downloadURL,
      size: entry.size,
      appPermissions: {
        // No Runner.entitlements exists, and the IPA is unsigned.
        entitlements: [],
        privacy,
      },
    }],
    news: [],
  };
}

/** The source document, from the in-memory cache when it is fresh. */
async function getSource() {
  if (cached && deps.now() - cached.at < CACHE_MS) return cached.value;
  if (!inFlight) {
    inFlight = buildSource()
      .then(value => {
        if (value) cached = { at: deps.now(), value };
        // A failed rebuild (GitHub unreachable, say) serves the last good
        // document rather than nothing.
        return value || (cached ? cached.value : null);
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

module.exports = {
  getSource,
  resetCache,
  pickGithubIpaRelease,
  parsePubspecVersion,
  privacyFromInfoPlist,
  deps,
  BUNDLE_ID,
  SOURCE_URL,
  CACHE_MS,
};
