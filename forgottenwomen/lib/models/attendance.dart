// Typed models.
//
// The old app indexed raw `dynamic` maps everywhere (data['employee']['status'],
// attendance['firstCheckInDisplay'] ?? attendance['checkInDisplay'] ?? '--:--'),
// so a server-side rename failed silently at runtime instead of at compile time.

/// One continuous stretch of presence within a day.
class WorkSession {
  final String from;
  final String to;
  final String duration;
  final bool open;

  const WorkSession({
    required this.from,
    required this.to,
    required this.duration,
    required this.open,
  });

  factory WorkSession.fromJson(Map<String, dynamic> json) => WorkSession(
        from: json['from'] as String? ?? '--',
        to: json['to'] as String? ?? '--',
        duration: json['duration'] as String? ?? '0 mins',
        open: json['open'] as bool? ?? false,
      );
}

/// Presence state for one employee-day, as derived by the server.
///
/// The server is the only authority on status. The app never computes it, so
/// the phone and the dashboard cannot disagree.
enum PresenceStatus {
  notCheckedIn,
  inOffice,
  gracePeriod,
  away,
  closed;

  static PresenceStatus parse(String? raw) {
    switch (raw) {
      case 'IN_OFFICE':
        return PresenceStatus.inOffice;
      case 'GRACE_PERIOD':
        return PresenceStatus.gracePeriod;
      case 'AWAY':
        return PresenceStatus.away;
      case 'CLOSED':
        return PresenceStatus.closed;
      default:
        return PresenceStatus.notCheckedIn;
    }
  }

  bool get isPresent =>
      this == PresenceStatus.inOffice || this == PresenceStatus.gracePeriod;
}

class Attendance {
  final String employeeId;
  final String employeeName;
  final String role;
  final String date;
  final PresenceStatus status;
  final String statusLabel;
  final String firstCheckIn;
  final String lastActiveTime;
  final int totalMinutes;
  final String timeWorkedFormatted;
  final int adjustmentMinutes;
  final bool needsReview;
  final List<WorkSession> sessions;

  const Attendance({
    required this.employeeId,
    required this.employeeName,
    required this.role,
    required this.date,
    required this.status,
    required this.statusLabel,
    required this.firstCheckIn,
    required this.lastActiveTime,
    required this.totalMinutes,
    required this.timeWorkedFormatted,
    required this.adjustmentMinutes,
    required this.needsReview,
    required this.sessions,
  });

  factory Attendance.fromJson(Map<String, dynamic> json) => Attendance(
        employeeId: json['employeeId'] as String? ?? '',
        employeeName: json['employeeName'] as String? ?? '',
        role: json['role'] as String? ?? '',
        date: (json['date'] ?? json['dateKey']) as String? ?? '',
        status: PresenceStatus.parse(json['status'] as String?),
        statusLabel: json['statusLabel'] as String? ?? '',
        firstCheckIn:
            (json['firstCheckIn'] ?? json['firstIn']) as String? ?? '--',
        lastActiveTime:
            (json['lastActiveTime'] ?? json['lastSeen']) as String? ?? '--',
        totalMinutes:
            ((json['totalMinutes'] ?? json['workedMinutes']) as num?)?.toInt() ??
                0,
        timeWorkedFormatted:
            (json['timeWorkedFormatted'] ?? json['worked']) as String? ??
                '0 mins',
        adjustmentMinutes: (json['adjustmentMinutes'] as num?)?.toInt() ?? 0,
        needsReview: json['needsReview'] is bool
            ? json['needsReview'] as bool
            : (json['needsReview'] is List
                ? (json['needsReview'] as List).isNotEmpty
                : false),
        sessions: (json['sessions'] as List<dynamic>? ?? [])
            .map((s) => WorkSession.fromJson(s as Map<String, dynamic>))
            .toList(),
      );

  static Attendance empty() => const Attendance(
        employeeId: '',
        employeeName: '',
        role: '',
        date: '',
        status: PresenceStatus.notCheckedIn,
        statusLabel: 'Not checked in',
        firstCheckIn: '--',
        lastActiveTime: '--',
        totalMinutes: 0,
        timeWorkedFormatted: '0 mins',
        adjustmentMinutes: 0,
        needsReview: false,
        sessions: [],
      );
}

/// Result of one heartbeat.
class PingResult {
  final int accepted;
  final int duplicates;
  final int rejected;

  /// Whether the server accepted this as verified office presence. False means
  /// the phone was authenticated but its location did not check out, so no
  /// attendance was recorded - the app must say so rather than showing
  /// "IN OFFICE" regardless, which is what the old UI did.
  final bool verified;

  final String serverTime;
  final Attendance attendance;

  const PingResult({
    required this.accepted,
    required this.duplicates,
    required this.rejected,
    required this.verified,
    required this.serverTime,
    required this.attendance,
  });

  factory PingResult.fromJson(Map<String, dynamic> json) => PingResult(
        accepted: (json['accepted'] as num?)?.toInt() ?? 0,
        duplicates: (json['duplicates'] as num?)?.toInt() ?? 0,
        rejected: (json['rejected'] as num?)?.toInt() ?? 0,
        verified: json['verified'] as bool? ?? false,
        serverTime: json['serverTime'] as String? ?? '',
        attendance: json['attendance'] == null
            ? Attendance.empty()
            : Attendance.fromJson(json['attendance'] as Map<String, dynamic>),
      );
}

/// One buffered sighting awaiting upload.
class QueuedObservation {
  final int observedAt;
  final String? ssid;
  final String? bssid;
  final String? localIp;

  const QueuedObservation({required this.observedAt, this.ssid, this.bssid, this.localIp});

  Map<String, dynamic> toJson() => {
        'observedAt': observedAt,
        if (ssid != null) 'ssid': ssid,
        if (bssid != null) 'bssid': bssid,
        if (localIp != null) 'localIp': localIp,
      };

  factory QueuedObservation.fromJson(Map<String, dynamic> json) =>
      QueuedObservation(
        observedAt: (json['observedAt'] as num).toInt(),
        ssid: json['ssid'] as String?,
        bssid: json['bssid'] as String?,
        localIp: json['localIp'] as String?,
      );
}

/// Detailed breakdown of today's attendance deficit (Spec 8.1, 19.3).
class DeficitBreakdown {
  final int lateMinutes;
  final int excessBreakMinutes;
  final int earlyDepartureMinutes;
  final int unauthorisedMissingMinutes;
  final int approvedAdjustmentMinutes;
  final int totalMinutes;
  final String formatted;

  const DeficitBreakdown({
    required this.lateMinutes,
    required this.excessBreakMinutes,
    required this.earlyDepartureMinutes,
    required this.unauthorisedMissingMinutes,
    required this.approvedAdjustmentMinutes,
    required this.totalMinutes,
    required this.formatted,
  });

  factory DeficitBreakdown.fromJson(Map<String, dynamic> json) =>
      DeficitBreakdown(
        lateMinutes: (json['lateMinutes'] as num?)?.toInt() ?? 0,
        excessBreakMinutes: (json['excessBreakMinutes'] as num?)?.toInt() ?? 0,
        earlyDepartureMinutes:
            (json['earlyDepartureMinutes'] as num?)?.toInt() ?? 0,
        unauthorisedMissingMinutes:
            (json['unauthorisedMissingMinutes'] as num?)?.toInt() ?? 0,
        approvedAdjustmentMinutes:
            ((json['approvedAdjustmentMinutes'] as num?)?.toInt() ?? 0).abs(),
        totalMinutes: (json['totalMinutes'] as num?)?.toInt() ?? 0,
        formatted: json['formatted'] as String? ?? '0 mins',
      );

  static DeficitBreakdown empty() => const DeficitBreakdown(
        lateMinutes: 0,
        excessBreakMinutes: 0,
        earlyDepartureMinutes: 0,
        unauthorisedMissingMinutes: 0,
        approvedAdjustmentMinutes: 0,
        totalMinutes: 0,
        formatted: '0 mins',
      );
}

/// Running accumulated attendance deficit balance (Spec 8.2, 8.3, 19.3).
class DeficitBalance {
  final int minutes;
  final String formatted;
  final int wholeDayEquivalents;
  final int carryForwardMinutes;
  final int dayEquivalentMinutes;
  final DeficitBreakdown todayBreakdown;

  const DeficitBalance({
    required this.minutes,
    required this.formatted,
    required this.wholeDayEquivalents,
    required this.carryForwardMinutes,
    required this.dayEquivalentMinutes,
    required this.todayBreakdown,
  });

  factory DeficitBalance.fromJson(
    Map<String, dynamic> json, {
    DeficitBreakdown? todayBreakdown,
  }) =>
      DeficitBalance(
        minutes: (json['minutes'] as num?)?.toInt() ?? 0,
        formatted: json['formatted'] as String? ?? '0 mins',
        wholeDayEquivalents:
            (json['wholeDayEquivalents'] as num?)?.toInt() ?? 0,
        carryForwardMinutes:
            (json['carryForwardMinutes'] as num?)?.toInt() ?? 0,
        dayEquivalentMinutes:
            (json['dayEquivalentMinutes'] as num?)?.toInt() ?? 480,
        todayBreakdown: todayBreakdown ?? DeficitBreakdown.empty(),
      );

  static DeficitBalance empty() => DeficitBalance(
        minutes: 0,
        formatted: '0 mins',
        wholeDayEquivalents: 0,
        carryForwardMinutes: 0,
        dayEquivalentMinutes: 480,
        todayBreakdown: DeficitBreakdown.empty(),
      );
}

/// Active break state for countdown and overruns (Spec 12, 19.1).
class ActiveBreakInfo {
  final bool onBreak;
  final int? startedAtMs;
  final int? dueBackAtMs;
  final String? dueBackDisplay;
  final int permittedMinutes;
  final int breakMinutesTaken;

  const ActiveBreakInfo({
    required this.onBreak,
    this.startedAtMs,
    this.dueBackAtMs,
    this.dueBackDisplay,
    this.permittedMinutes = 30,
    this.breakMinutesTaken = 0,
  });

  factory ActiveBreakInfo.fromJson(Map<String, dynamic> json) => ActiveBreakInfo(
        onBreak: json['onBreak'] as bool? ?? false,
        startedAtMs: (json['activeBreakStartedAtMs'] as num?)?.toInt(),
        dueBackAtMs: (json['breakDueBackAtMs'] as num?)?.toInt(),
        dueBackDisplay: json['breakDueBack'] as String?,
        permittedMinutes:
            (json['permittedBreakMinutes'] as num?)?.toInt() ?? 30,
        breakMinutesTaken: (json['breakMinutesTaken'] as num?)?.toInt() ?? 0,
      );

  static ActiveBreakInfo empty() => const ActiveBreakInfo(
        onBreak: false,
        permittedMinutes: 30,
        breakMinutesTaken: 0,
      );
}

/// Result returned when starting a break.
class BreakStartResult {
  final String breakId;
  final String startedAt;
  final int permittedMinutes;
  final String dueBackAt;
  final int dueBackAtMs;

  const BreakStartResult({
    required this.breakId,
    required this.startedAt,
    required this.permittedMinutes,
    required this.dueBackAt,
    required this.dueBackAtMs,
  });

  factory BreakStartResult.fromJson(Map<String, dynamic> json) =>
      BreakStartResult(
        breakId: json['breakId'] as String? ?? '',
        startedAt: json['startedAt'] as String? ?? '',
        permittedMinutes: (json['permittedMinutes'] as num?)?.toInt() ?? 30,
        dueBackAt: json['dueBackAt'] as String? ?? '',
        dueBackAtMs: (json['dueBackAtMs'] as num?)?.toInt() ?? 0,
      );
}

/// Result returned when ending a break.
class BreakEndResult {
  final int actualMinutes;
  final int permittedMinutes;
  final int excessMinutes;
  final String message;

  const BreakEndResult({
    required this.actualMinutes,
    required this.permittedMinutes,
    required this.excessMinutes,
    required this.message,
  });

  factory BreakEndResult.fromJson(Map<String, dynamic> json) => BreakEndResult(
        actualMinutes: (json['actualMinutes'] as num?)?.toInt() ?? 0,
        permittedMinutes: (json['permittedMinutes'] as num?)?.toInt() ?? 30,
        excessMinutes: (json['excessMinutes'] as num?)?.toInt() ?? 0,
        message: json['message'] as String? ?? '',
      );
}

/// Complete details for today from /api/attendance/today.
class TodayAttendanceDetails {
  final String employeeName;
  final Attendance attendance;
  final ActiveBreakInfo breakInfo;
  final DeficitBalance deficitBalance;
  final String? latenessMessage;

  const TodayAttendanceDetails({
    required this.employeeName,
    required this.attendance,
    required this.breakInfo,
    required this.deficitBalance,
    this.latenessMessage,
  });

  factory TodayAttendanceDetails.fromJson(Map<String, dynamic> json) {
    final todayMap = (json['today'] as Map<String, dynamic>?) ?? {};
    final employeeMap = (json['employee'] as Map<String, dynamic>?) ?? {};
    final latenessMap = (json['lateness'] as Map<String, dynamic>?) ?? {};
    final deficitMap = (json['deficitBalance'] as Map<String, dynamic>?) ?? {};
    final deficitBreakdownMap =
        (todayMap['deficit'] as Map<String, dynamic>?) ?? {};

    final breakdown = DeficitBreakdown.fromJson(deficitBreakdownMap);
    final deficit = DeficitBalance.fromJson(deficitMap, todayBreakdown: breakdown);
    final breakInfo = ActiveBreakInfo.fromJson(todayMap);

    return TodayAttendanceDetails(
      employeeName: employeeMap['name'] as String? ?? '',
      attendance: Attendance.fromJson({
        ...todayMap,
        'employeeId': employeeMap['id'] ?? '',
        'employeeName': employeeMap['name'] ?? '',
      }),
      breakInfo: breakInfo,
      deficitBalance: deficit,
      latenessMessage: latenessMap['message'] as String?,
    );
  }
}

/// Attendance dispute / correction request submitted by an employee (Spec 11).
class CorrectionRequest {
  final String id;
  final String date;
  final String reason;
  final String status;
  final Map<String, dynamic> requestedChange;
  final Map<String, dynamic> appliedChange;
  final String requestedAt;
  final String? reviewedAt;
  final String? reviewNotes;

  const CorrectionRequest({
    required this.id,
    required this.date,
    required this.reason,
    required this.status,
    this.requestedChange = const {},
    this.appliedChange = const {},
    required this.requestedAt,
    this.reviewedAt,
    this.reviewNotes,
  });

  factory CorrectionRequest.fromJson(Map<String, dynamic> json) =>
      CorrectionRequest(
        id: json['id'] as String? ?? '',
        date: (json['date'] ?? json['dateKey']) as String? ?? '',
        reason: json['reason'] as String? ?? '',
        status: json['status'] as String? ?? 'PENDING',
        requestedChange:
            (json['requestedChange'] as Map<String, dynamic>?) ?? const {},
        appliedChange:
            (json['appliedChange'] as Map<String, dynamic>?) ?? const {},
        requestedAt: json['requestedAt'] as String? ?? '',
        reviewedAt: json['reviewedAt'] as String?,
        reviewNotes: json['reviewNotes'] as String?,
      );

  bool get isPending => status == 'PENDING';
  bool get isApproved => status == 'APPROVED';
  bool get isRejected => status == 'REJECTED';
  bool get isAmended => status == 'AMENDED';
}
