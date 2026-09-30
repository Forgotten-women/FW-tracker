// Monthly invoices (the "Monthly Salary Statement"), as the employee sees them.
//
// Built against backend/src/routes/payroll.js and backend/src/domain/invoice.js:
//   GET /api/payroll/mine/invoices             the list, plus this month's draft
//   GET /api/payroll/mine/invoices/:periodId   one invoice: pre-formatted
//       template `fields`, raw `totals`, the attendance summary
//   GET /api/payroll/mine/invoices/:periodId/docx   the filled Word file
//
// Nothing about an invoice is stored server-side but the template, and the
// phone stores nothing either. Parsing is tolerant, as in payroll.dart: a
// missing or oddly typed value becomes a blank, never a crash.

import 'dart:typed_data';

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

int? _toIntOrNull(Object? v) {
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v) ?? double.tryParse(v)?.toInt();
  return null;
}

String? _toStringOrNull(Object? v) {
  if (v == null) return null;
  final s = v.toString();
  return s.isEmpty ? null : s;
}

Map<String, dynamic> _map(Object? v) {
  if (v is Map<String, dynamic>) return v;
  if (v is Map) return v.map((k, val) => MapEntry(k.toString(), val));
  return const {};
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/// One published (or paid) month's invoice in GET /mine/invoices.
class InvoiceSummary {
  final String periodId;
  final String periodName;
  final String? startDate;
  final String? endDate;
  final String? payDate;
  final String currency;
  final double netPayable;

  /// Epoch ms.
  final int? publishedAt;
  final int? paidAt;

  /// 'PUBLISHED' | 'PAID'.
  final String status;

  const InvoiceSummary({
    required this.periodId,
    required this.periodName,
    this.startDate,
    this.endDate,
    this.payDate,
    required this.currency,
    required this.netPayable,
    this.publishedAt,
    this.paidAt,
    required this.status,
  });

  bool get isPaid => status == 'PAID' || paidAt != null;

  factory InvoiceSummary.fromJson(Map<String, dynamic> json) {
    final paidAt = _toIntOrNull(json['paidAt']);
    final status = _toStringOrNull(json['status'])?.toUpperCase();
    return InvoiceSummary(
      periodId: _toStringOrNull(json['periodId']) ?? '',
      periodName: _toStringOrNull(json['periodName']) ?? 'Invoice',
      startDate: _toStringOrNull(json['startDate']),
      endDate: _toStringOrNull(json['endDate']),
      payDate: _toStringOrNull(json['payDate']),
      currency: (_toStringOrNull(json['currency']) ?? 'PKR').toUpperCase(),
      netPayable: _toDouble(json['netPayable']),
      publishedAt: _toIntOrNull(json['publishedAt']),
      paidAt: paidAt,
      status: status == 'PAID' || status == 'PUBLISHED' ? status! : (paidAt != null ? 'PAID' : 'PUBLISHED'),
    );
  }
}

/// This month's provisional invoice, offered only while HR also shows the
/// running estimate to employees.
class InvoiceDraftRef {
  final String periodId;
  final String periodName;
  final String? startDate;
  final String? endDate;
  final String? cutoffDate;

  const InvoiceDraftRef({
    required this.periodId,
    required this.periodName,
    this.startDate,
    this.endDate,
    this.cutoffDate,
  });

  static InvoiceDraftRef? fromJson(Object? json) {
    if (json is! Map) return null;
    final m = _map(json);
    final periodId = _toStringOrNull(m['periodId']);
    if (periodId == null) return null;
    return InvoiceDraftRef(
      periodId: periodId,
      periodName: _toStringOrNull(m['periodName']) ?? 'This month',
      startDate: _toStringOrNull(m['startDate']),
      endDate: _toStringOrNull(m['endDate']),
      cutoffDate: _toStringOrNull(m['cutoffDate']),
    );
  }
}

/// GET /api/payroll/mine/invoices.
class InvoiceList {
  /// False while HR hides salaries from employees: show [message].
  final bool enabled;
  final String? message;

  /// Newest first, as the server sends them.
  final List<InvoiceSummary> invoices;
  final InvoiceDraftRef? draft;

  const InvoiceList({
    required this.enabled,
    this.message,
    this.invoices = const [],
    this.draft,
  });

  static const restrictedFallback = 'Salary and monthly invoices are restricted by company HR policy.';

  /// Whether a published invoice exists for [periodId].
  bool has(String periodId) => invoices.any((i) => i.periodId == periodId);

  factory InvoiceList.fromJson(Map<String, dynamic> json) {
    final enabled = json['enabled'] == true;
    final raw = json['invoices'];
    return InvoiceList(
      enabled: enabled,
      message: _toStringOrNull(json['message']),
      invoices: enabled && raw is List
          ? raw
              .whereType<Map>()
              .map((m) => InvoiceSummary.fromJson(_map(m)))
              .where((i) => i.periodId.isNotEmpty)
              .toList()
          : const [],
      // Never offered while salaries are hidden, whatever else arrives.
      draft: enabled ? InvoiceDraftRef.fromJson(json['draft']) : null,
    );
  }
}

// ---------------------------------------------------------------------------
// One invoice
// ---------------------------------------------------------------------------

/// The template's placeholders, every one a pre-formatted string. A missing
/// key reads as ''.
class InvoiceFields {
  final Map<String, String> values;

  const InvoiceFields(this.values);

  /// Every placeholder the template uses, in reading order.
  static const keys = <String>[
    'company_name', 'company_email', 'company_phone', 'company_address',
    'employee_name', 'employee_id', 'job_title', 'department', 'working_arrangement',
    'payroll_month', 'period_start', 'period_end', 'statement_reference', 'currency',
    'monthly_salary', 'addition_amount', 'overtime_amount', 'gross_earnings', 'total_deductions',
    'scheduled_days', 'present_days', 'paid_leave_days', 'unpaid_leave_days', 'sick_leave_days',
    'unauthorised_days',
    'worked_hours', 'extra_hours', 'shortfall_hours',
    'unpaid_leave_deduction', 'shortfall_deduction', 'adjustment_amount',
    'net_salary',
    'bank_name', 'account_title', 'account_number', 'iban',
    'payroll_note', 'prepared_by', 'generated_date',
  ];

  /// The template's own heading when HR has set no company name.
  static const fallbackCompanyName = 'URBANE NETWORK LTD';

  String operator [](String key) => values[key]?.trim() ?? '';

  /// [key]'s value, or [placeholder] when it is blank.
  String or(String key, [String placeholder = '-']) {
    final v = this[key];
    return v.isEmpty ? placeholder : v;
  }

  String get companyName {
    final v = this['company_name'];
    return v.isEmpty ? fallbackCompanyName : v;
  }

  /// "email  |  phone", leaving out whichever is blank.
  String get companyContact =>
      [this['company_email'], this['company_phone']].where((s) => s.isNotEmpty).join('  |  ');

  /// "start - end", as the template writes the Pay Period.
  String get payPeriod {
    final from = this['period_start'];
    final to = this['period_end'];
    if (from.isEmpty && to.isEmpty) return '-';
    if (from.isEmpty || to.isEmpty) return from.isEmpty ? to : from;
    return '$from - $to';
  }

  // The template's sections, label then value, in its own wording and order.
  // The screen and the PDF both lay these out, so they can't drift apart.

  /// EMPLOYEE & PAYROLL INFO, read left to right in pairs.
  List<(String, String)> get employeeInfo => [
        ('Employee Name', or('employee_name')),
        ('Payroll Month', or('payroll_month')),
        ('Employee ID', or('employee_id')),
        ('Pay Period', payPeriod),
        ('Position', or('job_title')),
        ('Statement Ref', or('statement_reference')),
        ('Department', or('department')),
        ('Working Arrangement', or('working_arrangement')),
      ];

  /// Salary Summary. The last two rows are the totals.
  List<(String, String)> get salarySummary => [
        ('Monthly Salary', or('monthly_salary')),
        ('Bonus / Addition', or('addition_amount')),
        ('Overtime', or('overtime_amount')),
        ('Gross Earnings', or('gross_earnings')),
        ('Total Deductions', or('total_deductions')),
      ];

  List<(String, String)> get attendanceSummary => [
        ('Scheduled Days', or('scheduled_days')),
        ('Days Present', or('present_days')),
        ('Paid Leave', or('paid_leave_days')),
        ('Unpaid Leave', or('unpaid_leave_days')),
        ('Sick Leave', or('sick_leave_days')),
        ('Unauthorised', or('unauthorised_days')),
        ('Hours Worked', or('worked_hours')),
        ('Extra Hours', or('extra_hours')),
        ('Shortfall Hours', or('shortfall_hours')),
      ];

  /// Deductions. The last row is the total.
  List<(String, String)> get deductions => [
        ('Unpaid Leave', or('unpaid_leave_deduction')),
        ('Shortfall', or('shortfall_deduction')),
        ('Adjustments', or('adjustment_amount')),
        ('Total Deductions', or('total_deductions')),
      ];

  List<(String, String)> get bankDetails => [
        ('Bank Name', or('bank_name')),
        ('Account Title', or('account_title')),
        ('Account Number', or('account_number')),
        ('IBAN', or('iban')),
      ];

  factory InvoiceFields.fromJson(Object? json) {
    final out = <String, String>{};
    _map(json).forEach((k, v) {
      if (v == null) return;
      if (v is String || v is num || v is bool) out[k] = v.toString();
    });
    return InvoiceFields(Map.unmodifiable(out));
  }
}

/// The raw numbers beside the formatted fields.
class InvoiceTotals {
  final double monthlySalary;
  final double grossBaseline;
  final double additions;
  final double overtime;
  final double grossEarnings;
  final double unpaidLeave;
  final double shortfall;
  final double adjustments;
  final double totalDeductions;
  final double net;

  const InvoiceTotals({
    this.monthlySalary = 0,
    this.grossBaseline = 0,
    this.additions = 0,
    this.overtime = 0,
    this.grossEarnings = 0,
    this.unpaidLeave = 0,
    this.shortfall = 0,
    this.adjustments = 0,
    this.totalDeductions = 0,
    this.net = 0,
  });

  factory InvoiceTotals.fromJson(Object? json) {
    final m = _map(json);
    return InvoiceTotals(
      monthlySalary: _toDouble(m['monthlySalary']),
      grossBaseline: _toDouble(m['grossBaseline']),
      additions: _toDouble(m['additions']),
      overtime: _toDouble(m['overtime']),
      grossEarnings: _toDouble(m['grossEarnings']),
      unpaidLeave: _toDouble(m['unpaidLeave']),
      shortfall: _toDouble(m['shortfall']),
      adjustments: _toDouble(m['adjustments']),
      totalDeductions: _toDouble(m['totalDeductions']),
      net: _toDouble(m['net']),
    );
  }
}

/// The attendance summary the invoice was worked out from.
class InvoiceAttendance {
  final String? from;
  final String? to;
  final int? scheduledDays;
  final double? presentDays;
  final double? paidLeaveDays;
  final double? unpaidLeaveDays;
  final double? sickLeaveDays;
  final double? unauthorisedDays;
  final int? workedMinutes;
  final int? extraMinutes;
  final int? shortfallMinutes;

  const InvoiceAttendance({
    this.from,
    this.to,
    this.scheduledDays,
    this.presentDays,
    this.paidLeaveDays,
    this.unpaidLeaveDays,
    this.sickLeaveDays,
    this.unauthorisedDays,
    this.workedMinutes,
    this.extraMinutes,
    this.shortfallMinutes,
  });

  factory InvoiceAttendance.fromJson(Object? json) {
    final m = _map(json);
    return InvoiceAttendance(
      from: _toStringOrNull(m['from']),
      to: _toStringOrNull(m['to']),
      scheduledDays: _toIntOrNull(m['scheduledDays']),
      presentDays: _toDoubleOrNull(m['presentDays']),
      paidLeaveDays: _toDoubleOrNull(m['paidLeaveDays']),
      unpaidLeaveDays: _toDoubleOrNull(m['unpaidLeaveDays']),
      sickLeaveDays: _toDoubleOrNull(m['sickLeaveDays']),
      unauthorisedDays: _toDoubleOrNull(m['unauthorisedDays']),
      workedMinutes: _toIntOrNull(m['workedMinutes']),
      extraMinutes: _toIntOrNull(m['extraMinutes']),
      shortfallMinutes: _toIntOrNull(m['shortfallMinutes']),
    );
  }
}

/// GET /api/payroll/mine/invoices/:periodId's `invoice`.
class Invoice {
  final String periodId;
  final String? employeeId;
  final String? periodStatus;

  /// This month's provisional figures: they change until HR approves.
  final bool draft;

  /// False when the payslip's stored figures no longer match what was
  /// published.
  final bool integrityOk;
  final String? templateId;
  final String currency;
  final InvoiceFields fields;
  final InvoiceTotals totals;
  final InvoiceAttendance attendance;

  /// The days the attendance summary covers (YYYY-MM-DD).
  final String? windowFrom;
  final String? windowTo;

  const Invoice({
    required this.periodId,
    this.employeeId,
    this.periodStatus,
    required this.draft,
    required this.integrityOk,
    this.templateId,
    required this.currency,
    required this.fields,
    required this.totals,
    required this.attendance,
    this.windowFrom,
    this.windowTo,
  });

  // The template's fixed wording.
  static const title = 'Monthly Salary Statement';
  static const subtitle = 'A clear monthly summary of salary, attendance and payment details.';
  static const provisionalNotice = 'Provisional, will change until HR approves';
  static const integrityWarning =
      "The stored figures for this invoice don't match the record HR published. Please check it with HR.";

  /// The period's name as the template prints it.
  String get periodName => fields.or('payroll_month', 'Invoice');

  /// "PKR 12,345.00": the headline figure, in the template's wording.
  String get netPayableText {
    final cur = fields.or('currency', currency);
    final net = fields['net_salary'];
    return net.isEmpty ? '-' : (cur.isEmpty ? net : '$cur $net');
  }

  /// The file name the PDF is offered under.
  String get pdfFileName {
    String safe(String s) =>
        s.replaceAll(RegExp(r'[^A-Za-z0-9 _-]'), '').trim().replaceAll(RegExp(r'\s+'), '_');
    final ref = safe(fields['statement_reference']);
    final name = safe(fields['employee_name']);
    final base = [if (ref.isNotEmpty) ref else 'invoice', if (name.isNotEmpty) name].join('_');
    return '$base.pdf';
  }

  factory Invoice.fromJson(Map<String, dynamic> json) {
    final fields = InvoiceFields.fromJson(json['fields']);
    final window = _map(json['window']);
    final draft = json['draft'] == true ||
        // A period still open is provisional whatever the flag says.
        const {'OPEN', 'IN_REVIEW'}.contains(_toStringOrNull(json['periodStatus'])?.toUpperCase());
    return Invoice(
      periodId: _toStringOrNull(json['periodId']) ?? '',
      employeeId: _toStringOrNull(json['employeeId']),
      periodStatus: _toStringOrNull(json['periodStatus']),
      draft: draft,
      // Only an explicit false is a failure: absent means not checked.
      integrityOk: json['integrityOk'] != false,
      templateId: _toStringOrNull(json['templateId']),
      currency: (_toStringOrNull(json['currency']) ?? (fields['currency'].isEmpty ? 'PKR' : fields['currency']))
          .toUpperCase(),
      fields: fields,
      totals: InvoiceTotals.fromJson(json['totals']),
      attendance: InvoiceAttendance.fromJson(json['attendance']),
      windowFrom: _toStringOrNull(window['from']),
      windowTo: _toStringOrNull(window['to']),
    );
  }
}

// ---------------------------------------------------------------------------
// The Word copy
// ---------------------------------------------------------------------------

/// The filled .docx and the name the server gave it.
class InvoiceDocx {
  final Uint8List bytes;
  final String fileName;

  const InvoiceDocx({required this.bytes, required this.fileName});

  static const fallbackFileName = 'invoice.docx';

  /// The file name from a Content-Disposition header, made safe to use as a
  /// local file name (no path separators, always ending in .docx).
  static String fileNameFrom(String? contentDisposition) {
    String? name;
    final header = contentDisposition ?? '';
    final star = RegExp(r"filename\*\s*=\s*([^']*)''([^;]+)", caseSensitive: false).firstMatch(header);
    if (star != null) {
      try {
        name = Uri.decodeComponent(star.group(2)!.trim().replaceAll('"', ''));
      } catch (_) {}
    }
    if (name == null || name.isEmpty) {
      final plain = RegExp(r'filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)', caseSensitive: false)
          .firstMatch(header);
      name = (plain?.group(1) ?? plain?.group(2))?.trim();
    }
    if (name == null || name.isEmpty) return fallbackFileName;
    // Keep only the last path segment and ordinary characters.
    name = name.split(RegExp(r'[\\/]')).last;
    name = name.replaceAll(RegExp(r'[^A-Za-z0-9 ._-]'), '').trim().replaceAll(RegExp(r'\s+'), '_');
    if (name.toLowerCase() == '.docx') return fallbackFileName;
    name = name.replaceAll(RegExp(r'^\.+'), '');
    if (name.isEmpty) return fallbackFileName;
    if (!name.toLowerCase().endsWith('.docx')) name = '$name.docx';
    return name;
  }
}
