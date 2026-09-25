import 'package:flutter/material.dart';

import '../models/history.dart';
import '../services/api_client.dart';
import '../services/token_store.dart';
import '../theme.dart';
import '../widgets/glass/glass.dart';
import '../widgets/history/history_widgets.dart';
import 'history_day_screen.dart';

/// Attendance history, a month at a time, back to the first day of
/// employment. Each month comes from GET /api/attendance/mine/days and is
/// kept in memory for the session ([HistoryMonthCache]); the current month is
/// refetched once it is a couple of minutes old.
class HistoryScreen extends StatefulWidget {
  /// Defaults to a client of the screen's own (disposed with it).
  final ApiClient? api;
  final TokenStore? store;

  /// Month to open on; the current month when null.
  final DateTime? initialMonth;

  /// Called after a correction request is sent from a day, so the caller
  /// can refresh what it shows.
  final VoidCallback? onCorrectionSubmitted;

  /// The clock, for tests.
  final DateTime Function()? clock;

  const HistoryScreen({
    super.key,
    this.api,
    this.store,
    this.initialMonth,
    this.onCorrectionSubmitted,
    this.clock,
  });

  /// Forgets every month fetched, as a fresh launch would.
  @visibleForTesting
  static void clearCache() {
    _HistoryScreenState._cache.clear();
    _HistoryScreenState._employmentStartByOwner.clear();
  }

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  // In memory only, for the life of the app.
  static final HistoryMonthCache _cache = HistoryMonthCache();
  static final Map<String, String> _employmentStartByOwner = {};

  late final ApiClient _api = widget.api ?? ApiClient();
  late DateTime _month = monthOf(widget.initialMonth ?? _now());
  String? _owner;

  HistoryRange? _range;
  bool _loading = false;
  String? _error;
  bool _offline = false;
  int _generation = 0;

  DateTime _now() => (widget.clock ?? DateTime.now)();

  String? get _employmentStart => _owner == null ? null : _employmentStartByOwner[_owner!];

  DateTime get _maxMonth => monthOf(_now());

  /// The month employment began, or (when HR has no start date on file) a
  /// floor five years back so the pager still ends somewhere.
  DateTime get _minMonth {
    final start = parseDateKey(_employmentStart);
    if (start != null) return monthOf(start);
    final now = _now();
    return DateTime(now.year - 5, 1);
  }

  bool get _canGoBack => monthsBetween(_minMonth, _month) > 0;
  bool get _canGoForward => monthsBetween(_month, _maxMonth) > 0;

  @override
  void initState() {
    super.initState();
    if (monthsBetween(_month, _maxMonth) < 0) _month = _maxMonth;
    _start();
  }

  Future<void> _start() async {
    String owner = '';
    try {
      owner = await (widget.store ?? TokenStore()).readDeviceId() ?? '';
    } catch (_) {}
    if (!mounted) return;
    _owner = owner;
    _load();
  }

  @override
  void dispose() {
    if (widget.api == null) _api.dispose();
    super.dispose();
  }

  Future<void> _load({bool force = false}) async {
    final owner = _owner;
    if (owner == null) return;
    final month = _month;
    final now = _now();
    final generation = ++_generation;

    final fresh = force ? null : _cache.get(owner, month, now);
    if (fresh != null) {
      setState(() {
        _range = fresh;
        _error = null;
        _offline = false;
        _loading = false;
      });
      return;
    }

    setState(() {
      _range = _cache.getStale(owner, month);
      _loading = true;
      _error = null;
      _offline = false;
    });

    try {
      final res = await _api.fetchMyDays(historyDateKey(month), historyDateKey(lastDayOfMonth(month)));
      _cache.put(owner, month, res, now);
      if (res.employmentStart != null) _employmentStartByOwner[owner] = res.employmentStart!;
      if (!mounted || generation != _generation) return;
      setState(() {
        _range = res;
        _loading = false;
      });
    } catch (e) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _error = e is ApiException ? e.message : e.toString();
        _offline = e is ApiException && e.statusCode == null && e.code == null;
        _loading = false;
      });
    }
  }

  void _goTo(DateTime month) {
    var m = monthOf(month);
    if (monthsBetween(m, _maxMonth) < 0) m = _maxMonth;
    if (monthsBetween(_minMonth, m) < 0) m = _minMonth;
    if (m == _month && _range != null) return;
    _month = m;
    _load();
  }

  void _openDay(String dateKey, {DaySummary? summary}) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => HistoryDayScreen(
          dateKey: dateKey,
          api: _api,
          initial: summary,
          onCorrectionSubmitted: () {
            final d = parseDateKey(dateKey);
            if (_owner != null && d != null) _cache.invalidate(_owner!, monthOf(d));
            widget.onCorrectionSubmitted?.call();
            if (mounted && d != null && monthOf(d) == _month) _load(force: true);
          },
        ),
      ),
    );
  }

  Future<void> _openJumpPicker() async {
    final picked = await showModalBottomSheet<_Jump>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _JumpSheet(
        current: _month,
        minMonth: _minMonth,
        maxMonth: _maxMonth,
      ),
    );
    if (picked == null || !mounted) return;
    if (picked.pickDate) {
      final now = _now();
      final start = parseDateKey(_employmentStart) ?? _minMonth;
      final today = DateTime(now.year, now.month, now.day);
      var initial = _month == _maxMonth ? today : lastDayOfMonth(_month);
      if (initial.isBefore(start)) initial = start;
      if (initial.isAfter(today)) initial = today;
      final date = await showDatePicker(
        context: context,
        initialDate: initial,
        firstDate: start.isAfter(today) ? today : start,
        lastDate: today,
        helpText: 'Go to a date',
      );
      if (date == null || !mounted) return;
      _goTo(date);
      final key = historyDateKey(date);
      _openDay(key, summary: _range?.byDate[key]);
    } else {
      _goTo(picked.month!);
    }
  }

  @override
  Widget build(BuildContext context) {
    return GlassScaffold(
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        toolbarHeight: 64,
        titleSpacing: 4,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Attendance history',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, letterSpacing: -0.3, color: AppColors.textPrimary),
            ),
            Text(
              'Every day since you started',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: AppColors.textSecondary),
            ),
          ],
        ),
        actions: [
          _glassAction(Icons.event_note_rounded, 'Jump to a month or date', _openJumpPicker),
          _glassAction(
            Icons.refresh_rounded,
            'Refresh',
            _loading ? null : () => _load(force: true),
            busy: _loading,
          ),
          const SizedBox(width: 12),
        ],
      ),
      body: Column(
        children: [
          if (_loading && _range != null)
            LinearProgressIndicator(
              minHeight: 2.5,
              backgroundColor: Colors.transparent,
              valueColor: AlwaysStoppedAnimation<Color>(AppColors.primaryLight),
            ),
          Expanded(
            child: RefreshIndicator(
              color: AppColors.primary,
              onRefresh: () => _load(force: true),
              child: Align(
                alignment: Alignment.topCenter,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 720),
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 30),
                    children: _content(),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _glassAction(IconData icon, String tooltip, VoidCallback? onPressed, {bool busy = false}) {
    return Padding(
      padding: const EdgeInsets.only(left: 6),
      child: Tooltip(
        message: tooltip,
        child: Semantics(
          button: true,
          label: tooltip,
          excludeSemantics: true,
          child: SizedBox(
            width: 44,
            height: 44,
            child: GlassCard(
              radius: 15,
              padding: EdgeInsets.zero,
              onTap: onPressed,
              child: Center(
                child: busy
                    ? SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.textPrimary),
                      )
                    : Icon(icon, size: 19, color: AppColors.textPrimary),
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _content() {
    final range = _range;
    final start = parseDateKey(_employmentStart);
    final beforeEmployment = (start != null && lastDayOfMonth(_month).isBefore(start)) ||
        (range != null &&
            range.days.isNotEmpty &&
            range.days.every((d) => d.status == HistoryDayStatus.notEmployed));

    return [
      _monthHeader(),
      const SizedBox(height: 12),
      if (_error != null && range != null) ...[
        _staleBanner(),
        const SizedBox(height: 12),
      ],
      if (beforeEmployment)
        _beforeEmploymentCard(start)
      else if (range == null && _error != null)
        _errorCard()
      else ...[
        _gridCard(range, start),
        const SizedBox(height: 22),
        const SectionLabel('Month totals'),
        if (range == null)
          _totalsSkeleton()
        else
          HistoryTotalsCard(totals: MonthTotals.fromDays(range.days)),
      ],
      const SizedBox(height: 22),
      const SectionLabel('Key'),
      const GlassCard(radius: 22, padding: EdgeInsets.all(14), child: HistoryLegend()),
    ];
  }

  Widget _monthHeader() {
    final title = formatMonthTitle(_month);
    return GlassCard(
      radius: 20,
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
      child: Row(
        children: [
          IconButton(
            onPressed: _canGoBack ? () => _goTo(DateTime(_month.year, _month.month - 1)) : null,
            tooltip: 'Previous month',
            icon: const Icon(Icons.chevron_left_rounded),
            color: AppColors.textPrimary,
            disabledColor: AppColors.textTertiary.withValues(alpha: 0.5),
          ),
          Expanded(
            child: Semantics(
              button: true,
              label: '$title. Jump to a month or date',
              excludeSemantics: true,
              child: InkWell(
                onTap: _openJumpPicker,
                borderRadius: BorderRadius.circular(14),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Column(
                    children: [
                      FittedBox(
                        fit: BoxFit.scaleDown,
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              title,
                              style: TextStyle(fontSize: 16.5, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
                            ),
                            const SizedBox(width: 4),
                            Icon(Icons.expand_more_rounded, size: 18, color: AppColors.textSecondary),
                          ],
                        ),
                      ),
                      if (_month != _maxMonth)
                        Text(
                          'Tap to jump',
                          style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppColors.textTertiary),
                        )
                      else
                        Text(
                          'This month',
                          style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppColors.primaryLight),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          IconButton(
            onPressed: _canGoForward ? () => _goTo(DateTime(_month.year, _month.month + 1)) : null,
            tooltip: 'Next month',
            icon: const Icon(Icons.chevron_right_rounded),
            color: AppColors.textPrimary,
            disabledColor: AppColors.textTertiary.withValues(alpha: 0.5),
          ),
        ],
      ),
    );
  }

  Widget _gridCard(HistoryRange? range, DateTime? start) {
    final startsThisMonth = start != null && monthOf(start) == _month && start.day > 1;
    return GestureDetector(
      // Swipe between months.
      onHorizontalDragEnd: (d) {
        final v = d.primaryVelocity ?? 0;
        if (v < -250 && _canGoForward) _goTo(DateTime(_month.year, _month.month + 1));
        if (v > 250 && _canGoBack) _goTo(DateTime(_month.year, _month.month - 1));
      },
      child: GlassCard(
        radius: 22,
        padding: const EdgeInsets.fromLTRB(8, 12, 8, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (range == null)
              const HistoryGridSkeleton()
            else
              HistoryMonthGrid(
                month: _month,
                days: range.byDate,
                today: _now(),
                onDayTap: (d) => _openDay(d.dateKey, summary: d),
              ),
            if (range != null && range.days.isEmpty) ...[
              const SizedBox(height: 10),
              Text(
                'No attendance records for this month.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
              ),
            ],
            if (startsThisMonth) ...[
              const SizedBox(height: 10),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6),
                child: Text(
                  'Your employment started on ${formatShortDate(start)}. Earlier days are before you joined.',
                  style: TextStyle(fontSize: 11.5, height: 1.35, color: AppColors.textTertiary),
                ),
              ),
            ],
            const SizedBox(height: 4),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Text(
                'Tap a day for its full record.',
                style: TextStyle(fontSize: 11, color: AppColors.textTertiary),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _totalsSkeleton() {
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(12),
      child: Column(
        children: [
          for (var r = 0; r < 4; r++)
            Padding(
              padding: EdgeInsets.only(bottom: r == 3 ? 0 : 8),
              child: Row(
                children: [
                  for (var c = 0; c < 2; c++) ...[
                    if (c > 0) const SizedBox(width: 8),
                    Expanded(
                      child: Container(
                        height: 48,
                        decoration: BoxDecoration(color: AppColors.border, borderRadius: BorderRadius.circular(14)),
                      ),
                    ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _beforeEmploymentCard(DateTime? start) {
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(22),
      child: Column(
        children: [
          HistoryGlyph(tone: historyTone(HistoryDayStatus.notEmployed), size: 44),
          const SizedBox(height: 12),
          Text(
            'Before your employment started',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
          ),
          const SizedBox(height: 6),
          Text(
            start == null
                ? 'There is no attendance to show for this month.'
                : 'Your records start on ${formatShortDate(start)}.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, height: 1.4, color: AppColors.textSecondary),
          ),
          if (start != null && monthOf(start) != _month) ...[
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () => _goTo(start),
              icon: const Icon(Icons.arrow_forward_rounded, size: 18),
              label: Text('Go to ${formatMonthTitle(monthOf(start))}'),
            ),
          ],
        ],
      ),
    );
  }

  String _loadedAtText() {
    final at = _owner == null ? null : _cache.fetchedAt(_owner!, _month);
    if (at == null) return 'earlier';
    return 'at ${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';
  }

  Widget _staleBanner() {
    final tone = AppColors.amber;
    final text = _offline
        ? "You're offline. Showing this month as loaded ${_loadedAtText()}."
        : "Couldn't refresh ($_error). Showing this month as loaded ${_loadedAtText()}.";
    return GlassCard(
      radius: 16,
      tint: tone.withValues(alpha: 0.12),
      borderColor: tone.withValues(alpha: 0.35),
      padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
      child: Row(
        children: [
          Icon(_offline ? Icons.wifi_off_rounded : Icons.info_outline_rounded, color: tone, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Text(text, style: TextStyle(color: tone, fontSize: 11.5, fontWeight: FontWeight.w600, height: 1.35)),
          ),
          TextButton(
            onPressed: _loading ? null : () => _load(force: true),
            style: TextButton.styleFrom(foregroundColor: tone),
            child: const Text('Retry', style: TextStyle(fontWeight: FontWeight.w800)),
          ),
        ],
      ),
    );
  }

  Widget _errorCard() {
    final tone = _offline ? AppColors.amber : AppColors.danger;
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(22),
      child: Column(
        children: [
          Icon(_offline ? Icons.wifi_off_rounded : Icons.cloud_off_rounded, size: 40, color: tone),
          const SizedBox(height: 12),
          Text(
            _offline ? "You're offline" : "Couldn't load this month",
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
          ),
          const SizedBox(height: 6),
          Text(
            _offline ? 'Connect to the internet, then try again.' : (_error ?? 'Something went wrong.'),
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, height: 1.4, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _loading ? null : () => _load(force: true),
            icon: const Icon(Icons.refresh_rounded, size: 18),
            label: const Text('Try again'),
          ),
        ],
      ),
    );
  }
}

/// What the jump sheet chose: a month, or "pick a specific date".
class _Jump {
  final DateTime? month;
  final bool pickDate;
  const _Jump.month(DateTime this.month) : pickDate = false;
  const _Jump.date()
      : month = null,
        pickDate = true;
}

/// Year pager over a 3 x 4 grid of months, plus a way into the date picker.
class _JumpSheet extends StatefulWidget {
  final DateTime current;
  final DateTime minMonth;
  final DateTime maxMonth;
  const _JumpSheet({required this.current, required this.minMonth, required this.maxMonth});

  @override
  State<_JumpSheet> createState() => _JumpSheetState();
}

class _JumpSheetState extends State<_JumpSheet> {
  late int _year = widget.current.year;

  bool _enabled(DateTime m) =>
      monthsBetween(widget.minMonth, m) >= 0 && monthsBetween(m, widget.maxMonth) >= 0;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(color: AppColors.overlay(0.2), borderRadius: BorderRadius.circular(2)),
              ),
            ),
            const SizedBox(height: 14),
            Text(
              'Jump to a month',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                IconButton(
                  onPressed: _year > widget.minMonth.year ? () => setState(() => _year--) : null,
                  tooltip: 'Previous year',
                  icon: const Icon(Icons.chevron_left_rounded),
                  color: AppColors.textPrimary,
                ),
                Expanded(
                  child: Text(
                    '$_year',
                    textAlign: TextAlign.center,
                    style: monoStyle(fontSize: 17),
                  ),
                ),
                IconButton(
                  onPressed: _year < widget.maxMonth.year ? () => setState(() => _year++) : null,
                  tooltip: 'Next year',
                  icon: const Icon(Icons.chevron_right_rounded),
                  color: AppColors.textPrimary,
                ),
              ],
            ),
            const SizedBox(height: 8),
            LayoutBuilder(
              builder: (context, constraints) {
                const gap = 8.0;
                final w = (constraints.maxWidth - gap * 2) / 3;
                return Wrap(
                  spacing: gap,
                  runSpacing: gap,
                  children: [
                    for (var m = 1; m <= 12; m++) SizedBox(width: w, child: _monthChip(DateTime(_year, m))),
                  ],
                );
              },
            ),
            const SizedBox(height: 14),
            OutlinedButton.icon(
              onPressed: () => Navigator.pop(context, const _Jump.date()),
              style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
              icon: const Icon(Icons.calendar_today_rounded, size: 18),
              label: const Text('Go to a specific date'),
            ),
            if (widget.current != widget.maxMonth) ...[
              const SizedBox(height: 8),
              TextButton(
                onPressed: () => Navigator.pop(context, _Jump.month(widget.maxMonth)),
                child: const Text('Back to this month'),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _monthChip(DateTime m) {
    final enabled = _enabled(m);
    final selected = m == widget.current;
    final label = historyMonthNames[m.month - 1].substring(0, 3);
    return Semantics(
      button: true,
      enabled: enabled,
      selected: selected,
      label: formatMonthTitle(m),
      excludeSemantics: true,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: enabled ? () => Navigator.pop(context, _Jump.month(m)) : null,
          borderRadius: BorderRadius.circular(14),
          child: Container(
            constraints: const BoxConstraints(minHeight: 44),
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(vertical: 10),
            decoration: BoxDecoration(
              gradient: selected ? AppColors.accentGradient : null,
              color: selected ? null : AppColors.cardRaised,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: selected ? Colors.transparent : AppColors.glassBorder),
            ),
            child: Text(
              label,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w800,
                color: selected
                    ? AppColors.onAccent
                    : (enabled ? AppColors.textPrimary : AppColors.textTertiary.withValues(alpha: 0.6)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
