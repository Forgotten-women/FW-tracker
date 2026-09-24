// Layout smoke tests for the payroll UI at phone width, in both palettes:
// any RenderFlex overflow fails the test. Data is the backend's shapes (see
// payroll_models_test.dart); HTTP is a MockClient, so nothing leaves the
// machine.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:office_tracker/models/hr.dart';
import 'package:office_tracker/models/payroll.dart';
import 'package:office_tracker/screens/payslip_detail_screen.dart';
import 'package:office_tracker/screens/salary_screen.dart';
import 'package:office_tracker/services/api_client.dart';
import 'package:office_tracker/services/token_store.dart';
import 'package:office_tracker/theme.dart';
import 'package:office_tracker/widgets/glass/glass.dart';
import 'package:office_tracker/widgets/payroll/estimate_card.dart';
import 'package:office_tracker/widgets/payroll/payslip_widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'payroll_models_test.dart' as fixtures;

class _FakeStore extends TokenStore {
  @override
  Future<String?> readToken() async => 'test-token';

  @override
  Future<String> readServerUrl() async => 'https://payroll.test';
}

// google_fonts fetches its fonts over HTTP and rethrows the failure as an
// uncaught async error, which fails whichever test is running when it lands.
// Requests that never complete keep the fallback font and no error.
class _NoNetworkOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) => _NeverRespondingHttpClient();
}

class _NeverRespondingHttpClient implements HttpClient {
  @override
  dynamic noSuchMethod(Invocation invocation) => Completer<Never>().future;
}

ApiClient _statementsApi(Map<String, dynamic> body) => ApiClient(
      store: _FakeStore(),
      client: MockClient((req) async {
        expect(req.url.path, '/api/payroll/mine/statements');
        return http.Response(jsonEncode(body), 200);
      }),
    );

ApiClient _offlineApi() => ApiClient(
      store: _FakeStore(),
      client: MockClient((_) async => throw http.ClientException('Network is unreachable')),
    );

Widget _salaryScreen(ApiClient api) => AmbientBackground(child: SalaryScreen(api: api));

Future<void> _pumpAt360(WidgetTester tester, Widget child, {double height = 800}) async {
  tester.view.physicalSize = Size(360 * 3, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(), home: child));
  await tester.pump();
}

void main() {
  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized();
    HttpOverrides.global = _NoNetworkOverrides();
  });
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    SalaryScreen.clearCache();
  });

  for (final brightness in Brightness.values) {
    group('${brightness.name} mode', () {
      setUp(() => AppColors.palette = AppPalette.build(brightness, AccentChoice.indigo));

      testWidgets('estimate card and payslip tiles lay out at 360 px', (tester) async {
        final estimate = PayrollEstimate.fromJson(fixtures.estimateJson())!;
        final published = PayrollPeriodStatement.fromJson(fixtures.publishedPayslipEntry());
        final paid = PayrollPeriodStatement.fromJson(
          fixtures.publishedPayslipEntry(payslipStatus: 'PAID', paidAt: fixtures.mayPublishedAt),
        );
        final legacy = PayrollPeriodStatement.fromJson(fixtures.legacyClosedEntry());

        await _pumpAt360(
          tester,
          // Not a lazy ListView: every tile must be built to be checked.
          Scaffold(
            body: SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  EstimateCard(estimate: estimate),
                  for (final p in [published, paid, legacy]) PayslipTile(period: p, onTap: () {}),
                ],
              ),
            ),
          ),
        );

        expect(find.text('Estimate - not final until HR approves'), findsOneWidget);
        expect(find.text('7 h 40 m until the next unpaid day'), findsOneWidget);
        expect(find.text('Unpaid absence'), findsOneWidget);
        expect(find.text('PUBLISHED'), findsOneWidget);
        expect(find.text('PAID'), findsOneWidget);
        expect(find.text('CLOSED'), findsOneWidget);
        expect(find.text('Pay date 31 May 2025'), findsNWidgets(2));
      });

      testWidgets('salary screen: estimate first, then payslips newest first, then salary', (tester) async {
        final api = _statementsApi(fixtures.statementsJson());
        addTearDown(api.dispose);
        // Tall enough for the lazy list to build every row.
        await _pumpAt360(tester, _salaryScreen(api), height: 2000);
        await tester.pumpAndSettle();

        expect(find.text('This month so far'), findsOneWidget);
        expect(find.text('Estimate - not final until HR approves'), findsOneWidget);
        expect(find.text('August 2025 (manual)'), findsOneWidget);
        expect(find.text('May 2025'), findsOneWidget);
        expect(
          tester.getTopLeft(find.text('This month so far')).dy,
          lessThan(tester.getTopLeft(find.text('August 2025 (manual)')).dy),
        );
        expect(
          tester.getTopLeft(find.text('August 2025 (manual)')).dy,
          lessThan(tester.getTopLeft(find.text('May 2025')).dy),
        );
        expect(find.text('Gross monthly salary'), findsOneWidget);
      });

      testWidgets('legacy CLOSED period detail renders from the list fields', (tester) async {
        final legacy = PayrollPeriodStatement.fromJson(fixtures.legacyClosedEntry());
        final api = ApiClient(
          store: _FakeStore(),
          client: MockClient((_) async => fail('a legacy period has no payslip to fetch')),
        );
        addTearDown(api.dispose);

        await _pumpAt360(tester, PayslipDetailScreen(statement: legacy, api: api));

        expect(find.text('August 2025 (manual)'), findsOneWidget);
        expect(find.text('Overtime bonus'), findsOneWidget);
        expect(find.text('Monthly statement'), findsOneWidget);
        await tester.scrollUntilVisible(find.textContaining('finalised before payslips'), 300);
        expect(find.textContaining('finalised before payslips'), findsOneWidget);
      });
    });
  }

  group('salary screen states', () {
    setUp(() => AppColors.palette = AppPalette.build(Brightness.dark, AccentChoice.indigo));

    testWidgets('policy-restricted shows the server message and no figures', (tester) async {
      final api = _statementsApi({
        'status': 'SUCCESS',
        'enabled': false,
        'message': 'Salary and monthly statements are restricted by company HR policy.',
        'currentSalary': null,
        'periods': [],
        'estimate': null,
        'latestPayslip': null,
      });
      addTearDown(api.dispose);
      await _pumpAt360(tester, _salaryScreen(api));
      await tester.pumpAndSettle();

      expect(find.text('Salary details are restricted'), findsOneWidget);
      expect(find.text('Salary and monthly statements are restricted by company HR policy.'), findsOneWidget);
      expect(find.text('This month so far'), findsNothing);
      expect(find.text('No payslips yet'), findsNothing);
    });

    testWidgets('no payslips yet, and no estimate when the backend sends none', (tester) async {
      final json = fixtures.statementsJson()
        ..['periods'] = []
        ..['estimate'] = null
        ..['latestPayslip'] = null;
      final api = _statementsApi(json);
      addTearDown(api.dispose);
      await _pumpAt360(tester, _salaryScreen(api));
      await tester.pumpAndSettle();

      expect(find.text('No payslips yet'), findsOneWidget);
      expect(find.text('This month so far'), findsNothing);
    });

    testWidgets('offline with nothing loaded: a retry state', (tester) async {
      final api = _offlineApi();
      addTearDown(api.dispose);
      await _pumpAt360(tester, _salaryScreen(api));
      // ApiClient retries a network failure once, two seconds later.
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();

      expect(find.text("You're offline"), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });

    testWidgets('offline after a successful load: the loaded payslips stay, with a banner', (tester) async {
      final online = _statementsApi(fixtures.statementsJson());
      addTearDown(online.dispose);
      await _pumpAt360(tester, _salaryScreen(online), height: 2000);
      await tester.pumpAndSettle();
      expect(find.text('May 2025'), findsOneWidget);

      final offline = _offlineApi();
      addTearDown(offline.dispose);
      await tester.pumpWidget(const SizedBox());
      await _pumpAt360(tester, _salaryScreen(offline), height: 2000);
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();

      expect(find.textContaining("You're offline. Showing the payslips loaded"), findsOneWidget);
      expect(find.text('May 2025'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });
  });

  testWidgets('published payslip detail refreshes from its endpoint; deductions are red', (tester) async {
    AppColors.palette = AppPalette.build(Brightness.dark, AccentChoice.indigo);
    final published = PayrollPeriodStatement.fromJson(fixtures.publishedPayslipEntry());
    final requested = <Uri>[];
    final api = ApiClient(
      store: _FakeStore(),
      client: MockClient((req) async {
        requested.add(req.url);
        final entry = fixtures.publishedPayslipEntry();
        return http.Response(
          jsonEncode({
            'status': 'SUCCESS',
            'payslip': {
              'id': entry['payslipId'],
              'periodId': 'pp_may',
              'periodName': 'May 2025',
              'version': 1,
              'status': 'PUBLISHED',
              'payslipStatus': 'PAID',
              'currency': 'PKR',
              'exchangeRate': 350,
              'monthlySalary': 3000,
              'dailyRate': 115.38,
              'grossBaseline': 3000,
              'deductionsTotal': 346.14,
              'adjustmentsTotal': -346.14,
              'netPayable': 2653.86,
              'workingDays': 22,
              'fullPeriodDays': 22,
              'isPartial': false,
              'isStarter': false,
              'salaryEffectiveFrom': '2024-12-02',
              'lines': entry['lines'],
              'cutoffDate': '2025-05-25',
              'payDate': '2025-05-31',
              'publishedAt': fixtures.mayPublishedAt,
              'paidAt': fixtures.mayPublishedAt + 86400000,
              'contentHash': 'abc',
              'integrityOk': true,
              'startDate': '2025-05-01',
              'endDate': '2025-05-31',
            },
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    addTearDown(api.dispose);

    expect(published.payslipStatus, 'PUBLISHED', reason: 'the list still says unpaid');
    await _pumpAt360(tester, PayslipDetailScreen(statement: published, api: api));
    await tester.pumpAndSettle();
    expect(requested.single.path, '/api/payroll/mine/payslips/pp_may');
    expect(find.text('PAID'), findsOneWidget, reason: 'refreshed from the detail endpoint');

    final deduction = tester.widget<Text>(find.text(formatPayrollMoney(-115.38, 'PKR', signed: true)).first);
    expect(deduction.style?.color, AppColors.danger);
    expect(find.text('Attendance deficit'), findsOneWidget);
  });
}
