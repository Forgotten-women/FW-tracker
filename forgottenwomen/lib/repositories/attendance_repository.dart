import 'dart:async';
import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/attendance.dart';
import '../services/api_client.dart';
import '../services/notification_service.dart';
import '../services/offline_queue.dart';

class AttendanceRepository {
  final ApiClient apiClient;
  final OfflineQueue offlineQueue;

  static const String _cacheKey = 'cached_home_summary';

  AttendanceRepository({
    required this.apiClient,
    required this.offlineQueue,
  });

  /// Reads cached HomeSummary from persistent storage in under 5ms.
  /// Enables instant cold-boot rendering without blank screens or loading spinners.
  Future<HomeSummary?> getCachedHomeSummary() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_cacheKey);
      if (raw == null || raw.isEmpty) return null;
      final decoded = jsonDecode(raw) as Map<String, dynamic>;
      return HomeSummary.fromJson(decoded);
    } catch (_) {
      return null;
    }
  }

  /// Fetches the latest home summary from the server in a single atomic network call,
  /// caches it locally, and flushes queued offline observations asynchronously.
  Future<HomeSummary> fetchFreshHomeSummary() async {
    // Flush queued offline observations in the background without delaying the dashboard load
    unawaited(_tryFlushQueue());

    final rawJson = await apiClient.fetchHomeSummaryRaw();

    // Persist to offline cache for future instant launches
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_cacheKey, jsonEncode(rawJson));
    } catch (_) {
      // Non-fatal cache write failure
    }

    return HomeSummary.fromJson(rawJson);
  }

  Future<void> _tryFlushQueue() async {
    try {
      final pending = await offlineQueue.readAll();
      if (pending.isEmpty) return;
      final res = await apiClient.ping(pending);
      if (res.accepted > 0 || res.duplicates > 0) {
        await offlineQueue.removeDelivered(pending.length);
      }
    } catch (_) {
      // Offline queue flush can be retried on next heartbeat or refresh
    }
  }

  Future<BreakStartResult> startBreak() async {
    final res = await apiClient.startBreak();
    try {
      final prefs = await SharedPreferences.getInstance();
      final nowMs = DateTime.now().millisecondsSinceEpoch;
      await prefs.setInt('break_started_at_ms', nowMs);
      await prefs.setBool('break_5m_alerted', false);
      await prefs.setBool('break_ended_alerted', false);
    } catch (_) {}
    return res;
  }

  Future<BreakEndResult> endBreak() async {
    final res = await apiClient.endBreak();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove('break_started_at_ms');
      await prefs.remove('break_5m_alerted');
      await prefs.remove('break_ended_alerted');
      await NotificationService().cancelNotification(9901);
      await NotificationService().cancelNotification(9902);
    } catch (_) {}
    return res;
  }

  Future<void> clockOut() => apiClient.clockOut();
}
