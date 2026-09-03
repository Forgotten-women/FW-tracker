// Mobile System Notifications Service (Android Status Bar & Tray). Spec Section 22.
//
// Displays native device system notifications outside the app when HR makes a decision
// (Leave Approved/Rejected, Disputes Decided, Documents Verified, Formal Warnings Issued).

import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'token_store.dart';

typedef NotificationTapCallback = void Function(String? payload);

class NotificationService {
  static final NotificationService _instance = NotificationService._internal();
  factory NotificationService() => _instance;
  NotificationService._internal();

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

  /// Cancels an active or scheduled notification by ID.
  Future<void> cancelNotification(int id) async {
    try {
      await _notificationsPlugin.cancel(id);
    } catch (_) {}
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
      final res = await http.get(uri, headers: {
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

          // Generate numeric notification ID from string hash
          final numericId = id.hashCode & 0x7FFFFFFF;

          await showSystemNotification(
            id: numericId,
            title: title,
            body: body,
            payload: link,
            category: category,
          );

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
