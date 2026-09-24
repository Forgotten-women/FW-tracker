// Mobile System Notifications Service (Android Status Bar & Tray). Spec Section 22.
//
// Displays native device system notifications outside the app when HR makes a decision
// (Leave Approved/Rejected, Disputes Decided, Documents Verified, Formal Warnings Issued).

import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:timezone/data/latest_10y.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

import 'pinned_http_client.dart';
import 'token_store.dart';

typedef NotificationTapCallback = void Function(String? payload);

class NotificationService {
  static final NotificationService _instance = NotificationService._internal();
  factory NotificationService() => _instance;
  NotificationService._internal();

  final _http = createPinnedHttpClient();

  final FlutterLocalNotificationsPlugin _notificationsPlugin =
      FlutterLocalNotificationsPlugin();

  bool _isInitialized = false;
  NotificationTapCallback? onNotificationTapped;

  static const String channelId = 'office_tracker_notifications';
  static const String channelName = 'Office Presence & HR Notifications';
  static const String channelDesc =
      'Real-time alerts for leave approvals, attendance disputes, document status, and warnings.';

  static const String presenceChannelId = 'office_tracker_presence';
  static const String presenceChannelName = 'Office Presence Service';
  static const String presenceChannelDesc =
      'Keeps the background presence service running to detect office Wi-Fi.';

  static const String _seenIdsPrefKey = 'seen_notification_ids';

  /// Set when the HR feed brings a PAYROLL item ("Your payslip is ready"),
  /// cleared by PayslipWatcher once it has checked latestPayslip.
  static const String payslipSignalPrefKey = 'payslip_check_pending';

  /// Initializes the local notification plugin and creates Android channel & iOS Darwin configurations.
  Future<void> initialize({NotificationTapCallback? onSelect}) async {
    if (_isInitialized) return;
    onNotificationTapped = onSelect;

    const androidSettings = AndroidInitializationSettings('@mipmap/ic_launcher');
    const darwinSettings = DarwinInitializationSettings(
      requestAlertPermission: true,
      requestBadgePermission: true,
      requestSoundPermission: true,
    );

    const initSettings = InitializationSettings(
      android: androidSettings,
      iOS: darwinSettings,
    );

    await _notificationsPlugin.initialize(
      initSettings,
      onDidReceiveNotificationResponse: (response) {
        if (response.payload != null && onNotificationTapped != null) {
          onNotificationTapped!(response.payload);
        }
      },
    );

    // Create high-importance Android notification channel for alerts
    final androidChannel = AndroidNotificationChannel(
      channelId,
      channelName,
      description: channelDesc,
      importance: Importance.max,
      playSound: true,
      enableVibration: true,
    );

    await _notificationsPlugin
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(androidChannel);

    // Create low-importance Android notification channel for the foreground presence service
    final presenceChannel = AndroidNotificationChannel(
      presenceChannelId,
      presenceChannelName,
      description: presenceChannelDesc,
      importance: Importance.low,
      playSound: false,
      enableVibration: false,
    );

    await _notificationsPlugin
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(presenceChannel);

    // Request permissions explicitly for iOS
    await _notificationsPlugin
        .resolvePlatformSpecificImplementation<
            IOSFlutterLocalNotificationsPlugin>()
        ?.requestPermissions(
          alert: true,
          badge: true,
          sound: true,
        );

    _isInitialized = true;
  }

  /// Displays a native system notification in the device status bar / notification tray (Android & iOS).
  Future<void> showSystemNotification({
    required int id,
    required String title,
    required String body,
    String? payload,
    String? category,
  }) async {
    try {
      final androidDetails = AndroidNotificationDetails(
        channelId,
        channelName,
        channelDescription: channelDesc,
        importance: Importance.max,
        priority: Priority.high,
        ticker: title,
        icon: '@mipmap/ic_launcher',
        styleInformation: BigTextStyleInformation(
          body,
          contentTitle: title,
          summaryText: category != null ? 'HR: $category' : 'Office Tracker',
        ),
      );

      const darwinDetails = DarwinNotificationDetails(
        presentAlert: true,
        presentBadge: true,
        presentSound: true,
        interruptionLevel: InterruptionLevel.active,
      );

      final platformDetails = NotificationDetails(
        android: androidDetails,
        iOS: darwinDetails,
      );

      await _notificationsPlugin.show(
        id,
        title,
        body,
        platformDetails,
        payload: payload,
      );
    } catch (e) {
      debugPrint('NotificationService.showSystemNotification error: $e');
    }
  }

  /// Displays a local native break reminder notification (works completely offline without internet).
  Future<void> showBreakNotification({
    required int id,
    required String title,
    required String body,
  }) async {
    await showSystemNotification(
      id: id,
      title: title,
      body: body,
      category: 'BREAK',
    );
  }

  // ---------------------------------------------------------------------------
  // Break reminders
  //
  // Scheduled with the OS alarm system at the moment the phone learns a break
  // has started (started here, or on the laptop and seen on the next sync),
  // for two fixed instants: 10 minutes before the break ends, and when it
  // ends. From then on nothing needs the network, the app, or the background
  // service to be alive -- Android delivers them itself, and re-arms them
  // after a reboot (ScheduledNotificationBootReceiver in the manifest).
  // ---------------------------------------------------------------------------

  static const int breakWarningId = 9901;
  static const int breakEndedId = 9902;
  static const int breakWarningMinutes = 10;
  static const String breakChannelId = 'office_tracker_breaks';
  static const String _breakDuePrefKey = 'break_reminders_due_ms';

  bool _tzReady = false;

  String _clock(int ms) {
    final t = DateTime.fromMillisecondsSinceEpoch(ms);
    final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
    final m = t.minute.toString().padLeft(2, '0');
    return '$h:$m ${t.hour < 12 ? 'AM' : 'PM'}';
  }

  Future<AndroidScheduleMode> _scheduleMode() async {
    try {
      final android = _notificationsPlugin.resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>();
      final exact = await android?.canScheduleExactNotifications();
      if (exact == false) return AndroidScheduleMode.inexactAllowWhileIdle;
    } catch (_) {}
    return AndroidScheduleMode.exactAllowWhileIdle;
  }

  Future<void> _scheduleAt(int id, String title, String body, int atMs) async {
    const android = AndroidNotificationDetails(
      breakChannelId,
      'Break reminders',
      channelDescription: 'Tells you before your break ends, even without internet.',
      importance: Importance.max,
      priority: Priority.high,
      category: AndroidNotificationCategory.reminder,
      icon: '@mipmap/ic_launcher',
    );
    const darwin = DarwinNotificationDetails(
      presentAlert: true,
      presentSound: true,
      interruptionLevel: InterruptionLevel.timeSensitive,
    );
    await _notificationsPlugin.zonedSchedule(
      id,
      title,
      body,
      // A fixed instant, so the device's time zone doesn't matter.
      tz.TZDateTime.fromMillisecondsSinceEpoch(tz.UTC, atMs),
      const NotificationDetails(android: android, iOS: darwin),
      androidScheduleMode: await _scheduleMode(),
      uiLocalNotificationDateInterpretation:
          UILocalNotificationDateInterpretation.absoluteTime,
      payload: 'BREAK',
    );
  }

  /// Makes the scheduled break reminders match the break as last known.
  /// Safe to call on every sync: it only reschedules when the due time changes.
  Future<void> syncBreakReminders({
    required bool onBreak,
    int? startedAtMs,
    int? dueBackAtMs,
    int permittedMinutes = 30,
  }) async {
    try {
      if (!onBreak) {
        await cancelBreakReminders();
        return;
      }
      final due = dueBackAtMs ??
          (startedAtMs != null ? startedAtMs + permittedMinutes * 60 * 1000 : null);
      if (due == null) return;

      final prefs = await SharedPreferences.getInstance();
      if (prefs.getInt(_breakDuePrefKey) == due) return; // already scheduled

      await initialize();
      if (!_tzReady) {
        tzdata.initializeTimeZones();
        _tzReady = true;
      }
      await _notificationsPlugin.cancel(breakWarningId);
      await _notificationsPlugin.cancel(breakEndedId);

      final nowMs = DateTime.now().millisecondsSinceEpoch;
      final warnAt = due - breakWarningMinutes * 60 * 1000;
      if (warnAt > nowMs + 5000) {
        await _scheduleAt(
          breakWarningId,
          'Break ends in $breakWarningMinutes minutes',
          'Your break ends at ${_clock(due)}. Head back in time so it does not add to your deficit.',
          warnAt,
        );
      }
      if (due > nowMs + 5000) {
        await _scheduleAt(
          breakEndedId,
          'Your break is over',
          'Your $permittedMinutes-minute break ended at ${_clock(due)}. Resume work to avoid deficit time.',
          due,
        );
      }
      await prefs.setInt(_breakDuePrefKey, due);
    } catch (e) {
      debugPrint('NotificationService.syncBreakReminders error: $e');
    }
  }

  Future<void> cancelBreakReminders() async {
    try {
      await _notificationsPlugin.cancel(breakWarningId);
      await _notificationsPlugin.cancel(breakEndedId);
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_breakDuePrefKey);
    } catch (_) {}
  }

  /// Cancels an active or scheduled notification by ID.
  Future<void> cancelNotification(int id) async {
    try {
      await _notificationsPlugin.cancel(id);
    } catch (_) {}
  }

  /// If the app was cold-launched by the user tapping a notification (not
  /// just resumed from background), returns that notification's payload.
  ///
  /// onDidReceiveNotificationResponse (wired in initialize(), above) only
  /// fires for a tap while the plugin is already listening -- on a cold
  /// launch, initialize() runs in main.dart before MainShell exists to set
  /// onNotificationTapped, so the tap that actually launched the app was
  /// silently dropped: the app opened, but never navigated anywhere. Call
  /// this once a screen exists to route to, and feed the result through the
  /// same handler used for a live tap.
  Future<String?> checkLaunchPayload() async {
    try {
      final details = await _notificationsPlugin.getNotificationAppLaunchDetails();
      if (details != null && details.didNotificationLaunchApp) {
        return details.notificationResponse?.payload;
      }
    } catch (_) {}
    return null;
  }

  /// Polls /api/notifications/mine for the logged-in employee.
  /// For each new unread notification, fires a native status bar notification.
  Future<int> checkAndDispatchUnseenNotifications({
    TokenStore? store,
    String? serverUrl,
  }) async {
    final tokenStore = store ?? TokenStore();
    final token = await tokenStore.readToken();
    if (token == null) return 0;

    final baseUrl = serverUrl ?? await tokenStore.readServerUrl();
    final uri = Uri.parse('$baseUrl/api/notifications/mine');
    try {
      final res = await _http.get(uri, headers: {
        'Authorization': 'Bearer $token',
        'Accept': 'application/json',
      });

      if (res.statusCode != 200) return 0;

      final data = jsonDecode(res.body);
      if (data is! Map || data['status'] != 'SUCCESS') return 0;

      final list = data['notifications'];
      if (list is! List || list.isEmpty) return 0;

      final prefs = await SharedPreferences.getInstance();
      final seenIds = (prefs.getStringList(_seenIdsPrefKey) ?? []).toSet();
      int newlyDispatched = 0;

      for (final item in list) {
        if (item is! Map) continue;
        final id = item['id']?.toString() ?? '';
        if (id.isEmpty) continue;

        final isRead = item['read'] == true;
        final isDismissed = item['dismissed'] == true;

        // Only alert for unread & undismissed items not yet presented as system notifications
        if (!isRead && !isDismissed && !seenIds.contains(id)) {
          final title = item['title']?.toString() ?? 'HR Notification';
          final body = item['body']?.toString() ?? '';
          final category = item['category']?.toString();
          final link = item['link']?.toString() ?? category ?? '';

          // BREAK reminders are already delivered locally and offline by
          // presence_service.dart's own 30s timer, which is both more
          // precise (exact 25/30-minute mark) and doesn't depend on the
          // backend's cron sweep ever reaching this employee's record. This
          // server copy exists for the in-app feed / HR-side visibility,
          // not as a second tray popup for the same break -- showing it too
          // would double-notify for one event.
          //
          // PAYROLL is the server's "Your payslip is ready". PayslipWatcher
          // announces new payslips itself, from latestPayslip, with the
          // month in the title and at most once per payslip; showing this
          // copy as well would double-notify. It only marks a check as due.
          if (category == 'PAYROLL') {
            await prefs.setBool(payslipSignalPrefKey, true);
          } else if (category != 'BREAK') {
            // Generate numeric notification ID from string hash
            final numericId = id.hashCode & 0x7FFFFFFF;

            await showSystemNotification(
              id: numericId,
              title: title,
              body: body,
              payload: link,
              category: category,
            );
          }

          seenIds.add(id);
          newlyDispatched++;
        }
      }

      // Persist seen notification IDs (capped at most recent 200)
      final prunedList = seenIds.toList();
      if (prunedList.length > 200) {
        prunedList.removeRange(0, prunedList.length - 200);
      }
      await prefs.setStringList(_seenIdsPrefKey, prunedList);

      return newlyDispatched;
    } catch (e) {
      debugPrint('NotificationService.checkAndDispatch error: $e');
      return 0;
    }
  }
}
