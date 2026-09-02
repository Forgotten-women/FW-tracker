// Over-The-Air (OTA) Update Service
//
// Checks for new APK/iOS releases against the office backend, streams download
// progress, and triggers native Android package installation or iOS TestFlight/manifests.

import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:ota_update/ota_update.dart';

import '../models/ota.dart';
import 'token_store.dart';

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
        version: '1.0.0',
        buildNumber: '1',
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

      final cleanBase = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
      final uri = Uri.parse('$cleanBase/api/app/version/latest').replace(queryParameters: {
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
  Stream<OtaEvent> downloadAndInstallAndroid(String downloadUrl) {
    if (kIsWeb || !Platform.isAndroid) {
      throw UnsupportedError('In-app APK installation is only supported on Android.');
    }
    return OtaUpdate().execute(
      downloadUrl,
      destinationFilename: 'office_tracker_update.apk',
    );
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
