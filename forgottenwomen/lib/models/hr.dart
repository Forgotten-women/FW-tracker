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
  final String? cycleStartDate;
  final String? cycleEndDate;
  final String? nextRenewalDate;
  final String? officialJoiningDate;
  final double approvedCarryForward;
  final double remainingCurrentCycle;
  final double dueToExpire;
  final double alreadyLapsed;
  final String? renewalDate;

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
    this.cycleStartDate,
    this.cycleEndDate,
    this.nextRenewalDate,
    this.officialJoiningDate,
    this.approvedCarryForward = 0,
    this.remainingCurrentCycle = 0,
    this.dueToExpire = 0,
    this.alreadyLapsed = 0,
    this.renewalDate,
  });

  static double _d(dynamic v) => (v as num?)?.toDouble() ?? 0;

  factory LeaveBalance.fromJson(Map<String, dynamic> json) {
    if (json['blocked'] == true) {
      return LeaveBalance(blocked: true, blockedMessage: json['message'] as String?);
    }
    final year = json['holidayYear'] as Map<String, dynamic>?;
    return LeaveBalance(
      blocked: false,
      annualEntitlement: _d(json['annualEntitlementDays'] ?? json['annualEntitlement']),
      accrued: _d(json['accruedDays'] ?? json['accrued']),
      taken: _d(json['takenDays'] ?? json['taken']),
      booked: _d(json['bookedDays'] ?? json['booked']),
      available: _d(json['availableDays'] ?? json['available']),
      isNegative: json['isNegative'] as bool? ?? false,
      yearFrom: year?['from'] as String?,
      yearTo: year?['to'] as String?,
      nextAccrualDate: json['nextAccrualDate'] as String?,
      cycleStartDate: json['cycleStartDate'] as String? ?? year?['from'] as String?,
      cycleEndDate: json['cycleEndDate'] as String? ?? year?['to'] as String?,
      nextRenewalDate: json['nextRenewalDate'] as String? ?? year?['anniversaryDate'] as String?,
      officialJoiningDate: json['officialJoiningDate'] as String?,
      approvedCarryForward: _d(json['approvedCarryForwardDays'] ?? json['approvedCarryForward']),
      remainingCurrentCycle: _d(json['remainingCurrentCycleDays'] ?? json['remainingCurrentCycle'] ?? json['availableDays'] ?? json['available']),
      dueToExpire: _d(json['leaveDueToExpire'] ?? json['dueToExpire']),
      alreadyLapsed: _d(json['leaveAlreadyLapsed'] ?? json['alreadyLapsed']),
      renewalDate: json['renewalDate'] as String? ?? json['nextRenewalDate'] as String?,
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

class BankHoliday {
  final String id;
  final int year;
  final String date;
  final String name;
  final String? notes;
  final String weekday;
  final bool isPaid;

  const BankHoliday({
    required this.id,
    required this.year,
    required this.date,
    required this.name,
    this.notes,
    required this.weekday,
    this.isPaid = true,
  });

  factory BankHoliday.fromJson(Map<String, dynamic> json) => BankHoliday(
        id: json['id'] as String? ?? '',
        year: (json['year'] as num?)?.toInt() ?? DateTime.now().year,
        date: json['date'] as String? ?? '',
        name: json['name'] as String? ?? '',
        notes: json['notes'] as String?,
        weekday: json['weekday'] as String? ?? '',
        isPaid: json['isPaid'] as bool? ?? true,
      );
}

class MonthOption {
  final String monthKey;
  final String label;
  final bool isCurrent;
  final bool isSelected;

  const MonthOption({
    required this.monthKey,
    required this.label,
    required this.isCurrent,
    required this.isSelected,
  });

  factory MonthOption.fromJson(Map<String, dynamic> json) => MonthOption(
        monthKey: json['monthKey'] as String? ?? '',
        label: json['label'] as String? ?? '',
        isCurrent: json['isCurrent'] as bool? ?? false,
        isSelected: json['isSelected'] as bool? ?? false,
      );
}

class LeaveAdjustmentEntry {
  final String id;
  final String date;
  final double days;
  final String description;
  final String? createdBy;

  const LeaveAdjustmentEntry({
    required this.id,
    required this.date,
    required this.days,
    required this.description,
    this.createdBy,
  });

  factory LeaveAdjustmentEntry.fromJson(Map<String, dynamic> json) => LeaveAdjustmentEntry(
        id: json['id'] as String? ?? '',
        date: json['date'] as String? ?? '',
        days: (json['days'] as num?)?.toDouble() ?? 0,
        description: json['description'] as String? ?? '',
        createdBy: json['createdBy'] as String?,
      );
}

class PendingLeaveRequestItem {
  final String id;
  final String startDate;
  final String endDate;
  final double days;
  final String typeName;

  const PendingLeaveRequestItem({
    required this.id,
    required this.startDate,
    required this.endDate,
    required this.days,
    required this.typeName,
  });

  factory PendingLeaveRequestItem.fromJson(Map<String, dynamic> json) => PendingLeaveRequestItem(
        id: json['id'] as String? ?? '',
        startDate: json['startDate'] as String? ?? '',
        endDate: json['endDate'] as String? ?? '',
        days: (json['days'] as num?)?.toDouble() ?? 0,
        typeName: json['typeName'] as String? ?? '',
      );
}

class RequestedLeaveSufficiency {
  final bool hasRequestedLeave;
  final double pendingDays;
  final String status;
  final double shortfallDays;
  final String message;
  final List<PendingLeaveRequestItem> pendingRequests;

  const RequestedLeaveSufficiency({
    required this.hasRequestedLeave,
    required this.pendingDays,
    required this.status,
    required this.shortfallDays,
    required this.message,
    this.pendingRequests = const [],
  });

  bool get isSufficient => status == 'SUFFICIENT';

  factory RequestedLeaveSufficiency.fromJson(Map<String, dynamic> json) => RequestedLeaveSufficiency(
        hasRequestedLeave: json['hasRequestedLeave'] as bool? ?? false,
        pendingDays: (json['pendingDays'] as num?)?.toDouble() ?? 0,
        status: json['status'] as String? ?? 'SUFFICIENT',
        shortfallDays: (json['shortfallDays'] as num?)?.toDouble() ?? 0,
        message: json['message'] as String? ?? '',
        pendingRequests: (json['pendingRequests'] as List<dynamic>?)
                ?.map((e) => PendingLeaveRequestItem.fromJson(e as Map<String, dynamic>))
                .toList() ??
            const [],
      );
}

class MonthlyLeaveReport {
  final bool blocked;
  final String? blockedMessage;
  final String monthKey;
  final String monthName;
  final String monthStart;
  final String monthEnd;
  final String asOfDate;
  final String? cycleStartDate;
  final String? cycleEndDate;
  final String? nextRenewalDate;
  final String? officialJoiningDate;
  final List<MonthOption> availableMonths;

  final String summaryExplanation;

  final double annualEntitlementDays;
  final double leaveAlreadyTaken;
  final double cyclePaidLeaveUsed;
  final double monthPaidLeaveUsed;
  final double cycleUnpaidLeaveTaken;
  final double monthUnpaidLeaveTaken;
  final double remainingAnnualLeave;
  final double accruedUpToMonth;
  final double currentlyEntitledPaidLeave;
  final double approvedCarryForwardDays;

  final RequestedLeaveSufficiency requestedLeaveSufficiency;
  final double totalMonthAdjustments;
  final int monthAdjustmentsCount;
  final List<LeaveAdjustmentEntry> monthAdjustments;

  const MonthlyLeaveReport({
    required this.blocked,
    this.blockedMessage,
    this.monthKey = '',
    this.monthName = '',
    this.monthStart = '',
    this.monthEnd = '',
    this.asOfDate = '',
    this.cycleStartDate,
    this.cycleEndDate,
    this.nextRenewalDate,
    this.officialJoiningDate,
    this.availableMonths = const [],
    this.summaryExplanation = '',
    this.annualEntitlementDays = 0,
    this.leaveAlreadyTaken = 0,
    this.cyclePaidLeaveUsed = 0,
    this.monthPaidLeaveUsed = 0,
    this.cycleUnpaidLeaveTaken = 0,
    this.monthUnpaidLeaveTaken = 0,
    this.remainingAnnualLeave = 0,
    this.accruedUpToMonth = 0,
    this.currentlyEntitledPaidLeave = 0,
    this.approvedCarryForwardDays = 0,
    this.requestedLeaveSufficiency = const RequestedLeaveSufficiency(
      hasRequestedLeave: false,
      pendingDays: 0,
      status: 'SUFFICIENT',
      shortfallDays: 0,
      message: '',
    ),
    this.totalMonthAdjustments = 0,
    this.monthAdjustmentsCount = 0,
    this.monthAdjustments = const [],
  });

  static double _d(dynamic v) => (v as num?)?.toDouble() ?? 0;

  factory MonthlyLeaveReport.fromJson(Map<String, dynamic> json) {
    if (json['blocked'] == true) {
      return MonthlyLeaveReport(
        blocked: true,
        blockedMessage: json['message'] as String?,
      );
    }

    final paid = json['paidLeaveUsed'] as Map<String, dynamic>?;
    final unpaid = json['unpaidLeaveTaken'] as Map<String, dynamic>?;
    final reqSuff = json['requestedLeaveSufficiency'] as Map<String, dynamic>?;
    final adj = json['monthAdjustments'] as Map<String, dynamic>?;

    return MonthlyLeaveReport(
      blocked: false,
      monthKey: json['monthKey'] as String? ?? '',
      monthName: json['monthName'] as String? ?? '',
      monthStart: json['monthStart'] as String? ?? '',
      monthEnd: json['monthEnd'] as String? ?? '',
      asOfDate: json['asOfDate'] as String? ?? '',
      cycleStartDate: json['cycleStartDate'] as String?,
      cycleEndDate: json['cycleEndDate'] as String?,
      nextRenewalDate: json['nextRenewalDate'] as String?,
      officialJoiningDate: json['officialJoiningDate'] as String?,
      availableMonths: (json['availableMonths'] as List<dynamic>?)
              ?.map((e) => MonthOption.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
      summaryExplanation: json['summaryExplanation'] as String? ?? '',
      annualEntitlementDays: _d(json['annualEntitlementDays']),
      leaveAlreadyTaken: _d(json['leaveAlreadyTaken']),
      cyclePaidLeaveUsed: _d(paid?['cycleTotal']),
      monthPaidLeaveUsed: _d(paid?['thisMonth']),
      cycleUnpaidLeaveTaken: _d(unpaid?['cycleTotal']),
      monthUnpaidLeaveTaken: _d(unpaid?['thisMonth']),
      remainingAnnualLeave: _d(json['remainingAnnualLeave']),
      accruedUpToMonth: _d(json['accruedUpToMonth']),
      currentlyEntitledPaidLeave: _d(json['currentlyEntitledPaidLeave']),
      approvedCarryForwardDays: _d(json['approvedCarryForwardDays']),
      requestedLeaveSufficiency: reqSuff != null
          ? RequestedLeaveSufficiency.fromJson(reqSuff)
          : const RequestedLeaveSufficiency(
              hasRequestedLeave: false,
              pendingDays: 0,
              status: 'SUFFICIENT',
              shortfallDays: 0,
              message: '',
            ),
      totalMonthAdjustments: _d(adj?['totalDays']),
      monthAdjustmentsCount: (adj?['count'] as num?)?.toInt() ?? 0,
      monthAdjustments: (adj?['items'] as List<dynamic>?)
              ?.map((e) => LeaveAdjustmentEntry.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const [],
    );
  }
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

// ---------------------------------------------------------------------------
// Document Vault & KYC
// ---------------------------------------------------------------------------

class EmployeeDocument {
  final String id;
  final String type;
  final String typeId;
  final String title;
  final int version;
  final String? filename;
  final int sizeBytes;
  final String? mimeType;
  final String storageProvider;
  final String confidentiality;
  final String verificationStatus; // VERIFIED | PENDING_VERIFICATION | REJECTED
  final String? verifiedBy;
  final String? verifiedAt;
  final String? rejectionReason;
  final String? effectiveDate;
  final String? expiryDate;
  final String uploadedAt;
  final bool acknowledgementRequired;
  final String? acknowledgedAt;

  const EmployeeDocument({
    required this.id,
    required this.type,
    required this.typeId,
    required this.title,
    required this.version,
    this.filename,
    this.sizeBytes = 0,
    this.mimeType,
    this.storageProvider = 'local',
    this.confidentiality = 'normal',
    this.verificationStatus = 'VERIFIED',
    this.verifiedBy,
    this.verifiedAt,
    this.rejectionReason,
    this.effectiveDate,
    this.expiryDate,
    required this.uploadedAt,
    this.acknowledgementRequired = false,
    this.acknowledgedAt,
  });

  factory EmployeeDocument.fromJson(Map<String, dynamic> json) => EmployeeDocument(
        id: json['id'] as String? ?? '',
        type: json['type'] as String? ?? '',
        typeId: json['typeId'] as String? ?? '',
        title: json['title'] as String? ?? '',
        version: (json['version'] as num?)?.toInt() ?? 1,
        filename: json['filename'] as String?,
        sizeBytes: (json['sizeBytes'] as num?)?.toInt() ?? 0,
        mimeType: json['mimeType'] as String?,
        storageProvider: json['storageProvider'] as String? ?? 'local',
        confidentiality: json['confidentiality'] as String? ?? 'normal',
        verificationStatus: json['verificationStatus'] as String? ?? 'VERIFIED',
        verifiedBy: json['verifiedBy'] as String?,
        verifiedAt: json['verifiedAt'] as String?,
        rejectionReason: json['rejectionReason'] as String?,
        effectiveDate: json['effectiveDate'] as String?,
        expiryDate: json['expiryDate'] as String?,
        uploadedAt: json['uploadedAt'] as String? ?? '',
        acknowledgementRequired: json['acknowledgementRequired'] as bool? ?? false,
        acknowledgedAt: json['acknowledgedAt'] as String?,
      );

  bool get isVerified => verificationStatus == 'VERIFIED';
  bool get isPending => verificationStatus == 'PENDING_VERIFICATION';
  bool get isRejected => verificationStatus == 'REJECTED';
}

class KycItem {
  final String typeId;
  final String name;
  final String description;
  final bool isMandatory;
  final String status; // VERIFIED | PENDING_VERIFICATION | REJECTED | MISSING
  final String? documentId;
  final String? filename;
  final String? rejectionReason;
  final String? expiryDate;
  final String? uploadedAt;

  const KycItem({
    required this.typeId,
    required this.name,
    required this.description,
    required this.isMandatory,
    required this.status,
    this.documentId,
    this.filename,
    this.rejectionReason,
    this.expiryDate,
    this.uploadedAt,
  });

  factory KycItem.fromJson(Map<String, dynamic> json) => KycItem(
        typeId: json['typeId'] as String? ?? '',
        name: json['name'] as String? ?? '',
        description: json['description'] as String? ?? '',
        isMandatory: json['isMandatory'] as bool? ?? true,
        status: json['status'] as String? ?? 'MISSING',
        documentId: json['documentId'] as String?,
        filename: json['filename'] as String?,
        rejectionReason: json['rejectionReason'] as String?,
        expiryDate: json['expiryDate'] as String?,
        uploadedAt: json['uploadedAt'] as String?,
      );

  bool get isVerified => status == 'VERIFIED';
  bool get isPending => status == 'PENDING_VERIFICATION';
  bool get isRejected => status == 'REJECTED';
  bool get isMissing => status == 'MISSING';
}

class KycChecklist {
  final String employeeId;
  final String employeeName;
  final String employeeRole;
  final String overallKycStatus; // COMPLETE | PENDING_REVIEW | INCOMPLETE
  final int completionPercentage;
  final int totalMandatory;
  final int verifiedCount;
  final int pendingCount;
  final int rejectedCount;
  final int missingCount;
  final List<KycItem> mandatoryChecklist;
  final List<KycItem> optionalChecklist;

  const KycChecklist({
    required this.employeeId,
    required this.employeeName,
    required this.employeeRole,
    required this.overallKycStatus,
    required this.completionPercentage,
    required this.totalMandatory,
    required this.verifiedCount,
    required this.pendingCount,
    required this.rejectedCount,
    required this.missingCount,
    required this.mandatoryChecklist,
    required this.optionalChecklist,
  });

  factory KycChecklist.fromJson(Map<String, dynamic> json) {
    final summary = json['summary'] as Map<String, dynamic>? ?? {};
    return KycChecklist(
      employeeId: json['employeeId'] as String? ?? '',
      employeeName: json['employeeName'] as String? ?? '',
      employeeRole: json['employeeRole'] as String? ?? '',
      overallKycStatus: json['overallKycStatus'] as String? ?? 'INCOMPLETE',
      completionPercentage: (json['completionPercentage'] as num?)?.toInt() ?? 0,
      totalMandatory: (summary['totalMandatory'] as num?)?.toInt() ?? 0,
      verifiedCount: (summary['verifiedCount'] as num?)?.toInt() ?? 0,
      pendingCount: (summary['pendingCount'] as num?)?.toInt() ?? 0,
      rejectedCount: (summary['rejectedCount'] as num?)?.toInt() ?? 0,
      missingCount: (summary['missingCount'] as num?)?.toInt() ?? 0,
      mandatoryChecklist: (json['mandatoryChecklist'] as List<dynamic>? ?? [])
          .map((m) => KycItem.fromJson(m as Map<String, dynamic>))
          .toList(),
      optionalChecklist: (json['optionalChecklist'] as List<dynamic>? ?? [])
          .map((m) => KycItem.fromJson(m as Map<String, dynamic>))
          .toList(),
    );
  }
}

// ---------------------------------------------------------------------------
// Unscheduled Absences & Sickness Reporting (Spec 10 & 2.2)
// ---------------------------------------------------------------------------

class EmployeeAbsenceRecord {
  final String id;
  final String date;
  final String absenceType;
  final String? reason;
  final String? evidenceDocumentId;
  final String? documentTitle;
  final String detectedAt;
  final String status;
  final String? reviewNotes;
  final bool deductAnnualLeave;
  final bool treatAsUnpaid;
  final bool createWarningTrigger;

  const EmployeeAbsenceRecord({
    required this.id,
    required this.date,
    required this.absenceType,
    this.reason,
    this.evidenceDocumentId,
    this.documentTitle,
    required this.detectedAt,
    required this.status,
    this.reviewNotes,
    this.deductAnnualLeave = false,
    this.treatAsUnpaid = false,
    this.createWarningTrigger = false,
  });

  factory EmployeeAbsenceRecord.fromJson(Map<String, dynamic> json) {
    return EmployeeAbsenceRecord(
      id: json['id'] as String? ?? '',
      date: json['date'] as String? ?? '',
      absenceType: json['absenceType'] as String? ?? json['type'] as String? ?? 'SICK',
      reason: json['reason'] as String?,
      evidenceDocumentId: json['evidenceDocumentId'] as String?,
      documentTitle: json['documentTitle'] as String?,
      detectedAt: json['detectedAt'] as String? ?? '',
      status: json['status'] as String? ?? 'PENDING_REVIEW',
      reviewNotes: json['reviewNotes'] as String?,
      deductAnnualLeave: json['deductAnnualLeave'] == true,
      treatAsUnpaid: json['treatAsUnpaid'] == true,
      createWarningTrigger: json['createWarningTrigger'] == true,
    );
  }
}

// ---------------------------------------------------------------------------
// Employee Profile & Salary
// ---------------------------------------------------------------------------

class SalaryInfo {
  final bool enabled;
  final bool blocked;
  final String? message;
  final String? reason;
  final double monthly;
  final double daily;
  final double annual;
  final String currency;
  final String? effectiveFrom;

  const SalaryInfo({
    required this.enabled,
    this.blocked = false,
    this.message,
    this.reason,
    this.monthly = 0,
    this.daily = 0,
    this.annual = 0,
    this.currency = 'GBP',
    this.effectiveFrom,
  });

  factory SalaryInfo.fromJson(Map<String, dynamic>? json) {
    if (json == null) {
      return const SalaryInfo(enabled: false, message: 'Salary visibility is disabled.');
    }
    final enabled = json['enabled'] == true;
    final blocked = json['blocked'] == true;
    return SalaryInfo(
      enabled: enabled,
      blocked: blocked,
      message: json['message'] as String?,
      reason: json['reason'] as String?,
      monthly: (json['monthly'] as num?)?.toDouble() ?? 0,
      daily: (json['daily'] as num?)?.toDouble() ?? 0,
      annual: (json['annual'] as num?)?.toDouble() ?? 0,
      currency: (json['currency'] as String?)?.toUpperCase() ?? 'GBP',
      effectiveFrom: json['effectiveFrom'] as String?,
    );
  }
}

class EmergencyContact {
  final String? id;
  final String name;
  final String relationship;
  final String phone;
  final String? email;
  final bool isPrimary;

  const EmergencyContact({
    this.id,
    required this.name,
    required this.relationship,
    required this.phone,
    this.email,
    this.isPrimary = false,
  });

  factory EmergencyContact.fromJson(Map<String, dynamic> json) => EmergencyContact(
    id: json['id'] as String?,
    name: json['name'] as String? ?? '—',
    relationship: json['relationship'] as String? ?? '—',
    phone: json['phone'] as String? ?? '—',
    email: json['email'] as String?,
    isPrimary: json['isPrimary'] == true,
  );
}

class EmployeeProfile {
  final String id;
  final String name;
  final String? preferredName;
  final String role;
  final String? employeeNumber;
  final String? workEmail;
  final String? departmentName;
  final String? officeName;
  final String timeZone;
  final bool active;

  // Employment terms
  final String? jobTitle;
  final String? employmentType;
  final String? startDate;
  final String? contractEndDate;
  final int? noticePeriodDays;
  final double? holidayEntitlementDays;

  // Schedule
  final String startTime;
  final String endTime;
  final int graceMinutes;
  final int breakMinutes;
  final String workDays;

  // Personal
  final String? dateOfBirth;
  final String? personalEmail;
  final String? mobilePhone;
  final String? addressLine1;
  final String? addressLine2;
  final String? city;
  final String? postcode;
  final String? nationalId;

  // Emergency contacts & KYC
  final List<EmergencyContact> emergencyContacts;
  final SalaryInfo salary;
  final int kycVerifiedCount;
  final int kycTotalCount;

  const EmployeeProfile({
    required this.id,
    required this.name,
    this.preferredName,
    required this.role,
    this.employeeNumber,
    this.workEmail,
    this.departmentName,
    this.officeName,
    this.timeZone = 'Asia/Karachi',
    this.active = true,
    this.jobTitle,
    this.employmentType,
    this.startDate,
    this.contractEndDate,
    this.noticePeriodDays,
    this.holidayEntitlementDays,
    this.startTime = '11:00',
    this.endTime = '19:00',
    this.graceMinutes = 10,
    this.breakMinutes = 30,
    this.workDays = 'MON,TUE,WED,THU,FRI',
    this.dateOfBirth,
    this.personalEmail,
    this.mobilePhone,
    this.addressLine1,
    this.addressLine2,
    this.city,
    this.postcode,
    this.nationalId,
    this.emergencyContacts = const [],
    required this.salary,
    this.kycVerifiedCount = 0,
    this.kycTotalCount = 0,
  });

  factory EmployeeProfile.fromJson(Map<String, dynamic> json) {
    final emp = json['employment'] as Map<String, dynamic>?;
    final sched = json['schedule'] as Map<String, dynamic>?;
    final pers = json['personal'] as Map<String, dynamic>?;
    final kyc = json['kyc'] as Map<String, dynamic>?;
    final contactsList = (json['emergencyContacts'] as List<dynamic>? ?? [])
        .map((c) => EmergencyContact.fromJson(c as Map<String, dynamic>))
        .toList();

    return EmployeeProfile(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      preferredName: json['preferredName'] as String?,
      role: json['role'] as String? ?? 'Employee',
      employeeNumber: json['employeeNumber'] as String?,
      workEmail: json['workEmail'] as String?,
      departmentName: json['departmentName'] as String?,
      officeName: json['officeName'] as String?,
      timeZone: json['timeZone'] as String? ?? 'Asia/Karachi',
      active: json['active'] as bool? ?? true,
      jobTitle: emp?['jobTitle'] as String?,
      employmentType: emp?['employmentType'] as String?,
      startDate: emp?['startDate'] as String?,
      contractEndDate: emp?['contractEndDate'] as String?,
      noticePeriodDays: (emp?['noticePeriodDays'] as num?)?.toInt(),
      holidayEntitlementDays: (emp?['holidayEntitlementDays'] as num?)?.toDouble(),
      startTime: sched?['startTime'] as String? ?? '11:00',
      endTime: sched?['endTime'] as String? ?? '19:00',
      graceMinutes: (sched?['graceMinutes'] as num?)?.toInt() ?? 10,
      breakMinutes: (sched?['breakMinutes'] as num?)?.toInt() ?? 30,
      workDays: sched?['workDays'] as String? ?? 'MON,TUE,WED,THU,FRI',
      dateOfBirth: pers?['dateOfBirth'] as String?,
      personalEmail: pers?['personalEmail'] as String?,
      mobilePhone: pers?['mobilePhone'] as String?,
      addressLine1: pers?['addressLine1'] as String?,
      addressLine2: pers?['addressLine2'] as String?,
      city: pers?['city'] as String?,
      postcode: pers?['postcode'] as String?,
      nationalId: pers?['nationalId'] as String?,
      emergencyContacts: contactsList,
      salary: SalaryInfo.fromJson(json['salary'] as Map<String, dynamic>?),
      kycVerifiedCount: (kyc?['verifiedCount'] as num?)?.toInt() ?? 0,
      kycTotalCount: (kyc?['totalCount'] as num?)?.toInt() ?? 0,
    );
  }
}

// ---------------------------------------------------------------------------
// Employee Payroll Statements & Period History (Spec 17, 18, 29)
// ---------------------------------------------------------------------------

class PeriodAdjustmentItem {
  final String id;
  final String type;
  final String explanation;
  final double amount;
  final double? days;

  const PeriodAdjustmentItem({
    required this.id,
    required this.type,
    required this.explanation,
    required this.amount,
    this.days,
  });

  factory PeriodAdjustmentItem.fromJson(Map<String, dynamic> json) {
    return PeriodAdjustmentItem(
      id: json['id'] as String? ?? '',
      type: json['type'] as String? ?? 'OTHER',
      explanation: json['explanation'] as String? ?? '',
      amount: (json['amount'] as num?)?.toDouble() ?? 0,
      days: (json['days'] as num?)?.toDouble(),
    );
  }
}

class PayrollPeriodStatement {
  final String periodId;
  final String name;
  final String startDate;
  final String endDate;
  final String status;
  final double exchangeRate;
  final String currency;
  final double monthlyGross;
  final double dailyRate;
  final int workingDaysCount;
  final int fullPeriodDays;
  final bool isStarter;
  final double basePayable;
  final double adjustmentsTotal;
  final double netPayable;
  final List<PeriodAdjustmentItem> adjustments;
  final String? effectiveFrom;

  const PayrollPeriodStatement({
    required this.periodId,
    required this.name,
    required this.startDate,
    required this.endDate,
    required this.status,
    required this.exchangeRate,
    required this.currency,
    required this.monthlyGross,
    required this.dailyRate,
    required this.workingDaysCount,
    required this.fullPeriodDays,
    required this.isStarter,
    required this.basePayable,
    required this.adjustmentsTotal,
    required this.netPayable,
    required this.adjustments,
    this.effectiveFrom,
  });

  factory PayrollPeriodStatement.fromJson(Map<String, dynamic> json) {
    return PayrollPeriodStatement(
      periodId: json['periodId'] as String? ?? '',
      name: json['name'] as String? ?? '',
      startDate: json['startDate'] as String? ?? '',
      endDate: json['endDate'] as String? ?? '',
      status: json['status'] as String? ?? 'OPEN',
      exchangeRate: (json['exchangeRate'] as num?)?.toDouble() ?? 350.0,
      currency: (json['currency'] as String?)?.toUpperCase() ?? 'PKR',
      monthlyGross: (json['monthlyGross'] as num?)?.toDouble() ?? 0,
      dailyRate: (json['dailyRate'] as num?)?.toDouble() ?? 0,
      workingDaysCount: (json['workingDaysCount'] as num?)?.toInt() ?? 0,
      fullPeriodDays: (json['fullPeriodDays'] as num?)?.toInt() ?? 0,
      isStarter: json['isStarter'] == true,
      basePayable: (json['basePayable'] as num?)?.toDouble() ?? 0,
      adjustmentsTotal: (json['adjustmentsTotal'] as num?)?.toDouble() ?? 0,
      netPayable: (json['netPayable'] as num?)?.toDouble() ?? 0,
      adjustments: (json['adjustments'] as List<dynamic>? ?? [])
          .map((a) => PeriodAdjustmentItem.fromJson(a as Map<String, dynamic>))
          .toList(),
      effectiveFrom: json['effectiveFrom'] as String?,
    );
  }
}

class EmployeePayrollStatement {
  final bool enabled;
  final String? message;
  final SalaryInfo? currentSalary;
  final List<PayrollPeriodStatement> periods;

  const EmployeePayrollStatement({
    required this.enabled,
    this.message,
    this.currentSalary,
    this.periods = const [],
  });

  factory EmployeePayrollStatement.fromJson(Map<String, dynamic> json) {
    final enabled = json['enabled'] == true;
    return EmployeePayrollStatement(
      enabled: enabled,
      message: json['message'] as String?,
      currentSalary: json['currentSalary'] != null
          ? SalaryInfo.fromJson({
              'enabled': enabled,
              ...(json['currentSalary'] as Map<String, dynamic>),
            })
          : null,
      periods: (json['periods'] as List<dynamic>? ?? [])
          .map((p) => PayrollPeriodStatement.fromJson(p as Map<String, dynamic>))
          .toList(),
    );
  }
}



