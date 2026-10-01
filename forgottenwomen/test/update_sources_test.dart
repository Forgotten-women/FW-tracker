import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:office_tracker/models/ota.dart';
import 'package:office_tracker/services/ota_service.dart';
import 'package:office_tracker/services/update_sources.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _dl = 'https://github.com/Forgotten-women/FW-tracker/releases/download';
const _hex = '4abb26365552a70bf53963aafa6d1c59b9eee82af47e5d81e057721e7ed5e683';

Map<String, dynamic> _release(
  String tag, {
  bool draft = false,
  bool prerelease = false,
  List<String> assets = const [apkAssetName, apkSha256AssetName, ipaAssetName],
}) =>
    {
      'tag_name': tag,
      'draft': draft,
      'prerelease': prerelease,
      'published_at': '2026-10-01T10:30:00Z',
      'assets': [
        for (final a in assets)
          {'name': a, 'size': a == apkAssetName ? 60015022 : 82, 'browser_download_url': '$_dl/$tag/$a'},
      ],
    };

void main() {
  group('SemVer', () {
    test('parses tags, build suffixes and short forms', () {
      expect(SemVer.tryParse('v1.0.30'), const SemVer(1, 0, 30));
      expect(SemVer.tryParse('1.0.30+13'), const SemVer(1, 0, 30));
      expect(SemVer.tryParse('1.2'), const SemVer(1, 2, 0));
      expect(SemVer.tryParse('1.0.31-beta'), const SemVer(1, 0, 31));
      expect(SemVer.tryParse('desktop-v1.0.54'), isNull);
      expect(SemVer.tryParse(''), isNull);
      expect(SemVer.tryParse('1.0.x'), isNull);
    });

    test('compares numerically, not as text', () {
      expect(isNewerVersion('1.0.10', '1.0.9'), isTrue);
      expect(isNewerVersion('v1.0.31', '1.0.30'), isTrue);
      expect(isNewerVersion('2.0.0', '1.99.99'), isTrue);
      expect(isNewerVersion('1.0.30', '1.0.30'), isFalse);
      expect(isNewerVersion('1.0.29', '1.0.30'), isFalse);
      expect(isNewerVersion('garbage', '1.0.0'), isFalse);
      expect(compareVersions('1.0.30+13', 'v1.0.30'), 0);
      expect(compareVersions('x', '1.0.0'), isNull);
    });
  });

  group('pickLatestPhoneRelease', () {
    final releases = [
      _release('desktop-v1.0.99'),
      _release('v1.0.40', draft: true),
      _release('v1.0.39', prerelease: true),
      _release('v1.0.9'),
      _release('v1.0.30'),
      _release('v1.0.31', assets: const [apkAssetName]), // no checksum, no IPA
      _release('v1.0.30-ios-manual'),
    ];

    test('ignores desktop tags, drafts and prereleases, and picks the newest semver', () {
      final picked = pickLatestPhoneRelease(releases, UpdatePlatform.android)!;
      expect(picked.tag, 'v1.0.30');
      expect(picked.versionName, '1.0.30');
      expect(picked.apk!.url, '$_dl/v1.0.30/app-release.apk');
      expect(picked.apk!.size, 60015022);
      expect(picked.apkSha256!.url, '$_dl/v1.0.30/app-release.apk.sha256');
    });

    test('newest semver wins regardless of list order', () {
      final picked = pickLatestPhoneRelease(
          [_release('v1.0.9'), _release('v1.0.12'), _release('v1.0.10')], UpdatePlatform.android);
      expect(picked!.tag, 'v1.0.12');
    });

    test('Android needs the APK and its .sha256; iOS needs the IPA', () {
      final onlyApk = [
        _release('v1.0.5', assets: const [apkAssetName, apkSha256AssetName]),
        _release('v1.0.4', assets: const [ipaAssetName]),
      ];
      expect(pickLatestPhoneRelease(onlyApk, UpdatePlatform.android)!.tag, 'v1.0.5');
      expect(pickLatestPhoneRelease(onlyApk, UpdatePlatform.ios)!.tag, 'v1.0.4');
      expect(pickLatestPhoneRelease(onlyApk, UpdatePlatform.ios)!.ipa!.url, '$_dl/v1.0.4/OfficeTracker.ipa');
    });

    test('anything that is not a release list yields null', () {
      expect(pickLatestPhoneRelease({'message': 'API rate limit exceeded'}, UpdatePlatform.android), isNull);
      expect(pickLatestPhoneRelease(null, UpdatePlatform.android), isNull);
      expect(pickLatestPhoneRelease([], UpdatePlatform.ios), isNull);
    });
  });

  group('parseSha256File', () {
    test('reads the sha256sum format', () {
      expect(parseSha256File('$_hex  app-release.apk\n', expectedFileName: apkAssetName), _hex);
      expect(parseSha256File('${_hex.toUpperCase()} *app-release.apk', expectedFileName: apkAssetName), _hex);
      expect(parseSha256File('$_hex\n'), _hex);
      expect(parseSha256File('\n\n$_hex  app-release.apk'), _hex);
    });

    test('rejects malformed or mismatched files', () {
      expect(parseSha256File(''), isNull);
      expect(parseSha256File('not-a-hash  app-release.apk'), isNull);
      expect(parseSha256File('${_hex.substring(1)}  app-release.apk'), isNull);
      expect(parseSha256File('<html>Not Found</html>'), isNull);
      expect(parseSha256File('$_hex  other.apk', expectedFileName: apkAssetName), isNull);
    });
  });

  group('iOS links', () {
    const ipa = '$_dl/v1.0.30/OfficeTracker.ipa';

    test('install links carry the URL-encoded IPA', () {
      expect(
        sideStoreInstallUri(ipa).toString(),
        'sidestore://install?url=https%3A%2F%2Fgithub.com%2FForgotten-women%2FFW-tracker%2Freleases%2Fdownload%2Fv1.0.30%2FOfficeTracker.ipa',
      );
      expect(altStoreInstallUri(ipa).toString(), startsWith('altstore://install?url=https%3A%2F%2Fgithub.com'));
      expect(sideStoreInstallUri(ipa).queryParameters['url'], ipa);
      expect(altStoreInstallUri(ipa).queryParameters['url'], ipa);
    });

    test('source links point at the backend source.json', () {
      expect(iosSourceUrlFor('https://api.fwtracker.tech/'), defaultIosSourceUrl);
      expect(iosSourceUrlFor(''), defaultIosSourceUrl);
      expect(iosSourceUrlFor(null), defaultIosSourceUrl);
      expect(
        sideStoreSourceUri(defaultIosSourceUrl).toString(),
        'sidestore://source?url=https%3A%2F%2Fapi.fwtracker.tech%2Fapi%2Fapp%2Fios%2Fsource.json',
      );
      expect(altStoreSourceUri(defaultIosSourceUrl).queryParameters['url'], defaultIosSourceUrl);
      expect(sideStoreProbeUri.scheme, 'sidestore');
      expect(altStoreProbeUri.scheme, 'altstore');
    });
  });

  group('OtaService.checkForUpdate (Android)', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({});
      PackageInfo.setMockInitialValues(
        appName: 'Office Tracker',
        packageName: 'com.rethink.officetracker',
        version: '1.0.29',
        buildNumber: '12',
        buildSignature: '',
      );
    });

    MockClient github({int status = 200, String? shaBody}) => MockClient((req) async {
          if (req.url == githubReleasesUri) {
            return http.Response(jsonEncode([_release('desktop-v1.0.54'), _release('v1.0.30'), _release('v1.0.29')]), status);
          }
          if (req.url.toString() == '$_dl/v1.0.30/app-release.apk.sha256') {
            return http.Response(shaBody ?? '$_hex  app-release.apk\n', 200);
          }
          return http.Response('not found', 404);
        });

    MockClient backend(Map<String, dynamic>? body, {int status = 200}) =>
        MockClient((req) async => body == null
            ? http.Response('boom', status)
            : http.Response(jsonEncode(body), status));

    test('falls back to GitHub when the backend errors', () async {
      final ota = OtaService(client: backend(null, status: 500), downloadClient: github());
      final info = await ota.checkForUpdate(customBaseUrl: 'https://api.fwtracker.tech');
      expect(info, isNotNull);
      expect(info!.updateAvailable, isTrue);
      expect(info.origin, UpdateOrigin.github);
      expect(info.versionName, '1.0.30');
      expect(info.downloadUrl, '$_dl/v1.0.30/app-release.apk');
      expect(info.sha256, _hex);
      expect(info.mandatory, isFalse);
    });

    test('trusts the backend when it says up to date (GitHub is not asked)', () async {
      // So a release HR has deactivated on the backend is never offered.
      final ota = OtaService(
        client: backend({'status': 'SUCCESS', 'updateAvailable': false, 'latestRelease': null}),
        downloadClient: MockClient((_) async => throw StateError('GitHub must not be read')),
      );
      final info = await ota.checkForUpdate(customBaseUrl: 'https://api.fwtracker.tech');
      expect(info!.updateAvailable, isFalse);
    });

    test('uses the backend offer when it has one', () async {
      final ota = OtaService(
        client: backend({
          'status': 'SUCCESS',
          'updateAvailable': true,
          'mandatory': false,
          'latestRelease': {
            'versionName': '1.0.30',
            'versionCode': 13,
            'platform': 'android',
            'downloadUrl': '$_dl/v1.0.30/app-release.apk',
            'sha256': _hex,
          },
        }),
        downloadClient: MockClient((_) async => throw StateError('GitHub must not be read')),
      );
      final info = await ota.checkForUpdate(customBaseUrl: 'https://api.fwtracker.tech');
      expect(info!.origin, UpdateOrigin.backend);
      expect(info.versionCode, 13);
    });

    test('a GitHub release without a readable checksum is not offered', () async {
      final ota = OtaService(client: backend(null, status: 500), downloadClient: github(shaBody: '<html>'));
      expect(await ota.checkForUpdate(customBaseUrl: 'https://api.fwtracker.tech'), isNull);
    });

    test('up to date when GitHub has nothing newer than the installed version', () async {
      PackageInfo.setMockInitialValues(
        appName: 'Office Tracker',
        packageName: 'com.rethink.officetracker',
        version: '1.0.30',
        buildNumber: '13',
        buildSignature: '',
      );
      final ota = OtaService(client: backend(null, status: 500), downloadClient: github());
      final info = await ota.checkForUpdate(customBaseUrl: 'https://api.fwtracker.tech');
      expect(info, isNotNull);
      expect(info!.updateAvailable, isFalse);
    });

    test('null when neither source can be read', () async {
      final ota = OtaService(client: backend(null, status: 500), downloadClient: github(status: 403));
      expect(await ota.checkForUpdate(customBaseUrl: 'https://api.fwtracker.tech'), isNull);
    });

    test('the automatic check reads GitHub at most once per interval', () async {
      var listings = 0;
      final counting = MockClient((req) async {
        if (req.url == githubReleasesUri) listings++;
        return http.Response('[]', 200);
      });
      final ota = OtaService(client: backend(null, status: 500), downloadClient: counting);
      await ota.checkForUpdate(customBaseUrl: 'https://api.fwtracker.tech', automatic: true);
      await ota.checkForUpdate(customBaseUrl: 'https://api.fwtracker.tech', automatic: true);
      expect(listings, 1);
      await ota.checkForUpdate(customBaseUrl: 'https://api.fwtracker.tech');
      expect(listings, 2, reason: 'a manual check always reads GitHub');
    });
  });

  test('backend ipaUrl is parsed for iOS offers', () {
    final info = AppUpdateInfo.fromJson({
      'updateAvailable': true,
      'latestRelease': {
        'versionName': '1.0.31',
        'versionCode': 14,
        'platform': 'ios',
        'downloadUrl': 'https://testflight.apple.com/join/x',
        'ipaUrl': '$_dl/v1.0.31/OfficeTracker.ipa',
      },
    }, 13);
    expect(info.ipaUrl, '$_dl/v1.0.31/OfficeTracker.ipa');
  });
}
