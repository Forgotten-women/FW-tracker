import 'package:flutter/material.dart';

import '../../models/attendance.dart';
import '../../theme.dart';
import '../glass/glass.dart';

class AttendanceTimelineCard extends StatelessWidget {
  final List<Attendance> history;
  final Map<String, CorrectionRequest> disputesByDate;
  final ValueChanged<Attendance> onDayTapped;
  final VoidCallback onDisputeDay;

  /// Opens the full attendance history; the button is hidden when null.
  final VoidCallback? onSeeFullHistory;

  const AttendanceTimelineCard({
    super.key,
    required this.history,
    required this.disputesByDate,
    required this.onDayTapped,
    required this.onDisputeDay,
    this.onSeeFullHistory,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SectionLabel(
          'Attendance log · past 7 days',
          trailing: TextButton.icon(
            onPressed: onDisputeDay,
            style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
            icon: const Icon(Icons.edit_note_rounded, size: 16),
            label: const Text('Dispute a day', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800)),
          ),
        ),
        GlassCard(
          radius: 22,
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: history.isEmpty
              ? Padding(
                  padding: const EdgeInsets.all(22),
                  child: Center(
                    child: Text(
                      'No attendance history recorded yet.',
                      style: TextStyle(color: AppColors.textSecondary, fontSize: 13),
                    ),
                  ),
                )
              : Column(
                  children: [
                    for (var i = 0; i < history.length; i++) ...[
                      if (i > 0) Divider(height: 1, indent: 14, endIndent: 14, color: AppColors.border),
                      _buildDayRow(history[i], disputesByDate[history[i].date]),
                    ],
                  ],
                ),
        ),
        if (onSeeFullHistory != null) ...[
          const SizedBox(height: 10),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: onSeeFullHistory,
              style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46)),
              icon: const Icon(Icons.calendar_month_rounded, size: 18),
              label: const Text('See full history', style: TextStyle(fontWeight: FontWeight.w800)),
            ),
          ),
        ],
      ],
    );
  }

  Widget _buildDayRow(Attendance day, CorrectionRequest? dispute) {
    final bool isPresent = day.totalMinutes > 0;
    final Color statusTone;
    final String statusText;

    if (dispute != null) {
      if (dispute.isApproved) {
        statusTone = AppColors.teal;
        statusText = 'Resolved';
      } else if (dispute.isRejected) {
        statusTone = AppColors.danger;
        statusText = 'Rejected';
      } else {
        statusTone = AppColors.amber;
        statusText = 'Disputed';
      }
    } else if (day.status == PresenceStatus.inOffice) {
      statusTone = AppColors.teal;
      statusText = 'Present';
    } else if (day.status == PresenceStatus.gracePeriod) {
      statusTone = AppColors.amber;
      statusText = 'Grace';
    } else if (isPresent) {
      statusTone = AppColors.teal;
      statusText = 'Logged';
    } else {
      statusTone = AppColors.neutral;
      statusText = 'Off / absent';
    }

    return InkWell(
      onTap: () => onDayTapped(day),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: Row(
          children: [
            Container(
              width: 46,
              padding: const EdgeInsets.symmetric(vertical: 6),
              decoration: BoxDecoration(
                color: AppColors.cardRaised,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.glassBorder),
              ),
              child: Column(
                children: [
                  Text(
                    _dayOfWeek(day.date),
                    style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: AppColors.textTertiary),
                  ),
                  Text(
                    _dayNumber(day.date),
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        day.timeWorkedFormatted.isEmpty ? '0h 0m' : day.timeWorkedFormatted,
                        style: monoStyle(fontSize: 13.5),
                      ),
                      const SizedBox(width: 8),
                      Flexible(
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                          decoration: BoxDecoration(
                            color: statusTone.withValues(alpha: 0.14),
                            borderRadius: BorderRadius.circular(7),
                          ),
                          child: Text(
                            statusText,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: statusTone),
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(
                    day.firstCheckIn.isEmpty && day.lastActiveTime.isEmpty
                        ? 'No punches recorded'
                        : 'In ${day.firstCheckIn.isEmpty ? "—" : day.firstCheckIn}  ·  Out ${day.lastActiveTime.isEmpty ? "—" : day.lastActiveTime}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: AppColors.textTertiary),
                  ),
                  if (day.hasDeficit) ...[
                    const SizedBox(height: 3),
                    Row(
                      children: [
                        Icon(Icons.schedule_rounded, size: 12, color: AppColors.amber),
                        const SizedBox(width: 4),
                        Expanded(
                          child: Text(
                            _deficitSummary(day),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: AppColors.amber),
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
            Icon(Icons.chevron_right_rounded, color: AppColors.textTertiary, size: 20),
          ],
        ),
      ),
    );
  }

  /// A compact, single-line summary of every non-zero deficit reason for a
  /// day, e.g. "Late 12m · Break +8m". Approved adjustments are shown too
  /// (as a reduction) since they're part of the same running total and an
  /// employee should be able to see they were credited back.
  String _deficitSummary(Attendance day) {
    final parts = <String>[];
    if (day.lateMinutes > 0) parts.add('Late ${day.lateMinutes}m');
    if (day.excessBreakMinutes > 0) parts.add('Break +${day.excessBreakMinutes}m');
    if (day.earlyDepartureMinutes > 0) parts.add('Early ${day.earlyDepartureMinutes}m');
    if (day.unauthorisedMissingMinutes > 0) {
      parts.add('Missing ${day.unauthorisedMissingMinutes}m');
    }
    if (day.approvedAdjustmentMinutes > 0) {
      parts.add('−${day.approvedAdjustmentMinutes}m adj.');
    }
    if (parts.isEmpty) return '${day.dailyDeficitMinutes}m deficit';
    return parts.join(' · ');
  }

  String _dayOfWeek(String dateStr) {
    final dt = DateTime.tryParse(dateStr);
    if (dt == null) return '';
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return days[dt.weekday - 1];
  }

  String _dayNumber(String dateStr) {
    final dt = DateTime.tryParse(dateStr);
    if (dt == null) return dateStr;
    return '${dt.day}';
  }
}
