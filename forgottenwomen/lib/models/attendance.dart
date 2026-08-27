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
        date: json['date'] as String? ?? '',
        status: PresenceStatus.parse(json['status'] as String?),
        statusLabel: json['statusLabel'] as String? ?? '',
        firstCheckIn: json['firstCheckIn'] as String? ?? '--',
        lastActiveTime: json['lastActiveTime'] as String? ?? '--',
        totalMinutes: (json['totalMinutes'] as num?)?.toInt() ?? 0,
        timeWorkedFormatted: json['timeWorkedFormatted'] as String? ?? '0 mins',
        adjustmentMinutes: (json['adjustmentMinutes'] as num?)?.toInt() ?? 0,
        needsReview: json['needsReview'] as bool? ?? false,
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

  const QueuedObservation({required this.observedAt, this.ssid, this.bssid});

  Map<String, dynamic> toJson() => {
        'observedAt': observedAt,
        if (ssid != null) 'ssid': ssid,
        if (bssid != null) 'bssid': bssid,
      };

  factory QueuedObservation.fromJson(Map<String, dynamic> json) =>
      QueuedObservation(
        observedAt: (json['observedAt'] as num).toInt(),
        ssid: json['ssid'] as String?,
        bssid: json['bssid'] as String?,
      );
}
