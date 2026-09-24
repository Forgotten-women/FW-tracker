import 'package:flutter/material.dart';

import '../../models/hr.dart';
import '../../models/payroll.dart';
import '../../theme.dart';
import '../glass/glass.dart';

/// PAID / PUBLISHED for a payslip; CLOSED for a legacy period that was
/// finalised before payslips existed (payslipStatus null).
class PayslipStatusPill extends StatelessWidget {
  final String? payslipStatus;
  const PayslipStatusPill({super.key, required this.payslipStatus});

  @override
  Widget build(BuildContext context) {
    switch (payslipStatus) {
      case 'PAID':
        return StatusPill(label: 'PAID', tone: AppColors.teal, glow: false);
      case 'PUBLISHED':
        return StatusPill(label: 'PUBLISHED', tone: AppColors.primaryLight, glow: false);
      default:
        return StatusPill(label: 'CLOSED', tone: AppColors.neutral, glow: false);
    }
  }
}

/// Small label-over-value tile, as on the home hero card.
class PayrollInfoTile extends StatelessWidget {
  final String label;
  final String value;
  final Color? valueColor;
  const PayrollInfoTile({super.key, required this.label, required this.value, this.valueColor});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.cardRaised,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.glassBorder),
      ),
      child: Column(
        children: [
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: AppColors.textTertiary),
          ),
          const SizedBox(height: 3),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              value,
              maxLines: 1,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w800,
                color: valueColor ?? AppColors.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Uppercase caption above a headline figure.
class PayrollCaption extends StatelessWidget {
  final String text;
  const PayrollCaption(this.text, {super.key});

  @override
  Widget build(BuildContext context) {
    return Text(
      text.toUpperCase(),
      style: TextStyle(
        fontSize: 10.5,
        fontWeight: FontWeight.w800,
        letterSpacing: 0.8,
        color: AppColors.textTertiary,
      ),
    );
  }
}

/// Icon colours for a payslip's status.
List<Color> payslipToneColors(String? payslipStatus) {
  switch (payslipStatus) {
    case 'PAID':
      return [AppColors.teal, const Color(0xFF06B6D4)];
    case 'PUBLISHED':
      return [AppColors.primary, AppColors.accentEnd];
    default:
      return [AppColors.neutral, AppColors.neutral.withValues(alpha: 0.7)];
  }
}

/// One month in the payslip list: month, net pay, status and pay date.
class PayslipTile extends StatelessWidget {
  final PayrollPeriodStatement period;
  final VoidCallback onTap;
  const PayslipTile({super.key, required this.period, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final p = period;
    final payDate = formatPayrollDate(p.payDate);
    final from = formatPayrollDate(p.startDate);
    final to = formatPayrollDate(p.endDate);
    final subtitle = payDate != null
        ? 'Pay date $payDate'
        : (from != null && to != null ? '$from - $to' : 'Finalised statement');

    return GlassCard(
      onTap: onTap,
      radius: 20,
      padding: const EdgeInsets.fromLTRB(14, 14, 10, 14),
      child: Row(
        children: [
          GradientIconTile(
            icon: p.isPayslip ? Icons.receipt_long_rounded : Icons.inventory_2_outlined,
            colors: payslipToneColors(p.payslipStatus),
            size: 42,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  p.name.isEmpty ? 'Payslip' : p.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
                ),
                const SizedBox(height: 3),
                Text(
                  subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(formatPayrollMoney(p.netPayable, p.currency), style: monoStyle(fontSize: 14.5)),
              const SizedBox(height: 6),
              PayslipStatusPill(payslipStatus: p.payslipStatus),
            ],
          ),
          const SizedBox(width: 2),
          Icon(Icons.chevron_right_rounded, size: 20, color: AppColors.textTertiary),
        ],
      ),
    );
  }
}
