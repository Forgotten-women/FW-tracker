import 'package:flutter/material.dart';

import '../../models/history.dart';
import '../../theme.dart';
import '../glass/glass.dart';

/// How one day outcome is drawn: a colour and a glyph, so no two outcomes are
/// told apart by colour alone.
class HistoryTone {
  final Color color;
  final IconData icon;
  final String legend;
  const HistoryTone(this.color, this.icon, this.legend);
}

// Hues the base palette doesn't have, in a light- and a dark-mode shade so
// they read on both canvases.
Color get _orange => AppColors.isDark ? const Color(0xFFFB923C) : const Color(0xFFC2410C);
Color get _sky => AppColors.isDark ? const Color(0xFF38BDF8) : const Color(0xFF0369A1);
Color get _violet => AppColors.isDark ? const Color(0xFFC084FC) : const Color(0xFF7E22CE);

HistoryTone historyTone(HistoryDayStatus s) {
  switch (s) {
    case HistoryDayStatus.onTime:
      return HistoryTone(AppColors.teal, Icons.check_rounded, 'On time');
    case HistoryDayStatus.late:
      return HistoryTone(AppColors.amber, Icons.schedule_rounded, 'Late');
    case HistoryDayStatus.short:
      return HistoryTone(_orange, Icons.hourglass_bottom_rounded, 'Short of hours');
    case HistoryDayStatus.absent:
      return HistoryTone(AppColors.danger, Icons.close_rounded, 'Absent');
    case HistoryDayStatus.onLeave:
      return HistoryTone(_sky, Icons.flight_takeoff_rounded, 'Leave');
    case HistoryDayStatus.holiday:
      return HistoryTone(_violet, Icons.star_rounded, 'Holiday');
    case HistoryDayStatus.restDay:
      return HistoryTone(AppColors.neutral, Icons.weekend_outlined, 'Rest day');
    case HistoryDayStatus.restDayWorked:
      return HistoryTone(AppColors.tealDark, Icons.work_outline_rounded, 'Worked a rest day');
    case HistoryDayStatus.notEmployed:
      return HistoryTone(AppColors.textTertiary, Icons.remove_rounded, 'Not employed');
    case HistoryDayStatus.inProgress:
      return HistoryTone(AppColors.primaryLight, Icons.play_arrow_rounded, 'Today, in progress');
    case HistoryDayStatus.notStarted:
      return HistoryTone(AppColors.primaryLight, Icons.more_horiz_rounded, 'Today, not arrived');
    case HistoryDayStatus.unknown:
      return HistoryTone(AppColors.neutral, Icons.help_outline_rounded, 'Unknown');
  }
}

/// A tone's glyph on a tinted rounded square, as used in the legend and the
/// day header.
class HistoryGlyph extends StatelessWidget {
  final HistoryTone tone;
  final double size;
  const HistoryGlyph({super.key, required this.tone, this.size = 20});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: tone.color.withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(size * 0.3),
        border: Border.all(color: tone.color.withValues(alpha: 0.5)),
      ),
      child: Icon(tone.icon, size: size * 0.66, color: tone.color),
    );
  }
}

/// The month as a Monday-first calendar. Each recorded day is a coloured cell
/// with its date and glyph; days after today are faint and inert.
class HistoryMonthGrid extends StatelessWidget {
  final DateTime month;
  final Map<String, DaySummary> days;
  final DateTime today;
  final ValueChanged<DaySummary> onDayTap;

  const HistoryMonthGrid({
    super.key,
    required this.month,
    required this.days,
    required this.today,
    required this.onDayTap,
  });

  static const weekdayInitials = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  @override
  Widget build(BuildContext context) {
    final first = monthOf(month);
    final daysInMonth = lastDayOfMonth(first).day;
    final lead = first.weekday - 1;
    final rows = ((lead + daysInMonth) / 7).ceil();
    final todayKey = historyDateKey(today);

    return Column(
      children: [
        ExcludeSemantics(
          child: Row(
            children: [
              for (final w in weekdayInitials)
                Expanded(
                  child: Center(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        child: Text(
                          w,
                          style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: AppColors.textTertiary),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        for (var r = 0; r < rows; r++)
          Row(
            children: [
              for (var c = 0; c < 7; c++)
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.all(2),
                    child: AspectRatio(
                      aspectRatio: 0.84,
                      child: _cell(r * 7 + c - lead + 1, daysInMonth, first, todayKey),
                    ),
                  ),
                ),
            ],
          ),
      ],
    );
  }

  Widget _cell(int dayNumber, int daysInMonth, DateTime first, String todayKey) {
    if (dayNumber < 1 || dayNumber > daysInMonth) return const SizedBox.shrink();
    final date = DateTime(first.year, first.month, dayNumber);
    final key = historyDateKey(date);
    final summary = days[key];
    final isToday = key == todayKey;
    final isFuture = key.compareTo(todayKey) > 0;
    return HistoryDayCell(
      date: date,
      summary: summary,
      isToday: isToday,
      isFuture: isFuture,
      onTap: summary == null ? null : () => onDayTap(summary),
    );
  }
}

class HistoryDayCell extends StatelessWidget {
  final DateTime date;
  final DaySummary? summary;
  final bool isToday;
  final bool isFuture;
  final VoidCallback? onTap;

  const HistoryDayCell({
    super.key,
    required this.date,
    required this.summary,
    required this.isToday,
    required this.isFuture,
    this.onTap,
  });

  /// What a screen reader says for the cell.
  static String semanticLabel(DateTime date, DaySummary? s, {bool isToday = false, bool isFuture = false}) {
    final parts = <String>[formatLongDate(date)];
    if (isToday) parts.add('today');
    if (isFuture) {
      parts.add('not yet');
    } else if (s == null) {
      parts.add('no record');
    } else {
      parts.add(s.statusLabel);
      if (s.workedMinutes > 0) parts.add('worked ${formatHistoryMinutes(s.workedMinutes)}');
      if (s.deficit.totalMinutes > 0) parts.add('deficit ${formatHistoryMinutes(s.deficit.totalMinutes)}');
      if (s.leave != null && s.leave!.isPending) parts.add('leave request pending');
      if (s.corrections.pending > 0) {
        parts.add(s.corrections.pending == 1 ? 'correction pending' : '${s.corrections.pending} corrections pending');
      }
    }
    return parts.join(', ');
  }

  @override
  Widget build(BuildContext context) {
    final s = summary;
    final tone = s == null ? null : historyTone(s.status);
    final notEmployed = s?.status == HistoryDayStatus.notEmployed;
    final Color fill;
    final Color border;
    if (tone == null) {
      fill = AppColors.overlay(isFuture ? 0.02 : 0.04);
      border = AppColors.border;
    } else if (notEmployed) {
      fill = Colors.transparent;
      border = AppColors.border;
    } else {
      fill = tone.color.withValues(alpha: AppColors.isDark ? 0.18 : 0.14);
      border = tone.color.withValues(alpha: 0.45);
    }
    final numberColor = isFuture || notEmployed
        ? AppColors.textTertiary
        : AppColors.textPrimary;
    final br = BorderRadius.circular(12);
    final pendingDot = s != null && (s.corrections.pending > 0 || (s.leave?.isPending ?? false));

    Widget cell = Container(
      decoration: BoxDecoration(
        color: fill,
        borderRadius: br,
        border: Border.all(
          color: isToday ? AppColors.primary : border,
          width: isToday ? 2 : 1,
        ),
      ),
      child: Stack(
        children: [
          Positioned.fill(
            child: Padding(
              padding: const EdgeInsets.all(3),
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      '${date.day}',
                      style: monoStyle(
                        fontSize: 13,
                        fontWeight: isToday ? FontWeight.w800 : FontWeight.w700,
                        color: numberColor,
                      ),
                    ),
                    const SizedBox(height: 2),
                    if (tone != null)
                      Icon(tone.icon, size: 14, color: tone.color)
                    else
                      const SizedBox(height: 14),
                  ],
                ),
              ),
            ),
          ),
          if (pendingDot)
            Positioned(
              top: 4,
              right: 4,
              child: Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(color: AppColors.amber, shape: BoxShape.circle),
              ),
            ),
        ],
      ),
    );

    if (onTap != null) {
      cell = Material(
        type: MaterialType.transparency,
        child: InkWell(onTap: onTap, borderRadius: br, child: cell),
      );
    }

    return Semantics(
      // Its own node, so an inert (future) cell isn't merged into its row.
      container: true,
      button: onTap != null,
      label: semanticLabel(date, s, isToday: isToday, isFuture: isFuture),
      excludeSemantics: true,
      child: cell,
    );
  }
}

/// A placeholder month while the first load runs.
class HistoryGridSkeleton extends StatelessWidget {
  const HistoryGridSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Loading attendance',
      child: Column(
        children: [
          for (var r = 0; r < 5; r++)
            Row(
              children: [
                for (var c = 0; c < 7; c++)
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.all(2),
                      child: AspectRatio(
                        aspectRatio: 0.84,
                        child: Container(
                          decoration: BoxDecoration(
                            color: AppColors.border,
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
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

/// Every outcome the calendar can show, with its glyph.
class HistoryLegend extends StatelessWidget {
  const HistoryLegend({super.key});

  static const shown = [
    HistoryDayStatus.onTime,
    HistoryDayStatus.late,
    HistoryDayStatus.short,
    HistoryDayStatus.absent,
    HistoryDayStatus.onLeave,
    HistoryDayStatus.holiday,
    HistoryDayStatus.restDay,
    HistoryDayStatus.restDayWorked,
    HistoryDayStatus.notEmployed,
    HistoryDayStatus.inProgress,
  ];

  @override
  Widget build(BuildContext context) {
    Widget item(Widget glyph, String label) => Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            glyph,
            const SizedBox(width: 7),
            Flexible(
              child: Text(
                label,
                style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: AppColors.textSecondary),
              ),
            ),
          ],
        );

    return LayoutBuilder(
      builder: (context, constraints) {
        // Two columns at phone width, more when there's room.
        final cols = constraints.maxWidth >= 520 ? 3 : 2;
        const gap = 10.0;
        final w = (constraints.maxWidth - gap * (cols - 1)) / cols;
        return Wrap(
          spacing: gap,
          runSpacing: 10,
          children: [
            for (final s in shown)
              SizedBox(width: w, child: item(HistoryGlyph(tone: historyTone(s)), historyTone(s).legend)),
            SizedBox(
              width: w,
              child: item(
                SizedBox(
                  width: 20,
                  height: 20,
                  child: Center(
                    child: Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(color: AppColors.amber, shape: BoxShape.circle),
                    ),
                  ),
                ),
                'Request pending',
              ),
            ),
            SizedBox(
              width: w,
              child: item(
                Container(
                  width: 20,
                  height: 20,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppColors.primary, width: 2),
                  ),
                ),
                'Today',
              ),
            ),
          ],
        );
      },
    );
  }
}

String _days(double d) => d == d.roundToDouble() ? d.toStringAsFixed(0) : d.toStringAsFixed(1);

/// The month's totals as a two-column grid of labelled figures.
class HistoryTotalsCard extends StatelessWidget {
  final MonthTotals totals;
  const HistoryTotalsCard({super.key, required this.totals});

  @override
  Widget build(BuildContext context) {
    final t = totals;
    final tiles = <(String, String, Color?, IconData)>[
      ('Days present', '${t.daysPresent}', null, Icons.how_to_reg_rounded),
      ('On time', '${t.onTime}', historyTone(HistoryDayStatus.onTime).color, historyTone(HistoryDayStatus.onTime).icon),
      ('Late', '${t.late}', historyTone(HistoryDayStatus.late).color, historyTone(HistoryDayStatus.late).icon),
      ('Short of hours', '${t.short}', historyTone(HistoryDayStatus.short).color, historyTone(HistoryDayStatus.short).icon),
      ('Absent', '${t.absent}', historyTone(HistoryDayStatus.absent).color, historyTone(HistoryDayStatus.absent).icon),
      ('Leave days', _days(t.leaveDays), historyTone(HistoryDayStatus.onLeave).color, historyTone(HistoryDayStatus.onLeave).icon),
      ('Total worked', formatHistoryMinutes(t.workedMinutes), null, Icons.timer_outlined),
      (
        'Total deficit',
        formatHistoryMinutes(t.deficitMinutes),
        t.deficitMinutes > 0 ? AppColors.amber : AppColors.teal,
        Icons.trending_down_rounded,
      ),
    ];
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(12),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final cols = constraints.maxWidth >= 520 ? 4 : 2;
          const gap = 8.0;
          final w = (constraints.maxWidth - gap * (cols - 1)) / cols;
          return Wrap(
            spacing: gap,
            runSpacing: gap,
            children: [
              for (final tile in tiles)
                SizedBox(width: w, child: _tile(tile.$1, tile.$2, tile.$3, tile.$4)),
            ],
          );
        },
      ),
    );
  }

  Widget _tile(String label, String value, Color? tone, IconData icon) {
    return Semantics(
      container: true,
      label: '$label: $value',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
        decoration: BoxDecoration(
          color: AppColors.cardRaised,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.glassBorder),
        ),
        child: Row(
          children: [
            Icon(icon, size: 16, color: tone ?? AppColors.textTertiary),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: AppColors.textTertiary),
                  ),
                  const SizedBox(height: 2),
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(value, maxLines: 1, style: monoStyle(fontSize: 15, color: tone ?? AppColors.textPrimary)),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
