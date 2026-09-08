// Over-The-Air (OTA) Update Service
//
// Checks for new APK/iOS releases against the office backend, streams download
// progress, and triggers native Android package installation or iOS TestFlight/manifests.
//
// NOTE: ota_update package was removed because it uses jcenter() which was
// shut down and is incompatible with AGP 9+.  We now download the APK
// ourselves with package:http (already a dependency) and open it with
// package:open_file, which calls the native ACTION_VIEW intent and triggers
// the system package installer — identical end-user experience.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:open_file/open_file.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/ota.dart';
import 'token_store.dart';

// ---------------------------------------------------------------------------
// Synthetic event type that mirrors the old OtaUpdate stream shape so that
// existing UI code requires zero changes.
// ---------------------------------------------------------------------------

enum OtaStatus {
  downloading,
  installing,
  already_running_error,
  permission_not_granted_error,
  internal_error,
}

class OtaEvent {
  final OtaStatus status;
  /// 0–100 during downloading, null otherwise.
  final int? progress;

  const OtaEvent(this.status, [this.progress]);
}

// ---------------------------------------------------------------------------

class OtaService {
  final TokenStore _store;
  final http.Client _http;

  OtaService({TokenStore? store, http.Client? client})
      : _store = store ?? TokenStore(),
        _http = client ?? http.Client();

  /// Reads current installed app version information.
  Future<PackageInfo> getPackageInfo() async {
    try {
      return await PackageInfo.fromPlatform();
    } catch (_) {
      return PackageInfo(
        appName: 'Office Tracker',
        packageName: 'com.rethink.officetracker',
        version: '1.0.1',
        buildNumber: '2',
      );
    }
  }

  /// Checks the backend for available updates.
  Future<AppUpdateInfo?> checkForUpdate({String? customBaseUrl}) async {
    try {
      final info = await getPackageInfo();
      final localVersionCode = int.tryParse(info.buildNumber) ?? 1;
      final platformName = kIsWeb
          ? 'web'
          : Platform.isIOS
              ? 'ios'
              : 'android';

      final baseUrl = customBaseUrl ?? await _store.readServerUrl();
      if (baseUrl.isEmpty) return null;

      final cleanBase =
          baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
      final uri =
          Uri.parse('$cleanBase/api/app/version/latest').replace(queryParameters: {
        'platform': platformName,
        'currentVersionCode': localVersionCode.toString(),
        'currentVersionName': info.version,
      });

      final response = await _http.get(uri).timeout(const Duration(seconds: 8));
      if (response.statusCode != 200) return null;

      final data = jsonDecode(response.body) as Map<String, dynamic>;
      if (data['status'] != 'SUCCESS') return null;

      return AppUpdateInfo.fromJson(data, localVersionCode);
    } catch (e) {
      debugPrint('[OTA] update check failed: $e');
      return null;
    }
  }

  /// Downloads the APK and triggers the native Android package installer.
  ///
  /// Yields [OtaEvent] objects with [OtaStatus.downloading] and a [progress]
  /// value 0-100, then finally [OtaStatus.installing] when the file is handed
  /// off to the system package-manager.
  Stream<OtaEvent> downloadAndInstallAndroid(String downloadUrl) async* {
    if (kIsWeb || !Platform.isAndroid) {
      throw UnsupportedError(
          'In-app APK installation is only supported on Android.');
    }

    final dir = await getTemporaryDirectory();
    final apkFile = File('${dir.path}/office_tracker_update.apk');

    try {
      final request = http.Request('GET', Uri.parse(downloadUrl));
      final streamedResponse = await _http.send(request);
      final total = streamedResponse.contentLength ?? 0;
      int received = 0;

      final sink = apkFile.openWrite();
      await for (final chunk in streamedResponse.stream) {
        sink.add(chunk);
        received += chunk.length;
        if (total > 0) {
          final pct = ((received / total) * 100).round().clamp(0, 100);
          yield OtaEvent(OtaStatus.downloading, pct);
        } else {
          yield OtaEvent(OtaStatus.downloading, null);
        }
      }
      await sink.flush();
      await sink.close();
    } catch (e) {
      debugPrint('[OTA] download error: $e');
      yield OtaEvent(OtaStatus.internal_error);
      return;
    }

    yield OtaEvent(OtaStatus.installing);

    final result = await OpenFile.open(apkFile.path);
    if (result.type != ResultType.done) {
      debugPrint('[OTA] open_file error: ${result.message}');
      yield OtaEvent(OtaStatus.permission_not_granted_error);
    }
  }

  /// Launches the iOS TestFlight or wireless installation URL.
  Future<bool> launchIosUpdate(String url) async {
    final uri = Uri.parse(url);
    if (await canLaunchUrl(uri)) {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
    return false;
  }
}
