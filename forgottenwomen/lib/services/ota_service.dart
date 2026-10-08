// Over-The-Air (OTA) Update Service
//
// "Check for updates" asks our backend first and falls back to the public
// GitHub Releases API (update_sources.dart), so a phone that cannot reach the
// server still finds new builds.
//
// Android: the APK is downloaded with progress, verified against its sha256,
// and handed to the system installer. Android always shows its own "Update"
// confirmation; that cannot be skipped without device-owner/MDM rights.
//
// iOS: the build is an unsigned IPA that SideStore or AltStore re-signs with a
// free Apple ID. An iOS app cannot install a new build of itself, so the
// update is handed to SideStore / AltStore through their URL schemes.
//
// NOTE: ota_update package was removed because it uses jcenter() which was
// shut down and is incompatible with AGP 9+.  We now download the APK
// ourselves with package:http (already a dependency) and open it with
// package:open_file, which calls the native ACTION_VIEW intent and triggers
// the system package installer.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:open_file/open_file.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/ota.dart';
import 'pinned_http_client.dart';
import 'token_store.dart';
import 'update_sources.dart';

// ---------------------------------------------------------------------------
// Synthetic event type that mirrors the old OtaUpdate stream shape so that
// existing UI code requires zero changes.
// ---------------------------------------------------------------------------

enum OtaStatus {
  downloading,
  verifying,
  installing,
  /// The system installer was opened. Android now shows its own "Update"
  /// prompt; if the install succeeds the app is restarted by the system.
  installerOpened,
  already_running_error,
  permission_not_granted_error,
  checksum_mismatch_error,
  internal_error,
}

class OtaEvent {
  final OtaStatus status;
  /// 0–100 during downloading, null otherwise.
  final int? progress;

  const OtaEvent(this.status, [this.progress]);
}

/// Which sideloading apps are installed on this iPhone.
class IosStores {
  final bool sideStore;
  final bool altStore;
  const IosStores({required this.sideStore, required this.altStore});
  bool get any => sideStore || altStore;
}

// ---------------------------------------------------------------------------

class OtaService {
  final TokenStore _store;
  final http.Client _http;

  // The APK itself comes from `downloadUrl`, normally a GitHub Release asset,
  // not our own backend's host. The trust restriction in
  // `createPinnedHttpClient` is scoped to the CA our backend uses, so pinning
  // it here too would reject a legitimate download hosted elsewhere. Only the
  // version-check call against our own backend uses the restricted client.
  // GitHub's API is read with this default client too.
  final http.Client _downloadHttp;
  final GithubUpdateSource _github;

  /// Automatic checks (on app start) read GitHub at most this often, so a
  /// whole office behind one IP stays well inside GitHub's unauthenticated
  /// limit of 60 requests an hour. "Check for updates" always reads it.
  static const _githubAutoInterval = Duration(hours: 6);
  static const _kGithubLastAutoCheck = 'ota_github_last_auto_check_ms';

  OtaService({
    TokenStore? store,
    http.Client? client,
    http.Client? downloadClient,
    GithubUpdateSource? github,
  })  : _store = store ?? TokenStore(),
        _http = client ?? createPinnedHttpClient(),
        _downloadHttp = downloadClient ?? http.Client(),
        _github = github ?? GithubUpdateSource(client: downloadClient);

  static UpdatePlatform get currentPlatform =>
      !kIsWeb && Platform.isIOS ? UpdatePlatform.ios : UpdatePlatform.android;

  /// Reads current installed app version information.
  Future<PackageInfo> getPackageInfo() async {
    try {
      return await PackageInfo.fromPlatform();
    } catch (_) {
      return PackageInfo(
        appName: 'FWSync',
        packageName: 'com.rethink.officetracker',
        version: '1.0.1',
        buildNumber: '2',
      );
    }
  }

  /// Checks for an update: the backend first, then GitHub Releases only if the
  /// backend can't be read, or offers an update this device can't install (no
  /// download link / checksum). When the backend answers "up to date" that is
  /// final, so a release HR has deactivated there is never offered from GitHub.
  ///
  /// Returns an [AppUpdateInfo] whose `updateAvailable` says whether there is
  /// something to install, or null when no source could be read at all.
  /// [automatic] marks the background check on app start (GitHub throttled).
  Future<AppUpdateInfo?> checkForUpdate({String? customBaseUrl, bool automatic = false}) async {
    final PackageInfo info;
    try {
      info = await PackageInfo.fromPlatform();
    } catch (e) {
      debugPrint('[OTA] cannot read the installed version: $e');
      return null;
    }
    final localVersionCode = int.tryParse(info.buildNumber) ?? 0;
    final platform = currentPlatform;

    final backend = await _checkBackend(info, localVersionCode, platform, customBaseUrl);
    if (backend != null && backend.updateAvailable && _isInstallable(backend, platform)) {
      return backend;
    }
    if (backend != null && !backend.updateAvailable) return backend;

    if (automatic && !await _githubAutoCheckDue()) {
      return backend == null ? null : AppUpdateInfo.upToDate(localVersionCode);
    }

    final github = await _checkGithub(info.version, localVersionCode, platform);
    if (github != null && github.updateAvailable) return github;
    if (backend != null || github != null) return AppUpdateInfo.upToDate(localVersionCode);
    return null;
  }

  /// Whether an offer carries what the installer for [platform] needs.
  static bool _isInstallable(AppUpdateInfo info, UpdatePlatform platform) {
    if (platform == UpdatePlatform.ios) return (info.ipaUrl ?? '').isNotEmpty;
    return (info.downloadUrl ?? '').isNotEmpty && (info.sha256 ?? '').isNotEmpty;
  }

  Future<AppUpdateInfo?> _checkBackend(
    PackageInfo info,
    int localVersionCode,
    UpdatePlatform platform,
    String? customBaseUrl,
  ) async {
    try {
      final baseUrl = customBaseUrl ?? await _store.readServerUrl();
      if (baseUrl.isEmpty) return null;

      final cleanBase =
          baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
      final uri =
          Uri.parse('$cleanBase/api/app/version/latest').replace(queryParameters: {
        'platform': platform.name,
        'currentVersionCode': localVersionCode.toString(),
        'currentVersionName': info.version,
      });

      final response = await _http.get(uri).timeout(const Duration(seconds: 8));
      if (response.statusCode != 200) return null;

      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (data['status'] != 'SUCCESS') return null;

      return AppUpdateInfo.fromJson(data, localVersionCode);
    } catch (e) {
      debugPrint('[OTA] backend update check failed: $e');
      return null;
    }
  }

  Future<AppUpdateInfo?> _checkGithub(
    String installedVersion,
    int localVersionCode,
    UpdatePlatform platform,
  ) async {
    final release = await _github.latest(platform);
    if (release == null) return null;
    if (!isNewerVersion(release.versionName, installedVersion)) {
      return AppUpdateInfo.upToDate(localVersionCode);
    }

    if (platform == UpdatePlatform.ios) {
      final ipa = release.ipa!;
      return AppUpdateInfo(
        updateAvailable: true,
        mandatory: false,
        currentVersionCode: localVersionCode,
        minSupportedVersionCode: 1,
        versionName: release.versionName,
        platform: 'ios',
        downloadUrl: ipa.url,
        ipaUrl: ipa.url,
        fileSize: ipa.size,
        publishedAt: release.publishedAt,
        origin: UpdateOrigin.github,
      );
    }

    // No checksum, no offer: the installer must never run on an unverified file.
    final sha = await _github.apkSha256(release);
    if (sha == null) return null;
    final apk = release.apk!;
    return AppUpdateInfo(
      updateAvailable: true,
      mandatory: false,
      currentVersionCode: localVersionCode,
      minSupportedVersionCode: 1,
      versionName: release.versionName,
      platform: 'android',
      downloadUrl: apk.url,
      sha256: sha,
      fileSize: apk.size,
      publishedAt: release.publishedAt,
      origin: UpdateOrigin.github,
    );
  }

  Future<bool> _githubAutoCheckDue() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final now = DateTime.now().millisecondsSinceEpoch;
      final last = prefs.getInt(_kGithubLastAutoCheck) ?? 0;
      if (now - last < _githubAutoInterval.inMilliseconds) return false;
      await prefs.setInt(_kGithubLastAutoCheck, now);
      return true;
    } catch (_) {
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // Android
  // -------------------------------------------------------------------------

  /// Whether this app may open the package installer ("Install unknown
  /// apps"). Asks for it if not yet granted; Android shows its own settings
  /// toggle for this, and the result is read when the person comes back.
  Future<bool> ensureInstallPermission() async {
    if (kIsWeb || !Platform.isAndroid) return true;
    try {
      final status = await Permission.requestInstallPackages.status;
      if (status.isGranted) return true;
      return (await Permission.requestInstallPackages.request()).isGranted;
    } catch (e) {
      debugPrint('[OTA] install permission check failed: $e');
      return false;
    }
  }

  /// Whether "Install unknown apps" is granted, without asking.
  Future<bool> hasInstallPermission() async {
    if (kIsWeb || !Platform.isAndroid) return true;
    try {
      return await Permission.requestInstallPackages.isGranted;
    } catch (_) {
      return false;
    }
  }

  /// This app's page in system settings.
  Future<bool> openSettings() => openAppSettings();

  /// Downloads the APK, verifies it against [expectedSha256], and triggers
  /// the native Android package installer.
  ///
  /// [expectedSha256] comes from the backend's release record or from the
  /// `.sha256` file published beside the APK on GitHub. A null/empty value is
  /// treated as a hard failure rather than skipping the check, since that
  /// would silently reopen the install-anything gap this verification exists
  /// to close.
  ///
  /// Yields [OtaStatus.downloading] with a [progress] value 0-100, then
  /// [OtaStatus.verifying] while hashing, [OtaStatus.installing] when the
  /// file is handed to the system installer, and [OtaStatus.installerOpened]
  /// once it is showing.
  Stream<OtaEvent> downloadAndInstallAndroid(
    String downloadUrl, {
    String? expectedSha256,
  }) async* {
    if (kIsWeb || !Platform.isAndroid) {
      throw UnsupportedError(
          'In-app APK installation is only supported on Android.');
    }

    final dir = await getTemporaryDirectory();
    final apkFile = File('${dir.path}/office_tracker_update.apk');

    try {
      final request = http.Request('GET', Uri.parse(downloadUrl));
      final streamedResponse = await _downloadHttp.send(request);
      if (streamedResponse.statusCode != 200) {
        debugPrint('[OTA] download returned HTTP ${streamedResponse.statusCode}');
        await streamedResponse.stream.drain<void>();
        yield const OtaEvent(OtaStatus.internal_error);
        return;
      }
      final total = streamedResponse.contentLength ?? 0;
      int received = 0;
      int lastPct = -1;

      final sink = apkFile.openWrite();
      try {
        await for (final chunk in streamedResponse.stream) {
          sink.add(chunk);
          received += chunk.length;
          if (total > 0) {
            final pct = ((received / total) * 100).floor().clamp(0, 100);
            if (pct != lastPct) {
              lastPct = pct;
              yield OtaEvent(OtaStatus.downloading, pct);
            }
          } else {
            yield const OtaEvent(OtaStatus.downloading, null);
          }
        }
      } finally {
        await sink.flush();
        await sink.close();
      }
    } catch (e) {
      debugPrint('[OTA] download error: $e');
      yield const OtaEvent(OtaStatus.internal_error);
      return;
    }

    yield const OtaEvent(OtaStatus.verifying);

    final expected = expectedSha256?.trim().toLowerCase() ?? '';
    if (expected.isEmpty) {
      debugPrint('[OTA] refusing install: release has no sha256 checksum to verify against');
      await apkFile.delete().catchError((_) => apkFile);
      yield const OtaEvent(OtaStatus.checksum_mismatch_error);
      return;
    }

    final digest = await sha256.bind(apkFile.openRead()).first;
    final actual = digest.toString();
    if (actual != expected) {
      debugPrint('[OTA] checksum mismatch: expected $expected, got $actual');
      await apkFile.delete().catchError((_) => apkFile);
      yield const OtaEvent(OtaStatus.checksum_mismatch_error);
      return;
    }

    // The permission can be revoked while the download runs.
    if (!await hasInstallPermission()) {
      yield const OtaEvent(OtaStatus.permission_not_granted_error);
      return;
    }

    yield const OtaEvent(OtaStatus.installing);

    final result = await OpenFile.open(
      apkFile.path,
      type: 'application/vnd.android.package-archive',
    );
    if (result.type == ResultType.done) {
      yield const OtaEvent(OtaStatus.installerOpened);
    } else if (result.type == ResultType.permissionDenied) {
      debugPrint('[OTA] open_file permission denied: ${result.message}');
      yield const OtaEvent(OtaStatus.permission_not_granted_error);
    } else {
      debugPrint('[OTA] open_file error: ${result.message}');
      yield const OtaEvent(OtaStatus.internal_error);
    }
  }

  // -------------------------------------------------------------------------
  // iOS
  // -------------------------------------------------------------------------

  /// Which of SideStore / AltStore can be opened (LSApplicationQueriesSchemes
  /// in Info.plist lists both, which canLaunchUrl needs).
  Future<IosStores> detectIosStores() async {
    Future<bool> can(Uri uri) async {
      try {
        return await canLaunchUrl(uri);
      } catch (_) {
        return false;
      }
    }

    final results = await Future.wait([can(sideStoreProbeUri), can(altStoreProbeUri)]);
    return IosStores(sideStore: results[0], altStore: results[1]);
  }

  /// The AltStore / SideStore source of the configured server.
  Future<String> iosSourceUrl() async {
    try {
      return iosSourceUrlFor(await _store.readServerUrl());
    } catch (_) {
      return defaultIosSourceUrl;
    }
  }

  /// Opens [uri] in the app that handles it (SideStore, AltStore, Safari).
  Future<bool> openExternal(Uri uri) async {
    try {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (e) {
      debugPrint('[OTA] could not open $uri: $e');
      return false;
    }
  }
}
