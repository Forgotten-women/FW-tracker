import 'package:flutter/material.dart';

import '../models/hr.dart';
import '../models/payroll.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../widgets/glass/glass.dart';
import '../widgets/payroll/payslip_widgets.dart';

/// One month's payslip in full. Renders at once from the statements entry it
/// was opened from, then (for a real payslip) refreshes from
/// GET /api/payroll/mine/payslips/:periodId. A legacy CLOSED period has no
/// payslip to fetch and shows its approved adjustments as the lines.
class PayslipDetailScreen extends StatefulWidget {
  final PayrollPeriodStatement statement;
  final ApiClient api;

  const PayslipDetailScreen({super.key, required this.statement, required this.api});

  @override
  State<PayslipDetailScreen> createState() => _PayslipDetailScreenState();
}

class _PayslipDetailScreenState extends State<PayslipDetailScreen> {
  late PayslipDetail _payslip = PayslipDetail.fromStatement(widget.statement);
  bool _loading = false;
  bool _restricted = false;
  String? _restrictedMessage;
  String? _notice;

  @override
  void initState() {
    super.initState();
    if (widget.statement.isPayslip && widget.statement.periodId.isNotEmpty) {
      _loading = true;
      _refresh();
    }
  }

  Future<void> _refresh() async {
    if (!widget.statement.isPayslip) return;
    if (!_loading) setState(() => _loading = true);
    try {
      final fresh = await widget.api.fetchMyPayslip(widget.statement.periodId);
      if (!mounted) return;
      setState(() {
        if (fresh.periodId.isNotEmpty) _payslip = fresh;
        _notice = null;
        _restricted = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        if (e.statusCode == 403) {
          _restricted = true;
          _restrictedMessage = e.message;
        } else if (e.statusCode == 404) {
          _notice = 'This payslip is no longer published. Pull down on the payslip list to refresh it.';
        } else if (e.statusCode == null && e.code == null) {
          _notice = "You're offline. Showing the figures from your payslip list.";
        } else {
          _notice = "Couldn't refresh this payslip (${e.message}). Showing the figures from your payslip list.";
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _notice = "Couldn't refresh this payslip. Showing the figures from your payslip list.");
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _payslip;
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
              p.periodName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, letterSpacing: -0.3, color: AppColors.textPrimary),
            ),
            Text(
              p.isLegacy ? 'Monthly statement' : 'Payslip',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: AppColors.textSecondary),
            ),
          ],
        ),
      ),
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
              onRefresh: widget.statement.isPayslip ? _refresh : () async {},
              child: Align(
                alignment: Alignment.topCenter,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 720),
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 30),
                    children: _restricted ? [_restrictedCard()] : _content(p),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _content(PayslipDetail p) {
    final cur = p.currency;
    return [
      if (_notice != null) ...[
        _banner(_notice!, AppColors.amber, Icons.info_outline_rounded),
        const SizedBox(height: 12),
      ],
      if (p.integrityOk == false) ...[
        _banner(
          "The stored figures for this payslip don't match the record HR published. Please check it with HR.",
          AppColors.danger,
          Icons.error_outline_rounded,
        ),
        const SizedBox(height: 12),
      ],
      _hero(p),
      const SizedBox(height: 22),
      const SectionLabel('Breakdown'),
      _breakdown(p, cur),
      const SizedBox(height: 22),
      const SectionLabel('Dates'),
      _datesCard(p),
      const SizedBox(height: 22),
      const SectionLabel('Salary basis'),
      _basisCard(p, cur),
      if (p.isLegacy) ...[
        const SizedBox(height: 16),
        Text(
          'This month was finalised before payslips were introduced. Its figures are worked out from the adjustments HR approved.',
          style: TextStyle(fontSize: 11.5, height: 1.4, color: AppColors.textTertiary),
        ),
      ],
    ];
  }

  Widget _hero(PayslipDetail p) {
    final cur = p.currency;
    return GlassCard(
      blur: true,
      strong: true,
      radius: 26,
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              PayslipStatusPill(payslipStatus: p.payslipStatus),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                decoration: BoxDecoration(
                  color: AppColors.cardRaised,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.glassBorder),
                ),
                child: Text(
                  cur,
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: AppColors.textSecondary),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          const PayrollCaption('Net pay'),
          const SizedBox(height: 2),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(formatPayrollMoney(p.netPayable, cur), style: monoStyle(fontSize: 32, letterSpacing: -1.1)),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(child: PayrollInfoTile(label: 'Gross baseline', value: formatPayrollMoney(p.grossBaseline, cur))),
              const SizedBox(width: 8),
              Expanded(
                child: PayrollInfoTile(
                  label: 'Deductions',
                  value: p.deductionsPositive > 0 ? formatPayrollMoney(-p.deductionsPositive, cur) : 'None',
                  valueColor: p.deductionsPositive > 0 ? AppColors.danger : AppColors.teal,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(child: PayrollInfoTile(label: 'Pay date', value: formatPayrollDate(p.payDate) ?? '-')),
            ],
          ),
        ],
      ),
    );
  }

  Widget _breakdown(PayslipDetail p, String cur) {
    final grossNote = <String>[
      if (p.workingDays != null && p.fullPeriodDays != null && p.fullPeriodDays! > 0 &&
          (p.isPartial || p.isStarter || p.workingDays != p.fullPeriodDays))
        '${p.workingDays} of ${p.fullPeriodDays} working days',
      if (p.isStarter) 'prorated from your start date',
    ].join(', ');

    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Column(
        children: [
          _amountRow('Gross baseline', formatPayrollMoney(p.grossBaseline, cur),
              note: grossNote.isEmpty ? null : grossNote),
          Divider(height: 1, color: AppColors.border),
          if (p.lines.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 14),
              child: Row(
                children: [
                  Icon(Icons.check_circle_outline_rounded, size: 16, color: AppColors.teal),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'No deductions or adjustments this month.',
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
                    ),
                  ),
                ],
              ),
            )
          else
            for (final line in p.lines) _lineRow(line, cur),
          Divider(height: 1, color: AppColors.border),
          _amountRow('Net pay', formatPayrollMoney(p.netPayable, cur), bold: true),
        ],
      ),
    );
  }

  Widget _amountRow(String label, String value, {String? note, bool bold = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: TextStyle(
                    fontSize: bold ? 14 : 13,
                    fontWeight: FontWeight.w800,
                    color: AppColors.textPrimary,
                  ),
                ),
                if (note != null) ...[
                  const SizedBox(height: 2),
                  Text(note, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppColors.textTertiary)),
                ],
              ],
            ),
          ),
          const SizedBox(width: 10),
          Text(value, style: monoStyle(fontSize: bold ? 15.5 : 13.5, color: bold ? AppColors.teal : AppColors.textPrimary)),
        ],
      ),
    );
  }

  Widget _lineRow(PayslipLine line, String cur) {
    final meta = <String>[
      if (line.days != null && line.days != 0) formatDays(line.days!.abs()),
      if (formatPayrollDate(line.date) != null) formatPayrollDate(line.date)!,
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 11),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  line.label,
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
                ),
                if (meta.isNotEmpty) ...[
                  const SizedBox(height: 1),
                  Text(meta, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.textTertiary)),
                ],
                if (line.explanation.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(
                    line.explanation,
                    style: TextStyle(fontSize: 11.5, height: 1.35, color: AppColors.textSecondary),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 10),
          Text(
            formatPayrollMoney(line.amount, cur, signed: true),
            style: monoStyle(fontSize: 13.5, color: line.isDeduction ? AppColors.danger : AppColors.teal),
          ),
        ],
      ),
    );
  }

  Widget _datesCard(PayslipDetail p) {
    final from = formatPayrollDate(p.startDate);
    final to = formatPayrollDate(p.endDate);
    return _infoCard([
      if (from != null && to != null) ('Period', '$from - $to', null),
      ('Cut-off', formatPayrollDate(p.cutoffDate) ?? '-', null),
      ('Pay date', formatPayrollDate(p.payDate) ?? '-', null),
      if (!p.isLegacy) ...[
        ('Published', formatEpochDate(p.publishedAt) ?? '-', null),
        (
          'Paid',
          formatEpochDate(p.paidAt) ?? 'Not yet',
          p.paidAt != null ? AppColors.teal : AppColors.textSecondary,
        ),
      ],
      ('Currency', p.currency, null),
    ]);
  }

  Widget _basisCard(PayslipDetail p, String cur) {
    final working = p.workingDays == null
        ? null
        : (p.fullPeriodDays != null && p.fullPeriodDays! > 0 && p.fullPeriodDays != p.workingDays
            ? '${p.workingDays} of ${p.fullPeriodDays}'
            : '${p.workingDays}');
    return _infoCard([
      ('Monthly salary', formatPayrollMoney(p.monthlySalary, cur), null),
      ('Daily rate', formatPayrollMoney(p.dailyRate, cur), null),
      if (working != null) ('Working days', working, null),
      if (p.salaryEffectiveFrom != null)
        ('Salary effective from', formatPayrollDate(p.salaryEffectiveFrom) ?? p.salaryEffectiveFrom!, null),
      if (p.exchangeRate != null && cur == 'PKR')
        ('Exchange rate', '£1 = ${formatPayrollMoney(p.exchangeRate!, 'PKR')}', null),
      if (p.isStarter) ('Starter', 'Joined this period', null),
    ]);
  }

  Widget _infoCard(List<(String, String, Color?)> rows) {
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      child: Column(
        children: [
          for (var i = 0; i < rows.length; i++)
            _infoRow(rows[i].$1, rows[i].$2, valueColor: rows[i].$3, last: i == rows.length - 1),
        ],
      ),
    );
  }

  Widget _infoRow(String label, String value, {Color? valueColor, bool last = false}) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 11),
      decoration: BoxDecoration(
        border: last ? null : Border(bottom: BorderSide(color: AppColors.border)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(label, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
          ),
          const SizedBox(width: 10),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: valueColor ?? AppColors.textPrimary),
            ),
          ),
        ],
      ),
    );
  }

  Widget _banner(String text, Color tone, IconData icon) {
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
            child: Text(text, style: TextStyle(color: tone, fontSize: 11.5, fontWeight: FontWeight.w600, height: 1.35)),
          ),
        ],
      ),
    );
  }

  Widget _restrictedCard() {
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(22),
      child: Column(
        children: [
          GradientIconTile(icon: Icons.lock_outline_rounded, colors: payslipToneColors(null), size: 48),
          const SizedBox(height: 14),
          Text(
            'Salary details are restricted',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
          ),
          const SizedBox(height: 6),
          Text(
            _restrictedMessage ?? 'Salary and monthly statements are restricted by company HR policy.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, height: 1.4, color: AppColors.textSecondary),
          ),
        ],
      ),
    );
  }
}
