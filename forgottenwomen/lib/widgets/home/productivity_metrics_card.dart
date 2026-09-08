import 'package:flutter/material.dart';

import '../../models/attendance.dart';
import '../../theme.dart';

class ProductivityMetricsCard extends StatelessWidget {
  final WorkingHoursMetrics workingHours;
  final DeficitBalance deficit;
  final VoidCallback onDeficitTapped;

  const ProductivityMetricsCard({
    super.key,
    required this.workingHours,
    required this.deficit,
    required this.onDeficitTapped,
  });

  @override
  Widget build(BuildContext context) {
    final bool hasDeficit = deficit.minutes > 0;
    final Color deficitTone = hasDeficit ? AppColors.amber : AppColors.teal;

    final weeklyTarget = workingHours.weekly.formattedRequiredToDate != '0h 00m'
        ? workingHours.weekly.formattedRequiredToDate
        : (workingHours.weekly.formattedRequired != '0h 00m'
            ? workingHours.weekly.formattedRequired
            : '37h 30m');

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Expanded(
                child: Text(
                  'WORKING HOURS & STANDING',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 0.8,
                    color: AppColors.textMuted,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                'Window: ${workingHours.officeWindow}',
                style: const TextStyle(
                  fontSize: 11,
                  color: AppColors.textMuted,
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),

          // 2 Metric Cards side by side
          Row(
            children: [
              // Deficit Balance Card (Tappable for breakdown)
              Expanded(
                child: InkWell(
                  onTap: onDeficitTapped,
                  borderRadius: BorderRadius.circular(14),
                  child: Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: deficitTone.withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: deficitTone.withValues(alpha: 0.25)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              'Deficit Balance',
                              style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                                color: deficitTone,
                              ),
                            ),
                            Icon(Icons.info_outline_rounded, size: 14, color: deficitTone),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text(
                          hasDeficit ? deficit.formatted : '0 mins',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w800,
                            color: deficitTone,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          hasDeficit ? 'Tap for breakdown' : 'Standing: In Good Order',
                          style: const TextStyle(
                            fontSize: 10,
                            color: AppColors.textMuted,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),

              // Weekly Progress Card
              Expanded(
                child: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: AppColors.primaryLight.withValues(alpha: 0.25)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(
                            'This Week',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: AppColors.primaryLight,
                            ),
                          ),
                          Icon(Icons.date_range_rounded, size: 14, color: AppColors.primaryLight),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        workingHours.weekly.formattedWorked.isEmpty
                            ? '0h 0m'
                            : workingHours.weekly.formattedWorked,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w800,
                          color: Colors.white,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Target: $weeklyTarget',
                        style: const TextStyle(
                          fontSize: 10,
                          color: AppColors.textMuted,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
