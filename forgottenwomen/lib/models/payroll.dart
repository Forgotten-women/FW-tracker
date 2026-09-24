// Payslips and this month's running estimate, as the employee sees them.
//
// Built against three backend responses (backend/src/domain/payroll.js):
//   GET /api/payroll/mine/statements      employeeStatements: periods[] now
//       carry payslip fields and `lines`; `estimate`; `latestPayslip`
//   GET /api/payroll/mine/payslips/:id    employeePayslip (presentPayslip)
//   GET /api/attendance/home-summary      `latestPayslip` (latestPayslipFor)
//
// As in hr.dart, parsing is defensive: a missing or oddly typed field falls
// back rather than throwing, so a server change shows up as a blank value,
// never a crashed screen. PayrollPeriodStatement and EmployeePayrollStatement
// (the list shapes) live in hr.dart next to SalaryInfo.

import 'hr.dart';

double _toDouble(Object? v, [double fallback = 0]) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v) ?? fallback;
  return fallback;
}

double? _toDoubleOrNull(Object? v) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v);
  return null;
}

/// Epoch-ms timestamps are Postgres BIGINTs; the backend parses them to
/// numbers, but a string is accepted too.
int? _toIntOrNull(Object? v) {
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v) ?? double.tryParse(v)?.toInt();
  return null;
}

/// An epoch-ms timestamp field (publishedAt, paidAt), or null.
int? parseEpochMs(Object? v) => _toIntOrNull(v);

String? _toStringOrNull(Object? v) {
  if (v == null) return null;
  final s = v.toString();
  return s.isEmpty ? null : s;
}

/// The backend's lineLabel(): 'UNPAID_LEAVE_DEDUCTION' -> 'Unpaid leave deduction'.
/// Only used when a line arrives without its own label (legacy adjustments).
String humanizePayrollType(String type) {
  const known = {
    'ATTENDANCE_DEFICIT_DAY': 'Attendance deficit',
    'UNAUTHORISED_ABSENCE_UNPAID': 'Unpaid absence',
    'UNPAID_LEAVE_DEDUCTION': 'Unpaid leave',
  };
  if (known.containsKey(type)) return known[type]!;
  final words = (type.isEmpty ? 'Adjustment' : type).toLowerCase().replaceAll('_', ' ');
  return words[0].toUpperCase() + words.substring(1);
}

// ---------------------------------------------------------------------------
// Payslip lines
// ---------------------------------------------------------------------------

/// One approved line on a published payslip (writePayslip's `lines`).
class PayslipLine {
  final String? adjustmentId;
  final String type;
  final String label;
  final String explanation;
  final double? days;

  /// Signed: negative is a deduction.
  final double amount;
  final String? sourceReference;

  /// YYYY-MM-DD the line relates to (the absence, the leave start, or the
  /// deficit window's end), or null.
  final String? date;

  const PayslipLine({
    this.adjustmentId,
    required this.type,
    required this.label,
    required this.explanation,
    this.days,
    required this.amount,
    this.sourceReference,
    this.date,
  });

  bool get isDeduction => amount < 0;

  factory PayslipLine.fromJson(Map<String, dynamic> json) {
    final type = _toStringOrNull(json['type']) ?? 'OTHER';
    return PayslipLine(
      adjustmentId: _toStringOrNull(json['adjustmentId']),
      type: type,
      label: _toStringOrNull(json['label']) ?? humanizePayrollType(type),
      explanation: _toStringOrNull(json['explanation']) ?? '',
      days: _toDoubleOrNull(json['days']),
      amount: _toDouble(json['amount']),
      sourceReference: _toStringOrNull(json['sourceReference']),
      date: _toStringOrNull(json['date']),
    );
  }

  /// A pre-payslip period's approved adjustment, shown the same way.
  factory PayslipLine.fromLegacyAdjustment(PeriodAdjustmentItem a) => PayslipLine(
        adjustmentId: a.id.isEmpty ? null : a.id,
        type: a.type,
        label: humanizePayrollType(a.type),
        explanation: a.explanation,
        days: a.days,
        amount: a.amount,
      );

  static List<PayslipLine>? listFromJson(Object? v) {
    if (v is! List) return null;
    return v.whereType<Map<String, dynamic>>().map(PayslipLine.fromJson).toList();
  }
}

// ---------------------------------------------------------------------------
// latestPayslip
// ---------------------------------------------------------------------------

/// `{ periodId, publishedAt }` of the employee's newest published payslip.
/// Null from the server while salaries are hidden from employees.
class LatestPayslip {
  final String periodId;

  /// Epoch ms.
  final int publishedAt;

  const LatestPayslip({required this.periodId, required this.publishedAt});

  static LatestPayslip? fromJson(Object? json) {
    if (json is! Map) return null;
    final periodId = _toStringOrNull(json['periodId']);
    final publishedAt = _toIntOrNull(json['publishedAt']);
    if (periodId == null || publishedAt == null) return null;
    return LatestPayslip(periodId: periodId, publishedAt: publishedAt);
  }
}

// ---------------------------------------------------------------------------
// This month so far
// ---------------------------------------------------------------------------

/// A provisional deduction in the estimate, at its calculated figure.
class EstimateDeduction {
  final String type;
  final String label;
  final double days;

  /// Signed: negative.
  final double amount;
  final String explanation;

  const EstimateDeduction({
    required this.type,
    required this.label,
    required this.days,
    required this.amount,
    required this.explanation,
  });

  factory EstimateDeduction.fromJson(Map<String, dynamic> json) {
    final type = _toStringOrNull(json['type']) ?? 'OTHER';
    return EstimateDeduction(
      type: type,
      label: _toStringOrNull(json['label']) ?? humanizePayrollType(type),
      days: _toDouble(json['days']),
      amount: _toDouble(json['amount']),
      explanation: _toStringOrNull(json['explanation']) ?? '',
    );
  }
}

/// Where the running lateness/early-departure balance stands.
class EstimateDeficit {
  final int carryForwardMinutes;
  final int minutesUntilNextUnpaidDay;
  final double wholeDaysSoFar;

  /// Minutes that make one unpaid day. Sent by the backend alongside the
  /// three fields above; if absent it is their sum.
  final int dayEquivalentMinutes;

  const EstimateDeficit({
    required this.carryForwardMinutes,
    required this.minutesUntilNextUnpaidDay,
    required this.wholeDaysSoFar,
    required this.dayEquivalentMinutes,
  });

  /// Share of the next unpaid day already accumulated, 0..1.
  double get progress => dayEquivalentMinutes <= 0
      ? 0
      : (carryForwardMinutes / dayEquivalentMinutes).clamp(0.0, 1.0);

  static EstimateDeficit? fromJson(Object? json) {
    if (json is! Map) return null;
    final carry = _toIntOrNull(json['carryForwardMinutes']) ?? 0;
    final until = _toIntOrNull(json['minutesUntilNextUnpaidDay']) ?? 0;
    return EstimateDeficit(
      carryForwardMinutes: carry,
      minutesUntilNextUnpaidDay: until,
      wholeDaysSoFar: _toDouble(json['wholeDaysSoFar']),
      dayEquivalentMinutes: _toIntOrNull(json['dayEquivalentMinutes']) ?? (carry + until),
    );
  }
}

/// `estimate`: this month so far. Null unless HR has turned the estimate on
/// and there is an open period this employee is paid in.
class PayrollEstimate {
  final bool isEstimate;

  /// The backend's own wording, e.g. "Estimate - not final until HR approves".
  final String label;
  final String? periodId;
  final String periodName;
  final String? periodStatus;
  final String? cutoffDate;
  final String? payDate;
  final double grossBaseline;
  final List<EstimateDeduction> deductions;
  final double estimatedNet;
  final String currency;

  /// YYYY-MM-DD the figures run to: min(today, cut-off).
  final String? asOf;
  final EstimateDeficit? deficit;

  const PayrollEstimate({
    required this.isEstimate,
    required this.label,
    this.periodId,
    required this.periodName,
    this.periodStatus,
    this.cutoffDate,
    this.payDate,
    required this.grossBaseline,
    required this.deductions,
    required this.estimatedNet,
    required this.currency,
    this.asOf,
    this.deficit,
  });

  double get deductionsTotal => deductions.fold(0.0, (s, d) => s + d.amount);

  static const fallbackLabel = 'Estimate - not final until HR approves';

  static PayrollEstimate? fromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    return PayrollEstimate(
      // Always true from this backend. Anything else is still shown as an
      // estimate: nothing in this object is a final figure.
      isEstimate: json['isEstimate'] != false,
      label: _toStringOrNull(json['label']) ?? fallbackLabel,
      periodId: _toStringOrNull(json['periodId']),
      periodName: _toStringOrNull(json['periodName']) ?? 'This month',
      periodStatus: _toStringOrNull(json['periodStatus']),
      cutoffDate: _toStringOrNull(json['cutoffDate']),
      payDate: _toStringOrNull(json['payDate']),
      grossBaseline: _toDouble(json['grossBaseline']),
      deductions: (json['deductions'] is List ? json['deductions'] as List : const [])
          .whereType<Map<String, dynamic>>()
          .map(EstimateDeduction.fromJson)
          .toList(),
      estimatedNet: _toDouble(json['estimatedNet']),
      currency: (_toStringOrNull(json['currency']) ?? 'PKR').toUpperCase(),
      asOf: _toStringOrNull(json['asOf']),
      deficit: EstimateDeficit.fromJson(json['deficit']),
    );
  }
}

// ---------------------------------------------------------------------------
// One payslip in full
// ---------------------------------------------------------------------------

/// What the payslip detail screen shows. Parsed from
/// GET /mine/payslips/:periodId, or built from a statements entry (which
/// carries the same figures under the legacy field names) so the screen can
/// render at once and for pre-payslip CLOSED periods that have no payslip.
class PayslipDetail {
  final String? id;
  final String periodId;
  final String periodName;
  final String? startDate;
  final String? endDate;

  /// 'PUBLISHED' | 'PAID', or null for a legacy CLOSED period.
  final String? payslipStatus;

  /// The period's status for a legacy entry ('CLOSED'); the payslip row's
  /// status ('PUBLISHED') otherwise.
  final String? status;
  final int? version;
  final String currency;
  final double? exchangeRate;
  final double monthlySalary;
  final double dailyRate;
  final double grossBaseline;
  final double? deductionsTotal;
  final double adjustmentsTotal;
  final double netPayable;
  final int? workingDays;
  final int? fullPeriodDays;
  final bool isPartial;
  final bool isStarter;
  final String? salaryEffectiveFrom;
  final List<PayslipLine> lines;
  final String? cutoffDate;
  final String? payDate;

  /// Epoch ms.
  final int? publishedAt;
  final int? paidAt;

  /// From the detail endpoint only: false means the stored row no longer
  /// matches the hash it was published with.
  final bool? integrityOk;

  const PayslipDetail({
    this.id,
    required this.periodId,
    required this.periodName,
    this.startDate,
    this.endDate,
    this.payslipStatus,
    this.status,
    this.version,
    required this.currency,
    this.exchangeRate,
    required this.monthlySalary,
    required this.dailyRate,
    required this.grossBaseline,
    this.deductionsTotal,
    required this.adjustmentsTotal,
    required this.netPayable,
    this.workingDays,
    this.fullPeriodDays,
    this.isPartial = false,
    this.isStarter = false,
    this.salaryEffectiveFrom,
    required this.lines,
    this.cutoffDate,
    this.payDate,
    this.publishedAt,
    this.paidAt,
    this.integrityOk,
  });

  bool get isPaid => payslipStatus == 'PAID' || paidAt != null;
  bool get isLegacy => payslipStatus == null;

  /// Deductions as a positive total: the backend's figure, else the sum of
  /// the negative lines.
  double get deductionsPositive =>
      deductionsTotal ?? lines.where((l) => l.amount < 0).fold(0.0, (s, l) => s - l.amount);

  factory PayslipDetail.fromJson(Map<String, dynamic> json) {
    return PayslipDetail(
      id: _toStringOrNull(json['id']),
      periodId: _toStringOrNull(json['periodId']) ?? '',
      periodName: _toStringOrNull(json['periodName']) ?? 'Payslip',
      startDate: _toStringOrNull(json['startDate']),
      endDate: _toStringOrNull(json['endDate']),
      payslipStatus: _toStringOrNull(json['payslipStatus']) ??
          (json['paidAt'] != null ? 'PAID' : 'PUBLISHED'),
      status: _toStringOrNull(json['status']),
      version: _toIntOrNull(json['version']),
      currency: (_toStringOrNull(json['currency']) ?? 'PKR').toUpperCase(),
      exchangeRate: _toDoubleOrNull(json['exchangeRate']),
      monthlySalary: _toDouble(json['monthlySalary']),
      dailyRate: _toDouble(json['dailyRate']),
      grossBaseline: _toDouble(json['grossBaseline']),
      deductionsTotal: _toDoubleOrNull(json['deductionsTotal']),
      adjustmentsTotal: _toDouble(json['adjustmentsTotal']),
      netPayable: _toDouble(json['netPayable']),
      workingDays: _toIntOrNull(json['workingDays']),
      fullPeriodDays: _toIntOrNull(json['fullPeriodDays']),
      isPartial: json['isPartial'] == true,
      isStarter: json['isStarter'] == true,
      salaryEffectiveFrom: _toStringOrNull(json['salaryEffectiveFrom']),
      lines: PayslipLine.listFromJson(json['lines']) ?? const [],
      cutoffDate: _toStringOrNull(json['cutoffDate']),
      payDate: _toStringOrNull(json['payDate']),
      publishedAt: _toIntOrNull(json['publishedAt']),
      paidAt: _toIntOrNull(json['paidAt']),
      integrityOk: json['integrityOk'] is bool ? json['integrityOk'] as bool : null,
    );
  }

  /// From a statements entry. A legacy CLOSED period has no `lines`, so its
  /// approved adjustments are shown as the lines.
  factory PayslipDetail.fromStatement(PayrollPeriodStatement s) {
    return PayslipDetail(
      id: s.payslipId,
      periodId: s.periodId,
      periodName: s.name.isEmpty ? 'Payslip' : s.name,
      startDate: s.startDate.isEmpty ? null : s.startDate,
      endDate: s.endDate.isEmpty ? null : s.endDate,
      payslipStatus: s.payslipStatus,
      status: s.status,
      version: s.payslipVersion,
      currency: s.currency,
      exchangeRate: s.exchangeRate,
      monthlySalary: s.monthlyGross,
      dailyRate: s.dailyRate,
      grossBaseline: s.basePayable,
      deductionsTotal: s.deductionsTotal,
      adjustmentsTotal: s.adjustmentsTotal,
      netPayable: s.netPayable,
      workingDays: s.workingDaysCount,
      fullPeriodDays: s.fullPeriodDays,
      isStarter: s.isStarter,
      salaryEffectiveFrom: s.effectiveFrom,
      lines: s.displayLines,
      cutoffDate: s.cutoffDate,
      payDate: s.payDate,
      publishedAt: s.publishedAt,
      paidAt: s.paidAt,
    );
  }
}

// ---------------------------------------------------------------------------
// Display helpers (shared by the salary and payslip screens)
// ---------------------------------------------------------------------------

const _monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String _dmy(DateTime d) => '${d.day} ${_monthsShort[d.month - 1]} ${d.year}';

/// 'YYYY-MM-DD' -> '31 May 2025'. Anything unparseable is returned as-is.
String? formatPayrollDate(String? ymd) {
  if (ymd == null || ymd.isEmpty) return null;
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})').firstMatch(ymd);
  if (m == null) return ymd;
  final month = int.parse(m.group(2)!);
  if (month < 1 || month > 12) return ymd;
  return '${int.parse(m.group(3)!)} ${_monthsShort[month - 1]} ${m.group(1)}';
}

/// Epoch ms -> '28 May 2025' in the device's time zone.
String? formatEpochDate(int? ms) {
  if (ms == null || ms <= 0) return null;
  return _dmy(DateTime.fromMillisecondsSinceEpoch(ms));
}

/// 460 -> '7 h 40 m'; 40 -> '40 m'; 480 -> '8 h'.
String formatHoursMinutes(int minutes) {
  final m = minutes < 0 ? 0 : minutes;
  final h = m ~/ 60;
  final r = m % 60;
  if (h == 0) return '$r m';
  return r == 0 ? '$h h' : '$h h $r m';
}

String currencySymbol(String currency) {
  switch (currency.toUpperCase()) {
    case 'PKR':
      return '₨ ';
    case 'GBP':
      return '£';
    case 'USD':
      return '\$';
    default:
      return '$currency ';
  }
}

/// -1234.5, 'PKR' -> '-₨ 1,234.50'. [signed] adds '+' to positive amounts.
String formatPayrollMoney(double amount, String currency, {bool signed = false}) {
  final rounded = (amount * 100).round() / 100;
  final negative = rounded < 0;
  final parts = rounded.abs().toStringAsFixed(2).split('.');
  final whole = parts[0].replaceAllMapped(
    RegExp(r'(\d{1,3})(?=(\d{3})+(?!\d))'),
    (m) => '${m[1]},',
  );
  final sign = negative ? '-' : (signed && rounded > 0 ? '+' : '');
  return '$sign${currencySymbol(currency)}$whole.${parts[1]}';
}

/// 1.0 -> '1 day', 2.5 -> '2.5 days'.
String formatDays(double days) {
  final text = days == days.roundToDouble() ? days.toInt().toString() : days.toStringAsFixed(1);
  return '$text ${days == 1 ? 'day' : 'days'}';
}
