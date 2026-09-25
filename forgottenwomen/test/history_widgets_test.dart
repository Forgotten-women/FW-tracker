// Attendance history UI at phone width (360 dp), in both palettes and with a
// large text scale: any RenderFlex overflow fails the test. Data is the
// backend's shapes (history_models_test.dart); HTTP is a MockClient, so
// nothing leaves the machine.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:office_tracker/models/attendance.dart';
import 'package:office_tracker/models/history.dart';
import 'package:office_tracker/screens/history_day_screen.dart';
import 'package:office_tracker/screens/history_screen.dart';
import 'package:office_tracker/services/api_client.dart';
import 'package:office_tracker/services/token_store.dart';
import 'package:office_tracker/theme.dart';
import 'package:office_tracker/widgets/home/attendance_timeline_card.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'history_models_test.dart' as fixtures;

class FakeHistoryStore extends TokenStore {
  @override
  Future<String?> readToken() async => 'test-token';

  @override
  Future<String> readServerUrl() async => 'https://history.test';

  @override
  Future<String?> readDeviceId() async => 'dev_test';
}

// google_fonts fetches over HTTP; requests that never complete keep the
// fallback font and raise no error (as in payroll_widgets_test.dart).
class _NoNetworkOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) => _NeverRespondingHttpClient();
}

class _NeverRespondingHttpClient implements HttpClient {
  @override
  dynamic noSuchMethod(Invocation invocation) => Completer<Never>().future;
}

DateTime historyTestClock() => DateTime(2026, 9, 24, 14);

/// Serves the fixtures by path; every request is logged.
class FakeHistoryBackend {
  final requests = <Uri>[];
  bool offline = false;

  late final ApiClient api = ApiClient(
    store: FakeHistoryStore(),
    client: MockClient((req) async {
      requests.add(req.url);
      if (offline) throw http.ClientException('Network is unreachable');
      final path = req.url.path;
      if (path == '/api/attendance/mine/days') {
        final month = (req.url.queryParameters['from'] ?? '').substring(0, 7);
        final body = switch (month) {
          '2026-09' => fixtures.septemberJson(),
          '2026-08' => fixtures.augustJson(),
          '2026-07' => fixtures.julyJson(),
          _ => {'status': 'ERROR', 'message': 'unexpected month $month'},
        };
        return http.Response(jsonEncode(body), body['status'] == 'ERROR' ? 400 : 200);
      }
      if (path == '/api/attendance/mine/day/2026-09-02') {
        return http.Response(jsonEncode({'status': 'SUCCESS', 'day': fixtures.lateDayDetailJson()}), 200);
      }
      if (path.startsWith('/api/attendance/mine/day/')) {
        final key = path.split('/').last;
        final day = (fixtures.septemberJson()['days'] as List).cast<Map<String, dynamic>>().firstWhere(
              (d) => d['dateKey'] == key,
              orElse: () => fixtures.dayJson(key, 'ABSENT'),
            );
        return http.Response(
          jsonEncode({
            'status': 'SUCCESS',
            'day': {...day, 'sessions': [], 'breaks': [], 'correctionRequests': [], 'laptopSessions': []},
          }),
          200,
        );
      }
      return http.Response(jsonEncode({'status': 'ERROR', 'message': 'Not found'}), 404);
    }),
  );

  int get monthRequests => requests.where((u) => u.path == '/api/attendance/mine/days').length;
}

Future<void> _pumpAt360(
  WidgetTester tester,
  Widget child, {
  double height = 800,
  double textScale = 1.0,
}) async {
  tester.view.physicalSize = Size(360 * 3, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: buildTheme(),
    builder: (context, c) => MediaQuery(
      data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
      child: c!,
    ),
    home: child,
  ));
  await tester.pump();
}

void main() {
  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    HttpOverrides.global = _NoNetworkOverrides();
  });
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    HistoryScreen.clearCache();
  });

  for (final brightness in Brightness.values) {
    for (final textScale in [1.0, 1.6]) {
      group('${brightness.name} mode, text x$textScale', () {
        setUp(() => AppColors.palette = AppPalette.build(brightness, AccentChoice.indigo));

        testWidgets('month grid, totals and key lay out at 360 dp', (tester) async {
          final backend = FakeHistoryBackend();
          addTearDown(backend.api.dispose);
          await _pumpAt360(
            tester,
            HistoryScreen(api: backend.api, store: FakeHistoryStore(), clock: historyTestClock),
            height: 2400,
            textScale: textScale,
          );
          await tester.pumpAndSettle();

          expect(find.text('September 2026'), findsOneWidget);
          expect(find.text('This month'), findsOneWidget);
          // Every date of the month has a cell, future ones included.
          for (final d in ['1', '24', '30']) {
            expect(find.text(d), findsWidgets);
          }
          expect(find.text('Month totals'.toUpperCase()), findsOneWidget);
          expect(find.text('Days present'), findsOneWidget);
          expect(find.bySemanticsLabel('Days present: 16'), findsOneWidget);
          expect(find.bySemanticsLabel('Leave days: 1.5'), findsOneWidget);
          expect(find.bySemanticsLabel('Total deficit: 1h 45m'), findsOneWidget);
          expect(find.text('Short of hours'), findsWidgets);
          expect(find.text('Not employed'), findsOneWidget, reason: 'the key');
        });

        testWidgets('day detail lays out at 360 dp', (tester) async {
          final backend = FakeHistoryBackend();
          addTearDown(backend.api.dispose);
          await _pumpAt360(
            tester,
            HistoryDayScreen(dateKey: '2026-09-02', api: backend.api),
            // Tall enough for the lazy list to build every section.
            height: 3200 * textScale,
            textScale: textScale,
          );
          await tester.pumpAndSettle();

          expect(find.text('Wednesday 2 September 2026'), findsOneWidget);
          expect(find.text('Late'), findsOneWidget);
          expect(find.text('11:45 AM'), findsWidgets);
          expect(find.text('Arrived late'), findsOneWidget);
          expect(find.text('Break ran over the allowance'), findsOneWidget);
          expect(find.text('Time not accounted for'), findsOneWidget);
          expect(find.text('Approved adjustment (credited back)'), findsOneWidget);
          expect(find.text('-10 min'), findsOneWidget);
          expect(find.text('1h 07m'), findsOneWidget, reason: 'the day total');
          expect(find.text('Away 25 min'), findsOneWidget);
          expect(find.text('+12 min over'), findsOneWidget);
          expect(find.text('Confirmed with line manager.'), findsOneWidget);
          expect(find.text('APPROVED'), findsOneWidget);
          expect(find.text('PENDING'), findsOneWidget);
          expect(find.text('Asked for an adjustment of 20 min'), findsOneWidget);
          expect(find.text('ThinkPad X1'), findsOneWidget);
          expect(find.text('Request a correction for this day'), findsOneWidget);
        });
      });
    }
  }

  group('month view behaviour', () {
    setUp(() => AppColors.palette = AppPalette.build(Brightness.dark, AccentChoice.indigo));

    testWidgets('calendar cells carry semantic labels', (tester) async {
      final handle = tester.ensureSemantics();
      final backend = FakeHistoryBackend();
      addTearDown(backend.api.dispose);
      await _pumpAt360(tester, HistoryScreen(api: backend.api, store: FakeHistoryStore(), clock: historyTestClock), height: 2000);
      await tester.pumpAndSettle();

      expect(find.bySemanticsLabel(RegExp(r'^Wednesday 2 September 2026, Late, worked 7h 15m, deficit 45 min$')),
          findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^Wednesday 9 September 2026, On time, .*correction pending$')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^Thursday 24 September 2026, today, Today, in progress')), findsOneWidget);
      expect(find.bySemanticsLabel('Friday 25 September 2026, not yet'), findsOneWidget);
      handle.dispose();
    });

    testWidgets('pages back to the employment start month, never past it or the current month, and caches',
        (tester) async {
      final backend = FakeHistoryBackend();
      addTearDown(backend.api.dispose);
      await _pumpAt360(tester, HistoryScreen(api: backend.api, store: FakeHistoryStore(), clock: historyTestClock), height: 2000);
      await tester.pumpAndSettle();
      expect(backend.monthRequests, 1);

      IconButton button(String tooltip) =>
          tester.widget<IconButton>(find.ancestor(of: find.byTooltip(tooltip), matching: find.byType(IconButton)));
      expect(button('Next month').onPressed, isNull, reason: 'never past the current month');

      await tester.tap(find.byTooltip('Previous month'));
      await tester.pumpAndSettle();
      expect(find.text('August 2026'), findsOneWidget);
      expect(find.textContaining('Your employment started on 12 Aug 2026'), findsOneWidget);
      expect(button('Previous month').onPressed, isNull, reason: 'never before the employment start month');
      expect(backend.monthRequests, 2);

      await tester.tap(find.byTooltip('Next month'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Previous month'));
      await tester.pumpAndSettle();
      expect(find.text('August 2026'), findsOneWidget);
      expect(backend.monthRequests, 2, reason: 'both months come from the session cache');
    });

    testWidgets('the jump sheet offers only months in range and moves there', (tester) async {
      final backend = FakeHistoryBackend();
      addTearDown(backend.api.dispose);
      await _pumpAt360(tester, HistoryScreen(api: backend.api, store: FakeHistoryStore(), clock: historyTestClock), height: 1600);
      await tester.pumpAndSettle();

      await tester.tap(find.text('September 2026'));
      await tester.pumpAndSettle();
      expect(find.text('Jump to a month'), findsOneWidget);
      expect(find.text('Go to a specific date'), findsOneWidget);
      await tester.tap(find.text('Jul'));
      await tester.pumpAndSettle();
      expect(find.text('Jump to a month'), findsOneWidget, reason: 'July is before employment: disabled');
      await tester.tap(find.text('Aug'));
      await tester.pumpAndSettle();
      expect(find.text('August 2026'), findsOneWidget);
    });

    testWidgets('tapping a day opens its detail', (tester) async {
      final backend = FakeHistoryBackend();
      addTearDown(backend.api.dispose);
      await _pumpAt360(tester, HistoryScreen(api: backend.api, store: FakeHistoryStore(), clock: historyTestClock), height: 1600);
      await tester.pumpAndSettle();

      await tester.tap(find.bySemanticsLabel(RegExp(r'^Wednesday 2 September 2026')));
      await tester.pumpAndSettle();
      expect(find.text('Wednesday 2 September 2026'), findsOneWidget);
      expect(backend.requests.last.path, '/api/attendance/mine/day/2026-09-02');
      expect(find.text('Arrived late'), findsOneWidget);
    });

    testWidgets('a month wholly before employment says so', (tester) async {
      final backend = FakeHistoryBackend();
      addTearDown(backend.api.dispose);
      await _pumpAt360(
        tester,
        HistoryScreen(api: backend.api, store: FakeHistoryStore(), clock: historyTestClock, initialMonth: DateTime(2026, 7)),
      );
      await tester.pumpAndSettle();
      expect(find.text('Before your employment started'), findsOneWidget);
      expect(find.text('Your records start on 12 Aug 2026.'), findsOneWidget);
      await tester.tap(find.text('Go to August 2026'));
      await tester.pumpAndSettle();
      expect(find.text('August 2026'), findsOneWidget);
    });

    testWidgets('offline with nothing loaded: a retry state that recovers', (tester) async {
      final backend = FakeHistoryBackend()..offline = true;
      addTearDown(backend.api.dispose);
      await _pumpAt360(tester, HistoryScreen(api: backend.api, store: FakeHistoryStore(), clock: historyTestClock));
      // ApiClient retries a network failure once, two seconds later.
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(find.text("You're offline"), findsOneWidget);

      backend.offline = false;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text("You're offline"), findsNothing);
      expect(find.text('Days present'), findsOneWidget);
    });

    testWidgets('a failed refresh keeps the loaded month, with a banner', (tester) async {
      final backend = FakeHistoryBackend();
      addTearDown(backend.api.dispose);
      await _pumpAt360(tester, HistoryScreen(api: backend.api, store: FakeHistoryStore(), clock: historyTestClock), height: 1600);
      await tester.pumpAndSettle();

      backend.offline = true;
      await tester.tap(find.byTooltip('Refresh'));
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(find.textContaining("You're offline. Showing this month as loaded"), findsOneWidget);
      expect(find.text('Days present'), findsOneWidget);
    });
  });

  group('day view behaviour', () {
    setUp(() => AppColors.palette = AppPalette.build(Brightness.light, AccentChoice.indigo));

    testWidgets('the correction action opens the dispute form for that date', (tester) async {
      final backend = FakeHistoryBackend();
      addTearDown(backend.api.dispose);
      await _pumpAt360(tester, HistoryDayScreen(dateKey: '2026-09-02', api: backend.api), height: 3200);
      await tester.pumpAndSettle();

      await tester.tap(find.text('Request a correction for this day'));
      await tester.pumpAndSettle();
      expect(find.text('File Attendance Dispute'), findsOneWidget);
      expect(find.text('2026-09-02'), findsOneWidget);
    });

    testWidgets('offline: the summary from the month stays, the timeline says it needs a connection',
        (tester) async {
      final backend = FakeHistoryBackend()..offline = true;
      addTearDown(backend.api.dispose);
      final summary = (fixtures.septemberJson()['days'] as List)[1] as Map<String, dynamic>;
      await _pumpAt360(
        tester,
        HistoryDayScreen(
          dateKey: '2026-09-02',
          api: backend.api,
          initial: DaySummary.fromJson(summary),
        ),
        height: 2000,
      );
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(find.textContaining("You're offline. Showing this day's summary"), findsOneWidget);
      expect(find.text('Late'), findsOneWidget);
      expect(find.text('Not available until the full record loads.'), findsWidgets);
    });

    testWidgets('offline with no summary: a retry state', (tester) async {
      final backend = FakeHistoryBackend()..offline = true;
      addTearDown(backend.api.dispose);
      await _pumpAt360(tester, HistoryDayScreen(dateKey: '2026-09-02', api: backend.api));
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(find.text("You're offline"), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });
  });

  testWidgets('the recent-days card offers the full history', (tester) async {
    AppColors.palette = AppPalette.build(Brightness.dark, AccentChoice.indigo);
    var opened = 0;
    String? tapped;
    await _pumpAt360(
      tester,
      Scaffold(
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: AttendanceTimelineCard(
            history: [Attendance.fromJson({'date': '2026-09-23', 'totalMinutes': 480, 'status': 'CLOSED'})],
            disputesByDate: const {},
            onDayTapped: (d) => tapped = d.date,
            onDisputeDay: () {},
            onSeeFullHistory: () => opened++,
          ),
        ),
      ),
    );
    await tester.tap(find.text('See full history'));
    expect(opened, 1);
    await tester.tap(find.text('23'));
    expect(tapped, '2026-09-23');
  });
}
