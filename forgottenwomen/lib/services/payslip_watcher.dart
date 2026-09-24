// "Your <month> payslip is ready" notifications.
//
// Source of truth: latestPayslip { periodId, publishedAt }, the employee's
// newest published payslip (null while salaries are hidden from employees).
// It rides on the home summary the app polls every 30 s -- one indexed query
// server-side, never cached -- so AttendanceRepository.fetchFreshHomeSummary
// hands every fresh summary to [PayslipWatcher.observe]. Its publishedAt is
// compared with the last value this device stored; a newer one is announced
// once, and stored.
//
// First run: with nothing stored yet, the first value stored is
// max(latest publishedAt, now) and nothing is announced, so a payslip
// published before this device started watching never notifies.
//
// One notification per payslip, not two: when a run is published the
// backend also writes a PAYROLL feed item ("Your payslip is ready").
// NotificationService.checkAndDispatchUnseenNotifications doesn't pop that
// one up; it sets NotificationService.payslipSignalPrefKey instead, and the
// background presence tick calls [PayslipWatcher.checkPendingSignal], which
// turns the signal into one home-summary fetch and an observe(). That is how
// a payslip is announced while the app is closed, without the background
// service polling the home summary on every tick.

import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/payroll.dart';
import 'api_client.dart';
import 'notification_service.dart';
import 'server_time.dart';

/// What [PayslipWatcher.decide] concluded.
class PayslipCheck {
  final bool notify;

  /// The value to store, or null to leave the stored one as it is.
  final int? store;

  const PayslipCheck({required this.notify, this.store});
}

class PayslipWatcher {
  PayslipWatcher._();

  static const String lastSeenPrefKey = 'payslip_last_seen_published_at';

  /// Routed by MainShell: it contains 'PAY', so a tap opens the Salary tab.
  static const String notificationPayload = 'PAYSLIP';

  /// Fixed, so a second announcement of the same payslip (two isolates
  /// racing) replaces the first in the tray instead of stacking.
  static const int notificationId = 9920;

  /// Newest publishedAt this isolate has seen, so an open salary screen can
  /// reload when a payslip appears.
  static final ValueNotifier<int?> latestPublishedAt = ValueNotifier<int?>(null);

  /// Bumped when a payslip notification is tapped.
  static final ValueNotifier<int> refreshRequests = ValueNotifier<int>(0);

  /// The whole rule, without I/O.
  static PayslipCheck decide({
    required int? stored,
    required LatestPayslip? latest,
    required int nowMs,
  }) {
    if (stored == null) {
      return PayslipCheck(notify: false, store: math.max(latest?.publishedAt ?? 0, nowMs));
    }
    if (latest != null && latest.publishedAt > stored) {
      return PayslipCheck(notify: true, store: latest.publishedAt);
    }
    return const PayslipCheck(notify: false);
  }

  static String notificationTitle(String? periodName) =>
      (periodName == null || periodName.trim().isEmpty)
          ? 'Your payslip is ready'
          : 'Your ${periodName.trim()} payslip is ready';

  static String notificationBody(String? payDate) {
    final when = formatPayrollDate(payDate);
    return when == null
        ? 'Approved by HR and published. Tap to view it.'
        : 'Approved by HR and published. Pay date: $when.';
  }

  // Serialises observe() within an isolate, so two overlapping home-summary
  // fetches can't both decide to announce the same payslip.
  static Future<void> _tail = Future<void>.value();

  /// Compares [latest] with the stored value and announces a newer payslip.
  /// [payslipFor] looks up the period name and pay date for the text; if it
  /// fails the notification goes out without them. [settlesSignal] clears the
  /// pending server signal: pass it only for an uncached source (the home
  /// summary). Returns whether a notification was shown. Never throws.
  static Future<bool> observe(
    LatestPayslip? latest, {
    Future<PayslipDetail?> Function(String periodId)? payslipFor,
    bool settlesSignal = false,
  }) {
    final run = _tail.then((_) => _observe(latest, payslipFor, settlesSignal));
    _tail = run.then((_) {}, onError: (_) {});
    return run;
  }

  static Future<bool> _observe(
    LatestPayslip? latest,
    Future<PayslipDetail?> Function(String periodId)? payslipFor,
    bool settlesSignal,
  ) async {
    try {
      if (latest != null && latest.publishedAt > (latestPublishedAt.value ?? 0)) {
        latestPublishedAt.value = latest.publishedAt;
      }

      final prefs = await SharedPreferences.getInstance();
      // The background service isolate writes these too.
      await prefs.reload();
      final nowMs = (await ServerTime.now()).millisecondsSinceEpoch;
      final check = decide(stored: prefs.getInt(lastSeenPrefKey), latest: latest, nowMs: nowMs);

      // Stored before the (networked) name lookup, so another isolate
      // checking meanwhile sees it and stays quiet.
      if (check.store != null) await prefs.setInt(lastSeenPrefKey, check.store!);
      if (settlesSignal) await prefs.remove(NotificationService.payslipSignalPrefKey);
      if (!check.notify || latest == null) return false;

      PayslipDetail? payslip;
      try {
        payslip = await payslipFor?.call(latest.periodId);
      } on ApiException catch (e) {
        // Salaries were hidden again in between: don't announce a payslip
        // the employee can't open.
        if (e.statusCode == 403) return false;
      } catch (_) {}

      await NotificationService().showSystemNotification(
        id: notificationId,
        title: notificationTitle(payslip?.periodName),
        body: notificationBody(payslip?.payDate),
        payload: notificationPayload,
        category: 'PAYROLL',
      );
      return true;
    } catch (e) {
      debugPrint('PayslipWatcher.observe error: $e');
      return false;
    }
  }

  /// For the background presence tick. Does nothing (and makes no request)
  /// unless the HR notification dispatcher has seen a PAYROLL item since the
  /// last check. The signal stays set if the fetch fails, so the next tick
  /// retries.
  static Future<void> checkPendingSignal(ApiClient api) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.reload();
      if (prefs.getBool(NotificationService.payslipSignalPrefKey) != true) return;
      final raw = await api.fetchHomeSummaryRaw();
      await observe(
        LatestPayslip.fromJson(raw['latestPayslip']),
        payslipFor: api.fetchMyPayslip,
        settlesSignal: true,
      );
    } catch (e) {
      debugPrint('PayslipWatcher.checkPendingSignal error: $e');
    }
  }
}
