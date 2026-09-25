import 'package:flutter_test/flutter_test.dart';
import 'package:office_tracker/services/presence_service.dart';

// The presence service runs from 30 minutes before the scheduled start until
// 60 minutes after the scheduled end (presence_service.dart), so an early
// arrival and a late finish are both recorded. With the default 11:00-19:00
// shift that is 10:30 up to (not including) 20:00.
void main() {
  group('isWithinOfficeHours, default Mon-Fri 11:00-19:00 shift', () {
    test('Monday before the 10:30 buffer returns false', () {
      // 2026-09-07 is a Monday
      final dt = DateTime(2026, 9, 7, 10, 29);
      expect(isWithinOfficeHours(dt), isFalse);
    });

    test('Monday at 10:30, inside the early buffer, returns true', () {
      final dt = DateTime(2026, 9, 7, 10, 30);
      expect(isWithinOfficeHours(dt), isTrue);
    });

    test('Monday at 11:00 AM returns true', () {
      final dt = DateTime(2026, 9, 7, 11, 0);
      expect(isWithinOfficeHours(dt), isTrue);
    });

    test('Wednesday midday (14:30 / 2:30 PM) returns true', () {
      // 2026-09-09 is a Wednesday
      final dt = DateTime(2026, 9, 9, 14, 30);
      expect(isWithinOfficeHours(dt), isTrue);
    });

    test('Friday at 19:30, inside the late buffer, returns true', () {
      // 2026-09-11 is a Friday
      final dt = DateTime(2026, 9, 11, 19, 30);
      expect(isWithinOfficeHours(dt), isTrue);
    });

    test('Friday at 20:00, the end of the buffer, returns false', () {
      final dt = DateTime(2026, 9, 11, 20, 0);
      expect(isWithinOfficeHours(dt), isFalse);
    });

    test('Saturday during midday returns false', () {
      // 2026-09-12 is a Saturday
      final dt = DateTime(2026, 9, 12, 13, 0);
      expect(isWithinOfficeHours(dt), isFalse);
    });

    test('Sunday during midday returns false', () {
      // 2026-09-13 is a Sunday
      final dt = DateTime(2026, 9, 13, 14, 0);
      expect(isWithinOfficeHours(dt), isFalse);
    });
  });

  group('isWithinOfficeHours, an assigned shift', () {
    test('uses the employee\'s own times and working days', () {
      // Evening shift 12:00-20:00, Tue-Sat: window 11:30 to 21:00.
      const days = 'tue,wed,thu,fri,sat';
      expect(isWithinOfficeHours(DateTime(2026, 9, 12, 20, 59), '12:00', '20:00', days), isTrue);
      expect(isWithinOfficeHours(DateTime(2026, 9, 12, 21, 0), '12:00', '20:00', days), isFalse);
      expect(isWithinOfficeHours(DateTime(2026, 9, 8, 11, 29), '12:00', '20:00', days), isFalse);
      expect(isWithinOfficeHours(DateTime(2026, 9, 7, 14, 0), '12:00', '20:00', days), isFalse, reason: 'Monday is a rest day');
    });
  });
}
