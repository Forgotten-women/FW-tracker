import 'package:flutter/material.dart';

import '../../models/payroll.dart';
import '../../theme.dart';
import '../glass/glass.dart';
import 'payslip_widgets.dart';

/// "This month so far": the running estimate for the open period. Amber-toned
/// and carrying the backend's own label, so it can't be mistaken for a
/// payslip. Every figure here is provisional.
class EstimateCard extends StatelessWidget {
  final PayrollEstimate estimate;
  const EstimateCard({super.key, required this.estimate});

  @override
  Widget build(BuildContext context) {
    final e = estimate;
    final cur = e.currency;
    final tone = AppColors.amber;
    final asOf = formatPayrollDate(e.asOf);

    return GlassCard(
      strong: true,
      radius: 26,
      tint: tone.withValues(alpha: AppColors.isDark ? 0.08 : 0.10),
      borderColor: tone.withValues(alpha: 0.45),
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              GradientIconTile(
                icon: Icons.hourglass_top_rounded,
                colors: [tone, const Color(0xFFF97316)],
                size: 38,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'This month so far',
                      style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      asOf == null ? e.periodName : '${e.periodName} · up to $asOf',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          // The backend's label, verbatim.
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              color: tone.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: tone.withValues(alpha: 0.35)),
            ),
            child: Row(
              children: [
                Icon(Icons.info_outline_rounded, size: 16, color: tone),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    e.label,
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800, color: tone),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          const PayrollCaption('Estimated net pay'),
          const SizedBox(height: 2),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              formatPayrollMoney(e.estimatedNet, cur),
              style: monoStyle(fontSize: 30, letterSpacing: -1),
            ),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(child: PayrollInfoTile(label: 'Gross baseline', value: formatPayrollMoney(e.grossBaseline, cur))),
              const SizedBox(width: 8),
              Expanded(child: PayrollInfoTile(label: 'Cut-off', value: formatPayrollDate(e.cutoffDate) ?? '-')),
              const SizedBox(width: 8),
              Expanded(child: PayrollInfoTile(label: 'Pay date', value: formatPayrollDate(e.payDate) ?? '-')),
            ],
          ),
          const SizedBox(height: 18),
          const PayrollCaption('Provisional deductions'),
          const SizedBox(height: 8),
          if (e.deductions.isEmpty)
            Row(
              children: [
                Icon(Icons.check_circle_outline_rounded, size: 16, color: AppColors.teal),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'None so far this month.',
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
                  ),
                ),
              ],
            )
          else
            for (final d in e.deductions) _deduction(d, cur),
          if (e.deficit != null) ...[
            const SizedBox(height: 14),
            _deficit(e.deficit!),
          ],
        ],
      ),
    );
  }

  Widget _deduction(EstimateDeduction d, String cur) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  d.label,
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
                ),
                if (d.days > 0) ...[
                  const SizedBox(height: 1),
                  Text(
                    formatDays(d.days),
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.textTertiary),
                  ),
                ],
                if (d.explanation.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(
                    d.explanation,
                    style: TextStyle(fontSize: 11.5, height: 1.35, color: AppColors.textSecondary),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 10),
          Text(
            formatPayrollMoney(d.amount, cur, signed: true),
            style: monoStyle(fontSize: 13.5, color: d.amount < 0 ? AppColors.danger : AppColors.teal),
          ),
        ],
      ),
    );
  }

  Widget _deficit(EstimateDeficit d) {
    final tone = AppColors.amber;
    final perDay = formatHoursMinutes(d.dayEquivalentMinutes);
    final soFar = d.wholeDaysSoFar > 0
        ? '${formatDays(d.wholeDaysSoFar)} unpaid from lateness so far this month.'
        : 'No unpaid days from lateness so far this month.';
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
      decoration: BoxDecoration(
        color: AppColors.cardRaised,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.glassBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.timelapse_rounded, size: 16, color: tone),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Attendance deficit',
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
                ),
              ),
              if (d.dayEquivalentMinutes > 0)
                Text(
                  '${formatHoursMinutes(d.carryForwardMinutes)} of $perDay',
                  style: monoStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: AppColors.textSecondary),
                ),
            ],
          ),
          const SizedBox(height: 10),
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              value: d.progress,
              minHeight: 7,
              backgroundColor: tone.withValues(alpha: 0.16),
              valueColor: AlwaysStoppedAnimation<Color>(tone),
            ),
          ),
          const SizedBox(height: 9),
          Text(
            '${formatHoursMinutes(d.minutesUntilNextUnpaidDay)} until the next unpaid day',
            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
          ),
          const SizedBox(height: 3),
          Text(
            d.dayEquivalentMinutes > 0
                ? '$soFar Every $perDay of late arrival or early departure counts as one unpaid day.'
                : soFar,
            style: TextStyle(fontSize: 11, height: 1.35, color: AppColors.textSecondary),
          ),
        ],
      ),
    );
  }
}
