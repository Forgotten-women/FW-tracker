import 'package:flutter/material.dart';

import '../../models/attendance.dart';
import '../../theme.dart';
import '../glass/glass.dart';

/// Hero: live presence status, a progress ring for today's worked time
/// against the daily target, and first-in / remaining / last-seen tiles.
class ShiftHeroCard extends StatelessWidget {
  final TodayAttendanceDetails todayDetails;
  final DateTime liveNow;
  final bool isVerified;
  final String? networkSsid;
  final int? serverTimeMs;

  const ShiftHeroCard({
    super.key,
    required this.todayDetails,
    required this.liveNow,
    this.isVerified = false,
    this.networkSsid,
    this.serverTimeMs,
  });

  @override
  Widget build(BuildContext context) {
    final attendance = todayDetails.attendance;
    final breakInfo = todayDetails.breakInfo;
    final bool onBreak = breakInfo.onBreak;
    final bool hasActiveSession = attendance.sessions.any((s) => s.isOpen);
    final bool isPresent = attendance.status.isPresent || hasActiveSession;

    Color statusTone;
    String statusLabel;
    if (onBreak) {
      statusTone = AppColors.amber;
      statusLabel = 'ON BREAK';
    } else if (isPresent) {
      statusTone = AppColors.teal;
      statusLabel = isVerified ? 'IN OFFICE' : 'ON NETWORK';
    } else if (attendance.status == PresenceStatus.away) {
      statusTone = AppColors.neutral;
      statusLabel = 'OFF-SITE';
    } else if (attendance.status == PresenceStatus.closed) {
      statusTone = AppColors.neutral;
      statusLabel = 'SHIFT ENDED';
    } else {
      statusTone = AppColors.neutral;
      statusLabel = 'NOT CHECKED IN';
    }

    final serverTarget = todayDetails.workingHours.daily.requiredMinutes;
    final int targetMinutes = serverTarget > 0 ? serverTarget : 480;

    // Tick the worked total forward with the local clock while the employee
    // is present, so the ring moves between server syncs.
    int extraMinutes = 0;
    if (isPresent && !onBreak && serverTimeMs != null && serverTimeMs! > 0) {
      final elapsedMs = liveNow.millisecondsSinceEpoch - serverTimeMs!;
      if (elapsedMs > 0 && elapsedMs < 12 * 3600 * 1000) {
        extraMinutes = elapsedMs ~/ 60000;
      }
    }
    final int workedMinutes = attendance.totalMinutes + extraMinutes;
    final double progress = (workedMinutes / targetMinutes).clamp(0.0, 1.0);
    final int percent = (progress * 100).round();
    final int remainingMinutes = (targetMinutes - workedMinutes).clamp(0, targetMinutes);
    final bool targetMet = remainingMinutes == 0;

    final ringColors = onBreak
        ? [AppColors.amber, const Color(0xFFF97316), AppColors.amber]
        : targetMet
            ? [AppColors.teal, const Color(0xFF06B6D4), AppColors.teal]
            : [AppColors.primary, AppColors.accentEnd, const Color(0xFFEC4899)];

    final String networkLabel = isVerified
        ? 'Office Wi‑Fi'
        : (networkSsid != null && networkSsid!.isNotEmpty ? networkSsid! : 'Not verified');

    return GlassCard(
      blur: true,
      strong: true,
      radius: 28,
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
      child: Column(
        children: [
          Row(
            children: [
              StatusPill(label: statusLabel, tone: statusTone),
              const Spacer(),
              Icon(
                isVerified ? Icons.wifi_rounded : Icons.wifi_off_rounded,
                size: 14,
                color: AppColors.textSecondary,
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  networkLabel,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textSecondary,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ProgressRing(
            progress: progress,
            size: 196,
            stroke: 14,
            colors: ringColors,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  onBreak ? 'ON BREAK' : 'WORKED TODAY',
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.8,
                    color: AppColors.textTertiary,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  _fmt(workedMinutes),
                  style: monoStyle(fontSize: 32, letterSpacing: -1.2),
                ),
                const SizedBox(height: 2),
                Text(
                  targetMet ? 'Target reached' : 'of ${_fmt(targetMinutes)} · $percent%',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: targetMet ? AppColors.teal : AppColors.textSecondary,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: _tile(
                  'First in',
                  attendance.firstCheckIn.isEmpty ? '—' : attendance.firstCheckIn,
                  AppColors.textPrimary,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _tile(
                  'Remaining',
                  targetMet ? 'Done' : _fmt(remainingMinutes),
                  targetMet ? AppColors.teal : AppColors.primaryLight,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _tile(
                  'Last seen',
                  attendance.lastActiveTime.isEmpty ? '—' : attendance.lastActiveTime,
                  AppColors.textPrimary,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _tile(String label, String value, Color valueColor) {
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
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w600,
              color: AppColors.textTertiary,
            ),
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
                color: valueColor,
              ),
            ),
          ),
        ],
      ),
    );
  }

  static String _fmt(int minutes) =>
      '${minutes ~/ 60}h ${(minutes % 60).toString().padLeft(2, '0')}m';
}
