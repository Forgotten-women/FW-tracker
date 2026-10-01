// Where app updates come from, apart from our own backend.
//
// The backend (GET /api/app/version/latest) is asked first. This file is the
// fallback: the public GitHub Releases API of the repository CI publishes to,
// read with no token. It exists so a phone can never get stuck again -- older
// builds could not reach the server and so never saw an update at all.
//
// It also holds the pure helpers the updater needs (version comparison,
// .sha256 parsing, SideStore / AltStore links), kept free of Flutter so they
// can be unit tested.

import 'dart:convert';

import 'package:http/http.dart' as http;

/// Phone releases only. Desktop releases are tagged `desktop-v1.0.54`, and
/// phone releases are published with make_latest false, so
/// `/releases/latest` is NOT the phone release -- the list is read instead.
final Uri githubReleasesUri = Uri.parse(
    'https://api.github.com/repos/Forgotten-women/FW-tracker/releases?per_page=100');

const String apkAssetName = 'app-release.apk';
const String apkSha256AssetName = 'app-release.apk.sha256';
const String ipaAssetName = 'OfficeTracker.ipa';

/// The AltStore / SideStore source the backend serves.
const String defaultIosSourceUrl =
    'https://api.fwtracker.tech/api/app/ios/source.json';

final RegExp _phoneTag = RegExp(r'^v\d+\.\d+\.\d+$');
final RegExp _sha256Hex = RegExp(r'^[0-9a-fA-F]{64}$');

enum UpdatePlatform { android, ios }

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/// A MAJOR.MINOR.PATCH version. A leading `v`, a `+build` suffix and a
/// `-pre` suffix are ignored, so `v1.0.30`, `1.0.30+13` and `1.0.30` are equal.
class SemVer implements Comparable<SemVer> {
  final int major;
  final int minor;
  final int patch;

  const SemVer(this.major, this.minor, this.patch);

  static SemVer? tryParse(String? input) {
    if (input == null) return null;
    var s = input.trim();
    if (s.startsWith('v') || s.startsWith('V')) s = s.substring(1);
    s = s.split('+').first.split('-').first;
    if (s.isEmpty) return null;
    final parts = s.split('.');
    if (parts.length > 3) return null;
    final nums = <int>[];
    for (final p in parts) {
      final n = int.tryParse(p);
      if (n == null || n < 0) return null;
      nums.add(n);
    }
    while (nums.length < 3) {
      nums.add(0);
    }
    return SemVer(nums[0], nums[1], nums[2]);
  }

  @override
  int compareTo(SemVer other) {
    if (major != other.major) return major.compareTo(other.major);
    if (minor != other.minor) return minor.compareTo(other.minor);
    return patch.compareTo(other.patch);
  }

  bool operator >(SemVer other) => compareTo(other) > 0;
  bool operator <(SemVer other) => compareTo(other) < 0;

  @override
  bool operator ==(Object other) => other is SemVer && compareTo(other) == 0;

  @override
  int get hashCode => Object.hash(major, minor, patch);

  @override
  String toString() => '$major.$minor.$patch';
}

/// Negative, zero or positive as [a] is older than, equal to or newer than
/// [b]; null when either is not a version.
int? compareVersions(String a, String b) {
  final va = SemVer.tryParse(a);
  final vb = SemVer.tryParse(b);
  if (va == null || vb == null) return null;
  return va.compareTo(vb);
}

/// True only when [candidate] is a version strictly newer than [installed].
bool isNewerVersion(String candidate, String installed) =>
    (compareVersions(candidate, installed) ?? 0) > 0;

// ---------------------------------------------------------------------------
// GitHub releases
// ---------------------------------------------------------------------------

class GithubAsset {
  final String name;
  final String url;
  final int size;

  const GithubAsset({required this.name, required this.url, required this.size});
}

class GithubPhoneRelease {
  final String tag;
  final SemVer version;
  final String? publishedAt;
  final GithubAsset? apk;
  final GithubAsset? apkSha256;
  final GithubAsset? ipa;

  const GithubPhoneRelease({
    required this.tag,
    required this.version,
    this.publishedAt,
    this.apk,
    this.apkSha256,
    this.ipa,
  });

  String get versionName => version.toString();
}

/// The newest phone release in a GitHub `/releases` response that can update
/// [platform]: not a draft or prerelease, tagged exactly `vX.Y.Z` (so
/// `desktop-v...` is ignored), and carrying `app-release.apk` plus
/// `app-release.apk.sha256` (Android) or `OfficeTracker.ipa` (iOS).
GithubPhoneRelease? pickLatestPhoneRelease(Object? releases, UpdatePlatform platform) {
  if (releases is! List) return null;
  GithubPhoneRelease? best;
  for (final r in releases) {
    if (r is! Map) continue;
    if (r['draft'] == true || r['prerelease'] == true) continue;
    final tag = r['tag_name'];
    if (tag is! String || !_phoneTag.hasMatch(tag)) continue;
    final version = SemVer.tryParse(tag);
    if (version == null) continue;

    final assets = <String, GithubAsset>{};
    final rawAssets = r['assets'];
    if (rawAssets is List) {
      for (final a in rawAssets) {
        if (a is! Map) continue;
        final name = a['name'];
        final url = a['browser_download_url'];
        if (name is! String || url is! String || url.isEmpty) continue;
        final size = a['size'];
        assets[name] = GithubAsset(name: name, url: url, size: size is int ? size : 0);
      }
    }

    final candidate = GithubPhoneRelease(
      tag: tag,
      version: version,
      publishedAt: r['published_at'] as String?,
      apk: assets[apkAssetName],
      apkSha256: assets[apkSha256AssetName],
      ipa: assets[ipaAssetName],
    );
    final usable = platform == UpdatePlatform.android
        ? candidate.apk != null && candidate.apkSha256 != null
        : candidate.ipa != null;
    if (!usable) continue;
    if (best == null || candidate.version > best.version) best = candidate;
  }
  return best;
}

/// The checksum in a `sha256sum`-style file: `<hex>  app-release.apk`, or the
/// bare hex. Lower-cased; null if the first token is not 64 hex characters,
/// or if the file names some other file than [expectedFileName].
String? parseSha256File(String body, {String? expectedFileName}) {
  for (final line in const LineSplitter().convert(body)) {
    final tokens = line.trim().split(RegExp(r'\s+')).where((t) => t.isNotEmpty).toList();
    if (tokens.isEmpty) continue;
    final hex = tokens.first;
    if (!_sha256Hex.hasMatch(hex)) return null;
    if (expectedFileName != null && tokens.length > 1) {
      // `sha256sum -b` writes `*name`.
      final named = tokens[1].startsWith('*') ? tokens[1].substring(1) : tokens[1];
      if (named != expectedFileName) return null;
    }
    return hex.toLowerCase();
  }
  return null;
}

/// Reads the public GitHub Releases API. Uses a default (system trust store)
/// client: api.github.com is not our backend, so the Let's Encrypt-only client
/// would reject it.
class GithubUpdateSource {
  final http.Client _client;

  GithubUpdateSource({http.Client? client}) : _client = client ?? http.Client();

  /// The newest usable phone release, or null if GitHub could not be read.
  /// Throws nothing.
  Future<GithubPhoneRelease?> latest(UpdatePlatform platform) async {
    try {
      final res = await _client.get(githubReleasesUri, headers: const {
        'Accept': 'application/vnd.github+json',
      }).timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return null;
      return pickLatestPhoneRelease(jsonDecode(res.body), platform);
    } catch (_) {
      return null;
    }
  }

  /// The checksum published beside the APK, or null if it could not be read.
  Future<String?> apkSha256(GithubPhoneRelease release) async {
    final asset = release.apkSha256;
    if (asset == null) return null;
    try {
      final res = await _client.get(Uri.parse(asset.url)).timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return null;
      return parseSha256File(res.body, expectedFileName: apkAssetName);
    } catch (_) {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// iOS: SideStore / AltStore
// ---------------------------------------------------------------------------
//
// The iOS build is an unsigned IPA that SideStore or AltStore re-signs with a
// free Apple ID. An iOS app cannot install a new build of itself, so the
// update is handed to whichever of those two apps is installed.

/// `sidestore://install?url=<ipa>` -- SideStore downloads and installs it.
Uri sideStoreInstallUri(String ipaUrl) =>
    Uri.parse('sidestore://install?url=${Uri.encodeComponent(ipaUrl)}');

/// `altstore://install?url=<ipa>` -- AltStore downloads and installs it.
Uri altStoreInstallUri(String ipaUrl) =>
    Uri.parse('altstore://install?url=${Uri.encodeComponent(ipaUrl)}');

/// `sidestore://source?url=<source.json>` -- adds the update source once.
Uri sideStoreSourceUri(String sourceUrl) =>
    Uri.parse('sidestore://source?url=${Uri.encodeComponent(sourceUrl)}');

/// `altstore://source?url=<source.json>` -- adds the update source once.
Uri altStoreSourceUri(String sourceUrl) =>
    Uri.parse('altstore://source?url=${Uri.encodeComponent(sourceUrl)}');

/// Bare scheme URIs, for canLaunchUrl (needs LSApplicationQueriesSchemes).
final Uri sideStoreProbeUri = Uri.parse('sidestore://');
final Uri altStoreProbeUri = Uri.parse('altstore://');

/// The source.json of the configured server, or the default one.
String iosSourceUrlFor(String? serverBase) {
  var base = (serverBase ?? '').trim();
  while (base.endsWith('/')) {
    base = base.substring(0, base.length - 1);
  }
  if (base.isEmpty) return defaultIosSourceUrl;
  return '$base/api/app/ios/source.json';
}
