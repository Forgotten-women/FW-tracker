import 'package:flutter/material.dart';

import '../../models/attendance.dart';
import '../../theme.dart';

class AttendanceTimelineCard extends StatelessWidget {
  final List<Attendance> history;
  final Map<String, CorrectionRequest> disputesByDate;
  final ValueChanged<Attendance> onDayTapped;
  final VoidCallback onDisputeDay;

  const AttendanceTimelineCard({
    super.key,
    required this.history,
    required this.disputesByDate,
    required this.onDayTapped,
    required this.onDisputeDay,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const Text(
              'ATTENDANCE LOG (PAST 7 DAYS)',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.bold,
                letterSpacing: 1.1,
                color: AppColors.textMuted,
              ),
            ),
            TextButton.icon(
              onPressed: onDisputeDay,
              icon: const Icon(Icons.edit_note, size: 16, color: AppColors.primaryLight),
              label: const Text(
                'Dispute a Day',
                style: TextStyle(
                  fontSize: 12,
                  color: AppColors.primaryLight,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        if (history.isEmpty)
          Container(
            padding: const EdgeInsets.all(22),
            decoration: BoxDecoration(
              color: AppColors.surfaceDark,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.border),
            ),
            child: const Center(
              child: Text(
                'No attendance history recorded yet.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 13),
              ),
            ),
          )
        else
          ListView.separated(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: history.length,
            separatorBuilder: (_, _) => const SizedBox(height: 8),
            itemBuilder: (context, index) {
              final day = history[index];
              final dispute = disputesByDate[day.date];
              return _buildDayTile(context, day, dispute);
            },
          ),
      ],
    );
  }

  Widget _buildDayTile(BuildContext context, Attendance day, CorrectionRequest? dispute) {
    final bool isPresent = day.totalMinutes > 0;
    final Color statusTone;
    final String statusText;

    if (dispute != null) {
      if (dispute.isApproved) {
        statusTone = AppColors.teal;
        statusText = 'DISPUTE RESOLVED';
      } else if (dispute.isRejected) {
        statusTone = AppColors.danger;
        statusText = 'DISPUTE REJECTED';
      } else {
        statusTone = AppColors.amber;
        statusText = 'DISPUTE PENDING';
      }
    } else if (day.status == PresenceStatus.inOffice) {
      statusTone = AppColors.teal;
      statusText = 'PRESENT';
    } else if (day.status == PresenceStatus.gracePeriod) {
      statusTone = AppColors.amber;
      statusText = 'GRACE';
    } else if (isPresent) {
      statusTone = AppColors.teal;
      statusText = 'LOGGED';
    } else {
      statusTone = const Color(0xFF64748B);
      statusText = 'OFF / ABSENT';
    }

    return InkWell(
      onTap: () => onDayTapped(day),
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: AppColors.surfaceDark,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: [
            // Date Pill
            Container(
              width: 52,
              padding: const EdgeInsets.symmetric(vertical: 6),
              decoration: BoxDecoration(
                color: AppColors.bgDark,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.border),
              ),
              child: Column(
                children: [
                  Text(
                    _extractDayOfWeek(day.date),
                    style: const TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                      color: AppColors.textMuted,
                    ),
                  ),
                  Text(
                    _extractDayNumber(day.date),
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w800,
                      color: Colors.white,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 14),

            // Timestamps
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        day.timeWorkedFormatted.isEmpty ? '0h 0m' : day.timeWorkedFormatted,
                        style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.bold,
                          color: Colors.white,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: statusTone.withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(color: statusTone.withValues(alpha: 0.4)),
                        ),
                        child: Text(
                          statusText,
                          style: TextStyle(
                            fontSize: 9,
                            fontWeight: FontWeight.bold,
                            color: statusTone,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    day.firstCheckIn.isEmpty && day.lastActiveTime.isEmpty
                        ? 'No punches recorded'
                        : 'In: ${day.firstCheckIn.isEmpty ? "—" : day.firstCheckIn}  •  Out: ${day.lastActiveTime.isEmpty ? "—" : day.lastActiveTime}',
                    style: const TextStyle(
                      fontSize: 11,
                      color: AppColors.textMuted,
                    ),
                  ),
                ],
              ),
            ),

            const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted, size: 20),
          ],
        ),
      ),
    );
  }

  String _extractDayOfWeek(String dateStr) {
    final dt = DateTime.tryParse(dateStr);
    if (dt == null) return '';
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return days[dt.weekday - 1];
  }

  String _extractDayNumber(String dateStr) {
    final dt = DateTime.tryParse(dateStr);
    if (dt == null) return dateStr;
    return '${dt.day}';
  }
}
