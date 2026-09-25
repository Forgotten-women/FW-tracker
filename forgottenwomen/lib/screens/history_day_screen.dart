import 'package:flutter/material.dart';

import '../models/history.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../widgets/attendance_correction_sheet.dart';
import '../widgets/glass/glass.dart';
import '../widgets/history/history_widgets.dart';
import '../widgets/payroll/payslip_widgets.dart';

/// One day of attendance in full, from GET /api/attendance/mine/day/:dateKey.
/// Opened from the month view it renders at once from that day's summary and
/// fills in the timeline when the detail arrives.
class HistoryDayScreen extends StatefulWidget {
  final String dateKey;
  final ApiClient api;

  /// The day's summary from the month view, shown while the detail loads.
  final DaySummary? initial;

  /// Called after a correction request for this day is sent.
  final VoidCallback? onCorrectionSubmitted;

  const HistoryDayScreen({
    super.key,
    required this.dateKey,
    required this.api,
    this.initial,
    this.onCorrectionSubmitted,
  });

  @override
  State<HistoryDayScreen> createState() => _HistoryDayScreenState();
}

class _HistoryDayScreenState extends State<HistoryDayScreen> {
  DayDetail? _detail;
  bool _loading = true;
  String? _error;
  bool _offline = false;

  DaySummary? get _summary => _detail?.summary ?? widget.initial;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (!_loading) setState(() => _loading = true);
    try {
      final d = await widget.api.fetchMyDay(widget.dateKey);
      if (!mounted) return;
      setState(() {
        _detail = d;
        _error = null;
        _offline = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e is ApiException ? e.message : e.toString();
        _offline = e is ApiException && e.statusCode == null && e.code == null;
      });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _requestCorrection() async {
    final sent = await showAttendanceCorrectionSheet(context, api: widget.api, initialDateKey: widget.dateKey);
    if (!sent || !mounted) return;
    widget.onCorrectionSubmitted?.call();
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final date = parseDateKey(widget.dateKey);
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
              date == null ? widget.dateKey : formatLongDate(date),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, letterSpacing: -0.3, color: AppColors.textPrimary),
            ),
            Text(
              'Attendance record',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: AppColors.textSecondary),
            ),
          ],
        ),
      ),
      body: Column(
        children: [
          if (_loading)
            LinearProgressIndicator(
              minHeight: 2.5,
              backgroundColor: Colors.transparent,
              valueColor: AlwaysStoppedAnimation<Color>(AppColors.primaryLight),
            ),
          Expanded(
            child: RefreshIndicator(
              color: AppColors.primary,
              onRefresh: _load,
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

  List<Widget> _content() {
    final s = _summary;
    if (s == null) {
      if (_error != null) return [_errorCard()];
      return _skeleton();
    }
    final d = _detail;
    final notEmployed = s.status == HistoryDayStatus.notEmployed;
    final showsDeficit = const {
      HistoryDayStatus.onTime,
      HistoryDayStatus.late,
      HistoryDayStatus.short,
      HistoryDayStatus.absent,
      HistoryDayStatus.inProgress,
      HistoryDayStatus.restDayWorked,
    }.contains(s.status) || s.deficit.hasAny;

    return [
      if (_error != null) ...[
        _banner(
          _offline
              ? "You're offline. Showing this day's summary; the full timeline needs a connection."
              : "Couldn't load the full record ($_error).",
          AppColors.amber,
          _offline ? Icons.wifi_off_rounded : Icons.info_outline_rounded,
          onRetry: _loading ? null : _load,
        ),
        const SizedBox(height: 12),
      ],
      _hero(s),
      if (notEmployed) ...[
        const SizedBox(height: 16),
        _note('This day is before your employment started, so there is nothing to record.'),
      ] else ...[
        if (showsDeficit) ...[
          const SizedBox(height: 22),
          const SectionLabel('Deficit'),
          _deficitCard(s.deficit),
        ],
        if (s.leave != null) ...[
          const SizedBox(height: 22),
          const SectionLabel('Leave'),
          _leaveCard(s.leave!),
        ],
        if (s.absence != null) ...[
          const SizedBox(height: 22),
          const SectionLabel('Absence'),
          _absenceCard(s.absence!),
        ],
        if (s.adjustment != null && s.adjustment!.minutes != 0) ...[
          const SizedBox(height: 22),
          const SectionLabel('HR adjustment'),
          _adjustmentCard(s.adjustment!),
        ],
        const SizedBox(height: 22),
        const SectionLabel('Arrivals and departures'),
        d == null ? _sectionSkeleton(_error != null) : _sessionsCard(d.sessions, s),
        if (d == null || d.breaks.isNotEmpty || s.breakMinutes > 0) ...[
          const SizedBox(height: 22),
          const SectionLabel('Breaks'),
          d == null ? _sectionSkeleton(_error != null) : _breaksCard(d.breaks, s),
        ],
        const SizedBox(height: 22),
        SectionLabel(
          'Correction requests',
          trailing: s.corrections.total > 0
              ? Text('${s.corrections.total}', style: monoStyle(fontSize: 11, color: AppColors.textTertiary))
              : null,
        ),
        _correctionsCard(d, s),
        const SizedBox(height: 22),
        const SectionLabel('Laptop activity'),
        _laptopCard(d, s),
      ],
    ];
  }

  // --- hero ---------------------------------------------------------------

  Widget _hero(DaySummary s) {
    final tone = historyTone(s.status);
    final schedule = s.isWorkingDay
        ? (s.scheduledStart != null && s.scheduledEnd != null
            ? 'Scheduled ${s.scheduledStart} - ${s.scheduledEnd}'
            : 'Working day')
        : (s.nonWorkingReason ?? 'Not a working day');
    return GlassCard(
      blur: true,
      strong: true,
      radius: 26,
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            label: 'Status: ${s.statusLabel}',
            excludeSemantics: true,
            child: Container(
              padding: const EdgeInsets.fromLTRB(6, 5, 12, 5),
              decoration: BoxDecoration(
                color: tone.color.withValues(alpha: 0.14),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: tone.color.withValues(alpha: 0.32)),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  HistoryGlyph(tone: tone, size: 22),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      s.statusLabel,
                      style: TextStyle(color: tone.color, fontWeight: FontWeight.w800, fontSize: 12.5),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          const PayrollCaption('Worked'),
          const SizedBox(height: 2),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(s.workedFormatted, style: monoStyle(fontSize: 30, letterSpacing: -1)),
          ),
          const SizedBox(height: 4),
          Text(
            schedule,
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(child: PayrollInfoTile(label: 'First in', value: s.firstIn == null ? '--:--' : shortClock(s.firstIn))),
              const SizedBox(width: 8),
              Expanded(child: PayrollInfoTile(label: 'Last out', value: s.lastOut == null ? '--:--' : shortClock(s.lastOut))),
              const SizedBox(width: 8),
              Expanded(child: PayrollInfoTile(label: 'Breaks', value: formatHistoryMinutes(s.breakMinutes))),
            ],
          ),
        ],
      ),
    );
  }

  // --- deficit ------------------------------------------------------------

  Widget _deficitCard(HistoryDeficit f) {
    final rows = <Widget>[
      if (f.lateMinutes > 0) _deficitRow('Arrived late', f.lateMinutes),
      if (f.excessBreakMinutes > 0) _deficitRow('Break ran over the allowance', f.excessBreakMinutes),
      if (f.earlyDepartureMinutes > 0) _deficitRow('Left before the end of the day', f.earlyDepartureMinutes),
      if (f.unauthorisedMissingMinutes > 0) _deficitRow('Time not accounted for', f.unauthorisedMissingMinutes),
      if (f.approvedAdjustmentMinutes > 0)
        _deficitRow('Approved adjustment (credited back)', -f.approvedAdjustmentMinutes, credit: true),
    ];
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      child: Column(
        children: [
          if (rows.isEmpty && f.totalMinutes <= 0)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Row(
                children: [
                  Icon(Icons.check_circle_outline_rounded, size: 16, color: AppColors.teal),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'No deficit on this day.',
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
                    ),
                  ),
                ],
              ),
            )
          else ...[
            ...rows,
            if (rows.isNotEmpty) Divider(height: 1, color: AppColors.border),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Deficit for the day',
                      style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    formatHistoryMinutes(f.totalMinutes),
                    style: monoStyle(fontSize: 14.5, color: f.totalMinutes > 0 ? AppColors.amber : AppColors.teal),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _deficitRow(String label, int minutes, {bool credit = false}) {
    final value = credit ? '-${formatHistoryMinutes(-minutes)}' : formatHistoryMinutes(minutes);
    return Semantics(
      label: '$label: ${credit ? 'minus ' : ''}${formatHistoryMinutes(minutes.abs())}',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 11),
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: AppColors.border))),
        child: Row(
          children: [
            Expanded(
              child: Text(label, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
            ),
            const SizedBox(width: 10),
            Text(value, style: monoStyle(fontSize: 13, color: credit ? AppColors.teal : AppColors.textPrimary)),
          ],
        ),
      ),
    );
  }

  // --- sessions -----------------------------------------------------------

  Widget _sessionsCard(List<HistorySession> sessions, DaySummary s) {
    if (sessions.isEmpty) {
      return _emptyCard(
        s.isWorkingDay && s.status != HistoryDayStatus.onLeave
            ? 'No arrivals were recorded on this day.'
            : 'Nothing was recorded on this day.',
      );
    }
    final events = <Widget>[];
    for (var i = 0; i < sessions.length; i++) {
      final ses = sessions[i];
      if (i > 0) {
        final prev = sessions[i - 1];
        if (prev.endAt != null && ses.startAt != null && ses.startAt! > prev.endAt!) {
          final gap = ((ses.startAt! - prev.endAt!) / 60000).round();
          if (gap > 0) events.add(_gapRow(gap));
        }
      }
      events.add(_timelineRow(
        icon: Icons.login_rounded,
        tone: AppColors.teal,
        title: 'Arrived',
        time: shortClock(ses.start),
        first: i == 0,
      ));
      events.add(_durationRow(ses.duration));
      events.add(_timelineRow(
        icon: ses.isOpen ? Icons.more_horiz_rounded : Icons.logout_rounded,
        tone: ses.isOpen ? AppColors.primaryLight : AppColors.textSecondary,
        title: ses.isOpen ? 'Still here' : 'Left',
        time: ses.isOpen ? 'now' : shortClock(ses.end),
        last: i == sessions.length - 1,
      ));
    }
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      child: Column(children: events),
    );
  }

  Widget _timelineRow({
    required IconData icon,
    required Color tone,
    required String title,
    required String time,
    bool first = false,
    bool last = false,
  }) {
    return Semantics(
      label: '$title at $time',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            Container(
              width: 30,
              height: 30,
              decoration: BoxDecoration(
                color: tone.withValues(alpha: 0.16),
                shape: BoxShape.circle,
                border: Border.all(color: tone.withValues(alpha: 0.45)),
              ),
              child: Icon(icon, size: 15, color: tone),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(title, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: AppColors.textPrimary)),
            ),
            const SizedBox(width: 8),
            Text(time, style: monoStyle(fontSize: 13)),
          ],
        ),
      ),
    );
  }

  Widget _durationRow(String duration) {
    return Semantics(
      label: 'In the office for $duration',
      excludeSemantics: true,
      child: Row(
        children: [
          SizedBox(
            width: 30,
            height: 22,
            child: Center(child: Container(width: 2, height: 22, color: AppColors.teal.withValues(alpha: 0.4))),
          ),
          const SizedBox(width: 12),
          Text(
            duration,
            style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: AppColors.textTertiary),
          ),
        ],
      ),
    );
  }

  Widget _gapRow(int minutes) {
    return Semantics(
      label: 'Away for ${formatHistoryMinutes(minutes)}',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          children: [
            SizedBox(
              width: 30,
              height: 22,
              child: Center(
                child: Container(width: 2, height: 22, color: AppColors.border),
              ),
            ),
            const SizedBox(width: 12),
            Icon(Icons.directions_walk_rounded, size: 13, color: AppColors.textTertiary),
            const SizedBox(width: 4),
            Text(
              'Away ${formatHistoryMinutes(minutes)}',
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: AppColors.textTertiary),
            ),
          ],
        ),
      ),
    );
  }

  // --- breaks -------------------------------------------------------------

  Widget _breaksCard(List<HistoryBreak> breaks, DaySummary s) {
    if (breaks.isEmpty) {
      return _emptyCard('${formatHistoryMinutes(s.breakMinutes)} of break time, with no individual breaks on record.');
    }
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      child: Column(
        children: [
          for (var i = 0; i < breaks.length; i++) ...[
            if (i > 0) const SizedBox(height: 8),
            _breakRow(breaks[i]),
          ],
        ],
      ),
    );
  }

  Widget _breakRow(HistoryBreak b) {
    final over = b.isOver;
    final tone = over ? AppColors.amber : AppColors.textSecondary;
    final range = b.isOpen ? '${shortClock(b.start)} - still on break' : '${shortClock(b.start)} - ${shortClock(b.end)}';
    final actual = b.actualMinutes;
    final allowed = b.permittedMinutes;
    final detail = actual == null
        ? (allowed == null ? null : '$allowed min allowed')
        : (allowed == null ? formatHistoryMinutes(actual) : '${formatHistoryMinutes(actual)} of $allowed min allowed');
    return Semantics(
      label: [
        'Break $range',
        ?detail,
        if (over) '${formatHistoryMinutes(b.excessMinutes)} over',
      ].join(', '),
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: over ? AppColors.amber.withValues(alpha: 0.12) : AppColors.cardRaised,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: over ? AppColors.amber.withValues(alpha: 0.45) : AppColors.glassBorder),
        ),
        child: Row(
          children: [
            Icon(over ? Icons.warning_amber_rounded : Icons.free_breakfast_outlined, size: 18, color: tone),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(range, style: monoStyle(fontSize: 12.5)),
                  if (detail != null) ...[
                    const SizedBox(height: 2),
                    Text(detail, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  ],
                ],
              ),
            ),
            if (over) ...[
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: AppColors.amber.withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  '+${formatHistoryMinutes(b.excessMinutes)} over',
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: AppColors.amber),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  // --- leave, absence, adjustment ----------------------------------------

  Widget _leaveCard(HistoryLeave l) {
    final portion = l.isPartDay ? 'Part of the day (${_humanise(l.dayPortion)})' : 'Full day';
    final paid = l.isPaid == null ? null : (l.isPaid! ? 'Paid' : 'Unpaid');
    return _infoCard(
      leading: StatusPill(
        label: l.isApproved ? 'APPROVED' : 'PENDING',
        tone: l.isApproved ? AppColors.teal : AppColors.amber,
        glow: false,
      ),
      rows: [
        ('Type', l.type, null),
        ('Portion', portion, null),
        if (paid != null) ('Pay', paid, l.isPaid! ? AppColors.teal : AppColors.amber),
      ],
      footnote: l.isPending ? 'This leave request is waiting for a decision from HR.' : null,
    );
  }

  Widget _absenceCard(HistoryAbsence a) {
    return _infoCard(
      rows: [
        if (a.type != null) ('Type', _humanise(a.type!), null),
        if (a.status != null) ('Status', _humanise(a.status!), null),
        ('Pay', a.treatAsUnpaid ? 'Treated as unpaid' : 'Not marked unpaid', a.treatAsUnpaid ? AppColors.danger : null),
      ],
    );
  }

  Widget _adjustmentCard(HistoryAdjustment a) {
    return _infoCard(
      rows: [
        ('Minutes', '${a.minutes > 0 ? '+' : ''}${formatHistoryMinutes(a.minutes)}', a.minutes > 0 ? AppColors.teal : null),
        if (a.note != null) ('Note', a.note!, null),
      ],
    );
  }

  // --- corrections --------------------------------------------------------

  Widget _correctionsCard(DayDetail? d, DaySummary s) {
    final requests = d?.correctionRequests ?? const <HistoryCorrectionRequest>[];
    final canRequest = s.status != HistoryDayStatus.notEmployed;
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (d == null && s.corrections.total > 0)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 4, 4, 10),
              child: Text(
                '${s.corrections.total} on record${s.corrections.pending > 0 ? ', ${s.corrections.pending} pending' : ''}.',
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
              ),
            )
          else if (requests.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 4, 4, 10),
              child: Text(
                'No correction requests for this day.',
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
              ),
            )
          else
            for (final c in requests)
              Padding(padding: const EdgeInsets.only(bottom: 10), child: _correctionTile(c)),
          if (canRequest)
            OutlinedButton.icon(
              onPressed: _requestCorrection,
              style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
              icon: const Icon(Icons.edit_note_rounded, size: 20),
              label: const Text('Request a correction for this day'),
            ),
        ],
      ),
    );
  }

  Widget _correctionTile(HistoryCorrectionRequest c) {
    final Color tone;
    if (c.isApproved) {
      tone = AppColors.teal;
    } else if (c.isRejected) {
      tone = AppColors.danger;
    } else if (c.isPending) {
      tone = AppColors.amber;
    } else {
      tone = AppColors.primaryLight;
    }
    final requested = c.requestedAt == null ? null : DateTime.fromMillisecondsSinceEpoch(c.requestedAt!);
    final reviewed = c.reviewedAt == null ? null : DateTime.fromMillisecondsSinceEpoch(c.reviewedAt!);
    final adj = c.requestedAdjustmentMinutes;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: tone.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              StatusPill(label: _humanise(c.status).toUpperCase(), tone: tone, glow: false),
              const SizedBox(width: 8),
              if (requested != null)
                Expanded(
                  child: Text(
                    'Sent ${formatShortDate(requested)}',
                    textAlign: TextAlign.right,
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppColors.textTertiary),
                  ),
                ),
            ],
          ),
          if (c.reason.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(c.reason, style: TextStyle(fontSize: 12.5, height: 1.35, color: AppColors.textPrimary)),
          ],
          if (adj != null) ...[
            const SizedBox(height: 4),
            Text(
              'Asked for an adjustment of ${formatHistoryMinutes(adj)}',
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
            ),
          ],
          if (c.reviewNotes != null || reviewed != null) ...[
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.cardRaised,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.glassBorder),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.feedback_outlined, size: 14, color: AppColors.primaryLight),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          reviewed == null ? 'HR review' : 'HR reviewed ${formatShortDate(reviewed)}',
                          style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: AppColors.textSecondary),
                        ),
                        if (c.reviewNotes != null) ...[
                          const SizedBox(height: 2),
                          Text(
                            c.reviewNotes!,
                            style: TextStyle(fontSize: 12, height: 1.35, color: AppColors.textSecondary),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  // --- laptop -------------------------------------------------------------

  Widget _laptopCard(DayDetail? d, DaySummary s) {
    final sessions = d?.laptopSessions ?? const <HistoryLaptopSession>[];
    if (sessions.isEmpty) {
      final lap = s.laptop;
      if (lap == null) {
        if (d == null && _error == null) return _sectionSkeleton(false);
        return _emptyCard('No laptop activity was recorded on this day.');
      }
      return GlassCard(
        radius: 22,
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Expanded(child: PayrollInfoTile(label: 'Active', value: formatHistoryMinutes(lap.activeMinutes))),
            const SizedBox(width: 8),
            Expanded(child: PayrollInfoTile(label: 'Idle', value: formatHistoryMinutes(lap.idleMinutes))),
          ],
        ),
      );
    }
    return Column(
      children: [
        for (var i = 0; i < sessions.length; i++) ...[
          if (i > 0) const SizedBox(height: 10),
          _laptopSessionCard(sessions[i]),
        ],
      ],
    );
  }

  Widget _laptopSessionCard(HistoryLaptopSession l) {
    final seen = (l.firstSeen == null && l.lastSeen == null)
        ? null
        : '${shortClock(l.firstSeen)} - ${shortClock(l.lastSeen)}';
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              GradientIconTile(icon: Icons.laptop_mac_rounded, colors: [AppColors.primary, AppColors.accentEnd], size: 34),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(l.device, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w800, color: AppColors.textPrimary)),
                    if (seen != null)
                      Text(
                        'Seen $seen',
                        style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
                      ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(child: PayrollInfoTile(label: 'Active', value: formatHistoryMinutes(l.activeMinutes))),
              const SizedBox(width: 6),
              Expanded(child: PayrollInfoTile(label: 'Idle', value: formatHistoryMinutes(l.idleMinutes))),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(child: PayrollInfoTile(label: 'On break', value: formatHistoryMinutes(l.breakMinutes))),
              const SizedBox(width: 6),
              Expanded(
                child: PayrollInfoTile(
                  label: 'Unverified',
                  value: formatHistoryMinutes(l.unverifiedMinutes),
                  valueColor: l.unverifiedMinutes > 0 ? AppColors.amber : null,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // --- shared pieces ------------------------------------------------------

  static String _humanise(String raw) {
    final words = raw.replaceAll('_', ' ').toLowerCase().trim();
    if (words.isEmpty) return raw;
    return words[0].toUpperCase() + words.substring(1);
  }

  Widget _infoCard({Widget? leading, required List<(String, String, Color?)> rows, String? footnote}) {
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (leading != null) ...[leading, const SizedBox(height: 4)],
          for (var i = 0; i < rows.length; i++)
            Container(
              padding: const EdgeInsets.symmetric(vertical: 10),
              decoration: BoxDecoration(
                border: i == rows.length - 1 ? null : Border(bottom: BorderSide(color: AppColors.border)),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(
                      rows[i].$1,
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Flexible(
                    flex: 2,
                    child: Text(
                      rows[i].$2,
                      textAlign: TextAlign.right,
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: rows[i].$3 ?? AppColors.textPrimary),
                    ),
                  ),
                ],
              ),
            ),
          if (footnote != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(footnote, style: TextStyle(fontSize: 11.5, height: 1.35, color: AppColors.textTertiary)),
            ),
        ],
      ),
    );
  }

  Widget _emptyCard(String text) {
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(16),
      child: Text(text, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
    );
  }

  Widget _note(String text) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Text(text, style: TextStyle(fontSize: 12.5, height: 1.4, color: AppColors.textSecondary)),
    );
  }

  Widget _banner(String text, Color tone, IconData icon, {VoidCallback? onRetry}) {
    return GlassCard(
      radius: 16,
      tint: tone.withValues(alpha: 0.12),
      borderColor: tone.withValues(alpha: 0.35),
      padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
      child: Row(
        children: [
          Icon(icon, color: tone, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Text(text, style: TextStyle(color: tone, fontSize: 11.5, fontWeight: FontWeight.w600, height: 1.35)),
            ),
          ),
          TextButton(
            onPressed: onRetry,
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
            _offline ? "You're offline" : "Couldn't load this day",
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
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh_rounded, size: 18),
            label: const Text('Try again'),
          ),
        ],
      ),
    );
  }

  Widget _bar(double width, double height) => Container(
        width: width,
        height: height,
        decoration: BoxDecoration(color: AppColors.border, borderRadius: BorderRadius.circular(6)),
      );

  /// A placeholder for a section still loading; once the load has failed it
  /// says so instead of shimmering forever.
  Widget _sectionSkeleton(bool failed) {
    if (failed) return _emptyCard('Not available until the full record loads.');
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [_bar(160, 12), const SizedBox(height: 10), _bar(double.infinity, 12), const SizedBox(height: 10), _bar(120, 12)],
      ),
    );
  }

  List<Widget> _skeleton() {
    return [
      GlassCard(
        strong: true,
        radius: 26,
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _bar(130, 22),
            const SizedBox(height: 16),
            _bar(60, 10),
            const SizedBox(height: 8),
            _bar(150, 30),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(child: _bar(double.infinity, 44)),
                const SizedBox(width: 8),
                Expanded(child: _bar(double.infinity, 44)),
                const SizedBox(width: 8),
                Expanded(child: _bar(double.infinity, 44)),
              ],
            ),
          ],
        ),
      ),
      const SizedBox(height: 22),
      _sectionSkeleton(false),
      const SizedBox(height: 22),
      _sectionSkeleton(false),
    ];
  }
}
