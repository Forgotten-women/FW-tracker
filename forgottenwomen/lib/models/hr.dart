// Models for the employee-facing HR screens: leave, warnings and payslip.
//
// As with attendance.dart, these parse defensively - a missing or renamed
// field falls back rather than throwing, so a server change surfaces as a
// blank field, never a crashed screen.

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

class LeaveBalance {
  final bool blocked;
  final String? blockedMessage;
  final double annualEntitlement;
  final double accrued;
  final double taken;
  final double booked;
  final double available;
  final bool isNegative;
  final String? yearFrom;
  final String? yearTo;
  final String? nextAccrualDate;

  const LeaveBalance({
    required this.blocked,
    this.blockedMessage,
    this.annualEntitlement = 0,
    this.accrued = 0,
    this.taken = 0,
    this.booked = 0,
    this.available = 0,
    this.isNegative = false,
    this.yearFrom,
    this.yearTo,
    this.nextAccrualDate,
  });

  static double _d(dynamic v) => (v as num?)?.toDouble() ?? 0;

  factory LeaveBalance.fromJson(Map<String, dynamic> json) {
    if (json['blocked'] == true) {
      return LeaveBalance(blocked: true, blockedMessage: json['message'] as String?);
    }
    final year = json['holidayYear'] as Map<String, dynamic>?;
    return LeaveBalance(
      blocked: false,
      annualEntitlement: _d(json['annualEntitlement']),
      accrued: _d(json['accrued']),
      taken: _d(json['taken']),
      booked: _d(json['booked']),
      available: _d(json['available']),
      isNegative: json['isNegative'] as bool? ?? false,
      yearFrom: year?['from'] as String?,
      yearTo: year?['to'] as String?,
      nextAccrualDate: json['nextAccrualDate'] as String?,
    );
  }
}

class LeaveRequest {
  final String id;
  final String type;
  final String from;
  final String to;
  final double days;
  final String status;
  final String submittedAt;

  const LeaveRequest({
    required this.id,
    required this.type,
    required this.from,
    required this.to,
    required this.days,
    required this.status,
    required this.submittedAt,
  });

  factory LeaveRequest.fromJson(Map<String, dynamic> json) => LeaveRequest(
        id: json['id'] as String? ?? '',
        type: json['type'] as String? ?? '',
        from: json['from'] as String? ?? '',
        to: json['to'] as String? ?? '',
        days: (json['days'] as num?)?.toDouble() ?? 0,
        status: json['status'] as String? ?? 'UNKNOWN',
        submittedAt: json['submittedAt'] as String? ?? '',
      );

  bool get isPending => status == 'PENDING_HR' || status == 'PENDING_MANAGER';
  bool get isApproved => status == 'APPROVED';
}

class LeaveType {
  final String id;
  final String name;
  final bool reducesEntitlement;
  final bool requiresEvidence;

  const LeaveType({
    required this.id,
    required this.name,
    required this.reducesEntitlement,
    required this.requiresEvidence,
  });

  factory LeaveType.fromJson(Map<String, dynamic> json) => LeaveType(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        reducesEntitlement: json['reducesEntitlement'] as bool? ?? false,
        requiresEvidence: json['requiresEvidence'] as bool? ?? false,
      );
}

class LeavePreview {
  final double requestedDays;
  final double projectedAvailable;
  final bool exceedsBalance;
  final double shortfallDays;
  final String? warning;

  const LeavePreview({
    required this.requestedDays,
    required this.projectedAvailable,
    required this.exceedsBalance,
    required this.shortfallDays,
    this.warning,
  });

  factory LeavePreview.fromJson(Map<String, dynamic> json) => LeavePreview(
        requestedDays: (json['requestedDays'] as num?)?.toDouble() ?? 0,
        projectedAvailable: (json['projectedAvailable'] as num?)?.toDouble() ?? 0,
        exceedsBalance: json['exceedsBalance'] as bool? ?? false,
        shortfallDays: (json['shortfallDays'] as num?)?.toDouble() ?? 0,
        warning: json['warning'] as String?,
      );
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

class LatenessStatus {
  final bool resolved;
  final int count;
  final int allowed;
  final int remaining;
  final bool thresholdReached;
  final String message;

  const LatenessStatus({
    required this.resolved,
    this.count = 0,
    this.allowed = 0,
    this.remaining = 0,
    this.thresholdReached = false,
    this.message = '',
  });

  factory LatenessStatus.fromJson(Map<String, dynamic> json) => LatenessStatus(
        resolved: json['resolved'] as bool? ?? false,
        count: (json['count'] as num?)?.toInt() ?? 0,
        allowed: (json['allowed'] as num?)?.toInt() ?? 0,
        remaining: (json['remaining'] as num?)?.toInt() ?? 0,
        thresholdReached: json['thresholdReached'] as bool? ?? false,
        message: json['message'] as String? ?? '',
      );
}

class FormalWarning {
  final String id;
  final String levelLabel;
  final String type;
  final String explanation;
  final String issuedOn;
  final String status;
  final bool acknowledgementRequired;
  final String? acknowledgedAt;

  const FormalWarning({
    required this.id,
    required this.levelLabel,
    required this.type,
    required this.explanation,
    required this.issuedOn,
    required this.status,
    required this.acknowledgementRequired,
    this.acknowledgedAt,
  });

  factory FormalWarning.fromJson(Map<String, dynamic> json) => FormalWarning(
        id: json['id'] as String? ?? '',
        levelLabel: json['levelLabel'] as String? ?? 'warning',
        type: json['type'] as String? ?? '',
        explanation: json['explanation'] as String? ?? '',
        issuedOn: json['issuedOn'] as String? ?? '',
        status: json['status'] as String? ?? '',
        acknowledgementRequired: json['acknowledgementRequired'] as bool? ?? false,
        acknowledgedAt: json['acknowledgedAt'] as String?,
      );
}

class WarningView {
  final String band; // GREEN | AMBER | RED | UNKNOWN
  final String bandLabel;
  final LatenessStatus lateness;
  final bool pendingReview;
  final List<FormalWarning> warnings;
  final int activeWarnings;
  final String? nextLevelIfConfirmed;

  const WarningView({
    required this.band,
    required this.bandLabel,
    required this.lateness,
    required this.pendingReview,
    required this.warnings,
    required this.activeWarnings,
    this.nextLevelIfConfirmed,
  });

  factory WarningView.fromJson(Map<String, dynamic> json) {
    final standing = json['standing'] as Map<String, dynamic>? ?? {};
    return WarningView(
      band: json['band'] as String? ?? 'UNKNOWN',
      bandLabel: json['bandLabel'] as String? ?? '',
      lateness: LatenessStatus.fromJson(
          json['lateness'] as Map<String, dynamic>? ?? const {}),
      pendingReview: json['pendingReview'] as bool? ?? false,
      warnings: (json['warnings'] as List<dynamic>? ?? [])
          .map((w) => FormalWarning.fromJson(w as Map<String, dynamic>))
          .toList(),
      activeWarnings: (standing['activeWarnings'] as num?)?.toInt() ?? 0,
      nextLevelIfConfirmed: standing['nextLevelIfConfirmed'] as String?,
    );
  }
}
