import 'package:flutter/material.dart';

import '../../models/attendance.dart';
import '../../theme.dart';
import '../glass/glass.dart';

/// Mon–Fri of the current week. Today is highlighted; each past day carries a
/// dot for how it went (target met / short / nothing logged). Tapping a past
/// day opens its timesheet.
class WeekStrip extends StatelessWidget {
  final DateTime today;
  final Map<String, Attendance> daysByDate;
  final int dailyTargetMinutes;
  final ValueChanged<Attendance> onDayTapped;

  const WeekStrip({
    super.key,
    required this.today,
    required this.daysByDate,
    required this.dailyTargetMinutes,
    required this.onDayTapped,
  });

  static String dateKey(DateTime d) =>
      '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  static List<DateTime> weekdaysOf(DateTime today) {
    final monday = DateTime(today.year, today.month, today.day)
        .subtract(Duration(days: today.weekday - 1));
    return List.generate(5, (i) => monday.add(Duration(days: i)));
  }

  @override
  Widget build(BuildContext context) {
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    final days = weekdaysOf(today);
    final todayKey = dateKey(today);

    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(8),
      child: Row(
        children: [
          for (var i = 0; i < 5; i++)
            Expanded(child: _day(names[i], days[i], dateKey(days[i]) == todayKey)),
        ],
      ),
    );
  }

  Widget _day(String name, DateTime date, bool isToday) {
    final key = dateKey(date);
    final record = daysByDate[key];
    final bool isFuture = date.isAfter(today) && !isToday;

    Color? dot;
    if (!isFuture && !isToday) {
      if (record == null || record.totalMinutes <= 0) {
        dot = AppColors.neutral.withValues(alpha: 0.6);
      } else if (record.totalMinutes >= dailyTargetMinutes && !record.hasDeficit) {
        dot = AppColors.teal;
      } else {
        dot = AppColors.amber;
      }
    }

    final content = AnimatedContainer(
      duration: const Duration(milliseconds: 200),
      padding: const EdgeInsets.symmetric(vertical: 9),
      margin: const EdgeInsets.symmetric(horizontal: 2),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        gradient: isToday ? AppColors.accentGradient : null,
        boxShadow: isToday
            ? [BoxShadow(color: AppColors.primary.withValues(alpha: 0.35), blurRadius: 14, offset: const Offset(0, 6))]
            : null,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            name,
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w600,
              color: isToday ? AppColors.onAccent.withValues(alpha: 0.85) : AppColors.textTertiary,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            '${date.day}',
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w800,
              color: isToday
                  ? AppColors.onAccent
                  : (isFuture ? AppColors.textTertiary : AppColors.textPrimary),
            ),
          ),
          const SizedBox(height: 4),
          Container(
            width: 5,
            height: 5,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: isToday ? AppColors.onAccent : (dot ?? Colors.transparent),
            ),
          ),
        ],
      ),
    );

    if (record == null || isToday || isFuture) return content;
    return InkWell(
      onTap: () => onDayTapped(record),
      borderRadius: BorderRadius.circular(16),
      child: content,
    );
  }
}
