// Attendance history for any past date, as served by
// GET /api/attendance/mine/days and GET /api/attendance/mine/day/:dateKey
// (backend/src/domain/history.js). Parsing is tolerant: a missing or oddly
// typed field falls back to a neutral value rather than throwing, so one bad
// row cannot blank a whole month.

import 'dart:convert';

// --- tolerant readers ---------------------------------------------------------

int _int(Object? v, [int fallback = 0]) => _intOrNull(v) ?? fallback;

int? _intOrNull(Object? v) {
  if (v is int) return v;
  if (v is num) return v.round();
  if (v is String) return num.tryParse(v.trim())?.round();
  return null;
}

String? _strOrNull(Object? v) {
  if (v == null) return null;
  final s = v.toString();
  return s.isEmpty ? null : s;
}

String _str(Object? v, [String fallback = '']) => _strOrNull(v) ?? fallback;

bool _bool(Object? v, [bool fallback = false]) {
  if (v is bool) return v;
  if (v is num) return v != 0;
  if (v is String) {
    final s = v.toLowerCase();
    if (s == 'true' || s == '1') return true;
    if (s == 'false' || s == '0') return false;
  }
  return fallback;
}

bool? _boolOrNull(Object? v) => v == null ? null : _bool(v);

Map<String, dynamic>? _mapOrNull(Object? v) {
  if (v is Map<String, dynamic>) return v;
  if (v is Map) return v.map((k, val) => MapEntry(k.toString(), val));
  return null;
}

List<Map<String, dynamic>> _maps(Object? v) {
  if (v is! List) return const [];
  return [for (final e in v) ?_mapOrNull(e)];
}

// --- status -------------------------------------------------------------------

/// The server's plain-language outcome for a day (history.js dayStatus()).
enum HistoryDayStatus {
  notEmployed('NOT_EMPLOYED'),
  onLeave('ON_LEAVE'),
  holiday('HOLIDAY'),
  restDay('REST_DAY'),
  restDayWorked('REST_DAY_WORKED'),
  inProgress('IN_PROGRESS'),
  notStarted('NOT_STARTED'),
  absent('ABSENT'),
  late('LATE'),
  short('SHORT'),
  onTime('ON_TIME'),

  /// A value this build of the app does not know yet.
  unknown('UNKNOWN');

  final String wire;
  const HistoryDayStatus(this.wire);

  static HistoryDayStatus parse(Object? raw) {
    final s = raw?.toString().toUpperCase();
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return HistoryDayStatus.unknown;
  }

  /// Short fallback label, used only when the server sends no statusLabel.
  String get fallbackLabel {
    switch (this) {
      case HistoryDayStatus.notEmployed:
        return 'Before employment started';
      case HistoryDayStatus.onLeave:
        return 'On leave';
      case HistoryDayStatus.holiday:
        return 'Holiday';
      case HistoryDayStatus.restDay:
        return 'Rest day';
      case HistoryDayStatus.restDayWorked:
        return 'Rest day (worked)';
      case HistoryDayStatus.inProgress:
        return 'Today, in progress';
      case HistoryDayStatus.notStarted:
        return 'Today, not arrived yet';
      case HistoryDayStatus.absent:
        return 'No attendance recorded';
      case HistoryDayStatus.late:
        return 'Late';
      case HistoryDayStatus.short:
        return 'Present, short of hours';
      case HistoryDayStatus.onTime:
        return 'On time';
      case HistoryDayStatus.unknown:
        return 'Unknown';
    }
  }
}

// --- day summary --------------------------------------------------------------

class HistoryDeficit {
  final int lateMinutes;
  final int excessBreakMinutes;
  final int earlyDepartureMinutes;
  final int unauthorisedMissingMinutes;
  final int approvedAdjustmentMinutes;
  final int totalMinutes;

  const HistoryDeficit({
    this.lateMinutes = 0,
    this.excessBreakMinutes = 0,
    this.earlyDepartureMinutes = 0,
    this.unauthorisedMissingMinutes = 0,
    this.approvedAdjustmentMinutes = 0,
    this.totalMinutes = 0,
  });

  factory HistoryDeficit.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const HistoryDeficit();
    return HistoryDeficit(
      lateMinutes: _int(json['lateMinutes']),
      excessBreakMinutes: _int(json['excessBreakMinutes']),
      earlyDepartureMinutes: _int(json['earlyDepartureMinutes']),
      unauthorisedMissingMinutes: _int(json['unauthorisedMissingMinutes']),
      approvedAdjustmentMinutes: _int(json['approvedAdjustmentMinutes']).abs(),
      totalMinutes: _int(json['totalMinutes']),
    );
  }

  /// True when any component or the total is non-zero.
  bool get hasAny =>
      totalMinutes > 0 ||
      lateMinutes > 0 ||
      excessBreakMinutes > 0 ||
      earlyDepartureMinutes > 0 ||
      unauthorisedMissingMinutes > 0 ||
      approvedAdjustmentMinutes > 0;
}

class HistoryAdjustment {
  final int minutes;
  final String? note;
  const HistoryAdjustment({required this.minutes, this.note});

  static HistoryAdjustment? fromJson(Map<String, dynamic>? json) {
    if (json == null) return null;
    return HistoryAdjustment(minutes: _int(json['minutes']), note: _strOrNull(json['note']));
  }
}

class HistoryLeave {
  final String? requestId;
  final String type;

  /// APPROVED or PENDING.
  final String status;

  /// FULL for a whole day; anything else is part of a day.
  final String dayPortion;

  /// Null when the server doesn't know.
  final bool? isPaid;

  const HistoryLeave({
    this.requestId,
    required this.type,
    required this.status,
    this.dayPortion = 'FULL',
    this.isPaid,
  });

  static HistoryLeave? fromJson(Map<String, dynamic>? json) {
    if (json == null) return null;
    return HistoryLeave(
      requestId: _strOrNull(json['requestId']),
      type: _str(json['type'], 'Leave'),
      status: _str(json['status'], 'PENDING').toUpperCase(),
      dayPortion: _str(json['dayPortion'], 'FULL').toUpperCase(),
      isPaid: _boolOrNull(json['isPaid']),
    );
  }

  bool get isApproved => status == 'APPROVED';
  bool get isPending => status == 'PENDING';
  bool get isPartDay => dayPortion != 'FULL' && dayPortion != 'FULL_DAY';
}

class HistoryAbsence {
  final String? status;
  final String? type;
  final bool treatAsUnpaid;
  const HistoryAbsence({this.status, this.type, this.treatAsUnpaid = false});

  static HistoryAbsence? fromJson(Map<String, dynamic>? json) {
    if (json == null) return null;
    return HistoryAbsence(
      status: _strOrNull(json['status']),
      type: _strOrNull(json['type']),
      treatAsUnpaid: _bool(json['treatAsUnpaid']),
    );
  }
}

class HistoryCorrectionCounts {
  final int pending;
  final int total;
  const HistoryCorrectionCounts({this.pending = 0, this.total = 0});

  factory HistoryCorrectionCounts.fromJson(Map<String, dynamic>? json) => json == null
      ? const HistoryCorrectionCounts()
      : HistoryCorrectionCounts(pending: _int(json['pending']), total: _int(json['total']));
}

class HistoryLaptop {
  final int activeMinutes;
  final int idleMinutes;
  const HistoryLaptop({this.activeMinutes = 0, this.idleMinutes = 0});

  static HistoryLaptop? fromJson(Map<String, dynamic>? json) => json == null
      ? null
      : HistoryLaptop(activeMinutes: _int(json['activeMinutes']), idleMinutes: _int(json['idleMinutes']));
}

/// One day of the month view (history.js daysInRange()).
class DaySummary {
  final String dateKey;
  final String weekday;
  final bool isToday;
  final HistoryDayStatus status;
  final String statusLabel;
  final String? attendanceStatus;
  final bool isWorkingDay;
  final String? dayType;
  final String? nonWorkingReason;
  final String? scheduledStart;
  final String? scheduledEnd;
  final int? firstInAt;
  final String? firstIn;
  final int? lastOutAt;
  final String? lastOut;
  final int workedMinutes;
  final String workedFormatted;
  final int breakMinutes;
  final HistoryDeficit deficit;
  final HistoryAdjustment? adjustment;
  final HistoryLeave? leave;
  final HistoryAbsence? absence;
  final HistoryCorrectionCounts corrections;
  final HistoryLaptop? laptop;

  const DaySummary({
    required this.dateKey,
    this.weekday = '',
    this.isToday = false,
    required this.status,
    required this.statusLabel,
    this.attendanceStatus,
    this.isWorkingDay = false,
    this.dayType,
    this.nonWorkingReason,
    this.scheduledStart,
    this.scheduledEnd,
    this.firstInAt,
    this.firstIn,
    this.lastOutAt,
    this.lastOut,
    this.workedMinutes = 0,
    this.workedFormatted = '0 mins',
    this.breakMinutes = 0,
    this.deficit = const HistoryDeficit(),
    this.adjustment,
    this.leave,
    this.absence,
    this.corrections = const HistoryCorrectionCounts(),
    this.laptop,
  });

  factory DaySummary.fromJson(Map<String, dynamic> json) {
    final status = HistoryDayStatus.parse(json['status']);
    final worked = _int(json['workedMinutes']);
    return DaySummary(
      dateKey: _str(json['dateKey']),
      weekday: _str(json['weekday']),
      isToday: _bool(json['isToday']),
      status: status,
      statusLabel: _str(json['statusLabel'], status.fallbackLabel),
      attendanceStatus: _strOrNull(json['attendanceStatus']),
      isWorkingDay: _bool(json['isWorkingDay']),
      dayType: _strOrNull(json['dayType']),
      nonWorkingReason: _strOrNull(json['nonWorkingReason']),
      scheduledStart: _strOrNull(json['scheduledStart']),
      scheduledEnd: _strOrNull(json['scheduledEnd']),
      firstInAt: _intOrNull(json['firstInAt']),
      firstIn: _strOrNull(json['firstIn']),
      lastOutAt: _intOrNull(json['lastOutAt']),
      lastOut: _strOrNull(json['lastOut']),
      workedMinutes: worked,
      workedFormatted: _str(json['workedFormatted'], formatHistoryMinutes(worked)),
      breakMinutes: _int(json['breakMinutes']),
      deficit: HistoryDeficit.fromJson(_mapOrNull(json['deficit'])),
      adjustment: HistoryAdjustment.fromJson(_mapOrNull(json['adjustment'])),
      leave: HistoryLeave.fromJson(_mapOrNull(json['leave'])),
      absence: HistoryAbsence.fromJson(_mapOrNull(json['absence'])),
      corrections: HistoryCorrectionCounts.fromJson(_mapOrNull(json['corrections'])),
      laptop: HistoryLaptop.fromJson(_mapOrNull(json['laptop'])),
    );
  }

  DateTime? get date => parseDateKey(dateKey);

  /// Something was recorded as worked on this day.
  bool get wasPresent => workedMinutes > 0 && status != HistoryDayStatus.notEmployed;
}

/// The response of GET /api/attendance/mine/days.
class HistoryRange {
  final String from;
  final String to;

  /// The first day of employment (YYYY-MM-DD), or null when HR has no
  /// employment record on file.
  final String? employmentStart;
  final List<DaySummary> days;

  const HistoryRange({
    required this.from,
    required this.to,
    this.employmentStart,
    this.days = const [],
  });

  factory HistoryRange.fromJson(Map<String, dynamic> json) {
    final days = <DaySummary>[];
    for (final d in _maps(json['days'])) {
      final day = DaySummary.fromJson(d);
      if (parseDateKey(day.dateKey) != null) days.add(day);
    }
    days.sort((a, b) => a.dateKey.compareTo(b.dateKey));
    return HistoryRange(
      from: _str(json['from']),
      to: _str(json['to']),
      employmentStart: parseDateKey(_strOrNull(json['employmentStart'])) == null
          ? null
          : _str(json['employmentStart']),
      days: days,
    );
  }

  Map<String, DaySummary> get byDate => {for (final d in days) d.dateKey: d};
}

// --- day detail ---------------------------------------------------------------

class HistoryEmployee {
  final String id;
  final String name;
  final String role;
  const HistoryEmployee({this.id = '', this.name = '', this.role = ''});

  factory HistoryEmployee.fromJson(Map<String, dynamic>? json) => json == null
      ? const HistoryEmployee()
      : HistoryEmployee(id: _str(json['id']), name: _str(json['name']), role: _str(json['role']));
}

class HistorySession {
  final int? startAt;
  final int? endAt;
  final String? start;

  /// A display time, or 'now' for a session still open today.
  final String? end;
  final int minutes;
  final String duration;

  const HistorySession({
    this.startAt,
    this.endAt,
    this.start,
    this.end,
    this.minutes = 0,
    this.duration = '0 mins',
  });

  factory HistorySession.fromJson(Map<String, dynamic> json) {
    final minutes = _int(json['minutes']);
    return HistorySession(
      startAt: _intOrNull(json['startAt']),
      endAt: _intOrNull(json['endAt']),
      start: _strOrNull(json['start']),
      end: _strOrNull(json['end']),
      minutes: minutes,
      duration: _str(json['duration'], formatHistoryMinutes(minutes)),
    );
  }

  bool get isOpen => end == 'now';
}

class HistoryBreak {
  final int? startedAt;
  final int? endedAt;
  final String? start;
  final String? end;
  final int? permittedMinutes;
  final int? actualMinutes;
  final int excessMinutes;

  const HistoryBreak({
    this.startedAt,
    this.endedAt,
    this.start,
    this.end,
    this.permittedMinutes,
    this.actualMinutes,
    this.excessMinutes = 0,
  });

  factory HistoryBreak.fromJson(Map<String, dynamic> json) => HistoryBreak(
        startedAt: _intOrNull(json['startedAt']),
        endedAt: _intOrNull(json['endedAt']),
        start: _strOrNull(json['start']),
        end: _strOrNull(json['end']),
        permittedMinutes: _intOrNull(json['permittedMinutes']),
        actualMinutes: _intOrNull(json['actualMinutes']),
        excessMinutes: _int(json['excessMinutes']),
      );

  bool get isOpen => endedAt == null && end == null;
  bool get isOver => excessMinutes > 0;
}

class HistoryCorrectionRequest {
  final String id;
  final int? requestedAt;

  /// As stored: a JSON object (or its text) such as {"adjustmentMinutes": 30}.
  final Map<String, dynamic> requestedChange;
  final String reason;
  final String status;
  final int? reviewedAt;
  final String? reviewNotes;

  const HistoryCorrectionRequest({
    required this.id,
    this.requestedAt,
    this.requestedChange = const {},
    this.reason = '',
    this.status = 'PENDING',
    this.reviewedAt,
    this.reviewNotes,
  });

  factory HistoryCorrectionRequest.fromJson(Map<String, dynamic> json) {
    var change = _mapOrNull(json['requestedChange']);
    final raw = json['requestedChange'];
    if (change == null && raw is String && raw.trim().isNotEmpty) {
      try {
        change = _mapOrNull(jsonDecode(raw));
      } on FormatException {
        change = null;
      }
    }
    return HistoryCorrectionRequest(
      id: _str(json['id']),
      requestedAt: _intOrNull(json['requestedAt']),
      requestedChange: change ?? const {},
      reason: _str(json['reason']),
      status: _str(json['status'], 'PENDING').toUpperCase(),
      reviewedAt: _intOrNull(json['reviewedAt']),
      reviewNotes: _strOrNull(json['reviewNotes']),
    );
  }

  /// The adjustment the employee asked for, when they gave one.
  int? get requestedAdjustmentMinutes => _intOrNull(requestedChange['adjustmentMinutes']);

  bool get isPending => status == 'PENDING' || status == 'PENDING_HR';
  bool get isApproved => status == 'APPROVED';
  bool get isRejected => status == 'REJECTED';
}

class HistoryLaptopSession {
  final String? deviceId;
  final String device;
  final int activeMinutes;
  final int idleMinutes;
  final int breakMinutes;
  final int unverifiedMinutes;
  final String? firstSeen;
  final String? lastSeen;

  const HistoryLaptopSession({
    this.deviceId,
    this.device = 'Laptop',
    this.activeMinutes = 0,
    this.idleMinutes = 0,
    this.breakMinutes = 0,
    this.unverifiedMinutes = 0,
    this.firstSeen,
    this.lastSeen,
  });

  factory HistoryLaptopSession.fromJson(Map<String, dynamic> json) => HistoryLaptopSession(
        deviceId: _strOrNull(json['deviceId']),
        device: _str(json['device'], 'Laptop'),
        activeMinutes: _int(json['activeMinutes']),
        idleMinutes: _int(json['idleMinutes']),
        breakMinutes: _int(json['breakMinutes']),
        unverifiedMinutes: _int(json['unverifiedMinutes']),
        firstSeen: _strOrNull(json['firstSeen']),
        lastSeen: _strOrNull(json['lastSeen']),
      );
}

/// The response's `day` from GET /api/attendance/mine/day/:dateKey: a
/// [DaySummary] plus the timeline.
class DayDetail {
  final DaySummary summary;
  final HistoryEmployee employee;
  final String? employmentStart;
  final List<HistorySession> sessions;
  final List<HistoryBreak> breaks;
  final List<HistoryCorrectionRequest> correctionRequests;
  final List<HistoryLaptopSession> laptopSessions;

  const DayDetail({
    required this.summary,
    this.employee = const HistoryEmployee(),
    this.employmentStart,
    this.sessions = const [],
    this.breaks = const [],
    this.correctionRequests = const [],
    this.laptopSessions = const [],
  });

  factory DayDetail.fromJson(Map<String, dynamic> json) => DayDetail(
        summary: DaySummary.fromJson(json),
        employee: HistoryEmployee.fromJson(_mapOrNull(json['employee'])),
        employmentStart: _strOrNull(json['employmentStart']),
        sessions: [for (final s in _maps(json['sessions'])) HistorySession.fromJson(s)],
        breaks: [for (final b in _maps(json['breaks'])) HistoryBreak.fromJson(b)],
        correctionRequests: [
          for (final c in _maps(json['correctionRequests'])) HistoryCorrectionRequest.fromJson(c),
        ],
        laptopSessions: [for (final l in _maps(json['laptopSessions'])) HistoryLaptopSession.fromJson(l)],
      );
}

// --- month totals -------------------------------------------------------------

/// What the month view's totals card shows, worked out from the days the
/// server returned (days before employment are left out).
class MonthTotals {
  final int daysPresent;
  final int onTime;
  final int late;
  final int short;
  final int absent;

  /// Approved leave on working days; a part-day counts as half.
  final double leaveDays;
  final int workedMinutes;
  final int deficitMinutes;

  const MonthTotals({
    this.daysPresent = 0,
    this.onTime = 0,
    this.late = 0,
    this.short = 0,
    this.absent = 0,
    this.leaveDays = 0,
    this.workedMinutes = 0,
    this.deficitMinutes = 0,
  });

  factory MonthTotals.fromDays(Iterable<DaySummary> days) {
    var present = 0, onTime = 0, late = 0, short = 0, absent = 0, worked = 0, deficit = 0;
    var leave = 0.0;
    for (final d in days) {
      if (d.status == HistoryDayStatus.notEmployed) continue;
      if (d.wasPresent) present++;
      switch (d.status) {
        case HistoryDayStatus.onTime:
          onTime++;
        case HistoryDayStatus.late:
          late++;
        case HistoryDayStatus.short:
          short++;
        case HistoryDayStatus.absent:
          absent++;
        case HistoryDayStatus.onLeave:
          // A leave request spanning a weekend reports the rest days as
          // ON_LEAVE too; only working days are leave actually taken.
          if (d.isWorkingDay) leave += (d.leave?.isPartDay ?? false) ? 0.5 : 1;
        default:
          break;
      }
      worked += d.workedMinutes;
      deficit += d.deficit.totalMinutes;
    }
    return MonthTotals(
      daysPresent: present,
      onTime: onTime,
      late: late,
      short: short,
      absent: absent,
      leaveDays: leave,
      workedMinutes: worked,
      deficitMinutes: deficit,
    );
  }
}

// --- dates and formatting -----------------------------------------------------

const historyMonthNames = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const historyWeekdayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

final _dateKeyRe = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$');

/// A YYYY-MM-DD key as a local calendar date, or null when malformed.
DateTime? parseDateKey(String? key) {
  if (key == null) return null;
  final m = _dateKeyRe.firstMatch(key);
  if (m == null) return null;
  final y = int.parse(m[1]!), mo = int.parse(m[2]!), d = int.parse(m[3]!);
  final dt = DateTime(y, mo, d);
  if (dt.year != y || dt.month != mo || dt.day != d) return null;
  return dt;
}

String historyDateKey(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// The first of [d]'s month.
DateTime monthOf(DateTime d) => DateTime(d.year, d.month);

DateTime lastDayOfMonth(DateTime month) => DateTime(month.year, month.month + 1, 0);

/// Whole months from [a] to [b] (positive when b is later).
int monthsBetween(DateTime a, DateTime b) => (b.year - a.year) * 12 + (b.month - a.month);

String monthKey(DateTime month) => '${month.year}-${month.month.toString().padLeft(2, '0')}';

String formatMonthTitle(DateTime month) => '${historyMonthNames[month.month - 1]} ${month.year}';

/// "Tuesday 1 September 2026".
String formatLongDate(DateTime d) =>
    '${historyWeekdayNames[d.weekday - 1]} ${d.day} ${historyMonthNames[d.month - 1]} ${d.year}';

/// "1 Sep 2026".
String formatShortDate(DateTime d) => '${d.day} ${historyMonthNames[d.month - 1].substring(0, 3)} ${d.year}';

/// "45 min", "8h 05m".
String formatHistoryMinutes(int minutes) {
  final m = minutes.abs();
  final sign = minutes < 0 ? '-' : '';
  if (m < 60) return '$sign$m min';
  return '$sign${m ~/ 60}h ${(m % 60).toString().padLeft(2, '0')}m';
}

/// The server's clock text without seconds: "11:02:15 AM" -> "11:02 AM".
/// Anything that isn't in that shape is shown as sent.
String shortClock(String? display) {
  if (display == null || display.isEmpty) return '--:--';
  final m = RegExp(r'^(\d{1,2}:\d{2}):\d{2}(\s*[AaPp][Mm])?$').firstMatch(display.trim());
  if (m == null) return display;
  return '${m[1]}${m[2] ?? ''}';
}

// --- session cache ------------------------------------------------------------

/// Months already fetched this session, in memory only, so paging back and
/// forth doesn't refetch. Past months don't change often and are kept for the
/// session; the current month (today is still moving) goes stale after
/// [currentMonthTtl]. Keyed by device so a re-enrolled phone never sees the
/// previous person's months.
class HistoryMonthCache {
  static const currentMonthTtl = Duration(minutes: 2);

  final Map<String, (HistoryRange, DateTime)> _months = {};

  String _key(String owner, DateTime month) => '$owner|${monthKey(month)}';

  /// The cached month, or null when absent or stale at [now].
  HistoryRange? get(String owner, DateTime month, DateTime now) {
    final hit = _months[_key(owner, month)];
    if (hit == null) return null;
    final isCurrent = monthKey(month) == monthKey(now);
    if (isCurrent && now.difference(hit.$2) > currentMonthTtl) return null;
    return hit.$1;
  }

  /// The cached month whatever its age, to show while a refresh runs or
  /// when a refresh fails.
  HistoryRange? getStale(String owner, DateTime month) => _months[_key(owner, month)]?.$1;

  DateTime? fetchedAt(String owner, DateTime month) => _months[_key(owner, month)]?.$2;

  void put(String owner, DateTime month, HistoryRange range, DateTime at) =>
      _months[_key(owner, month)] = (range, at);

  void invalidate(String owner, DateTime month) => _months.remove(_key(owner, month));

  void clear() => _months.clear();

  /// The employment start date from any month fetched for [owner].
  String? employmentStart(String owner) {
    for (final e in _months.entries) {
      if (e.key.startsWith('$owner|') && e.value.$1.employmentStart != null) {
        return e.value.$1.employmentStart;
      }
    }
    return null;
  }
}
