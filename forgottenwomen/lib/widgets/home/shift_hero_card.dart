import 'package:flutter/material.dart';

import '../../models/attendance.dart';
import '../../theme.dart';

class ShiftHeroCard extends StatelessWidget {
  final TodayAttendanceDetails todayDetails;
  final DateTime liveNow;
  final bool isVerified;
  final String? networkSsid;

  const ShiftHeroCard({
    super.key,
    required this.todayDetails,
    required this.liveNow,
    this.isVerified = false,
    this.networkSsid,
  });

  @override
  Widget build(BuildContext context) {
    final attendance = todayDetails.attendance;
    final breakInfo = todayDetails.breakInfo;
    final bool onBreak = breakInfo.onBreak;
    final bool isPresent = attendance.status == PresenceStatus.inOffice ||
        attendance.status == PresenceStatus.gracePeriod;

    Color statusTone;
    String statusLabel;
    IconData statusIcon;

    if (onBreak) {
      statusTone = AppColors.amber;
      statusLabel = 'ON BREAK';
      statusIcon = Icons.coffee_rounded;
    } else if (isPresent) {
      statusTone = AppColors.teal;
      statusLabel = isVerified ? 'IN OFFICE' : 'ON NETWORK';
      statusIcon = Icons.verified_rounded;
    } else if (attendance.status == PresenceStatus.away) {
      statusTone = const Color(0xFF64748B);
      statusLabel = 'OFF-SITE';
      statusIcon = Icons.person_off_outlined;
    } else {
      statusTone = const Color(0xFF64748B);
      statusLabel = 'NOT CHECKED IN';
      statusIcon = Icons.radio_button_unchecked_rounded;
    }

    // Daily target is 7h 30m = 450 minutes
    const int targetMinutes = 450;
    final int workedMinutes = attendance.totalMinutes;
    final double progress = (workedMinutes / targetMinutes).clamp(0.0, 1.0);
    final int percent = (progress * 100).round();

    // Formatted worked time
    final int hours = workedMinutes ~/ 60;
    final int mins = workedMinutes % 60;
    final String workedFormatted = '${hours}h ${mins.toString().padLeft(2, '0')}m';

    // Remaining time to target
    final int remainingMinutes = (targetMinutes - workedMinutes).clamp(0, targetMinutes);
    final int remHours = remainingMinutes ~/ 60;
    final int remMins = remainingMinutes % 60;
    final String remainingFormatted = remainingMinutes == 0
        ? 'Target Completed! 🎉'
        : '${remHours > 0 ? '${remHours}h ' : ''}${remMins}m remaining';

    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(22),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            statusTone.withValues(alpha: 0.12),
            AppColors.surfaceDark,
            AppColors.surfaceDark,
          ],
        ),
        border: Border.all(
          color: statusTone.withValues(alpha: 0.35),
          width: 1.2,
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.35),
            blurRadius: 18,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Top Row: Status Pill & Date
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(
                    color: statusTone.withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: statusTone.withValues(alpha: 0.5)),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: statusTone,
                          boxShadow: [
                            BoxShadow(
                              color: statusTone.withValues(alpha: 0.8),
                              blurRadius: 6,
                              spreadRadius: 1,
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 7),
                      Icon(statusIcon, size: 14, color: statusTone),
                      const SizedBox(width: 5),
                      Text(
                        statusLabel,
                        style: TextStyle(
                          color: statusTone,
                          fontWeight: FontWeight.bold,
                          fontSize: 11,
                          letterSpacing: 0.8,
                        ),
                      ),
                    ],
                  ),
                ),
                Text(
                  _formatTodayHeader(liveNow),
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textMuted,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 18),

            // Time Worked Big Display
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(
                  workedFormatted,
                  style: const TextStyle(
                    fontSize: 34,
                    fontWeight: FontWeight.w800,
                    color: Colors.white,
                    letterSpacing: -1.0,
                    height: 1.1,
                  ),
                ),
                const SizedBox(width: 10),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppColors.primaryLight.withValues(alpha: 0.3)),
                  ),
                  child: Text(
                    '$percent%',
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                      color: AppColors.primaryLight,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              'Target: 7h 30m • $remainingFormatted',
              style: const TextStyle(
                fontSize: 12,
                color: AppColors.textMuted,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 16),

            // Sleek Rounded Progress Bar
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: SizedBox(
                height: 8,
                child: LinearProgressIndicator(
                  value: progress,
                  backgroundColor: AppColors.border,
                  valueColor: AlwaysStoppedAnimation<Color>(
                    progress >= 1.0 ? AppColors.teal : AppColors.primaryLight,
                  ),
                ),
              ),
            ),
            const SizedBox(height: 18),

            // Punch in / out info chips
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: AppColors.bgDark.withValues(alpha: 0.6),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AppColors.border.withValues(alpha: 0.7)),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: _buildMetaChip(
                      icon: Icons.login_rounded,
                      label: 'First In',
                      value: attendance.firstCheckIn.isEmpty
                          ? '—'
                          : attendance.firstCheckIn,
                      valueColor: AppColors.teal,
                    ),
                  ),
                  Container(
                    width: 1,
                    height: 24,
                    color: AppColors.border,
                  ),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.only(left: 12),
                      child: _buildMetaChip(
                        icon: Icons.access_time_rounded,
                        label: 'Last Seen',
                        value: attendance.lastActiveTime.isEmpty
                            ? '—'
                            : attendance.lastActiveTime,
                        valueColor: Colors.white,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMetaChip({
    required IconData icon,
    required String label,
    required String value,
    required Color valueColor,
  }) {
    return Row(
      children: [
        Icon(icon, size: 16, color: AppColors.textMuted),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: const TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w500,
                  color: AppColors.textMuted,
                ),
              ),
              Text(
                value,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  color: valueColor,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  String _formatTodayHeader(DateTime dt) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ];
    final dayName = days[dt.weekday - 1];
    final monthName = months[dt.month - 1];
    return '$dayName, $monthName ${dt.day}';
  }
}
