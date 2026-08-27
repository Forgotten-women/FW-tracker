// Presence reporting.

import 'dart:async';
import 'dart:ui';
import 'package:flutter/foundation.dart';
import 'package:flutter_background_service/flutter_background_service.dart';

import '../models/attendance.dart';
import 'api_client.dart';
import 'device_probe.dart';
import 'offline_queue.dart';
import 'token_store.dart';

const heartbeatInterval = Duration(minutes: 2);

Future<PingResult?> sendHeartbeat({
  ApiClient? client,
  DeviceProbe? probe,
  OfflineQueue? queue,
}) async {
  final api = client ?? ApiClient();
  final deviceProbe = probe ?? DeviceProbe();
  final buffer = queue ?? OfflineQueue();

  final facts = await deviceProbe.network();
  final observation = QueuedObservation(
    observedAt: DateTime.now().millisecondsSinceEpoch,
    ssid: facts.ssid,
    bssid: facts.bssid,
  );

  try {
    await buffer.add(observation);
  } catch (_) {}

  List<QueuedObservation> pending = const [];
  try {
    pending = await buffer.readAll();
  } catch (_) {}

  if (pending.isEmpty) return null;

  try {
    final result = await api.ping(pending);
    try {
      await buffer.removeDelivered(pending.length);
    } catch (_) {}
    return result;
  } on ApiException catch (e) {
    if (e.needsReEnrollment) {
      rethrow;
    }
    return null;
  } catch (_) {
    return null;
  }
}

@pragma('vm:entry-point')
Future<void> onBackgroundStart(ServiceInstance service) async {
  DartPluginRegistrant.ensureInitialized();

  final store = TokenStore();
  final api = ApiClient();
  final probe = DeviceProbe();
  final queue = OfflineQueue();

  service.on('stop').listen((_) => service.stopSelf());

  Timer.periodic(heartbeatInterval, (timer) async {
    try {
      if (!await store.isEnrolled) return;
      final result = await sendHeartbeat(client: api, probe: probe, queue: queue);

      if (service is AndroidServiceInstance && result != null) {
        await service.setForegroundNotificationInfo(
          title: result.verified ? 'Present in office' : 'Not verified at office',
          content: result.verified
              ? 'Logged ${result.attendance.timeWorkedFormatted} today'
              : 'Connected, but not on an office network',
        );
      }
    } catch (_) {}
  });
}

@pragma('vm:entry-point')
Future<bool> onIosBackground(ServiceInstance service) async {
  DartPluginRegistrant.ensureInitialized();
  try {
    await sendHeartbeat();
  } catch (_) {}
  return true;
}

class PresenceService {
  static final _service = FlutterBackgroundService();

  static Future<void> configure() async {
    try {
      await _service.configure(
        androidConfiguration: AndroidConfiguration(
          onStart: onBackgroundStart,
          autoStart: false,
          isForegroundMode: false,
          notificationChannelId: 'office_tracker_presence',
          initialNotificationTitle: 'Office Tracker',
          initialNotificationContent: 'Presence reporting active',
          foregroundServiceNotificationId: 8801,
        ),
        iosConfiguration: IosConfiguration(
          autoStart: false,
          onForeground: onBackgroundStart,
          onBackground: onIosBackground,
        ),
      );
    } catch (e) {
      debugPrint('PresenceService configure error: $e');
    }
  }

  static Future<void> start() async {
    try {
      if (!await _service.isRunning()) {
        await _service.startService();
      }
    } catch (e) {
      debugPrint('PresenceService start error: $e');
    }
  }

  static Future<void> stop() async {
    try {
      if (await _service.isRunning()) {
        _service.invoke('stop');
      }
    } catch (_) {}
  }

  static Future<bool> isRunning() async {
    try {
      return await _service.isRunning();
    } catch (_) {
      return false;
    }
  }
}