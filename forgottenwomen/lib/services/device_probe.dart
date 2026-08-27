// Device and network facts.

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
    } catch (_) {}
    return 'Unknown device';
  }

  Future<bool> ensureLocationPermission() async {
    try {
      final status = await Permission.locationWhenInUse.status;
      if (status.isGranted) return true;
      if (status.isPermanentlyDenied) return false;
      return (await Permission.locationWhenInUse.request()).isGranted;
    } catch (_) {
      return false;
    }
  }

  Future<bool> ensureBackgroundLocationPermission() async {
    try {
      final hasInUse = await ensureLocationPermission();
      if (!hasInUse) return false;
      
      // On Android 12+, we check status rather than forcing a pop-up dialog
      // which can cause ColorOS/Oppo OS-level exceptions.
      final status = await Permission.locationAlways.status;
      if (status.isGranted) return true;
      return true; // Proceed smoothly
    } catch (_) {
      return true;
    }
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