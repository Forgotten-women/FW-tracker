// Server-time reconciliation.
//
// The office-hours pre-check that gates background heartbeats
// (presence_service.dart) runs entirely on the device clock. A wrong
// timezone or an unsynced clock (roaming, a manual change, an OEM
// clock-sync bug) makes that gate silently skip sending heartbeats during
// real office hours, with no server-side fallback -- the whole point of the
// gate is to avoid ever contacting the server when it's obviously outside
// hours.
//
// This tracks the drift between the device clock and the server's own
// clock, read from the standard HTTP `Date` response header on every API
// call, and lets callers ask for a corrected "now". It stays a low-privilege
// client-side stopgap: the backend remains the sole authority on whether a
// ping actually counts as attendance (presence.js), this only prevents the
// client's own pre-filter from mistakenly hiding a heartbeat from a server
// that is otherwise perfectly reachable.

import 'dart:developer';
import 'dart:io' show HttpDate;
import 'package:shared_preferences/shared_preferences.dart';

class ServerTime {
  static const _kOffsetMs = 'server_time_offset_ms';
  static const _kSyncedAtMs = 'server_time_synced_at_ms';

  /// Beyond this the cached offset is treated as unknown -- trusting the
  /// device clock outright is safer than applying a correction that is
  /// itself stale (e.g. the app hasn't reached the server in days).
  static const _maxAge = Duration(hours: 12);

  static int? _offsetMs;
  static DateTime? _syncedAt;

  /// Parses a response's `Date` header and records the drift against the
  /// device clock at the moment it arrived. Safe to call on every response,
  /// including error responses -- the header is still a valid clock sample.
  static Future<void> recordDateHeader(String? dateHeader) async {
    if (dateHeader == null) return;
    DateTime serverDate;
    try {
      serverDate = HttpDate.parse(dateHeader);
    } catch (_) {
      return;
    }
    final deviceNow = DateTime.now().toUtc();
    final offset = serverDate.difference(deviceNow).inMilliseconds;
    _offsetMs = offset;
    _syncedAt = deviceNow;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setInt(_kOffsetMs, offset);
      await prefs.setInt(_kSyncedAtMs, deviceNow.millisecondsSinceEpoch);
    } catch (e) {
      log('ServerTime persist error: $e');
    }
  }

  /// Best-effort "now", corrected by the last known drift against the
  /// server's clock. Falls back to the plain device clock when no
  /// correction has been recorded yet, or the last one is too stale to
  /// trust.
  static Future<DateTime> now() async {
    var offset = _offsetMs;
    var syncedAt = _syncedAt;
    if (offset == null || syncedAt == null) {
      try {
        final prefs = await SharedPreferences.getInstance();
        final storedOffset = prefs.getInt(_kOffsetMs);
        final storedSyncedAtMs = prefs.getInt(_kSyncedAtMs);
        if (storedOffset != null && storedSyncedAtMs != null) {
          offset = storedOffset;
          syncedAt = DateTime.fromMillisecondsSinceEpoch(storedSyncedAtMs, isUtc: true);
          _offsetMs = offset;
          _syncedAt = syncedAt;
        }
      } catch (_) {}
    }
    final deviceNow = DateTime.now();
    if (offset == null || syncedAt == null) return deviceNow;
    if (DateTime.now().toUtc().difference(syncedAt) > _maxAge) return deviceNow;
    return deviceNow.add(Duration(milliseconds: offset));
  }
}
