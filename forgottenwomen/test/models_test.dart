// Replaces the default counter-app scaffold test, which tested a widget this
// app never had and failed on every run.

import 'package:flutter_test/flutter_test.dart';
import 'package:office_tracker/models/attendance.dart';
import 'package:office_tracker/services/offline_queue.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  group('PresenceStatus', () {
    test('parses every status the server can send', () {
      expect(PresenceStatus.parse('IN_OFFICE'), PresenceStatus.inOffice);
      expect(PresenceStatus.parse('GRACE_PERIOD'), PresenceStatus.gracePeriod);
      expect(PresenceStatus.parse('AWAY'), PresenceStatus.away);
      expect(PresenceStatus.parse('CLOSED'), PresenceStatus.closed);
      expect(PresenceStatus.parse('NOT_CHECKED_IN'), PresenceStatus.notCheckedIn);
    });

    test('an unknown status degrades to not-checked-in rather than throwing', () {
      expect(PresenceStatus.parse('SOMETHING_NEW'), PresenceStatus.notCheckedIn);
      expect(PresenceStatus.parse(null), PresenceStatus.notCheckedIn);
    });

    test('grace period still counts as present', () {
      expect(PresenceStatus.inOffice.isPresent, isTrue);
      expect(PresenceStatus.gracePeriod.isPresent, isTrue);
      expect(PresenceStatus.away.isPresent, isFalse);
      expect(PresenceStatus.notCheckedIn.isPresent, isFalse);
    });
  });

  group('Attendance', () {
    test('parses a full server payload', () {
      final a = Attendance.fromJson({
        'employeeId': 'emp_abc',
        'employeeName': 'Abdullah Shahid',
        'role': 'Engineering',
        'date': '2026-08-27',
        'status': 'IN_OFFICE',
        'statusLabel': 'Active in Office',
        'firstCheckIn': '9:02:11 AM',
        'lastActiveTime': '1:20:00 PM',
        'totalMinutes': 258,
        'timeWorkedFormatted': '4h 18m',
        'adjustmentMinutes': 0,
        'needsReview': false,
        'sessions': [
          {'from': '9:02 AM', 'to': 'now', 'duration': '4h 18m', 'open': true},
        ],
      });

      expect(a.status, PresenceStatus.inOffice);
      expect(a.totalMinutes, 258);
      expect(a.sessions.single.open, isTrue);
      expect(a.sessions.single.to, 'now');
    });

    test('missing fields fall back instead of throwing', () {
      // The old app did data['employee']['status'] on raw maps, so any change
      // to the response shape was a runtime crash.
      final a = Attendance.fromJson({});
      expect(a.status, PresenceStatus.notCheckedIn);
      expect(a.totalMinutes, 0);
      expect(a.firstCheckIn, '--');
      expect(a.sessions, isEmpty);
    });
  });

  group('PingResult', () {
    test('an unverified ping is reported as unverified', () {
      final r = PingResult.fromJson({
        'accepted': 1,
        'duplicates': 0,
        'rejected': 0,
        'verified': false,
        'serverTime': '2:00:00 PM',
        'attendance': {'status': 'NOT_CHECKED_IN'},
      });
      // The old UI showed "IN OFFICE" whenever a request succeeded, regardless
      // of whether the server actually counted it.
      expect(r.verified, isFalse);
      expect(r.attendance.status, PresenceStatus.notCheckedIn);
    });
  });

  group('OfflineQueue', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('buffers observations so a failed upload loses nothing', () async {
      final q = OfflineQueue();
      await q.add(const QueuedObservation(observedAt: 1000, ssid: 'Office'));
      await q.add(const QueuedObservation(observedAt: 2000, ssid: 'Office'));

      final all = await q.readAll();
      expect(all.length, 2);
      expect(all.first.observedAt, 1000);
      expect(all.first.ssid, 'Office');
    });

    test('preserves original timestamps for replay', () async {
      final q = OfflineQueue();
      const original = 1756000000000;
      await q.add(const QueuedObservation(observedAt: original));
      // Replay must carry the time the sighting HAPPENED, not the time it was
      // finally delivered, or offline periods land on the wrong day.
      expect((await q.readAll()).single.observedAt, original);
    });

    test('drops the oldest entries when full rather than growing without limit', () async {
      final q = OfflineQueue();
      for (var i = 0; i < OfflineQueue.maxEntries + 25; i++) {
        await q.add(QueuedObservation(observedAt: i));
      }
      final all = await q.readAll();
      expect(all.length, OfflineQueue.maxEntries);
      expect(all.first.observedAt, 25, reason: 'oldest dropped, newest kept');
    });

    test('removes only the entries that were delivered', () async {
      final q = OfflineQueue();
      await q.add(const QueuedObservation(observedAt: 1));
      await q.add(const QueuedObservation(observedAt: 2));
      await q.add(const QueuedObservation(observedAt: 3));

      // Two uploaded; a third arrived while the request was in flight.
      await q.removeDelivered(2);

      final remaining = await q.readAll();
      expect(remaining.length, 1);
      expect(remaining.single.observedAt, 3);
    });
  });
}
