import 'package:flutter_test/flutter_test.dart';
import 'package:office_tracker/models/ota.dart';

void main() {
  group('AppUpdateInfo Model Tests', () {
    test('parses full OTA response with update available', () {
      final json = {
        'status': 'SUCCESS',
        'updateAvailable': true,
        'mandatory': false,
        'minSupportedVersionCode': 1,
        'currentVersionCode': 1,
        'latestRelease': {
          'id': 'rel_123',
          'versionName': '1.0.1',
          'versionCode': 2,
          'platform': 'android',
          'fileName': 'app-release.apk',
          'fileSize': 26214400, // 25 MB
          'downloadUrl': 'https://github.com/Abdullah-rethink/Office_tracker/releases/download/v1.0.1/app-release.apk',
          'releaseNotes': '• Performance enhancements\n• Dark theme fixes',
          'downloadCount': 12,
          'publishedAt': '2026-09-02 11:30',
        },
        'ios': {
          'testflightUrl': 'https://testflight.apple.com/join/office123',
          'manifestUrl': 'https://example.com/manifest.plist',
        }
      };

      final info = AppUpdateInfo.fromJson(json, 1);

      expect(info.updateAvailable, isTrue);
      expect(info.mandatory, isFalse);
      expect(info.versionName, '1.0.1');
      expect(info.versionCode, 2);
      expect(info.platform, 'android');
      expect(info.downloadUrl, 'https://github.com/Abdullah-rethink/Office_tracker/releases/download/v1.0.1/app-release.apk');
      expect(info.formattedFileSize, '25.0 MB');
      expect(info.releaseNotes, contains('Performance enhancements'));
      expect(info.iosTestflightUrl, 'https://testflight.apple.com/join/office123');
      expect(info.iosManifestUrl, 'https://example.com/manifest.plist');
    });

    test('parses mandatory update correctly', () {
      final json = {
        'status': 'SUCCESS',
        'updateAvailable': true,
        'mandatory': true,
        'minSupportedVersionCode': 3,
        'currentVersionCode': 1,
        'latestRelease': {
          'id': 'rel_456',
          'versionName': '2.0.0',
          'versionCode': 3,
          'platform': 'android',
          'downloadUrl': 'https://example.com/app.apk',
          'releaseNotes': 'Critical security upgrade.',
        }
      };

      final info = AppUpdateInfo.fromJson(json, 1);

      expect(info.updateAvailable, isTrue);
      expect(info.mandatory, isTrue);
      expect(info.versionName, '2.0.0');
    });

    test('handles empty / no-release response gracefully', () {
      final json = {
        'status': 'SUCCESS',
        'updateAvailable': false,
        'mandatory': false,
        'minSupportedVersionCode': 1,
        'currentVersionCode': 2,
        'latestRelease': null,
      };

      final info = AppUpdateInfo.fromJson(json, 2);

      expect(info.updateAvailable, isFalse);
      expect(info.mandatory, isFalse);
      expect(info.versionName, isNull);
      expect(info.formattedFileSize, '');
    });
  });
}
