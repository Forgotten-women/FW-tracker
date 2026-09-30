// The on-device PDF: one A4 page in the template's structure, carrying the
// invoice's own fields. Built uncompressed so the page's text can be read
// back from the bytes (the pdf package writes each word as its own string).

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:office_tracker/models/invoice.dart';
import 'package:office_tracker/services/invoice_pdf.dart';

import 'invoice_models_test.dart' as fixtures;

/// Every literal string drawn on the page, in order, joined by spaces.
String _pageText(List<int> bytes) {
  final raw = latin1.decode(bytes);
  const str = r'\((?:\\.|[^\\)])*\)';
  String unescape(String s) => s.replaceAllMapped(RegExp(r'\\([()\\])'), (x) => x.group(1)!);
  String strings(String s) =>
      RegExp(str).allMatches(s).map((m) => unescape(m.group(0)!.substring(1, m.group(0)!.length - 1))).join();
  // `[(word) -12 (s)] TJ` and `(word) Tj`.
  final words = RegExp('\\[((?:$str|[-\\d.\\s])*)\\]\\s*TJ|($str)\\s*Tj')
      .allMatches(raw)
      .map((m) => strings(m.group(1) ?? m.group(2)!));
  return words.join(' ');
}

void main() {
  test('one A4 page with every section and value', () async {
    final invoice = Invoice.fromJson(fixtures.invoiceJson());
    final bytes = await buildInvoicePdf(invoice, compress: false);

    final raw = latin1.decode(bytes);
    expect(raw.startsWith('%PDF-'), isTrue);
    expect(RegExp(r'/Type\s*/Page(?!s)').allMatches(raw).length, 1, reason: 'a single page');
    // A4 in points.
    expect(raw, contains(RegExp(r'/MediaBox\s*\[\s*0\s+0\s+595\.27\d*\s+841\.88\d*\s*\]')));

    final text = _pageText(bytes);
    for (final heading in [
      'URBANE NETWORK LTD',
      Invoice.title,
      Invoice.subtitle,
      'EMPLOYEE & PAYROLL INFO',
      'SALARY & ATTENDANCE',
      'Salary Summary',
      'Attendance Summary',
      'Deductions',
      'NET PAY & BANK DETAILS',
      'NET SALARY PAYABLE',
      'Payroll Notes',
      'Prepared By:',
      'Date:',
    ]) {
      expect(text, contains(heading), reason: heading);
    }

    final f = invoice.fields;
    for (final key in InvoiceFields.keys) {
      if (key == 'company_name') continue; // printed uppercase, checked above
      final value = f[key];
      expect(value, isNotEmpty, reason: 'fixture $key');
      expect(text, contains(value), reason: key);
    }
    for (final (label, _) in [...f.employeeInfo, ...f.salarySummary, ...f.attendanceSummary, ...f.bankDetails]) {
      expect(text, contains(label), reason: label);
    }
    expect(text, contains('PKR 2,770.00'));
    expect(text, isNot(contains(Invoice.provisionalNotice.toUpperCase())));
  });

  test('a draft says it is provisional; a failed integrity check warns', () async {
    final invoice = Invoice.fromJson(fixtures.invoiceJson(draft: true, integrityOk: false));
    final text = _pageText(await buildInvoicePdf(invoice, compress: false));
    expect(text, contains(Invoice.provisionalNotice.toUpperCase()));
    expect(text, contains('DRAFT-URB-202503-FWINV'));
    expect(text, contains("don't match the record HR published"));
  });

  test('compressed by default, and still a PDF', () async {
    final invoice = Invoice.fromJson(fixtures.invoiceJson());
    final small = await buildInvoicePdf(invoice);
    final big = await buildInvoicePdf(invoice, compress: false);
    expect(latin1.decode(small.sublist(0, 5)), '%PDF-');
    expect(small.length, lessThan(big.length));
  });

  test('text outside the built-in font is made printable', () {
    expect(pdfSafeText('Ayesha – “Khan” ₨ 5'), 'Ayesha - "Khan" Rs 5');
    expect(pdfSafeText('Zoë'), 'Zoë', reason: 'Latin-1 is kept');
    expect(pdfSafeText('عائشہ'), '?????');
  });

  test('blank fields still build a page', () async {
    final invoice = Invoice.fromJson(const {'periodId': 'pp_x'});
    final text = _pageText(await buildInvoicePdf(invoice, compress: false));
    expect(text, contains(InvoiceFields.fallbackCompanyName));
    expect(text, contains(Invoice.title));
  });
}
