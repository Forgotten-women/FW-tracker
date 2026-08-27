// Presence reporting.
//
// The old implementation used a Timer.periodic inside a StatefulWidget and told
// the user it "pings server every 15s in background". It did not: on iOS the
// timer stops the moment the app is backgrounded, and on Android it is killed
// by Doze. Attendance was only ever recorded while someone was looking at the
// screen.
//
// This runs in a real background isolate, with an Android foreground service.
//
// AN HONEST LIMIT ON iOS
// iOS does not permit reliable timer-driven background work. Background fetch
// is best-effort and the OS decides when, or whether, to run it. The dependable
// iOS mechanism is region monitoring on an office geofence, which wakes the app
// on entry and exit and requires "Always" location permission. So on iOS treat
// this as: reliable entry/exit events, opportunistic top-ups in between. It is
// not a 15-second heartbeat, and the UI must not claim it is.

import 'dart:async';
import 'dart:ui';

import 'package:flutter_background_service/flutter_background_service.dart';

import '../models/attendance.dart';
import 'api_client.dart';
import 'device_probe.dart';
import 'offline_queue.dart';
import 'token_store.dart';

const heartbeatInterval = Duration(minutes: 2);

/// Records one observation and flushes the buffer.
///
/// Shared by the foreground UI and the background isolate so both take exactly
/// the same path - there is no second implementation to drift.
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

  // Buffer first, then upload. If the upload fails the observation is already
  // durable, which is precisely what the old code got wrong.
  await buffer.add(observation);

  final pending = await buffer.readAll();
  if (pending.isEmpty) return null;

  try {
    final result = await api.ping(pending);
    await buffer.removeDelivered(pending.length);
    return result;
  } on ApiException catch (e) {
    if (e.needsReEnrollment) {
      // The credential is dead. Keep the buffer - it is useless without a
      // token, but discarding it would hide that presence went unrecorded.
      rethrow;
    }
    // Transient failure: leave everything buffered for the next attempt.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Background service
// ---------------------------------------------------------------------------

/// Background isolate entrypoint.
///
/// Must be a top-level function annotated for AOT entry-point retention, and it
/// cannot share state with the UI isolate - it reads the token from secure
/// storage itself.
@pragma('vm:entry-point')
Future<void> onBackgroundStart(ServiceInstance service) async {
  DartPluginRegistrant.ensureInitialized();

  final store = TokenStore();
  final api = ApiClient();
  final probe = DeviceProbe();
  final queue = OfflineQueue();

  service.on('stop').listen((_) => service.stopSelf());

  Timer.periodic(heartbeatInterval, (timer) async {
    if (!await store.isEnrolled) return;

    try {
      final result = await sendHeartbeat(client: api, probe: probe, queue: queue);

      if (service is AndroidServiceInstance && result != null) {
        // The persistent notification is required for an Android foreground
        // service, and it is also the honest signal to the employee that
        // presence reporting is running.
        await service.setForegroundNotificationInfo(
          title: result.verified ? 'Present in office' : 'Not verified at office',
          content: result.verified
              ? 'Logged ${result.attendance.timeWorkedFormatted} today'
              : 'Connected, but not on an office network',
        );
      }
    } on ApiException catch (e) {
      if (e.needsReEnrollment) {
        // Nothing this isolate can do without a human re-enrolling.
        if (service is AndroidServiceInstance) {
          await service.setForegroundNotificationInfo(
            title: 'Re-enrolment needed',
            content: 'Open the app to pair this device again',
          );
        }
        timer.cancel();
        service.stopSelf();
      }
    } catch (_) {
      // Never let one failed tick kill the service.
    }
  });
}

/// iOS background-fetch entrypoint. Best-effort by design: iOS decides if and
/// when this runs. Returning true keeps the app eligible for future wake-ups.
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
    await _service.configure(
      androidConfiguration: AndroidConfiguration(
        onStart: onBackgroundStart,
        autoStart: false, // started only after enrolment
        isForegroundMode: true,
        notificationChannelId: 'office_tracker_presence',
        initialNotificationTitle: 'Office Tracker',
        initialNotificationContent: 'Presence reporting starting',
        foregroundServiceNotificationId: 8801,
      ),
      iosConfiguration: IosConfiguration(
        autoStart: false,
        onForeground: onBackgroundStart,
        onBackground: onIosBackground,
      ),
    );
  }

  static Future<void> start() async {
    if (!await _service.isRunning()) {
      await _service.startService();
    }
  }

  static Future<void> stop() async {
    if (await _service.isRunning()) {
      _service.invoke('stop');
    }
  }

  static Future<bool> isRunning() => _service.isRunning();
}
