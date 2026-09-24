import 'package:flutter/material.dart';

import '../../models/attendance.dart';
import '../../theme.dart';
import '../glass/glass.dart';

/// Two glass tiles: the deficit standing (today + all-time running balance)
/// and this week's worked total with a Mon–Fri mini bar chart.
class ProductivityMetricsCard extends StatelessWidget {
  final WorkingHoursMetrics workingHours;
  final DeficitBalance deficit;
  final VoidCallback onDeficitTapped;

  /// Mon..Fri, each the share of that day's target worked (0..1), or null for
  /// a day that hasn't happened yet.
  final List<double?> weekProgress;

  /// 0 = Monday … 4 = Friday; -1 on weekends.
  final int todayIndex;

  const ProductivityMetricsCard({
    super.key,
    required this.workingHours,
    required this.deficit,
    required this.onDeficitTapped,
    this.weekProgress = const [],
    this.todayIndex = -1,
  });

  @override
  Widget build(BuildContext context) {
    final int todayDeficit = deficit.todayBreakdown.totalMinutes;
    final bool hasDeficit = deficit.minutes > 0;
    final Color tone = todayDeficit > 0 ? AppColors.amber : AppColors.teal;

    final weekly = workingHours.weekly;
    final String weeklyTarget =
        weekly.formattedRequired != '0h 00m' ? weekly.formattedRequired : '40h 00m';

    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: GlassCard(
              onTap: onDeficitTapped,
              radius: 22,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Deficit',
                          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.textSecondary),
                        ),
                      ),
                      _badge(todayDeficit > 0 ? 'Today' : 'On track', tone),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Text('${todayDeficit}m', style: monoStyle(fontSize: 24, letterSpacing: -0.6)),
                  const SizedBox(height: 2),
                  Text(
                    hasDeficit ? 'today · ${deficit.formatted} all‑time' : 'today · none all‑time',
                    maxLines: 2,
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppColors.textTertiary),
                  ),
                  const Spacer(),
                  const SizedBox(height: 8),
                  Text(
                    'Breakdown →',
                    style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w800, color: AppColors.primaryLight),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: GlassCard(
              radius: 22,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          'This week',
                          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.textSecondary),
                        ),
                      ),
                      Text(
                        'of $weeklyTarget',
                        style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: AppColors.textTertiary),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(
                      weekly.formattedWorked.isEmpty ? '0h 00m' : weekly.formattedWorked,
                      style: monoStyle(fontSize: 24, letterSpacing: -0.6),
                    ),
                  ),
                  const SizedBox(height: 10),
                  SizedBox(height: 36, child: _bars()),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _bars() {
    final values = weekProgress.length == 5 ? weekProgress : List<double?>.filled(5, null);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        for (var i = 0; i < 5; i++) ...[
          if (i > 0) const SizedBox(width: 5),
          Expanded(child: _bar(values[i], isToday: i == todayIndex)),
        ],
      ],
    );
  }

  Widget _bar(double? v, {required bool isToday}) {
    if (v == null) {
      return Container(
        decoration: BoxDecoration(
          color: AppColors.primary.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(5),
        ),
      );
    }
    final colors = isToday
        ? const [Color(0xFFF472B6), Color(0xFFEC4899)]
        : [AppColors.primary.withValues(alpha: 0.7), AppColors.primary];
    return FractionallySizedBox(
      heightFactor: v.clamp(0.12, 1.0),
      alignment: Alignment.bottomCenter,
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(5),
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: colors,
          ),
        ),
      ),
    );
  }

  Widget _badge(String text, Color tone) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Text(
        text,
        style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: tone),
      ),
    );
  }
}
