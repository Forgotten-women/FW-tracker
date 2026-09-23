// Presence reporting.

import 'dart:async';
import 'dart:io' show Platform;
import 'dart:ui';
import 'package:android_alarm_manager_plus/android_alarm_manager_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_background_service/flutter_background_service.dart';

import '../models/attendance.dart';
import 'api_client.dart';
import 'device_probe.dart';
import 'notification_service.dart';
import 'offline_queue.dart';
import 'server_time.dart';
import 'token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

const heartbeatInterval = Duration(seconds: 30);

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
    localIp: facts.localIp,
  );

  try {
    await buffer.add(observation);
  } catch (_) {}

  try {
    return await buffer.flush((pending) => api.ping(pending));
  } on ApiException catch (e) {
    if (e.needsReEnrollment) {
      rethrow;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/// Checks whether the given or current time falls within official office hours:
/// Monday to Friday (weekdays only), 11:00 AM to 7:00 PM (11:00 to 19:00).
bool isWithinOfficeHours([DateTime? dateTime]) {
  final now = dateTime ?? DateTime.now();
  if (now.weekday < DateTime.monday || now.weekday > DateTime.friday) {
    return false;
  }
  final minuteOfDay = now.hour * 60 + now.minute;
  const startMinute = 11 * 60; // 11:00 AM
  const endMinute = 19 * 60;   // 7:00 PM (19:00)
  return minuteOfDay >= startMinute && minuteOfDay < endMinute;
}

@pragma('vm:entry-point')
Future<void> onBackgroundStart(ServiceInstance service) async {
  DartPluginRegistrant.ensureInitialized();

  // Initialize notifications plugin in the background service isolate
  try {
    await NotificationService().initialize();
  } catch (_) {}

  final store = TokenStore();
  final api = ApiClient();
  final probe = DeviceProbe();
  final queue = OfflineQueue();

  service.on('stop').listen((_) => service.stopSelf());

  Future<void> runPresenceTick() async {
    try {
      // Reconciled against the server's clock (see server_time.dart) so a
      // wrong device timezone/clock can't silently suppress heartbeats
      // during real office hours.
      final now = await ServerTime.now();
      final withinHours = isWithinOfficeHours(now);

      if (!withinHours) {
        // Outside office hours (Mon-Fri 11:00 AM - 7:00 PM):
        // 1. Demote to background and completely hide/cancel presence notification 8800.
        // 2. Zero updates sent to backend.
        if (service is AndroidServiceInstance) {
          await service.setAsBackgroundService();
        }
        try {
          await NotificationService().cancelNotification(8800);
        } catch (_) {}
        try {
          final prefs = await SharedPreferences.getInstance();
          await prefs.setBool('was_in_office', false);
        } catch (_) {}
        return;
      }

      // Within office hours:
      if (!await store.isEnrolled) return;

      if (service is AndroidServiceInstance) {
        await service.setAsForegroundService();
      }

      // Send heartbeat to backend
      final result = await sendHeartbeat(client: api, probe: probe, queue: queue);

      if (result != null) {
        final prefs = await SharedPreferences.getInstance();
        final wasInOffice = prefs.getBool('was_in_office') ?? false;

        if (result.verified) {
          if (service is AndroidServiceInstance) {
            service.setForegroundNotificationInfo(
              title: 'Office Tracker Active',
              content: '🟢 In Office · Logged ${result.attendance.timeWorkedFormatted}',
            );
          }

          if (!wasInOffice) {
            await prefs.setBool('was_in_office', true);
            await prefs.setString('last_presence_verified_date', DateTime.now().toIso8601String().substring(0, 10));
            await NotificationService().showSystemNotification(
              id: 8801,
              title: 'Office Presence Verified',
              body: 'Connected to office network. Logged ${result.attendance.timeWorkedFormatted} today.',
              category: 'ATTENDANCE',
            );
          }
        } else {
          // Out of office network during office hours
          await prefs.setBool('was_in_office', false);
          if (service is AndroidServiceInstance) {
            service.setForegroundNotificationInfo(
              title: 'Office Tracker Active',
              content: 'Monitoring office presence in background',
            );
          }
        }
      }

      // Check for incoming HR notifications in background
      try {
        await NotificationService().checkAndDispatchUnseenNotifications(store: store);
      } catch (e) {
        debugPrint('Background notification dispatch error: $e');
      }

      // Local, offline break monitoring (works 100% offline without internet or Wi-Fi)
      try {
        final prefs = await SharedPreferences.getInstance();
        final breakStartMs = prefs.getInt('break_started_at_ms');
        if (breakStartMs != null) {
          final nowMs = DateTime.now().millisecondsSinceEpoch;
          final elapsedSeconds = (nowMs - breakStartMs) ~/ 1000;
          final alerted5m = prefs.getBool('break_5m_alerted') ?? false;
          final alertedEnded = prefs.getBool('break_ended_alerted') ?? false;

          // 25 minutes in (5 minutes remaining on 30-minute break)
          if (elapsedSeconds >= 25 * 60 && !alerted5m) {
            await prefs.setBool('break_5m_alerted', true);
            await NotificationService().showBreakNotification(
              id: 9901,
              title: 'Break Reminder',
              body: 'You have 5 minutes left on your break.',
            );
          }

          // 30 minutes in (30-minute break completed)
          if (elapsedSeconds >= 30 * 60 && !alertedEnded) {
            await prefs.setBool('break_ended_alerted', true);
            await NotificationService().showBreakNotification(
              id: 9902,
              title: 'Break Completed',
              body: 'Your 30-minute break period has been completed. Please check back in to avoid deficit time.',
            );
          }
        }
      } catch (_) {}
    } catch (_) {}
  }

  // Initial immediate tick on start
  unawaited(runPresenceTick());

  // Periodic heartbeat every 30 seconds
  Timer.periodic(heartbeatInterval, (_) => runPresenceTick());
}

// Android only. Android kills a plain (non-foreground) background service
// once the app isn't open, which is exactly what onBackgroundStart above
// deliberately becomes outside office hours (setAsBackgroundService()) --
// so most nights the service is fully gone by the time it would matter.
// RECEIVE_BOOT_COMPLETED only gets it running again after a device reboot,
// not every morning. This alarm, scheduled via _dailyResumeAlarmId below,
// is what actually restarts it at 11:00 AM daily regardless of whether it
// was killed overnight. Runs in its own isolate (owned by the
// AndroidAlarmManager service, not the app or the background-service
// isolate), so it re-registers plugins and reconfigures the background
// service from scratch before starting it.
const int _dailyResumeAlarmId = 0x4F540B; // arbitrary stable id ("OT" + tag)

@pragma('vm:entry-point')
Future<void> dailyResumeAlarmCallback() async {
  DartPluginRegistrant.ensureInitialized();
  try {
    await PresenceService.configure();
    await PresenceService.start();
  } catch (e) {
    debugPrint('dailyResumeAlarmCallback error: $e');
  }
}

@pragma('vm:entry-point')
Future<bool> onIosBackground(ServiceInstance service) async {
  DartPluginRegistrant.ensureInitialized();
  try {
    if (!isWithinOfficeHours(await ServerTime.now())) {
      return true;
    }
    await NotificationService().initialize();
    await sendHeartbeat();
    final store = TokenStore();
    await NotificationService().checkAndDispatchUnseenNotifications(store: store);
  } catch (_) {}
  return true;
}

class PresenceService {
  static final _service = FlutterBackgroundService();

  static Future<void> configure() async {
    try {
      final withinHours = isWithinOfficeHours(await ServerTime.now());
      if (!withinHours) {
        try {
          await NotificationService().cancelNotification(8800);
        } catch (_) {}
      }

      await _service.configure(
        androidConfiguration: AndroidConfiguration(
          onStart: onBackgroundStart,
          autoStart: true,
          autoStartOnBoot: true,
          isForegroundMode: withinHours,
          notificationChannelId: 'office_tracker_presence',
          initialNotificationTitle: 'Office Tracker Active',
          initialNotificationContent: 'Monitoring office presence in background',
          foregroundServiceNotificationId: 8800,
        ),
        iosConfiguration: IosConfiguration(
          autoStart: true,
          onForeground: onBackgroundStart,
          onBackground: onIosBackground,
        ),
      );
    } catch (e) {
      debugPrint('PresenceService configure error: $e');
    }
  }

  /// Schedules the OS-level alarm (Android only) that restarts the presence
  /// service at 11:00 AM every day, even if Android fully killed it
  /// overnight. Safe to call on every app launch -- android_alarm_manager_plus
  /// replaces any existing alarm registered under the same id rather than
  /// stacking duplicates.
  static Future<void> scheduleDailyResume() async {
    if (!Platform.isAndroid) return;
    try {
      await AndroidAlarmManager.initialize();

      final now = DateTime.now();
      var next = DateTime(now.year, now.month, now.day, 11, 0);
      if (!next.isAfter(now)) {
        next = next.add(const Duration(days: 1));
      }

      await AndroidAlarmManager.periodic(
        const Duration(days: 1),
        _dailyResumeAlarmId,
        dailyResumeAlarmCallback,
        startAt: next,
        // Inexact: avoids requiring the user to separately grant
        // SCHEDULE_EXACT_ALARM on Android 12+. A few minutes of slack on a
        // "restart the background service" alarm is immaterial -- the
        // service's own office-hours check (11:00-19:00) already tolerates
        // exactly this kind of small timing slop everywhere else.
        exact: false,
        allowWhileIdle: true,
        wakeup: true,
        rescheduleOnReboot: true,
      );
    } catch (e) {
      debugPrint('PresenceService.scheduleDailyResume error: $e');
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