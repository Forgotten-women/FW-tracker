// Device and network facts.
//
// Replaces the hardcoded `_deviceModel = 'CPH2119'` that every install used to
// report, and supplies the SSID/BSSID the server needs to verify the phone is
// actually on an office access point.

import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:network_info_plus/network_info_plus.dart';
import 'package:permission_handler/permission_handler.dart';

class NetworkFacts {
  final String? ssid;
  final String? bssid;

  const NetworkFacts({this.ssid, this.bssid});

  bool get hasBssid => bssid != null && bssid!.isNotEmpty;
}

class DeviceProbe {
  final NetworkInfo _network = NetworkInfo();

  String get platform {
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    return 'unknown';
  }

  /// The real hardware model.
  Future<String> model() async {
    final info = DeviceInfoPlugin();
    try {
      if (Platform.isAndroid) {
        final a = await info.androidInfo;
        return '${a.manufacturer} ${a.model}'.trim();
      }
      if (Platform.isIOS) {
        final i = await info.iosInfo;
        return i.utsname.machine;
      }
    } catch (_) {
      // Never let a probe failure block enrolment.
    }
    return 'Unknown device';
  }

  /// Reading the SSID/BSSID requires location permission on Android 8.1+ and
  /// on iOS. Without it the platform returns null rather than an error, which
  /// would silently weaken location verification - so the caller is told
  /// whether the grant succeeded.
  Future<bool> ensureLocationPermission() async {
    final status = await Permission.locationWhenInUse.status;
    if (status.isGranted) return true;
    if (status.isPermanentlyDenied) return false;
    return (await Permission.locationWhenInUse.request()).isGranted;
  }

  /// Background presence needs "Always" on both platforms. On iOS this is what
  /// makes region monitoring possible at all; a timer cannot run in the
  /// background there.
  Future<bool> ensureBackgroundLocationPermission() async {
    if (!await ensureLocationPermission()) return false;
    final status = await Permission.locationAlways.status;
    if (status.isGranted) return true;
    if (status.isPermanentlyDenied) return false;
    return (await Permission.locationAlways.request()).isGranted;
  }

  Future<NetworkFacts> network() async {
    try {
      final ssid = await _network.getWifiName();
      final bssid = await _network.getWifiBSSID();
      return NetworkFacts(
        ssid: _clean(ssid),
        bssid: _clean(bssid)?.toLowerCase(),
      );
    } catch (_) {
      return const NetworkFacts();
    }
  }

  /// Android wraps the SSID in quotes; both platforms can return the literal
  /// strings below when permission is missing.
  static String? _clean(String? v) {
    if (v == null) return null;
    var s = v.trim();
    if (s.isEmpty) return null;
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
      s = s.substring(1, s.length - 1);
    }
    if (s == '<unknown ssid>' || s == '00:00:00:00:00:00' || s == '02:00:00:00:00:00') {
      return null;
    }
    return s;
  }
}
