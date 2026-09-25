// Attendance history models: the shapes of GET /api/attendance/mine/days and
// GET /api/attendance/mine/day/:dateKey as backend/src/domain/history.js
// builds them, plus the month totals and the in-memory month cache. The
// fixtures here are reused by history_widgets_test.dart.

import 'package:flutter_test/flutter_test.dart';
import 'package:office_tracker/models/history.dart';

// --- fixtures (backend shapes) ------------------------------------------------

const employmentStart = '2026-08-12';

/// One DaySummary exactly as daysInRange() returns it.
Map<String, dynamic> dayJson(
  String dateKey,
  String status, {
  String? statusLabel,
  bool isToday = false,
  bool? isWorkingDay,
  String? nonWorkingReason,
  int workedMinutes = 0,
  String? firstIn,
  String? lastOut,
  int breakMinutes = 0,
  Map<String, dynamic>? deficit,
  Map<String, dynamic>? adjustment,
  Map<String, dynamic>? leave,
  Map<String, dynamic>? absence,
  Map<String, dynamic>? corrections,
  Map<String, dynamic>? laptop,
}) {
  final d = DateTime.parse(dateKey);
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  final weekend = d.weekday >= DateTime.saturday;
  final working = isWorkingDay ?? (!weekend && status != 'HOLIDAY');
  final h = workedMinutes ~/ 60, m = workedMinutes % 60;
  return {
    'dateKey': dateKey,
    'weekday': names[d.weekday - 1],
    'isToday': isToday,
    'status': status,
    'statusLabel': statusLabel ?? HistoryDayStatus.parse(status).fallbackLabel,
    'attendanceStatus': workedMinutes > 0 ? (status == 'LATE' ? 'LATE' : 'PRESENT') : null,
    'isWorkingDay': working,
    'dayType': status == 'HOLIDAY' ? 'PUBLIC_HOLIDAY' : (working ? 'WORKING' : 'REST_DAY'),
    'nonWorkingReason': working ? null : (nonWorkingReason ?? 'Rest day'),
    'scheduledStart': '11:00',
    'scheduledEnd': '19:00',
    'firstInAt': firstIn == null ? null : DateTime.parse('${dateKey}T06:00:00Z').millisecondsSinceEpoch,
    'firstIn': firstIn,
    'lastOutAt': lastOut == null ? null : DateTime.parse('${dateKey}T14:00:00Z').millisecondsSinceEpoch,
    'lastOut': lastOut,
    'workedMinutes': workedMinutes,
    'workedFormatted': h == 0 ? '$m mins' : '${h}h ${m}m',
    'breakMinutes': breakMinutes,
    'deficit': {
      'lateMinutes': 0,
      'excessBreakMinutes': 0,
      'earlyDepartureMinutes': 0,
      'unauthorisedMissingMinutes': 0,
      'approvedAdjustmentMinutes': 0,
      'totalMinutes': 0,
      ...?deficit,
    },
    'adjustment': adjustment,
    'leave': leave,
    'absence': absence,
    'corrections': corrections ?? {'pending': 0, 'total': 0},
    'laptop': laptop,
  };
}

Map<String, dynamic> annualLeave({String portion = 'FULL', String status = 'APPROVED'}) => {
      'requestId': 'lr_1',
      'type': 'Paid annual leave',
      'status': status,
      'dayPortion': portion,
      'isPaid': true,
    };

/// September 2026 up to Thursday 24th (today, in progress): every outcome.
Map<String, dynamic> septemberJson() {
  final days = <Map<String, dynamic>>[];
  for (var day = 1; day <= 24; day++) {
    final key = '2026-09-${day.toString().padLeft(2, '0')}';
    final weekday = DateTime(2026, 9, day).weekday;
    final weekend = weekday >= DateTime.saturday;
    switch (day) {
      case 2:
        days.add(dayJson(key, 'LATE', workedMinutes: 435, firstIn: '11:45:10 AM', lastOut: '7:00:00 PM',
            deficit: {'lateMinutes': 45, 'totalMinutes': 45}));
      case 3:
        days.add(dayJson(key, 'ABSENT'));
      case 4:
        days.add(dayJson(key, 'ON_LEAVE', statusLabel: 'Paid annual leave', leave: annualLeave()));
      case 5:
        // A leave request spanning the weekend reports the rest day as leave.
        days.add(dayJson(key, 'ON_LEAVE', statusLabel: 'Paid annual leave', leave: annualLeave()));
      case 7:
        days.add(dayJson(key, 'SHORT', workedMinutes: 400, firstIn: '11:00:00 AM', lastOut: '6:00:00 PM',
            deficit: {'earlyDepartureMinutes': 60, 'totalMinutes': 60}));
      case 8:
        days.add(dayJson(key, 'HOLIDAY', statusLabel: 'Defence Day', nonWorkingReason: 'Defence Day'));
      case 9:
        days.add(dayJson(key, 'ON_TIME', workedMinutes: 480, firstIn: '10:58:00 AM', lastOut: '7:01:00 PM',
            corrections: {'pending': 1, 'total': 1}));
      case 10:
        days.add(dayJson(key, 'ON_LEAVE', statusLabel: 'Paid annual leave (half day)', workedMinutes: 240,
            leave: annualLeave(portion: 'FIRST_HALF')));
      case 12:
        days.add(dayJson(key, 'REST_DAY_WORKED', workedMinutes: 120));
      case 24:
        days.add(dayJson(key, 'IN_PROGRESS', isToday: true, workedMinutes: 190, firstIn: '11:02:00 AM'));
      default:
        days.add(weekend
            ? dayJson(key, 'REST_DAY')
            : dayJson(key, 'ON_TIME', workedMinutes: 480, firstIn: '11:00:00 AM', lastOut: '7:00:00 PM'));
    }
  }
  return {
    'status': 'SUCCESS',
    'from': '2026-09-01',
    'to': '2026-09-24',
    'employmentStart': employmentStart,
    'days': days,
  };
}

/// August 2026: employment starts on the 12th.
Map<String, dynamic> augustJson() {
  final days = <Map<String, dynamic>>[];
  for (var day = 1; day <= 31; day++) {
    final key = '2026-08-${day.toString().padLeft(2, '0')}';
    final weekend = DateTime(2026, 8, day).weekday >= DateTime.saturday;
    if (day < 12) {
      days.add(dayJson(key, 'NOT_EMPLOYED'));
    } else {
      days.add(weekend
          ? dayJson(key, 'REST_DAY')
          : dayJson(key, 'ON_TIME', workedMinutes: 480, firstIn: '11:00:00 AM', lastOut: '7:00:00 PM'));
    }
  }
  return {'status': 'SUCCESS', 'from': '2026-08-01', 'to': '2026-08-31', 'employmentStart': employmentStart, 'days': days};
}

/// A month wholly before employment.
Map<String, dynamic> julyJson() => {
      'status': 'SUCCESS',
      'from': '2026-07-01',
      'to': '2026-07-31',
      'employmentStart': employmentStart,
      'days': [
        for (var day = 1; day <= 31; day++) dayJson('2026-07-${day.toString().padLeft(2, '0')}', 'NOT_EMPLOYED'),
      ],
    };

/// dayDetail() for Wednesday 2 September: late, two sessions, a break that
/// ran over, an approved and a pending correction, laptop time.
Map<String, dynamic> lateDayDetailJson() {
  final base = dayJson('2026-09-02', 'LATE',
      workedMinutes: 380,
      firstIn: '11:45:10 AM',
      lastOut: '7:00:00 PM',
      breakMinutes: 42,
      deficit: {
        'lateMinutes': 45,
        'excessBreakMinutes': 12,
        'earlyDepartureMinutes': 0,
        'unauthorisedMissingMinutes': 20,
        'approvedAdjustmentMinutes': -10,
        'totalMinutes': 67,
      },
      adjustment: {'minutes': 10, 'note': 'Client call off-site'},
      corrections: {'pending': 1, 'total': 2},
      laptop: {'activeMinutes': 300, 'idleMinutes': 25});
  final t0 = DateTime.utc(2026, 9, 2, 6, 45).millisecondsSinceEpoch;
  return {
    'employee': {'id': 'emp_1', 'name': 'History Subject', 'role': 'Analyst'},
    'employmentStart': employmentStart,
    ...base,
    'sessions': [
      {'startAt': t0, 'endAt': t0 + 135 * 60000, 'start': '11:45:10 AM', 'end': '2:00:10 PM', 'minutes': 135, 'duration': '2h 15m'},
      {'startAt': t0 + 160 * 60000, 'endAt': t0 + 405 * 60000, 'start': '2:25:10 PM', 'end': '6:30:10 PM', 'minutes': 245, 'duration': '4h 5m'},
    ],
    'breaks': [
      {'startedAt': t0 + 60 * 60000, 'endedAt': t0 + 102 * 60000, 'start': '12:45:10 PM', 'end': '1:27:10 PM',
        'permittedMinutes': 30, 'actualMinutes': 42, 'excessMinutes': 12},
      {'startedAt': t0 + 300 * 60000, 'endedAt': null, 'start': '4:45:10 PM', 'end': null,
        'permittedMinutes': 30, 'actualMinutes': null, 'excessMinutes': 0},
    ],
    'correctionRequests': [
      {'id': 'corr_a', 'requestedAt': DateTime.utc(2026, 9, 3, 8).millisecondsSinceEpoch,
        'requestedChange': {'adjustmentMinutes': 10}, 'reason': '[Off-site Business Meeting] Client call',
        'status': 'APPROVED', 'reviewedAt': DateTime.utc(2026, 9, 4, 9).millisecondsSinceEpoch,
        'reviewNotes': 'Confirmed with line manager.'},
      {'id': 'corr_b', 'requestedAt': DateTime.utc(2026, 9, 5, 8).millisecondsSinceEpoch,
        'requestedChange': '{"adjustmentMinutes":20}', 'reason': '[Wi-Fi / Network Disconnection] Router down',
        'status': 'PENDING', 'reviewedAt': null, 'reviewNotes': null},
    ],
    'laptopSessions': [
      {'deviceId': 'dev_1', 'device': 'ThinkPad X1', 'activeMinutes': 300, 'idleMinutes': 25, 'breakMinutes': 40,
        'unverifiedMinutes': 5, 'firstSeen': '11:50:00 AM', 'lastSeen': '6:28:00 PM'},
    ],
  };
}

void main() {
  group('DaySummary parsing', () {
    test('reads every field the backend sends', () {
      final d = DaySummary.fromJson(dayJson('2026-09-10', 'ON_LEAVE',
          statusLabel: 'Paid annual leave (half day)',
          workedMinutes: 240,
          firstIn: '11:00:00 AM',
          lastOut: '3:00:00 PM',
          breakMinutes: 15,
          leave: annualLeave(portion: 'FIRST_HALF'),
          absence: {'status': 'AUTHORISED', 'type': 'SICK', 'treatAsUnpaid': 1},
          adjustment: {'minutes': 15, 'note': 'Late train'},
          corrections: {'pending': 1, 'total': 3},
          laptop: {'activeMinutes': 200, 'idleMinutes': 10}));
      expect(d.dateKey, '2026-09-10');
      expect(d.weekday, 'Thu');
      expect(d.status, HistoryDayStatus.onLeave);
      expect(d.statusLabel, 'Paid annual leave (half day)');
      expect(d.isWorkingDay, isTrue);
      expect(d.scheduledStart, '11:00');
      expect(d.scheduledEnd, '19:00');
      expect(d.firstIn, '11:00:00 AM');
      expect(d.firstInAt, isNotNull);
      expect(d.lastOut, '3:00:00 PM');
      expect(d.workedMinutes, 240);
      expect(d.workedFormatted, '4h 0m');
      expect(d.breakMinutes, 15);
      expect(d.leave!.type, 'Paid annual leave');
      expect(d.leave!.isApproved, isTrue);
      expect(d.leave!.isPartDay, isTrue);
      expect(d.leave!.isPaid, isTrue);
      expect(d.absence!.type, 'SICK');
      expect(d.absence!.treatAsUnpaid, isTrue);
      expect(d.adjustment!.minutes, 15);
      expect(d.adjustment!.note, 'Late train');
      expect(d.corrections.pending, 1);
      expect(d.corrections.total, 3);
      expect(d.laptop!.activeMinutes, 200);
      expect(d.wasPresent, isTrue);
    });

    test('is tolerant of missing, null and oddly typed fields', () {
      final d = DaySummary.fromJson({
        'dateKey': '2026-09-02',
        'status': 'late',
        'workedMinutes': '95',
        'isWorkingDay': 1,
        'deficit': {'lateMinutes': 12.6, 'approvedAdjustmentMinutes': -5, 'totalMinutes': null},
        'leave': 'not a map',
        'corrections': null,
      });
      expect(d.status, HistoryDayStatus.late);
      expect(d.statusLabel, 'Late', reason: 'falls back when statusLabel is missing');
      expect(d.workedMinutes, 95);
      expect(d.workedFormatted, '1h 35m');
      expect(d.isWorkingDay, isTrue);
      expect(d.deficit.lateMinutes, 13);
      expect(d.deficit.approvedAdjustmentMinutes, 5, reason: 'shown as a positive credit');
      expect(d.deficit.totalMinutes, 0);
      expect(d.leave, isNull);
      expect(d.absence, isNull);
      expect(d.laptop, isNull);
      expect(d.corrections.total, 0);
      expect(d.firstIn, isNull);

      expect(DaySummary.fromJson({'dateKey': '2026-09-02', 'status': 'SOMETHING_NEW'}).status, HistoryDayStatus.unknown);
      expect(DaySummary.fromJson(const {}).status, HistoryDayStatus.unknown);
    });

    test('every backend status maps to its own value', () {
      const wire = ['NOT_EMPLOYED', 'ON_LEAVE', 'HOLIDAY', 'REST_DAY', 'REST_DAY_WORKED', 'IN_PROGRESS',
        'NOT_STARTED', 'ABSENT', 'LATE', 'SHORT', 'ON_TIME'];
      final parsed = wire.map(HistoryDayStatus.parse).toSet();
      expect(parsed.length, wire.length);
      expect(parsed.contains(HistoryDayStatus.unknown), isFalse);
    });
  });

  group('HistoryRange parsing', () {
    test('a month: days oldest first, employmentStart kept', () {
      final r = HistoryRange.fromJson(septemberJson());
      expect(r.from, '2026-09-01');
      expect(r.to, '2026-09-24');
      expect(r.employmentStart, employmentStart);
      expect(r.days.length, 24);
      expect(r.days.first.dateKey, '2026-09-01');
      expect(r.days.last.isToday, isTrue);
      expect(r.byDate['2026-09-08']!.status, HistoryDayStatus.holiday);
    });

    test('drops rows with no usable date, sorts, and allows a null start date', () {
      final r = HistoryRange.fromJson({
        'from': '2026-09-01',
        'to': '2026-09-03',
        'employmentStart': null,
        'days': [
          dayJson('2026-09-03', 'ABSENT'),
          {'status': 'ON_TIME'},
          'junk',
          dayJson('2026-09-01', 'ON_TIME', workedMinutes: 480),
        ],
      });
      expect(r.employmentStart, isNull);
      expect(r.days.map((d) => d.dateKey), ['2026-09-01', '2026-09-03']);
      expect(HistoryRange.fromJson(const {}).days, isEmpty);
    });
  });

  group('DayDetail parsing', () {
    test('summary plus sessions, breaks, corrections and laptop sessions', () {
      final d = DayDetail.fromJson(lateDayDetailJson());
      expect(d.summary.status, HistoryDayStatus.late);
      expect(d.summary.deficit.totalMinutes, 67);
      expect(d.employee.name, 'History Subject');
      expect(d.employmentStart, employmentStart);

      expect(d.sessions.length, 2);
      expect(d.sessions.first.start, '11:45:10 AM');
      expect(d.sessions.first.minutes, 135);
      expect(d.sessions.first.isOpen, isFalse);

      expect(d.breaks.first.isOver, isTrue);
      expect(d.breaks.first.excessMinutes, 12);
      expect(d.breaks.last.isOpen, isTrue);
      expect(d.breaks.last.actualMinutes, isNull);

      expect(d.correctionRequests.first.isApproved, isTrue);
      expect(d.correctionRequests.first.reviewNotes, 'Confirmed with line manager.');
      expect(d.correctionRequests.first.requestedAdjustmentMinutes, 10);
      expect(d.correctionRequests.last.isPending, isTrue);
      expect(d.correctionRequests.last.requestedAdjustmentMinutes, 20, reason: 'JSON text is decoded');

      expect(d.laptopSessions.single.device, 'ThinkPad X1');
      expect(d.laptopSessions.single.unverifiedMinutes, 5);
    });

    test("today's open session ends 'now'; malformed lists are ignored", () {
      final d = DayDetail.fromJson({
        ...dayJson('2026-09-24', 'IN_PROGRESS', isToday: true, workedMinutes: 30),
        'sessions': [
          {'startAt': 1, 'endAt': null, 'start': '11:00:00 AM', 'end': 'now', 'minutes': 30, 'duration': '30 mins'},
        ],
        'breaks': 'nope',
        'correctionRequests': [
          {'id': 'x', 'requestedChange': 'not json', 'status': 'pending'},
        ],
      });
      expect(d.sessions.single.isOpen, isTrue);
      expect(d.breaks, isEmpty);
      expect(d.correctionRequests.single.requestedChange, isEmpty);
      expect(d.correctionRequests.single.isPending, isTrue);
      expect(d.laptopSessions, isEmpty);
    });
  });

  group('MonthTotals', () {
    test('counts each outcome, leave on working days only, and sums minutes', () {
      final days = HistoryRange.fromJson(septemberJson()).days;
      final t = MonthTotals.fromDays(days);
      // On time: weekdays 1, 9, 11, 14-18, 21-23 = 11.
      expect(t.onTime, 11);
      expect(t.late, 1);
      expect(t.short, 1);
      expect(t.absent, 1);
      // 4th (full) + 10th (half); the Saturday 5th is inside the request
      // but not a working day.
      expect(t.leaveDays, 1.5);
      // Present: 11 on time + late + short + half-day 10th + rest day worked + today.
      expect(t.daysPresent, 16);
      expect(t.workedMinutes, 11 * 480 + 435 + 400 + 240 + 120 + 190);
      expect(t.deficitMinutes, 105);
    });

    test('days before employment are left out', () {
      final t = MonthTotals.fromDays(HistoryRange.fromJson(augustJson()).days);
      expect(t.onTime, 14);
      expect(t.absent, 0);
      expect(t.daysPresent, 14);
      expect(MonthTotals.fromDays(const []).workedMinutes, 0);
      expect(MonthTotals.fromDays(HistoryRange.fromJson(julyJson()).days).daysPresent, 0);
    });
  });

  group('dates and formatting', () {
    test('date keys round-trip and reject impossible dates', () {
      expect(historyDateKey(DateTime(2026, 9, 1)), '2026-09-01');
      expect(parseDateKey('2026-09-01'), DateTime(2026, 9, 1));
      expect(parseDateKey('2026-02-30'), isNull);
      expect(parseDateKey('2026-9-1'), isNull);
      expect(parseDateKey(null), isNull);
    });

    test('month arithmetic', () {
      expect(lastDayOfMonth(DateTime(2026, 2)).day, 28);
      expect(lastDayOfMonth(DateTime(2028, 2)).day, 29);
      expect(monthsBetween(DateTime(2025, 11), DateTime(2026, 2)), 3);
      expect(monthOf(DateTime(2026, 9, 24, 14)), DateTime(2026, 9));
      expect(formatMonthTitle(DateTime(2026, 9)), 'September 2026');
      expect(formatLongDate(DateTime(2026, 9, 2)), 'Wednesday 2 September 2026');
      expect(formatShortDate(DateTime(2026, 9, 2)), '2 Sep 2026');
    });

    test('minutes and clock text', () {
      expect(formatHistoryMinutes(0), '0 min');
      expect(formatHistoryMinutes(45), '45 min');
      expect(formatHistoryMinutes(485), '8h 05m');
      expect(formatHistoryMinutes(-90), '-1h 30m');
      expect(shortClock('11:02:15 AM'), '11:02 AM');
      expect(shortClock('7:00:00 PM'), '7:00 PM');
      expect(shortClock('14:05:09'), '14:05');
      expect(shortClock('now'), 'now');
      expect(shortClock(null), '--:--');
    });
  });

  group('HistoryMonthCache', () {
    final sept = HistoryRange.fromJson(septemberJson());
    final aug = HistoryRange.fromJson(augustJson());

    test('past months are kept for the session', () {
      final c = HistoryMonthCache();
      final at = DateTime(2026, 9, 24, 9);
      c.put('dev', DateTime(2026, 8), aug, at);
      expect(c.get('dev', DateTime(2026, 8), at.add(const Duration(hours: 6))), same(aug));
    });

    test("the current month goes stale after two minutes, but is still there to show", () {
      final c = HistoryMonthCache();
      final at = DateTime(2026, 9, 24, 9);
      c.put('dev', DateTime(2026, 9), sept, at);
      expect(c.get('dev', DateTime(2026, 9), at.add(const Duration(seconds: 90))), same(sept));
      expect(c.get('dev', DateTime(2026, 9), at.add(const Duration(minutes: 3))), isNull);
      expect(c.getStale('dev', DateTime(2026, 9)), same(sept));
      expect(c.fetchedAt('dev', DateTime(2026, 9)), at);
    });

    test('keyed by device, and can be invalidated', () {
      final c = HistoryMonthCache();
      final at = DateTime(2026, 9, 24, 9);
      c.put('dev', DateTime(2026, 8), aug, at);
      expect(c.get('other', DateTime(2026, 8), at), isNull);
      expect(c.employmentStart('dev'), employmentStart);
      expect(c.employmentStart('other'), isNull);
      c.invalidate('dev', DateTime(2026, 8));
      expect(c.getStale('dev', DateTime(2026, 8)), isNull);
    });
  });
}
