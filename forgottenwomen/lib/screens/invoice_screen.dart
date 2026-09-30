import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:open_file/open_file.dart';
import 'package:printing/printing.dart';

import '../models/hr.dart';
import '../models/invoice.dart';
import '../services/api_client.dart';
import '../services/invoice_files.dart';
import '../services/invoice_pdf.dart';
import '../theme.dart';
import '../widgets/glass/glass.dart';
import 'payslip_detail_screen.dart';

/// Opens the system share/save sheet for a PDF. [origin] anchors the
/// popover on tablets.
typedef InvoicePdfSharer = Future<void> Function(Uint8List bytes, String fileName, Rect? origin);

/// Saves the Word file and opens it in another app. Returns null on success,
/// otherwise a message to show.
typedef InvoiceDocxOpener = Future<String?> Function(InvoiceDocx docx);

Future<void> _sharePdfWithPrinting(Uint8List bytes, String fileName, Rect? origin) async {
  await Printing.sharePdf(bytes: bytes, filename: fileName, bounds: origin);
}

Future<String?> _saveAndOpenDocx(InvoiceDocx docx) async {
  final file = await InvoiceFiles.save(docx.bytes, docx.fileName);
  final result = await OpenFile.open(
    file.path,
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  switch (result.type) {
    case ResultType.done:
      return null;
    case ResultType.noAppToOpen:
      return 'No app on this phone opens Word files. Save the PDF instead.';
    default:
      return result.message.isEmpty ? "Couldn't open the Word copy." : result.message;
  }
}

/// One month's invoice (the "Monthly Salary Statement"), laid out as HR's
/// Word template is: header, employee & payroll info, salary & attendance,
/// net pay & bank details, notes. Everything comes from
/// GET /api/payroll/mine/invoices/:periodId; a draft month is marked
/// provisional. Offers the same statement as a PDF built on the phone, and
/// the server-filled Word file.
class InvoiceScreen extends StatefulWidget {
  final String periodId;

  /// Shown in the title until the invoice loads.
  final String? periodName;

  /// Opened for this month's provisional invoice: says so while loading.
  final bool provisional;

  /// The payslip it was opened from, to offer its breakdown.
  final PayrollPeriodStatement? statement;

  /// Defaults to a client of the screen's own (disposed with it).
  final ApiClient? api;

  final InvoicePdfSharer sharePdf;
  final InvoiceDocxOpener openDocx;

  const InvoiceScreen({
    super.key,
    required this.periodId,
    this.periodName,
    this.provisional = false,
    this.statement,
    this.api,
    this.sharePdf = _sharePdfWithPrinting,
    this.openDocx = _saveAndOpenDocx,
  });

  @override
  State<InvoiceScreen> createState() => _InvoiceScreenState();
}

class _InvoiceScreenState extends State<InvoiceScreen> {
  late final ApiClient _api = widget.api ?? ApiClient();

  Invoice? _invoice;
  bool _loading = true;
  ApiException? _error;

  bool _pdfBusy = false;
  bool _wordBusy = false;
  bool _wordUnavailable = false;
  final _pdfButtonKey = GlobalKey();

  // A refusal the server made on purpose: the figures must not stay on screen.
  static const _refusals = {'RESTRICTED', 'NOT_FOUND', 'NO_SALARY', 'INVOICE_MISMATCH'};

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    if (widget.api == null) _api.dispose();
    super.dispose();
  }

  bool _isRefusal(ApiException e) =>
      _refusals.contains(e.code) || e.statusCode == 403 || e.statusCode == 404 || e.statusCode == 409;

  bool _isOffline(ApiException e) => e.statusCode == null && e.code == null;

  Future<void> _load() async {
    if (!mounted) return;
    if (!_loading) setState(() => _loading = true);
    try {
      final inv = await _api.fetchMyInvoice(widget.periodId);
      if (!mounted) return;
      setState(() {
        _invoice = inv;
        _error = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        if (_isRefusal(e) || e.code == 'INVOICE_MISMATCH' || e.statusCode == 500) _invoice = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = ApiException(e.toString()));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toast(String message, {Color? tone}) {
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger?.clearSnackBars();
    messenger?.showSnackBar(SnackBar(content: Text(message), backgroundColor: tone));
  }

  Rect? _pdfButtonRect() {
    final box = _pdfButtonKey.currentContext?.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return null;
    return box.localToGlobal(Offset.zero) & box.size;
  }

  Future<void> _savePdf() async {
    final inv = _invoice;
    if (inv == null || _pdfBusy) return;
    setState(() => _pdfBusy = true);
    try {
      final bytes = await buildInvoicePdf(inv);
      if (!mounted) return;
      await widget.sharePdf(bytes, inv.pdfFileName, _pdfButtonRect());
    } catch (e) {
      if (mounted) _toast("Couldn't create the PDF: $e", tone: AppColors.danger);
    } finally {
      if (mounted) setState(() => _pdfBusy = false);
    }
  }

  Future<void> _openWord() async {
    if (_invoice == null || _wordBusy || _wordUnavailable) return;
    setState(() => _wordBusy = true);
    try {
      final docx = await _api.downloadMyInvoiceDocx(widget.periodId);
      final problem = await widget.openDocx(docx);
      if (problem != null && mounted) _toast(problem, tone: AppColors.amber);
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.code == 'NO_TEMPLATE') {
        setState(() => _wordUnavailable = true);
        _toast('Word copy not available yet');
      } else if (_isOffline(e)) {
        _toast("You're offline. Connect to the internet to get the Word copy.", tone: AppColors.amber);
      } else {
        _toast(e.message, tone: AppColors.danger);
      }
    } catch (e) {
      if (mounted) _toast("Couldn't open the Word copy: $e", tone: AppColors.danger);
    } finally {
      if (mounted) setState(() => _wordBusy = false);
    }
  }

  void _openPayslip() {
    final s = widget.statement;
    if (s == null) return;
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => PayslipDetailScreen(statement: s, api: _api, offerInvoice: false)),
    );
  }

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final inv = _invoice;
    final title = inv?.periodName ?? widget.periodName ?? 'Invoice';
    final provisional = inv?.draft ?? widget.provisional;
    return GlassScaffold(
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        toolbarHeight: 64,
        titleSpacing: 4,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, letterSpacing: -0.3, color: AppColors.textPrimary),
            ),
            Text(
              provisional ? 'Provisional invoice' : 'Invoice',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: AppColors.textSecondary),
            ),
          ],
        ),
        actions: [
          if (widget.statement != null && widget.statement!.isPayslip)
            IconButton(
              tooltip: 'Payslip breakdown',
              onPressed: _openPayslip,
              icon: Icon(Icons.receipt_long_rounded, color: AppColors.textPrimary),
            ),
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _load,
            icon: Icon(Icons.refresh_rounded, color: AppColors.textPrimary),
          ),
          const SizedBox(width: 6),
        ],
      ),
      bottomNavigationBar: inv == null ? null : _actionBar(),
      body: Column(
        children: [
          if (_loading)
            LinearProgressIndicator(
              minHeight: 2.5,
              backgroundColor: Colors.transparent,
              valueColor: AlwaysStoppedAnimation<Color>(AppColors.primaryLight),
            ),
          Expanded(
            child: RefreshIndicator(
              color: AppColors.primary,
              onRefresh: _load,
              child: Align(
                alignment: Alignment.topCenter,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 720),
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                    children: inv != null
                        ? _content(inv)
                        : (_error != null ? [_errorState(_error!)] : _skeleton()),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _actionBar() {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
        decoration: BoxDecoration(
          color: AppColors.sheet.withValues(alpha: AppColors.isDark ? 0.92 : 0.96),
          border: Border(top: BorderSide(color: AppColors.border)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    key: _pdfButtonKey,
                    onPressed: _pdfBusy ? null : _savePdf,
                    icon: _pdfBusy ? _buttonSpinner(AppColors.onAccent) : const Icon(Icons.picture_as_pdf_rounded, size: 18),
                    label: const Text('Save PDF', maxLines: 1, overflow: TextOverflow.ellipsis),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: (_wordBusy || _wordUnavailable) ? null : _openWord,
                    icon: _wordBusy ? _buttonSpinner(AppColors.textPrimary) : const Icon(Icons.description_outlined, size: 18),
                    label: const Text('Word copy', maxLines: 1, overflow: TextOverflow.ellipsis),
                  ),
                ),
              ],
            ),
            if (_wordUnavailable) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  Icon(Icons.info_outline_rounded, size: 15, color: AppColors.textTertiary),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      'Word copy not available yet',
                      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buttonSpinner(Color color) =>
      SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: color));

  List<Widget> _content(Invoice inv) {
    final f = inv.fields;
    final e = _error;
    return [
      if (e != null) ...[
        _banner(
          _isOffline(e)
              ? "You're offline. Showing the invoice loaded earlier."
              : "Couldn't refresh (${e.message}). Showing the invoice loaded earlier.",
          AppColors.amber,
          _isOffline(e) ? Icons.wifi_off_rounded : Icons.info_outline_rounded,
        ),
        const SizedBox(height: 12),
      ],
      if (inv.draft) ...[
        _banner(Invoice.provisionalNotice, AppColors.amber, Icons.hourglass_top_rounded, bold: true),
        const SizedBox(height: 12),
      ],
      if (!inv.integrityOk) ...[
        _banner(Invoice.integrityWarning, AppColors.danger, Icons.error_outline_rounded),
        const SizedBox(height: 12),
      ],
      _header(inv),
      const SizedBox(height: 20),

      const _Band('Employee & payroll info'),
      _pairGrid(f.employeeInfo),
      const SizedBox(height: 20),

      const _Band('Salary & attendance'),
      _table('Salary Summary', f.salarySummary, currency: inv.currency, boldFrom: 3),
      const SizedBox(height: 10),
      _table('Attendance Summary', f.attendanceSummary),
      const SizedBox(height: 10),
      _table('Deductions', f.deductions, currency: inv.currency, boldFrom: 3, negative: true),
      const SizedBox(height: 20),

      const _Band('Net pay & bank details'),
      _netCard(inv),
      const SizedBox(height: 10),
      _pairGrid(f.bankDetails),
      const SizedBox(height: 20),

      const _Band('Payroll Notes'),
      GlassCard(
        radius: 20,
        padding: const EdgeInsets.all(16),
        child: Text(
          f['payroll_note'].isEmpty ? 'No notes for this month.' : f['payroll_note'],
          style: TextStyle(
            fontSize: 12.5,
            height: 1.45,
            color: f['payroll_note'].isEmpty ? AppColors.textTertiary : AppColors.textSecondary,
          ),
        ),
      ),
      const SizedBox(height: 16),
      _footer(f),
    ];
  }

  Widget _header(Invoice inv) {
    final f = inv.fields;
    final contact = f.companyContact;
    final address = f['company_address'];
    return GlassCard(
      blur: true,
      strong: true,
      radius: 24,
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            f.companyName.toUpperCase(),
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w900,
              letterSpacing: 0.6,
              color: AppColors.primaryLight,
            ),
          ),
          if (contact.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(contact, style: TextStyle(fontSize: 11.5, height: 1.35, color: AppColors.textSecondary)),
          ],
          if (address.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(address, style: TextStyle(fontSize: 11.5, height: 1.35, color: AppColors.textSecondary)),
          ],
          const SizedBox(height: 12),
          Divider(height: 1, color: AppColors.border),
          const SizedBox(height: 12),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  Invoice.title,
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, letterSpacing: -0.3, color: AppColors.textPrimary),
                ),
              ),
              if (inv.draft) ...[
                const SizedBox(width: 8),
                StatusPill(label: 'PROVISIONAL', tone: AppColors.amber, glow: false),
              ],
            ],
          ),
          const SizedBox(height: 3),
          Text(
            Invoice.subtitle,
            style: TextStyle(fontSize: 12, height: 1.35, color: AppColors.textSecondary),
          ),
        ],
      ),
    );
  }

  /// Label-over-value pairs, two to a row, as the template's four-column
  /// tables read on a phone.
  Widget _pairGrid(List<(String, String)> pairs) {
    Widget cell((String, String) p) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              p.$1,
              style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: 0.2, color: AppColors.textTertiary),
            ),
            const SizedBox(height: 3),
            Text(
              p.$2,
              style: TextStyle(fontSize: 13, height: 1.3, fontWeight: FontWeight.w700, color: AppColors.textPrimary),
            ),
          ],
        );
    final rows = <Widget>[];
    for (var i = 0; i < pairs.length; i += 2) {
      rows.add(Container(
        padding: const EdgeInsets.symmetric(vertical: 11),
        decoration: BoxDecoration(
          border: i + 2 >= pairs.length ? null : Border(bottom: BorderSide(color: AppColors.border)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: cell(pairs[i])),
            const SizedBox(width: 12),
            Expanded(child: i + 1 < pairs.length ? cell(pairs[i + 1]) : const SizedBox()),
          ],
        ),
      ));
    }
    return GlassCard(
      radius: 20,
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      child: Column(children: rows),
    );
  }

  /// A titled label/value table. Rows from [boldFrom] on are totals.
  Widget _table(
    String title,
    List<(String, String)> rows, {
    String? currency,
    int? boldFrom,
    bool negative = false,
  }) {
    return GlassCard(
      radius: 20,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: AppColors.primaryLight),
                ),
              ),
              if (currency != null && currency.isNotEmpty) _currencyChip(currency),
            ],
          ),
          const SizedBox(height: 4),
          for (var i = 0; i < rows.length; i++)
            _tableRow(
              rows[i].$1,
              rows[i].$2,
              bold: boldFrom != null && i >= boldFrom,
              last: i == rows.length - 1,
              valueColor: negative && boldFrom != null && i >= boldFrom && rows[i].$2 != '-' && !_isZero(rows[i].$2)
                  ? AppColors.danger
                  : null,
            ),
        ],
      ),
    );
  }

  static bool _isZero(String formatted) => RegExp(r'^[0.,\s]*$').hasMatch(formatted);

  Widget _tableRow(String label, String value, {bool bold = false, bool last = false, Color? valueColor}) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(
        border: last ? null : Border(bottom: BorderSide(color: AppColors.border)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: bold ? FontWeight.w800 : FontWeight.w600,
                color: bold ? AppColors.textPrimary : AppColors.textSecondary,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: monoStyle(
                fontSize: bold ? 13.5 : 12.5,
                fontWeight: bold ? FontWeight.w800 : FontWeight.w600,
                color: valueColor ?? AppColors.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _currencyChip(String currency) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: AppColors.cardRaised,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppColors.glassBorder),
        ),
        child: Text(
          currency,
          style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: AppColors.textSecondary),
        ),
      );

  Widget _netCard(Invoice inv) {
    final tone = AppColors.primaryLight;
    return GlassCard(
      strong: true,
      radius: 22,
      tint: AppColors.isDark
          ? tone.withValues(alpha: 0.10)
          : Color.alphaBlend(tone.withValues(alpha: 0.08), AppColors.glassFillStrong),
      borderColor: tone.withValues(alpha: 0.35),
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'NET SALARY PAYABLE',
            style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 0.9, color: tone),
          ),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(inv.netPayableText, maxLines: 1, style: monoStyle(fontSize: 28, letterSpacing: -0.8)),
          ),
          if (inv.draft) ...[
            const SizedBox(height: 4),
            Text(
              'Provisional figure',
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.amber),
            ),
          ],
        ],
      ),
    );
  }

  Widget _footer(InvoiceFields f) {
    TextSpan pair(String label, String value) => TextSpan(
          children: [
            TextSpan(text: '$label ', style: TextStyle(fontWeight: FontWeight.w800, color: AppColors.textSecondary)),
            TextSpan(text: value, style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.textPrimary)),
          ],
        );
    final style = TextStyle(fontSize: 12, height: 1.4);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Wrap(
        spacing: 20,
        runSpacing: 4,
        children: [
          Text.rich(pair('Prepared By:', f.or('prepared_by')), style: style),
          Text.rich(pair('Date:', f.or('generated_date')), style: style),
        ],
      ),
    );
  }

  Widget _banner(String text, Color tone, IconData icon, {bool bold = false}) {
    return GlassCard(
      radius: 16,
      tint: tone.withValues(alpha: 0.12),
      borderColor: tone.withValues(alpha: 0.35),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      child: Row(
        children: [
          Icon(icon, color: tone, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: TextStyle(color: tone, fontSize: bold ? 12.5 : 11.5, fontWeight: bold ? FontWeight.w800 : FontWeight.w600, height: 1.35),
            ),
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // States
  // ---------------------------------------------------------------------------

  Widget _errorState(ApiException e) {
    final offline = _isOffline(e);
    late final IconData icon;
    late final Color tone;
    late final String title;
    String message = e.message;
    var retry = true;

    if (e.code == 'RESTRICTED' || e.statusCode == 403) {
      icon = Icons.lock_outline_rounded;
      tone = AppColors.neutral;
      title = 'Salary details are restricted';
      if (message.isEmpty) message = InvoiceList.restrictedFallback;
      retry = false;
    } else if (e.code == 'NOT_FOUND' || e.statusCode == 404) {
      icon = Icons.search_off_rounded;
      tone = AppColors.neutral;
      title = 'No invoice for this month';
      message = '${message.isEmpty ? 'No such invoice.' : message} '
          'An invoice appears once HR publishes the month.';
    } else if (e.code == 'NO_SALARY') {
      icon = Icons.account_balance_wallet_outlined;
      tone = AppColors.amber;
      title = 'No salary on record';
      retry = false;
    } else if (e.code == 'INVOICE_MISMATCH') {
      icon = Icons.report_gmailerrorred_rounded;
      tone = AppColors.danger;
      title = "This invoice can't be shown";
    } else if (offline) {
      icon = Icons.wifi_off_rounded;
      tone = AppColors.amber;
      title = "You're offline";
      message = 'Connect to the internet, then try again.';
    } else {
      icon = Icons.cloud_off_rounded;
      tone = AppColors.danger;
      title = "Couldn't load your invoice";
    }

    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(22),
      child: Column(
        children: [
          GradientIconTile(icon: icon, colors: [tone, tone.withValues(alpha: 0.7)], size: 48),
          const SizedBox(height: 14),
          Text(
            title,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
          ),
          const SizedBox(height: 6),
          Text(
            message.isEmpty ? 'Something went wrong.' : message,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, height: 1.4, color: AppColors.textSecondary),
          ),
          if (retry) ...[
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh_rounded, size: 18),
              label: const Text('Try again'),
            ),
          ],
          if (widget.statement != null && widget.statement!.isPayslip && !(e.code == 'RESTRICTED' || e.statusCode == 403)) ...[
            const SizedBox(height: 8),
            TextButton.icon(
              onPressed: _openPayslip,
              icon: const Icon(Icons.receipt_long_rounded, size: 18),
              label: const Text('View payslip breakdown'),
            ),
          ],
        ],
      ),
    );
  }

  List<Widget> _skeleton() {
    Widget bar(double width, double height) => Container(
          width: width,
          height: height,
          decoration: BoxDecoration(color: AppColors.border, borderRadius: BorderRadius.circular(6)),
        );
    Widget card(List<Widget> children) => Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: GlassCard(
            radius: 22,
            padding: const EdgeInsets.all(18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
          ),
        );
    return [
      card([
        bar(170, 16),
        const SizedBox(height: 8),
        bar(220, 10),
        const SizedBox(height: 16),
        bar(double.infinity, 20),
        const SizedBox(height: 8),
        bar(240, 10),
      ]),
      for (var i = 0; i < 3; i++)
        card([
          bar(120, 12),
          const SizedBox(height: 14),
          Row(children: [Expanded(child: bar(double.infinity, 30)), const SizedBox(width: 12), Expanded(child: bar(double.infinity, 30))]),
          const SizedBox(height: 10),
          Row(children: [Expanded(child: bar(double.infinity, 30)), const SizedBox(width: 12), Expanded(child: bar(double.infinity, 30))]),
        ]),
    ];
  }
}

/// The template's shaded section heading.
class _Band extends StatelessWidget {
  final String text;
  const _Band(this.text);

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(
        color: AppColors.primaryLight.withValues(alpha: AppColors.isDark ? 0.14 : 0.10),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        text.toUpperCase(),
        style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1.0, color: AppColors.primaryLight),
      ),
    );
  }
}
