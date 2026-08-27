// Offline buffer for heartbeats.
//
// The old app caught a failed heartbeat and discarded it, so any network blip -
// a dropped Wi-Fi association, a server restart, a router reboot - became
// permanently missing attendance with nothing to show it had happened.
//
// Observations are buffered locally and replayed with their ORIGINAL
// timestamps. The server dedupes on (device, second), so replaying a batch
// cannot double-count.

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/attendance.dart';

class OfflineQueue {
  static const _key = 'pending_observations';

  /// Bounded so a phone left offline for a week cannot grow the buffer without
  /// limit. At one observation a minute this is roughly eight hours of backlog,
  /// and the server refuses anything older than seven days anyway.
  static const maxEntries = 500;

  Future<List<QueuedObservation>> readAll() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_key) ?? const [];
    final out = <QueuedObservation>[];
    for (final entry in raw) {
      try {
        out.add(QueuedObservation.fromJson(
            jsonDecode(entry) as Map<String, dynamic>));
      } catch (_) {
        // Drop an unreadable entry rather than losing the whole queue.
      }
    }
    return out;
  }

  Future<void> add(QueuedObservation observation) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_key) ?? <String>[];
    raw.add(jsonEncode(observation.toJson()));

    // Drop the OLDEST entries when full: the newest observations are the ones
    // that matter for current presence, and the oldest are closest to expiring
    // server-side.
    if (raw.length > maxEntries) {
      raw.removeRange(0, raw.length - maxEntries);
    }
    await prefs.setStringList(_key, raw);
  }

  /// Clears entries that were successfully delivered. Anything buffered while
  /// the upload was in flight is preserved.
  Future<void> removeDelivered(int count) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_key) ?? <String>[];
    if (count >= raw.length) {
      await prefs.remove(_key);
      return;
    }
    await prefs.setStringList(_key, raw.sublist(count));
  }

  Future<int> get length async {
    final prefs = await SharedPreferences.getInstance();
    return (prefs.getStringList(_key) ?? const []).length;
  }

  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
  }
}
