import 'package:flutter/material.dart';

import '../../models/attendance.dart';
import '../../theme.dart';
import '../glass/glass.dart';

/// Today's work sessions as a vertical timeline: each session is a node with
/// its time range and duration; the open session reads "Working now".
class TodayTimelineCard extends StatelessWidget {
  final List<WorkSession> sessions;

  /// Live duration for the open session (ticks with the local clock).
  final String Function(WorkSession s)? liveDuration;
  final VoidCallback? onHistoryTapped;

  const TodayTimelineCard({
    super.key,
    required this.sessions,
    this.liveDuration,
    this.onHistoryTapped,
  });

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  "Today's timeline",
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
                ),
              ),
              if (onHistoryTapped != null)
                TextButton(
                  onPressed: onHistoryTapped,
                  style: TextButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800),
                  ),
                  child: const Text('History'),
                ),
            ],
          ),
          const SizedBox(height: 8),
          for (var i = 0; i < sessions.length; i++)
            _node(sessions[i], isLast: i == sessions.length - 1),
        ],
      ),
    );
  }

  Widget _node(WorkSession s, {required bool isLast}) {
    final Color tone = s.open ? AppColors.primary : AppColors.teal;
    final String duration = (s.open && liveDuration != null) ? liveDuration!(s) : s.duration;

    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 16,
            child: Column(
              children: [
                const SizedBox(height: 3),
                Container(
                  width: 12,
                  height: 12,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: tone,
                    boxShadow: [BoxShadow(color: tone.withValues(alpha: 0.25), spreadRadius: 4)],
                  ),
                ),
                if (!isLast)
                  Expanded(
                    child: Container(
                      width: 2,
                      margin: const EdgeInsets.symmetric(vertical: 4),
                      color: AppColors.primary.withValues(alpha: 0.18),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          s.open ? 'Working now' : 'Session',
                          style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: AppColors.textPrimary),
                        ),
                        const SizedBox(height: 1),
                        Text(
                          '${s.from} → ${s.to}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 11, fontWeight: FontWeight.w500, color: AppColors.textTertiary),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    duration,
                    style: monoStyle(fontSize: 11.5, color: s.open ? AppColors.primaryLight : AppColors.textSecondary),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
