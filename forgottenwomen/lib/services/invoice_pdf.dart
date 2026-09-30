// The invoice as a one-page A4 PDF, built on the device from the same
// `fields` the server fills HR's Word template with, and laid out in that
// template's structure and colours (Urbane_Monthly_Salary_Statement_Clean.docx).
//
// Pure: bytes in, bytes out, no platform channels, so it is unit-tested
// directly. The share/save sheet is opened by the screen.

import 'dart:typed_data';

import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

import '../models/invoice.dart';

// The template's palette.
const _navy = PdfColor.fromInt(0xFF1E3A5F);
const _ink = PdfColor.fromInt(0xFF334155);
const _muted = PdfColor.fromInt(0xFF64748B);
const _faint = PdfColor.fromInt(0xFF8091A5);
const _bandTint = PdfColor.fromInt(0xFFF1F5F9);
const _rowTint = PdfColor.fromInt(0xFFFBFCFD);
const _netTint = PdfColor.fromInt(0xFFEEF4F8);
const _rule = PdfColor.fromInt(0xFFE2E8F0);
const _amber = PdfColor.fromInt(0xFFB45309);
const _amberTint = PdfColor.fromInt(0xFFFEF3C7);
const _red = PdfColor.fromInt(0xFFB91C1C);
const _redTint = PdfColor.fromInt(0xFFFEE2E2);

/// The built-in PDF fonts (Helvetica) cover Latin-1 only. Common typographic
/// characters are mapped to their plain forms; anything else outside Latin-1
/// becomes '?', rather than a missing glyph.
String pdfSafeText(String s) {
  const map = {
    '–': '-', '—': '-', '‒': '-', '−': '-',
    '‘': "'", '’': "'", '‚': "'", '′': "'",
    '“': '"', '”': '"', '„': '"',
    '…': '...', '•': '-', ' ': ' ', ' ': ' ',
    '₨': 'Rs', '₹': 'Rs', '€': 'EUR',
  };
  final out = StringBuffer();
  for (final rune in s.runes) {
    final ch = String.fromCharCode(rune);
    if (map.containsKey(ch)) {
      out.write(map[ch]);
    } else if (rune == 0x09 || rune == 0x0A || (rune >= 0x20 && rune <= 0x7E) || (rune >= 0xA0 && rune <= 0xFF)) {
      out.write(ch);
    } else if (rune < 0x20 || (rune >= 0x7F && rune < 0xA0)) {
      out.write(' ');
    } else {
      out.write('?');
    }
  }
  return out.toString();
}

/// Builds the invoice PDF. [compress] is off in tests so the page's text can
/// be read back from the bytes.
Future<Uint8List> buildInvoicePdf(Invoice invoice, {bool compress = true}) {
  final f = invoice.fields;
  final doc = pw.Document(
    compress: compress,
    title: pdfSafeText('${Invoice.title} - ${invoice.periodName}'),
    author: pdfSafeText(f.companyName),
    subject: Invoice.title,
    creator: pdfSafeText(f.companyName),
  );
  doc.addPage(
    pw.Page(
      pageFormat: PdfPageFormat.a4,
      // The template's page margins (twips / 20).
      margin: const pw.EdgeInsets.fromLTRB(37, 31, 37, 27),
      theme: pw.ThemeData.withFont(base: pw.Font.helvetica(), bold: pw.Font.helveticaBold()),
      build: (context) => _page(invoice),
    ),
  );
  return doc.save();
}

pw.Widget _text(
  String s, {
  double size = 8,
  PdfColor color = _ink,
  bool bold = false,
  double? letterSpacing,
  pw.TextAlign? align,
  int? maxLines,
}) =>
    pw.Text(
      pdfSafeText(s),
      textAlign: align,
      maxLines: maxLines,
      style: pw.TextStyle(
        fontSize: size,
        color: color,
        fontWeight: bold ? pw.FontWeight.bold : pw.FontWeight.normal,
        letterSpacing: letterSpacing,
        lineSpacing: 1.5,
      ),
    );

pw.Widget _page(Invoice invoice) {
  final f = invoice.fields;
  final contact = f.companyContact;
  final address = f['company_address'];
  return pw.Column(
    crossAxisAlignment: pw.CrossAxisAlignment.stretch,
    children: [
      // Header
      _text(f.companyName.toUpperCase(), size: 17, color: _navy, bold: true, letterSpacing: 0.6),
      if (contact.isNotEmpty) ...[pw.SizedBox(height: 3), _text(contact, color: _muted)],
      if (address.isNotEmpty) ...[pw.SizedBox(height: 1), _text(address, color: _muted)],
      pw.SizedBox(height: 8),
      pw.Container(height: 1.2, color: _navy),
      pw.SizedBox(height: 10),
      _text(Invoice.title, size: 15, color: _navy, bold: true),
      pw.SizedBox(height: 2),
      _text(Invoice.subtitle, size: 8.5, color: _muted),
      if (invoice.draft) ...[
        pw.SizedBox(height: 8),
        _notice(Invoice.provisionalNotice.toUpperCase(), _amber, _amberTint),
      ],
      if (!invoice.integrityOk) ...[
        pw.SizedBox(height: 6),
        _notice(Invoice.integrityWarning, _red, _redTint),
      ],
      pw.SizedBox(height: 10),

      _band('EMPLOYEE & PAYROLL INFO'),
      _pairTable(f.employeeInfo),
      pw.SizedBox(height: 10),

      _band('SALARY & ATTENDANCE'),
      pw.SizedBox(height: 6),
      pw.Row(
        crossAxisAlignment: pw.CrossAxisAlignment.start,
        children: [
          pw.Expanded(
            child: _summary('Salary Summary', f.salarySummary, boldFrom: f.salarySummary.length - 2),
          ),
          pw.SizedBox(width: 12),
          pw.Expanded(child: _summary('Attendance Summary', f.attendanceSummary, labelsBold: true)),
        ],
      ),
      pw.SizedBox(height: 8),
      _text('Deductions', size: 9, color: _navy, bold: true),
      pw.SizedBox(height: 3),
      _pairTable(f.deductions, boldLastValue: true),
      pw.SizedBox(height: 10),

      _band('NET PAY & BANK DETAILS'),
      pw.SizedBox(height: 6),
      pw.Container(
        color: _netTint,
        padding: const pw.EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        child: pw.Row(
          crossAxisAlignment: pw.CrossAxisAlignment.center,
          children: [
            pw.Expanded(child: _text('NET SALARY PAYABLE', size: 9.5, color: _navy, bold: true)),
            _text(invoice.netPayableText, size: 17.5, color: _navy, bold: true),
          ],
        ),
      ),
      pw.SizedBox(height: 4),
      _pairTable(f.bankDetails),
      pw.SizedBox(height: 10),

      _text('Payroll Notes', size: 9, color: _navy, bold: true),
      pw.SizedBox(height: 3),
      pw.Container(
        color: _rowTint,
        padding: const pw.EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: _text(f.or('payroll_note', ' '), color: _muted, maxLines: 6),
      ),
      pw.SizedBox(height: 10),
      pw.RichText(
        text: pw.TextSpan(
          style: const pw.TextStyle(fontSize: 8, color: _muted),
          children: [
            pw.TextSpan(text: 'Prepared By: ', style: pw.TextStyle(fontWeight: pw.FontWeight.bold)),
            pw.TextSpan(text: pdfSafeText(f.or('prepared_by')), style: const pw.TextStyle(color: _ink)),
            const pw.TextSpan(text: '     '),
            pw.TextSpan(text: 'Date: ', style: pw.TextStyle(fontWeight: pw.FontWeight.bold)),
            pw.TextSpan(text: pdfSafeText(f.or('generated_date')), style: const pw.TextStyle(color: _ink)),
          ],
        ),
      ),
      pw.Spacer(),
      pw.Container(height: 0.6, color: _rule),
      pw.SizedBox(height: 4),
      _text(
        [
          f.companyName,
          Invoice.title,
          if (f['statement_reference'].isNotEmpty) f['statement_reference'],
        ].join('  |  '),
        size: 7,
        color: _faint,
        align: pw.TextAlign.center,
      ),
    ],
  );
}

pw.Widget _band(String title) => pw.Container(
      color: _bandTint,
      padding: const pw.EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      child: _text(title, size: 10, color: _navy, bold: true, letterSpacing: 0.4),
    );

pw.Widget _notice(String text, PdfColor tone, PdfColor tint) => pw.Container(
      padding: const pw.EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: pw.BoxDecoration(
        color: tint,
        border: pw.Border.all(color: tone, width: 0.8),
      ),
      child: _text(text, size: 8.5, color: tone, bold: true),
    );

/// Label, value, label, value: the template's four-column info tables.
pw.Widget _pairTable(List<(String, String)> pairs, {bool boldLastValue = false}) {
  final rows = <pw.TableRow>[];
  for (var i = 0; i < pairs.length; i += 2) {
    final left = pairs[i];
    final right = i + 1 < pairs.length ? pairs[i + 1] : null;
    final isLast = i + 2 >= pairs.length;
    pw.Widget cell(String s, {bool label = false, bool bold = false}) => pw.Padding(
          padding: const pw.EdgeInsets.symmetric(horizontal: 8, vertical: 4.5),
          child: _text(s, size: label ? 8 : 8.5, color: label ? _muted : _ink, bold: label || bold),
        );
    rows.add(pw.TableRow(
      decoration: pw.BoxDecoration(color: (i ~/ 2).isEven ? _rowTint : PdfColors.white),
      children: [
        cell(left.$1, label: true),
        cell(left.$2),
        cell(right?.$1 ?? '', label: true),
        cell(right?.$2 ?? '', bold: boldLastValue && isLast),
      ],
    ));
  }
  return pw.Table(
    columnWidths: const {
      0: pw.FlexColumnWidth(2.2),
      1: pw.FlexColumnWidth(3),
      2: pw.FlexColumnWidth(2.4),
      3: pw.FlexColumnWidth(3),
    },
    border: const pw.TableBorder(horizontalInside: pw.BorderSide(color: _rule, width: 0.5)),
    children: rows,
  );
}

/// A titled two-column list: Salary Summary / Attendance Summary.
pw.Widget _summary(String title, List<(String, String)> rows, {int? boldFrom, bool labelsBold = false}) {
  return pw.Column(
    crossAxisAlignment: pw.CrossAxisAlignment.stretch,
    children: [
      _text(title, size: 9, color: _navy, bold: true),
      pw.SizedBox(height: 3),
      pw.Table(
        columnWidths: const {0: pw.FlexColumnWidth(3), 1: pw.FlexColumnWidth(2)},
        border: const pw.TableBorder(horizontalInside: pw.BorderSide(color: _rule, width: 0.5)),
        children: [
          for (var i = 0; i < rows.length; i++)
            pw.TableRow(
              decoration: pw.BoxDecoration(color: i.isEven ? _rowTint : PdfColors.white),
              children: [
                pw.Padding(
                  padding: const pw.EdgeInsets.symmetric(horizontal: 6, vertical: 3.5),
                  child: _text(
                    rows[i].$1,
                    color: labelsBold ? _muted : _ink,
                    bold: labelsBold || (boldFrom != null && i >= boldFrom),
                  ),
                ),
                pw.Padding(
                  padding: const pw.EdgeInsets.symmetric(horizontal: 6, vertical: 3.5),
                  child: _text(
                    rows[i].$2,
                    align: pw.TextAlign.right,
                    bold: boldFrom != null && i >= boldFrom,
                  ),
                ),
              ],
            ),
        ],
      ),
    ],
  );
}
