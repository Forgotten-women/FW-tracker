import 'package:flutter_test/flutter_test.dart';
import 'package:office_tracker/services/presence_service.dart';

void main() {
  group('isWithinOfficeHours Tests (Mon-Fri 11:00 AM - 7:00 PM)', () {
    test('Monday before 11:00 AM returns false', () {
      // 2026-09-07 is a Monday
      final dt = DateTime(2026, 9, 7, 10, 59);
      expect(isWithinOfficeHours(dt), isFalse);
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

    test('Friday at 18:59 (6:59 PM) returns true', () {
      // 2026-09-11 is a Friday
      final dt = DateTime(2026, 9, 11, 18, 59);
      expect(isWithinOfficeHours(dt), isTrue);
    });

    test('Friday at 19:00 (7:00 PM) returns false', () {
      final dt = DateTime(2026, 9, 11, 19, 0);
      expect(isWithinOfficeHours(dt), isFalse);
    });

    test('Friday after 7:00 PM returns false', () {
      final dt = DateTime(2026, 9, 11, 20, 15);
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
}
