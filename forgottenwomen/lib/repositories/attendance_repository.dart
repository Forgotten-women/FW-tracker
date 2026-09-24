import 'dart:async';
import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/attendance.dart';
import '../models/payroll.dart';
import '../services/api_client.dart';
import '../services/notification_service.dart';
import '../services/offline_queue.dart';
import '../services/payslip_watcher.dart';

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

    final summary = HomeSummary.fromJson(rawJson);
    // Keeps the OS-scheduled break reminders in step with the server --
    // including a break started or ended on the laptop.
    final b = summary.todayDetails.breakInfo;
    await NotificationService().syncBreakReminders(
      onBreak: b.onBreak,
      startedAtMs: b.startedAtMs,
      dueBackAtMs: b.dueBackAtMs,
      permittedMinutes: b.permittedMinutes,
    );

    // "Your <month> payslip is ready": latestPayslip rides on every home
    // summary. Not awaited, so the name lookup never delays the dashboard.
    if (rawJson.containsKey('latestPayslip')) {
      unawaited(PayslipWatcher.observe(
        LatestPayslip.fromJson(rawJson['latestPayslip']),
        payslipFor: apiClient.fetchMyPayslip,
        settlesSignal: true,
      ));
    }
    return summary;
  }

  Future<void> _tryFlushQueue() async {
    try {
      // Goes through OfflineQueue.flush so this can never race the
      // background heartbeat isolate's own concurrent flush attempt.
      await offlineQueue.flush((pending) => apiClient.ping(pending));
    } catch (_) {
      // Offline queue flush can be retried on next heartbeat or refresh
    }
  }

  Future<BreakStartResult> startBreak() async {
    final res = await apiClient.startBreak();
    // Scheduled with the OS right away, so the reminders fire on time even if
    // the phone goes offline or the app is closed for the rest of the break.
    await NotificationService().syncBreakReminders(
      onBreak: true,
      startedAtMs: DateTime.now().millisecondsSinceEpoch,
      dueBackAtMs: res.dueBackAtMs > 0 ? res.dueBackAtMs : null,
      permittedMinutes: res.permittedMinutes,
    );
    return res;
  }

  Future<BreakEndResult> endBreak() async {
    final res = await apiClient.endBreak();
    await NotificationService().cancelBreakReminders();
    return res;
  }

  Future<void> clockOut() => apiClient.clockOut();
}
