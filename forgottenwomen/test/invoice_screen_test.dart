// The invoice screen at phone width (360 dp), in both palettes: any
// RenderFlex overflow fails the test. HTTP is a MockClient behind the real
// ApiClient, as in payroll_widgets_test.dart; the share sheet and the Word
// opener are injected, so nothing leaves the machine.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:office_tracker/models/hr.dart';
import 'package:office_tracker/models/invoice.dart';
import 'package:office_tracker/screens/invoice_screen.dart';
import 'package:office_tracker/screens/payslip_detail_screen.dart';
import 'package:office_tracker/screens/salary_screen.dart';
import 'package:office_tracker/services/api_client.dart';
import 'package:office_tracker/services/token_store.dart';
import 'package:office_tracker/theme.dart';
import 'package:office_tracker/widgets/glass/glass.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'invoice_models_test.dart' as fixtures;
import 'payroll_models_test.dart' as payroll;

class _FakeStore extends TokenStore {
  @override
  Future<String?> readToken() async => 'test-token';

  @override
  Future<String> readServerUrl() async => 'https://payroll.test';
}

// google_fonts' HTTP fetches never complete: fallback font, no stray errors.
class _NoNetworkOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) => _NeverRespondingHttpClient();
}

class _NeverRespondingHttpClient implements HttpClient {
  @override
  dynamic noSuchMethod(Invocation invocation) => Completer<Never>().future;
}

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

http.Response _error(int status, String code, String message) =>
    _json({'status': 'ERROR', 'code': code, 'message': message}, status);

/// Routes the invoice endpoints; anything else fails the test.
ApiClient _api({
  Map<String, dynamic>? invoice,
  http.Response? invoiceResponse,
  http.Response? docxResponse,
  List<Uri>? log,
}) =>
    ApiClient(
      store: _FakeStore(),
      client: MockClient((req) async {
        log?.add(req.url);
        expect(req.headers['Authorization'], 'Bearer test-token');
        final path = req.url.path;
        if (path.endsWith('/docx')) {
          return docxResponse ?? _error(409, 'NO_TEMPLATE', 'No invoice template has been uploaded yet.');
        }
        if (path.startsWith('/api/payroll/mine/invoices/')) {
          return invoiceResponse ?? _json({'status': 'SUCCESS', 'invoice': invoice ?? fixtures.invoiceJson()});
        }
        fail('unexpected request: $path');
      }),
    );

Future<void> _pumpAt360(WidgetTester tester, Widget child, {double height = 3400}) async {
  tester.view.physicalSize = Size(360 * 3, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(), home: child));
  await tester.pump();
}

/// Values made as awkward as the template allows: long names, an address
/// that wraps, an unbroken IBAN, a large net figure.
Map<String, dynamic> _longInvoiceJson() {
  final json = fixtures.invoiceJson(draft: true, integrityOk: false);
  (json['fields'] as Map<String, String>)
    ..['company_name'] = 'Urbane Network International Holdings Limited'
    ..['company_address'] = 'Unit 14, Second Floor, Example Business Centre, 221 Very Long Road Name, London EC1A 1BB'
    ..['employee_name'] = 'Ayesha Siddiqa Khan-Mahmood Chaudhry'
    ..['job_title'] = 'Senior Software Engineer, Platform Reliability'
    ..['working_arrangement'] = 'Hybrid (3 days in office)'
    ..['statement_reference'] = 'DRAFT-URB-202503-FWINV-0000042-V12'
    ..['iban'] = 'PK36MEZN00012301234567020000000000'
    ..['net_salary'] = '123,456,789.00'
    ..['gross_earnings'] = '123,456,789.00'
    ..['payroll_note'] = List.filled(12, 'A long payroll note that wraps across several lines.').join(' ');
  return json;
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

      testWidgets('a published invoice mirrors the template at 360 dp', (tester) async {
        final log = <Uri>[];
        final api = _api(log: log);
        addTearDown(api.dispose);
        await _pumpAt360(tester, InvoiceScreen(periodId: 'pp_mar', periodName: 'March 2025', api: api));
        await tester.pumpAndSettle();

        expect(log.single.path, '/api/payroll/mine/invoices/pp_mar');
        expect(find.text('URBANE NETWORK LTD'), findsOneWidget);
        expect(find.text('payroll@urbane.test  |  +44 20 7946 0000'), findsOneWidget);
        expect(find.text('Monthly Salary Statement'), findsOneWidget);
        expect(find.text(Invoice.subtitle), findsOneWidget);
        for (final band in [
          'EMPLOYEE & PAYROLL INFO',
          'SALARY & ATTENDANCE',
          'NET PAY & BANK DETAILS',
          'PAYROLL NOTES',
        ]) {
          expect(find.text(band), findsOneWidget, reason: band);
        }
        for (final label in ['Employee Name', 'Pay Period', 'Working Arrangement', 'Salary Summary',
            'Attendance Summary', 'Deductions', 'Bonus / Addition', 'Hours Worked', 'Adjustments',
            'NET SALARY PAYABLE', 'Bank Name', 'IBAN']) {
          expect(find.text(label), findsWidgets, reason: label);
        }
        expect(find.text('Ayesha Invoice'), findsNWidgets(2), reason: 'employee name and account title');
        expect(find.text('1 Mar 2025 - 31 Mar 2025'), findsOneWidget);
        expect(find.text('URB-202503-FWINV'), findsOneWidget);
        expect(find.text('136h 00m'), findsOneWidget);
        expect(find.text('PKR 2,770.00'), findsOneWidget);
        expect(find.text('PK36MEZN0001230123456702'), findsOneWidget);
        expect(find.text('March approved - thank you all'), findsOneWidget);
        expect(find.text('Save PDF'), findsOneWidget);
        expect(find.text('Word copy'), findsOneWidget);
        expect(find.text(Invoice.provisionalNotice), findsNothing);
        expect(find.text(Invoice.integrityWarning), findsNothing);
      });

      testWidgets('a draft with long values: provisional banner, integrity warning, no overflow', (tester) async {
        final api = _api(invoice: _longInvoiceJson());
        addTearDown(api.dispose);
        await _pumpAt360(tester, InvoiceScreen(periodId: 'pp_apr', provisional: true, api: api));
        await tester.pumpAndSettle();

        expect(find.text(Invoice.provisionalNotice), findsOneWidget);
        expect(find.text('PROVISIONAL'), findsOneWidget);
        expect(find.text('Provisional invoice'), findsOneWidget);
        expect(find.text(Invoice.integrityWarning), findsOneWidget);
        expect(find.text('URBANE NETWORK INTERNATIONAL HOLDINGS LIMITED'), findsOneWidget);
        expect(find.text('PKR 123,456,789.00'), findsOneWidget);
      });

      testWidgets('loading state before the invoice arrives', (tester) async {
        final gate = Completer<http.Response>();
        final api = ApiClient(store: _FakeStore(), client: MockClient((_) => gate.future));
        addTearDown(api.dispose);
        await _pumpAt360(tester, InvoiceScreen(periodId: 'pp_mar', periodName: 'March 2025', api: api), height: 800);

        expect(find.byType(LinearProgressIndicator), findsOneWidget);
        expect(find.text('March 2025'), findsOneWidget, reason: 'the title it was opened with');
        expect(find.text('Save PDF'), findsNothing);

        gate.complete(_json({'status': 'SUCCESS', 'invoice': fixtures.invoiceJson()}));
        await tester.pumpAndSettle();
        expect(find.text('Save PDF'), findsOneWidget);
      });
    });
  }

  group('refusals and errors', () {
    setUp(() => AppColors.palette = AppPalette.build(Brightness.dark, AccentChoice.indigo));

    testWidgets('restricted by HR: the server message, no figures', (tester) async {
      final api = _api(
        invoiceResponse: _error(403, 'RESTRICTED', 'Salary and monthly invoices are restricted by company HR policy.'),
      );
      addTearDown(api.dispose);
      await _pumpAt360(tester, InvoiceScreen(periodId: 'pp_mar', api: api), height: 800);
      await tester.pumpAndSettle();

      expect(find.text('Salary details are restricted'), findsOneWidget);
      expect(find.text('Salary and monthly invoices are restricted by company HR policy.'), findsOneWidget);
      expect(find.text('Save PDF'), findsNothing);
      expect(find.text('Try again'), findsNothing);
    });

    testWidgets("figures that don't add up are refused, and no number is shown", (tester) async {
      const message =
          'This invoice does not add up to the approved net pay, so it has not been shown. HR has been told.';
      final api = _api(invoiceResponse: _error(500, 'INVOICE_MISMATCH', message));
      addTearDown(api.dispose);
      await _pumpAt360(tester, InvoiceScreen(periodId: 'pp_mar', periodName: 'March 2025', api: api), height: 800);
      await tester.pumpAndSettle();

      expect(find.text("This invoice can't be shown"), findsOneWidget);
      expect(find.text(message), findsOneWidget);
      expect(find.textContaining('PKR'), findsNothing);
      expect(find.textContaining('2,770'), findsNothing);
      expect(find.text('NET SALARY PAYABLE'), findsNothing);
      expect(find.text('Save PDF'), findsNothing);
    });

    testWidgets('no salary on record, and no such invoice', (tester) async {
      final noSalary = _api(invoiceResponse: _error(409, 'NO_SALARY', 'No salary on record for this employee.'));
      addTearDown(noSalary.dispose);
      await _pumpAt360(tester, InvoiceScreen(periodId: 'pp_mar', api: noSalary), height: 800);
      await tester.pumpAndSettle();
      expect(find.text('No salary on record'), findsOneWidget);
      expect(find.text('No salary on record for this employee.'), findsOneWidget);

      final missing = _api(invoiceResponse: _error(404, 'NOT_FOUND', 'No such invoice.'));
      addTearDown(missing.dispose);
      await tester.pumpWidget(const SizedBox());
      await _pumpAt360(tester, InvoiceScreen(periodId: 'pp_x', api: missing), height: 800);
      await tester.pumpAndSettle();
      expect(find.text('No invoice for this month'), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });

    testWidgets('offline: a retry state', (tester) async {
      final api = ApiClient(
        store: _FakeStore(),
        client: MockClient((_) async => throw http.ClientException('Network is unreachable')),
      );
      addTearDown(api.dispose);
      await _pumpAt360(tester, InvoiceScreen(periodId: 'pp_mar', api: api), height: 800);
      // ApiClient retries a network failure once, two seconds later.
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();

      expect(find.text("You're offline"), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
    });
  });

  group('actions', () {
    setUp(() => AppColors.palette = AppPalette.build(Brightness.light, AccentChoice.indigo));

    testWidgets('Save PDF hands the share sheet a PDF of this invoice', (tester) async {
      final shared = <(Uint8List, String)>[];
      final api = _api();
      addTearDown(api.dispose);
      await _pumpAt360(
        tester,
        InvoiceScreen(
          periodId: 'pp_mar',
          api: api,
          sharePdf: (bytes, name, _) async => shared.add((bytes, name)),
          openDocx: (_) async => fail('not asked for'),
        ),
        height: 900,
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Save PDF'));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      await tester.pumpAndSettle();

      expect(shared, hasLength(1));
      expect(shared.single.$2, 'URB-202503-FWINV_Ayesha_Invoice.pdf');
      expect(latin1.decode(shared.single.$1.sublist(0, 5)), '%PDF-');
    });

    testWidgets('no Word template yet: says so and keeps the PDF option', (tester) async {
      final api = _api();
      addTearDown(api.dispose);
      await _pumpAt360(
        tester,
        InvoiceScreen(periodId: 'pp_mar', api: api, openDocx: (_) async => fail('nothing to open')),
        height: 900,
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Word copy'));
      await tester.pumpAndSettle();

      expect(find.text('Word copy not available yet'), findsWidgets);
      final word = tester.widget<OutlinedButton>(find.ancestor(of: find.text('Word copy'), matching: find.byWidgetPredicate((w) => w is OutlinedButton)));
      expect(word.onPressed, isNull);
      final pdf = tester.widget<FilledButton>(find.ancestor(of: find.text('Save PDF'), matching: find.byWidgetPredicate((w) => w is FilledButton)));
      expect(pdf.onPressed, isNotNull);
    });

    testWidgets('Word copy downloads with the device token and opens the named file', (tester) async {
      final opened = <InvoiceDocx>[];
      final log = <Uri>[];
      final docxBytes = Uint8List.fromList([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
      final api = _api(
        log: log,
        docxResponse: http.Response.bytes(docxBytes, 200, headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'content-disposition': 'attachment; filename="URB-202503-FWINV_Ayesha_Invoice.docx"',
        }),
      );
      addTearDown(api.dispose);
      await _pumpAt360(
        tester,
        InvoiceScreen(
          periodId: 'pp_mar',
          api: api,
          openDocx: (docx) async {
            opened.add(docx);
            return null;
          },
        ),
        height: 900,
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Word copy'));
      await tester.pumpAndSettle();

      expect(log.last.path, '/api/payroll/mine/invoices/pp_mar/docx');
      expect(opened.single.fileName, 'URB-202503-FWINV_Ayesha_Invoice.docx');
      expect(opened.single.bytes, docxBytes);
      expect(find.text('Word copy not available yet'), findsNothing);
    });
  });

  group('entry points', () {
    setUp(() => AppColors.palette = AppPalette.build(Brightness.dark, AccentChoice.indigo));

    ApiClient salaryApi(List<Uri> log, {bool draft = true}) => ApiClient(
          store: _FakeStore(),
          client: MockClient((req) async {
            log.add(req.url);
            final path = req.url.path;
            if (path == '/api/payroll/mine/statements') return _json(payroll.statementsJson());
            if (path == '/api/payroll/mine/invoices') return _json(fixtures.invoiceListJson(withDraft: draft));
            if (path.startsWith('/api/payroll/mine/invoices/')) {
              final id = path.split('/').last;
              return _json({'status': 'SUCCESS', 'invoice': fixtures.invoiceJson(periodId: id, draft: id == 'pp_apr')});
            }
            if (path.startsWith('/api/payroll/mine/payslips/')) {
              return _error(404, 'NOT_FOUND', 'No published payslip.');
            }
            fail('unexpected request: $path');
          }),
        );

    testWidgets('salary tab: provisional invoice beside the estimate; a payslip opens its invoice', (tester) async {
      final log = <Uri>[];
      final api = salaryApi(log);
      addTearDown(api.dispose);
      await _pumpAt360(tester, AmbientBackground(child: SalaryScreen(api: api)), height: 2000);
      await tester.pumpAndSettle();

      expect(find.text("This month's invoice (provisional)"), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('This month so far')).dy,
        lessThan(tester.getTopLeft(find.text("This month's invoice (provisional)")).dy),
      );
      expect(log.where((u) => u.path == '/api/payroll/mine/invoices'), hasLength(1));

      await tester.tap(find.text('May 2025'));
      await tester.pumpAndSettle();
      expect(find.byType(InvoiceScreen), findsOneWidget);
      expect(log.last.path, '/api/payroll/mine/invoices/pp_may');
      expect(find.byTooltip('Payslip breakdown'), findsOneWidget, reason: 'the payslip stays reachable');

      await tester.tap(find.byTooltip('Payslip breakdown'));
      await tester.pumpAndSettle();
      expect(find.byType(PayslipDetailScreen), findsOneWidget);
      expect(find.text('View invoice'), findsNothing, reason: 'opened from the invoice');

      Navigator.of(tester.element(find.byType(PayslipDetailScreen))).pop();
      await tester.pumpAndSettle();
      Navigator.of(tester.element(find.byType(InvoiceScreen))).pop();
      await tester.pumpAndSettle();

      await tester.tap(find.text("This month's invoice (provisional)"));
      await tester.pumpAndSettle();
      expect(log.last.path, '/api/payroll/mine/invoices/pp_apr');
      expect(find.text(Invoice.provisionalNotice), findsOneWidget);
    });

    testWidgets('no draft offered: no provisional entry', (tester) async {
      final log = <Uri>[];
      final api = salaryApi(log, draft: false);
      addTearDown(api.dispose);
      await _pumpAt360(tester, AmbientBackground(child: SalaryScreen(api: api)), height: 2000);
      await tester.pumpAndSettle();
      expect(find.text("This month's invoice (provisional)"), findsNothing);
    });

    testWidgets('payslip detail offers View invoice', (tester) async {
      final log = <Uri>[];
      final api = salaryApi(log);
      addTearDown(api.dispose);
      final published = PayrollPeriodStatement.fromJson(payroll.publishedPayslipEntry());
      await _pumpAt360(tester, PayslipDetailScreen(statement: published, api: api), height: 1600);
      await tester.pumpAndSettle();

      await tester.tap(find.text('View invoice'));
      await tester.pumpAndSettle();
      expect(find.byType(InvoiceScreen), findsOneWidget);
      expect(log.last.path, '/api/payroll/mine/invoices/pp_may');
    });
  });
}
