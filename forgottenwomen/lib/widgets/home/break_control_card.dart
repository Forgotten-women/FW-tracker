import 'package:flutter/material.dart';

import '../../models/attendance.dart';
import '../../theme.dart';

class BreakControlCard extends StatelessWidget {
  final ActiveBreakInfo breakInfo;
  final DateTime liveNow;
  final bool isSubmitting;
  final VoidCallback onToggleBreak;
  final VoidCallback onClockOut;
  final VoidCallback onOpenDispute;

  const BreakControlCard({
    super.key,
    required this.breakInfo,
    required this.liveNow,
    required this.isSubmitting,
    required this.onToggleBreak,
    required this.onClockOut,
    required this.onOpenDispute,
  });

  @override
  Widget build(BuildContext context) {
    if (breakInfo.onBreak) {
      return _buildActiveBreakCard(context);
    }
    return _buildIdleActionHub(context);
  }

  Widget _buildActiveBreakCard(BuildContext context) {
    final int startedMs = breakInfo.startedAtMs ?? liveNow.millisecondsSinceEpoch;
    final int nowMs = liveNow.millisecondsSinceEpoch;
    final int elapsedSeconds = ((nowMs - startedMs) / 1000).floor().clamp(0, 999999);

    final int permittedSeconds = breakInfo.permittedMinutes * 60;
    final int remainingSeconds = permittedSeconds - elapsedSeconds;
    final bool isOverdue = remainingSeconds < 0;

    final String countdownText;
    if (!isOverdue) {
      final int m = remainingSeconds ~/ 60;
      final int s = remainingSeconds % 60;
      countdownText = '${m}m ${s.toString().padLeft(2, '0')}s';
    } else {
      final int overdueSec = -remainingSeconds;
      final int m = overdueSec ~/ 60;
      final int s = overdueSec % 60;
      countdownText = '+${m}m ${s.toString().padLeft(2, '0')}s EXCEEDED';
    }

    final double breakProgress = (elapsedSeconds / permittedSeconds).clamp(0.0, 1.0);
    final Color tone = isOverdue ? AppColors.danger : AppColors.amber;

    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: tone.withValues(alpha: 0.5), width: 1.5),
        boxShadow: [
          BoxShadow(
            color: tone.withValues(alpha: 0.18),
            blurRadius: 16,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: tone.withValues(alpha: 0.15),
                  shape: BoxShape.circle,
                ),
                child: Icon(Icons.coffee_rounded, color: tone, size: 22),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text(
                          'Active Break Session',
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                        Text(
                          breakInfo.dueBackDisplay != null
                              ? 'Due: ${breakInfo.dueBackDisplay}'
                              : '30m Allowance',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                            color: tone,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      countdownText,
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w800,
                        color: tone,
                        letterSpacing: -0.5,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),

          // Linear countdown bar
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: SizedBox(
              height: 6,
              child: LinearProgressIndicator(
                value: breakProgress,
                backgroundColor: AppColors.border,
                valueColor: AlwaysStoppedAnimation<Color>(tone),
              ),
            ),
          ),
          const SizedBox(height: 16),

          // Primary End Break Button
          SizedBox(
            width: double.infinity,
            height: 48,
            child: FilledButton.icon(
              onPressed: isSubmitting ? null : onToggleBreak,
              icon: isSubmitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                    )
                  : const Icon(Icons.stop_circle_outlined, size: 20),
              label: Text(
                isSubmitting ? 'Ending Break...' : 'End Break & Resume Work',
                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
              ),
              style: FilledButton.styleFrom(
                backgroundColor: tone,
                foregroundColor: isOverdue ? Colors.white : Colors.black,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildIdleActionHub(BuildContext context) {
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
          const Text(
            'QUICK ACTIONS',
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.bold,
              letterSpacing: 1.1,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              // Start Break Action
              Expanded(
                child: SizedBox(
                  height: 46,
                  child: FilledButton.icon(
                    onPressed: isSubmitting ? null : onToggleBreak,
                    icon: isSubmitting
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                          )
                        : const Icon(Icons.coffee_outlined, size: 18),
                    label: const FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(
                        'Take Break',
                        maxLines: 1,
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                      ),
                    ),
                    style: FilledButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      backgroundColor: AppColors.amber,
                      foregroundColor: Colors.black,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),

              // Clock Out Action
              Expanded(
                child: SizedBox(
                  height: 46,
                  child: OutlinedButton.icon(
                    onPressed: isSubmitting ? null : onClockOut,
                    icon: const Icon(Icons.logout_rounded, size: 16, color: AppColors.danger),
                    label: const FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(
                        'Clock Out',
                        maxLines: 1,
                        style: TextStyle(
                          fontWeight: FontWeight.bold,
                          fontSize: 12,
                          color: AppColors.danger,
                        ),
                      ),
                    ),
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      side: BorderSide(color: AppColors.danger.withValues(alpha: 0.5)),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),

              // Dispute Action
              IconButton(
                onPressed: onOpenDispute,
                tooltip: 'File Attendance Dispute',
                icon: const Icon(Icons.rate_review_outlined, color: AppColors.primaryLight, size: 20),
                style: IconButton.styleFrom(
                  backgroundColor: AppColors.primary.withValues(alpha: 0.15),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
