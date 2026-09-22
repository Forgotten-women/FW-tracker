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

  /// Serializes every read/add/remove against this queue.
  ///
  /// Presence is flushed from two independent, concurrently-running
  /// consumers: the background heartbeat isolate (every 30s) and the
  /// foreground home-summary refresh (every 10s). Without serialization, one
  /// consumer can read a snapshot, start a slow `ping()`, and have the other
  /// consumer read a *newer* snapshot, deliver it, and clear the whole queue
  /// first — so when the first consumer's `ping()` finally returns it removes
  /// entries by position against a queue that no longer matches its snapshot,
  /// silently discarding whatever was appended in between. Chaining every
  /// operation onto one static Future makes each read-send-remove cycle
  /// atomic across both consumers.
  static Future<void> _chain = Future.value();

  Future<T> _synchronized<T>(Future<T> Function() action) {
    final result = _chain.then((_) => action());
    _chain = result.then((_) {}, onError: (_) {});
    return result;
  }

  Future<List<QueuedObservation>> readAll() => _synchronized(_readAllLocked);

  Future<List<QueuedObservation>> _readAllLocked() async {
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

  Future<void> add(QueuedObservation observation) => _synchronized(() async {
        final prefs = await SharedPreferences.getInstance();
        final raw = prefs.getStringList(_key) ?? <String>[];
        raw.add(jsonEncode(observation.toJson()));

        // Drop the OLDEST entries when full: the newest observations are the
        // ones that matter for current presence, and the oldest are closest
        // to expiring server-side.
        if (raw.length > maxEntries) {
          raw.removeRange(0, raw.length - maxEntries);
        }
        await prefs.setStringList(_key, raw);
      });

  /// Clears entries that were successfully delivered. Anything buffered while
  /// the upload was in flight is preserved.
  Future<void> removeDelivered(int count) => _synchronized(() async {
        final prefs = await SharedPreferences.getInstance();
        final raw = prefs.getStringList(_key) ?? <String>[];
        if (count >= raw.length) {
          await prefs.remove(_key);
          return;
        }
        await prefs.setStringList(_key, raw.sublist(count));
      });

  /// Atomically reads the pending queue, hands it to [send], and — only once
  /// [send] completes without throwing — removes exactly those entries.
  /// Anything a concurrent [add] appends after this snapshot is taken is left
  /// untouched, because the whole read-send-remove cycle runs as one
  /// [_synchronized] step. Callers that deliver the queue over the network
  /// should use this instead of composing [readAll] + [removeDelivered]
  /// themselves, which is exactly the pattern that used to race.
  Future<R?> flush<R>(Future<R> Function(List<QueuedObservation> pending) send) {
    return _synchronized(() async {
      final pending = await _readAllLocked();
      if (pending.isEmpty) return null;
      final result = await send(pending);
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getStringList(_key) ?? <String>[];
      if (pending.length >= raw.length) {
        await prefs.remove(_key);
      } else {
        await prefs.setStringList(_key, raw.sublist(pending.length));
      }
      return result;
    });
  }

  Future<int> get length async {
    final prefs = await SharedPreferences.getInstance();
    return (prefs.getStringList(_key) ?? const []).length;
  }

  Future<void> clear() => _synchronized(() async {
        final prefs = await SharedPreferences.getInstance();
        await prefs.remove(_key);
      });
}
