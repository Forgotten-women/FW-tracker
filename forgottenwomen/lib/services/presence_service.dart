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
import 'payslip_watcher.dart';
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
/// Dynamically uses employee's assigned schedule from TokenStore/SharedPreferences.
bool isWithinOfficeHours([
  DateTime? dateTime,
  String? startTimeStr,
  String? endTimeStr,
  String? workingDaysStr,
]) {
  final now = dateTime ?? DateTime.now();

  // Check day of week against employee's working days
  final days = (workingDaysStr ?? 'mon,tue,wed,thu,fri')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .toList();
  const dayNames = ['', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  final currentDayName =
      now.weekday >= 1 && now.weekday <= 7 ? dayNames[now.weekday] : '';
  if (!days.contains(currentDayName)) {
    return false;
  }

  int startMinute = 11 * 60; // default 11:00 AM
  int endMinute = 19 * 60;   // default 7:00 PM
  if (startTimeStr != null && startTimeStr.contains(':')) {
    final parts =
        startTimeStr.split(':').map((s) => int.tryParse(s) ?? 0).toList();
    if (parts.length >= 2) startMinute = parts[0] * 60 + parts[1];
  }
  if (endTimeStr != null && endTimeStr.contains(':')) {
    final parts =
        endTimeStr.split(':').map((s) => int.tryParse(s) ?? 0).toList();
    if (parts.length >= 2) endMinute = parts[0] * 60 + parts[1];
  }

  // Allow a 30-minute buffer before scheduled start and 60-minute buffer after scheduled end
  final effectiveStart = (startMinute - 30).clamp(0, 1439);
  final effectiveEnd = (endMinute + 60).clamp(0, 1439);

  final minuteOfDay = now.hour * 60 + now.minute;
  return minuteOfDay >= effectiveStart && minuteOfDay < effectiveEnd;
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

      final prefs = await SharedPreferences.getInstance();
      final schedStart = prefs.getString('shift_start_time') ?? '11:00';
      final schedEnd = prefs.getString('shift_end_time') ?? '19:00';
      final schedDays =
          prefs.getString('shift_working_days') ?? 'mon,tue,wed,thu,fri';

      final withinHours =
          isWithinOfficeHours(now, schedStart, schedEnd, schedDays);

      if (!withinHours) {
        // Outside office hours for this employee's schedule:
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

      // New-payslip notification. The dispatch above turns the server's
      // "payslip ready" feed item into a signal; only then is the home
      // summary fetched for latestPayslip. No request on any other tick.
      await PayslipWatcher.checkPendingSignal(api);

      // Break reminders. These used to be checked here every tick, which only
      // worked while this service was alive, assumed a 30-minute break, and
      // missed a break started on the laptop. They are now scheduled with the
      // OS (NotificationService.syncBreakReminders) the moment a break is
      // known, and fire with no network; this tick just keeps them in step
      // with the server, so a laptop-started break is picked up here too.
      final breakState = result?.breakState;
      if (breakState != null) {
        await NotificationService().syncBreakReminders(
          onBreak: breakState.onBreak,
          startedAtMs: breakState.startedAtMs,
          dueBackAtMs: breakState.dueBackAtMs,
          permittedMinutes: breakState.permittedMinutes,
        );
      }
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
    final payslipApi = ApiClient();
    try {
      await PayslipWatcher.checkPendingSignal(payslipApi);
    } finally {
      payslipApi.dispose();
    }
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