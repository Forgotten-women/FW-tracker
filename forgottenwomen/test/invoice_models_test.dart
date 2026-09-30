// Invoice parsing, against the shapes backend/src/routes/payroll.js
// (GET /mine/invoices) and backend/src/domain/invoice.js (buildStatement)
// produce, as backend/test/invoice.test.js asserts them. The fixtures here
// are shared with the screen and PDF tests.

import 'package:flutter_test/flutter_test.dart';
import 'package:office_tracker/models/invoice.dart';
import 'package:office_tracker/services/payslip_watcher.dart';

// 2025-03-28 00:00 UTC, as epoch ms.
const marchPublishedAt = 1743120000000;

Map<String, String> invoiceFieldsJson({bool draft = false}) => {
      'company_name': 'Urbane Network Ltd',
      'company_email': 'payroll@urbane.test',
      'company_phone': '+44 20 7946 0000',
      'company_address': '12 Example Street, London',
      'employee_name': 'Ayesha Invoice',
      'employee_id': 'FW-0042',
      'job_title': 'Software Engineer',
      'department': 'Operations',
      'working_arrangement': 'Hybrid',
      'payroll_month': 'March 2025',
      'period_start': '1 Mar 2025',
      'period_end': '31 Mar 2025',
      'statement_reference': draft ? 'DRAFT-URB-202503-FWINV' : 'URB-202503-FWINV',
      'currency': 'PKR',
      'monthly_salary': '3,000.00',
      'addition_amount': '100.00',
      'overtime_amount': '50.00',
      'gross_earnings': '3,150.00',
      'total_deductions': '380.00',
      'scheduled_days': '21',
      'present_days': '17',
      'paid_leave_days': '2',
      'unpaid_leave_days': '1',
      'sick_leave_days': '1',
      'unauthorised_days': '1',
      'worked_hours': '136h 00m',
      'extra_hours': '2h 30m',
      'shortfall_hours': '1h 00m',
      'unpaid_leave_deduction': '240.00',
      'shortfall_deduction': '120.00',
      'adjustment_amount': '20.00',
      'net_salary': '2,770.00',
      'bank_name': 'Meezan Bank',
      'account_title': 'Ayesha Invoice',
      'account_number': '0123456789',
      'iban': 'PK36MEZN0001230123456702',
      'payroll_note': draft
          ? 'Provisional - this invoice will change until HR approves the month.'
          : 'March approved - thank you all',
      'prepared_by': 'HR Department',
      'generated_date': '28 Mar 2025',
    };

Map<String, dynamic> invoiceJson({bool draft = false, bool? integrityOk = true, String periodId = 'pp_mar'}) => {
      'periodId': periodId,
      'employeeId': 'emp_1',
      'periodStatus': draft ? 'OPEN' : 'CLOSED',
      'draft': draft,
      'integrityOk': integrityOk,
      'templateId': 'tpl_1',
      'currency': 'PKR',
      'fields': invoiceFieldsJson(draft: draft),
      'totals': {
        'monthlySalary': 3000,
        'grossBaseline': 3000,
        'additions': 100,
        'overtime': 50,
        'grossEarnings': 3150,
        'unpaidLeave': 240,
        'shortfall': 120,
        'adjustments': 20,
        'totalDeductions': 380,
        'net': 2770,
      },
      'attendance': {
        'from': '2025-03-01',
        'to': '2025-03-31',
        'scheduledDays': 21,
        'presentDays': 17,
        'paidLeaveDays': 2,
        'unpaidLeaveDays': 1,
        'sickLeaveDays': 1,
        'unauthorisedDays': 1,
        'workedMinutes': 8160,
        'extraMinutes': 150,
        'shortfallMinutes': 60,
      },
      'window': {'from': '2025-03-01', 'to': '2025-03-31'},
    };

Map<String, dynamic> invoiceListJson({bool withDraft = true}) => {
      'status': 'SUCCESS',
      'enabled': true,
      'invoices': [
        {
          'periodId': 'pp_mar',
          'periodName': 'March 2025',
          'startDate': '2025-03-01',
          'endDate': '2025-03-31',
          'payDate': '2025-03-31',
          'currency': 'PKR',
          'netPayable': 2770,
          'publishedAt': marchPublishedAt,
          'paidAt': null,
          'status': 'PUBLISHED',
        },
      ],
      'draft': withDraft
          ? {
              'periodId': 'pp_apr',
              'periodName': 'April 2025',
              'startDate': '2025-04-01',
              'endDate': '2025-04-30',
              'cutoffDate': '2025-04-25',
            }
          : null,
    };

void main() {
  group('InvoiceList', () {
    test('published invoices and the draft', () {
      final list = InvoiceList.fromJson(invoiceListJson());
      expect(list.enabled, isTrue);
      expect(list.invoices, hasLength(1));
      final mar = list.invoices.single;
      expect(mar.periodId, 'pp_mar');
      expect(mar.periodName, 'March 2025');
      expect(mar.netPayable, 2770);
      expect(mar.publishedAt, marchPublishedAt);
      expect(mar.status, 'PUBLISHED');
      expect(mar.isPaid, isFalse);
      expect(list.has('pp_mar'), isTrue);
      expect(list.has('pp_apr'), isFalse);
      expect(list.draft?.periodId, 'pp_apr');
      expect(list.draft?.cutoffDate, '2025-04-25');
    });

    test('hidden by HR: the message, and never a draft', () {
      final list = InvoiceList.fromJson({
        'status': 'SUCCESS',
        'enabled': false,
        'invoices': [],
        'draft': {'periodId': 'pp_apr', 'periodName': 'April 2025'},
        'message': 'Salary and monthly invoices are restricted by company HR policy.',
      });
      expect(list.enabled, isFalse);
      expect(list.message, 'Salary and monthly invoices are restricted by company HR policy.');
      expect(list.invoices, isEmpty);
      expect(list.draft, isNull);
    });

    test('tolerates odd types and missing fields', () {
      final list = InvoiceList.fromJson({
        'enabled': true,
        'invoices': [
          {'periodId': 'pp_1', 'netPayable': '1234.5', 'publishedAt': '1743120000000', 'paidAt': 1743206400000},
          {'periodName': 'no id, dropped'},
          'not a map',
        ],
        'draft': {'periodName': 'no id'},
      });
      expect(list.invoices, hasLength(1));
      final inv = list.invoices.single;
      expect(inv.netPayable, 1234.5);
      expect(inv.publishedAt, 1743120000000);
      expect(inv.status, 'PAID', reason: 'paidAt set and no status sent');
      expect(inv.currency, 'PKR');
      expect(inv.periodName, 'Invoice');
      expect(list.draft, isNull, reason: 'a draft without a period id cannot be opened');

      final empty = InvoiceList.fromJson(const {});
      expect(empty.enabled, isFalse);
      expect(empty.invoices, isEmpty);
    });
  });

  group('Invoice', () {
    test('parses the statement', () {
      final inv = Invoice.fromJson(invoiceJson());
      expect(inv.periodId, 'pp_mar');
      expect(inv.draft, isFalse);
      expect(inv.integrityOk, isTrue);
      expect(inv.currency, 'PKR');
      expect(inv.periodName, 'March 2025');
      expect(inv.fields['employee_name'], 'Ayesha Invoice');
      expect(inv.fields.companyName, 'Urbane Network Ltd');
      expect(inv.fields.companyContact, 'payroll@urbane.test  |  +44 20 7946 0000');
      expect(inv.fields.payPeriod, '1 Mar 2025 - 31 Mar 2025');
      expect(inv.netPayableText, 'PKR 2,770.00');
      expect(inv.totals.net, 2770);
      expect(inv.totals.totalDeductions, 380);
      expect(inv.attendance.workedMinutes, 8160);
      expect(inv.attendance.presentDays, 17);
      expect(inv.windowFrom, '2025-03-01');
      expect(inv.windowTo, '2025-03-31');
      expect(inv.pdfFileName, 'URB-202503-FWINV_Ayesha_Invoice.pdf');
    });

    test('the template sections carry every value placeholder', () {
      final f = Invoice.fromJson(invoiceJson()).fields;
      final shown = [
        ...f.employeeInfo,
        ...f.salarySummary,
        ...f.attendanceSummary,
        ...f.deductions,
        ...f.bankDetails,
      ].map((p) => p.$2).toSet();
      const elsewhere = {
        // Header, net pay, notes and footer.
        'company_name', 'company_email', 'company_phone', 'company_address', 'currency', 'net_salary',
        'payroll_note', 'prepared_by', 'generated_date',
        // Shown together as the Pay Period.
        'period_start', 'period_end',
      };
      for (final key in InvoiceFields.keys) {
        if (elsewhere.contains(key)) continue;
        expect(shown, contains(f[key]), reason: key);
      }
      expect(f.employeeInfo.map((p) => p.$1), [
        'Employee Name', 'Payroll Month', 'Employee ID', 'Pay Period',
        'Position', 'Statement Ref', 'Department', 'Working Arrangement',
      ]);
    });

    test('a draft, and a failed integrity check', () {
      final draft = Invoice.fromJson(invoiceJson(draft: true, integrityOk: false));
      expect(draft.draft, isTrue);
      expect(draft.integrityOk, isFalse);

      // An open period is provisional even if the flag is missing.
      final open = Invoice.fromJson(invoiceJson()..remove('draft')..['periodStatus'] = 'IN_REVIEW');
      expect(open.draft, isTrue);

      // Absent means not checked, not failed.
      expect(Invoice.fromJson(invoiceJson(integrityOk: null)).integrityOk, isTrue);
    });

    test('tolerant: blanks, numbers as strings, no company name', () {
      final inv = Invoice.fromJson({
        'periodId': 'pp_x',
        'fields': {'net_salary': 1500, 'employee_name': null, 'currency': 'gbp', 'nested': {'a': 1}},
        'totals': {'net': '1500'},
        'attendance': 'nonsense',
      });
      expect(inv.fields.companyName, InvoiceFields.fallbackCompanyName);
      expect(inv.fields['employee_name'], '');
      expect(inv.fields.or('employee_name'), '-');
      expect(inv.fields['nested'], '');
      expect(inv.fields.payPeriod, '-');
      expect(inv.currency, 'GBP');
      expect(inv.netPayableText, 'gbp 1500');
      expect(inv.totals.net, 1500);
      expect(inv.attendance.scheduledDays, isNull);
      expect(inv.periodName, 'Invoice');
      expect(inv.pdfFileName, 'invoice.pdf');

      final none = Invoice.fromJson(const {});
      expect(none.periodId, '');
      expect(none.netPayableText, '-');
      expect(none.draft, isFalse);
    });
  });

  group('InvoiceDocx.fileNameFrom', () {
    test('reads the server name', () {
      expect(
        InvoiceDocx.fileNameFrom('attachment; filename="URB-202503-FWINV_Ayesha_Invoice.docx"'),
        'URB-202503-FWINV_Ayesha_Invoice.docx',
      );
      expect(InvoiceDocx.fileNameFrom('attachment; filename=plain.docx'), 'plain.docx');
      expect(
        InvoiceDocx.fileNameFrom("attachment; filename*=UTF-8''March%202025.docx"),
        'March_2025.docx',
      );
    });

    test('never escapes the folder, and always ends in .docx', () {
      expect(InvoiceDocx.fileNameFrom('attachment; filename="../../etc/passwd"'), 'passwd.docx');
      expect(InvoiceDocx.fileNameFrom(r'attachment; filename="..\..\x.docx"'), 'x.docx');
      expect(InvoiceDocx.fileNameFrom(null), InvoiceDocx.fallbackFileName);
      expect(InvoiceDocx.fileNameFrom('attachment'), InvoiceDocx.fallbackFileName);
      expect(InvoiceDocx.fileNameFrom('attachment; filename=".docx"'), InvoiceDocx.fallbackFileName);
    });
  });

  group('payslip notification payload', () {
    test('carries the period so a tap opens its invoice', () {
      final payload = PayslipWatcher.payloadFor('pp_mar');
      expect(payload.toUpperCase(), contains('PAY'), reason: 'still routed to the Salary tab');
      expect(PayslipWatcher.periodIdFromPayload(payload), 'pp_mar');
      expect(PayslipWatcher.periodIdFromPayload(PayslipWatcher.notificationPayload), isNull);
      expect(PayslipWatcher.periodIdFromPayload('LEAVE'), isNull);
      expect(PayslipWatcher.periodIdFromPayload(null), isNull);
      expect(PayslipWatcher.payloadFor(''), PayslipWatcher.notificationPayload);
    });
  });
}
