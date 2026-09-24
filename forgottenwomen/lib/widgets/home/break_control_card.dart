import 'package:flutter/material.dart';

import '../../models/attendance.dart';
import '../../theme.dart';
import '../glass/glass.dart';

/// Idle: four one-tap quick actions (break, clock out, dispute, concerns).
/// On break: a live countdown card with the end-break action.
class BreakControlCard extends StatelessWidget {
  final ActiveBreakInfo breakInfo;
  final DateTime liveNow;
  final bool isSubmitting;
  final VoidCallback onToggleBreak;
  final VoidCallback onClockOut;
  final VoidCallback onOpenDispute;
  final VoidCallback onOpenConcerns;

  const BreakControlCard({
    super.key,
    required this.breakInfo,
    required this.liveNow,
    required this.isSubmitting,
    required this.onToggleBreak,
    required this.onClockOut,
    required this.onOpenDispute,
    required this.onOpenConcerns,
  });

  @override
  Widget build(BuildContext context) {
    if (breakInfo.onBreak) return _buildActiveBreakCard();
    return _buildQuickActions();
  }

  Widget _buildActiveBreakCard() {
    final int startedMs = breakInfo.startedAtMs ?? liveNow.millisecondsSinceEpoch;
    final int elapsedSeconds =
        ((liveNow.millisecondsSinceEpoch - startedMs) / 1000).floor().clamp(0, 999999);
    final int permittedSeconds = breakInfo.permittedMinutes * 60;
    final int remainingSeconds = permittedSeconds - elapsedSeconds;
    final bool isOverdue = remainingSeconds < 0;

    final int shown = isOverdue ? -remainingSeconds : remainingSeconds;
    final String countdown =
        '${isOverdue ? '+' : ''}${shown ~/ 60}:${(shown % 60).toString().padLeft(2, '0')}';
    final double progress =
        permittedSeconds > 0 ? (elapsedSeconds / permittedSeconds).clamp(0.0, 1.0) : 1.0;
    final Color tone = isOverdue ? AppColors.danger : AppColors.amber;

    return GlassCard(
      radius: 24,
      borderColor: tone.withValues(alpha: 0.45),
      padding: const EdgeInsets.all(18),
      child: Column(
        children: [
          Row(
            children: [
              ProgressRing(
                progress: progress,
                size: 64,
                stroke: 7,
                colors: [tone, tone],
                trackColor: tone.withValues(alpha: 0.16),
                child: Icon(Icons.coffee_rounded, color: tone, size: 22),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      isOverdue ? 'Break exceeded' : 'On break',
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w800,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(countdown, style: monoStyle(fontSize: 26, color: tone, letterSpacing: -0.8)),
                    Text(
                      breakInfo.dueBackDisplay != null
                          ? 'Due back at ${breakInfo.dueBackDisplay}'
                          : '${breakInfo.permittedMinutes}m allowance',
                      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            height: 50,
            child: FilledButton.icon(
              onPressed: isSubmitting ? null : onToggleBreak,
              icon: isSubmitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.onAccent),
                    )
                  : const Icon(Icons.play_arrow_rounded, size: 22),
              label: Text(isSubmitting ? 'Ending break…' : 'End break and resume'),
              style: FilledButton.styleFrom(
                backgroundColor: tone,
                foregroundColor: AppColors.onAccent,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildQuickActions() {
    return Row(
      children: [
        Expanded(
          child: _action(
            label: isSubmitting ? 'Starting…' : 'Break',
            icon: Icons.coffee_rounded,
            colors: const [Color(0xFFFBBF24), Color(0xFFF59E0B)],
            onTap: isSubmitting ? null : onToggleBreak,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: _action(
            label: 'Clock out',
            icon: Icons.logout_rounded,
            colors: const [Color(0xFFFB7185), Color(0xFFE11D48)],
            onTap: isSubmitting ? null : onClockOut,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: _action(
            label: 'Dispute',
            icon: Icons.edit_note_rounded,
            colors: [AppColors.primary, AppColors.accentEnd],
            onTap: onOpenDispute,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: _action(
            label: 'Concerns',
            icon: Icons.shield_outlined,
            colors: const [Color(0xFF2DD4BF), Color(0xFF0D9488)],
            onTap: onOpenConcerns,
          ),
        ),
      ],
    );
  }

  Widget _action({
    required String label,
    required IconData icon,
    required List<Color> colors,
    required VoidCallback? onTap,
  }) {
    return Semantics(
      button: true,
      label: label,
      child: GlassCard(
        radius: 20,
        onTap: onTap,
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
        child: Column(
          children: [
            Opacity(
              opacity: onTap == null ? 0.5 : 1,
              child: GradientIconTile(icon: icon, colors: colors, size: 42),
            ),
            const SizedBox(height: 8),
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w700,
                color: AppColors.textPrimary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
