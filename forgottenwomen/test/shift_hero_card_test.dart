// The phone shows the shared day view (backend attendance.buildDayView), the
// same figures the laptop widget and the HR dashboard show (2026-10-05).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:office_tracker/models/attendance.dart';
import 'package:office_tracker/theme.dart';
import 'package:office_tracker/widgets/home/shift_hero_card.dart';

// Abdullah's 5 Oct at 18:52: 436 worked + 23 break of a 480 shift.
Map<String, dynamic> _summaryJson({bool counting = true}) => {
      'employee': {'id': 'emp_x', 'name': 'Test'},
      'today': {
        'date': '2026-10-05',
        'status': 'IN_OFFICE',
        'firstIn': '10:55:19 AM',
        'workedMinutes': 436,
        'day': {
          'dateKey': '2026-10-05',
          'asOf': 1791205920000,
          'counting': counting,
          'checkIn': '10:55:19 AM',
          'lastSeen': '6:52:00 PM',
          'checkedOut': false,
          'shiftEndAt': 1791208800000,              // 19:00 PKT, 48 min after asOf
          'targetMinutes': 480,
          'breakMinutes': 23,
          'permittedBreakMinutes': 30,
          'idleMinutes': 13,
          'workedMinutes': 436,
          'progressMinutes': 459,
          'progressPercent': 96,
          'remainingMinutes': 21,
          'overtimeMinutes': 0,
        },
      },
      'workingHours': {
        'daily': {'requiredMinutes': 480, 'workedMinutes': 436, 'percent': 96},
      },
      'serverTimeMs': 1791205920000,
    };

Future<void> _pump(WidgetTester tester, Widget child) async {
  tester.view.physicalSize = const Size(360 * 3, 900 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(), home: Scaffold(body: SingleChildScrollView(child: child))));
  await tester.pump();
}

void main() {
  testWidgets('shows the server day view: worked, progress, remaining, break, idle', (tester) async {
    final summary = HomeSummary.fromJson(_summaryJson(), receivedAtMs: 1000);
    await _pump(
      tester,
      ShiftHeroCard(
        todayDetails: summary.todayDetails,
        liveNow: DateTime.fromMillisecondsSinceEpoch(1000),   // just arrived
        receivedAtMs: summary.receivedAtMs,
      ),
    );
    expect(find.text('7h 16m'), findsOneWidget);            // worked
    expect(find.text('of 8h 00m · 96%'), findsOneWidget);
    expect(find.text('0h 21m'), findsOneWidget);            // remaining
    expect(find.text('23m'), findsOneWidget);               // break
    expect(find.text('13m'), findsOneWidget);               // idle
    expect(find.text('10:55:19 AM'), findsOneWidget);       // first in
  });

  testWidgets('moves on only while counting, and never from a cached summary', (tester) async {
    // 5 minutes after a live response, while counting: +5 min.
    final live = HomeSummary.fromJson(_summaryJson(), receivedAtMs: 1000);
    await _pump(
      tester,
      ShiftHeroCard(
        todayDetails: live.todayDetails,
        liveNow: DateTime.fromMillisecondsSinceEpoch(1000 + 5 * 60000),
        receivedAtMs: live.receivedAtMs,
      ),
    );
    expect(find.text('7h 21m'), findsOneWidget);
    expect(find.text('0h 16m'), findsOneWidget);

    // The same summary from the offline cache (receivedAtMs 0): frozen.
    final cached = HomeSummary.fromJson(_summaryJson());
    await _pump(
      tester,
      ShiftHeroCard(
        todayDetails: cached.todayDetails,
        liveNow: DateTime.fromMillisecondsSinceEpoch(1000 + 5 * 60000),
        receivedAtMs: cached.receivedAtMs,
      ),
    );
    expect(find.text('7h 16m'), findsOneWidget);

    // Not counting (idle / break / after hours): frozen even when live.
    final idle = HomeSummary.fromJson(_summaryJson(counting: false), receivedAtMs: 1000);
    await _pump(
      tester,
      ShiftHeroCard(
        todayDetails: idle.todayDetails,
        liveNow: DateTime.fromMillisecondsSinceEpoch(1000 + 5 * 60000),
        receivedAtMs: idle.receivedAtMs,
      ),
    );
    expect(find.text('7h 16m'), findsOneWidget);
  });
}
