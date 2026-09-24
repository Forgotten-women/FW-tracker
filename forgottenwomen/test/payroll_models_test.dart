// Payslip, estimate and legacy-period parsing, against the shapes
// backend/src/domain/payroll.js produces (presentPayslipStatement,
// legacyStatements, payrollEstimate, employeeStatements, presentPayslip) and
// backend/test/payroll_run.test.js asserts.

import 'package:flutter_test/flutter_test.dart';
import 'package:office_tracker/models/hr.dart';
import 'package:office_tracker/models/payroll.dart';
import 'package:office_tracker/services/notification_service.dart';
import 'package:office_tracker/services/payslip_watcher.dart';
import 'package:shared_preferences/shared_preferences.dart';

// 2025-05-28 and 2025-07-28 00:00 UTC, as epoch ms.
const mayPublishedAt = 1748390400000;
const julyPublishedAt = 1753660800000;

Map<String, dynamic> publishedPayslipEntry({String? payslipStatus = 'PUBLISHED', int? paidAt}) => {
      'periodId': 'pp_may',
      'name': 'May 2025',
      'startDate': '2025-05-01',
      'endDate': '2025-05-31',
      'status': 'CLOSED',
      'exchangeRate': 350,
      'currency': 'PKR',
      'monthlyGross': 3000,
      'dailyRate': 115.38,
      'workingDaysCount': 22,
      'fullPeriodDays': 22,
      'isStarter': false,
      'basePayable': 3000,
      'adjustmentsTotal': -346.14,
      'netPayable': 2653.86,
      'adjustments': [
        {'id': 'adj_1', 'type': 'ATTENDANCE_DEFICIT_DAY', 'explanation': '1 whole day', 'amount': -115.38, 'days': 1},
        {'id': 'adj_2', 'type': 'UNAUTHORISED_ABSENCE_UNPAID', 'explanation': 'Absent', 'amount': -115.38, 'days': 1},
        {'id': 'adj_3', 'type': 'UNPAID_LEAVE_DEDUCTION', 'explanation': 'Unpaid leave', 'amount': -115.38, 'days': 1},
      ],
      'effectiveFrom': '2024-12-02',
      'payslipId': 'ps_0123456789abcdef',
      'payslipVersion': 1,
      'payslipStatus': payslipStatus,
      'payDate': '2025-05-31',
      'cutoffDate': '2025-05-25',
      'publishedAt': mayPublishedAt,
      'paidAt': paidAt,
      'deductionsTotal': 346.14,
      'lines': [
        {
          'adjustmentId': 'adj_1',
          'type': 'ATTENDANCE_DEFICIT_DAY',
          'label': 'Attendance deficit',
          'explanation': '1 whole day(s) of accumulated lateness/early departures (every 480 minutes is one unpaid day).',
          'days': 1,
          'amount': -115.38,
          'sourceReference': null,
          'date': '2025-05-25',
        },
        {
          'adjustmentId': 'adj_2',
          'type': 'UNAUTHORISED_ABSENCE_UNPAID',
          'label': 'Unpaid absence',
          'explanation': '1 unauthorised absence(s) confirmed by HR as unpaid.',
          'days': 1,
          'amount': -115.38,
          'sourceReference': 'abs_13',
          'date': '2025-05-13',
        },
        {
          'adjustmentId': 'adj_3',
          'type': 'UNPAID_LEAVE_DEDUCTION',
          'label': 'Unpaid leave',
          'explanation': '1 day(s) of approved unpaid leave.',
          'days': 1,
          'amount': -115.38,
          'sourceReference': 'lr_12',
          'date': '2025-05-12',
        },
      ],
    };

/// legacyStatements(): a CLOSED manual period with no payslip.
Map<String, dynamic> legacyClosedEntry() => {
      'periodId': 'pp_aug_manual',
      'name': 'August 2025 (manual)',
      'startDate': '2025-08-01',
      'endDate': '2025-08-31',
      'status': 'CLOSED',
      'exchangeRate': 350,
      'currency': 'PKR',
      'monthlyGross': 5000,
      'dailyRate': 192.31,
      'workingDaysCount': 21,
      'fullPeriodDays': 21,
      'isStarter': false,
      'basePayable': 5000,
      'adjustmentsTotal': 250,
      'netPayable': 5250,
      'adjustments': [
        {'id': 'adj_9', 'type': 'OVERTIME_BONUS', 'explanation': 'Weekend cover', 'amount': 250, 'days': null},
      ],
      'effectiveFrom': '2025-01-01',
      'payslipId': null,
      'payslipVersion': null,
      'payslipStatus': null,
      'payDate': null,
      'cutoffDate': null,
      'publishedAt': null,
      'paidAt': null,
      'deductionsTotal': null,
      'lines': null,
    };

/// payrollEstimate(), as asserted in payroll_run.test.js.
Map<String, dynamic> estimateJson() => {
      'isEstimate': true,
      'label': 'Estimate - not final until HR approves',
      'periodId': 'pp_sep',
      'periodName': 'September 2025',
      'periodStatus': 'OPEN',
      'cutoffDate': '2025-09-25',
      'payDate': '2025-09-30',
      'grossBaseline': 5000,
      'deductions': [
        {
          'type': 'UNAUTHORISED_ABSENCE_UNPAID',
          'label': 'Unpaid absence',
          'days': 1,
          'amount': -192.31,
          'explanation': '1 unauthorised absence(s) confirmed by HR as unpaid.',
        },
      ],
      'estimatedNet': 4807.69,
      'currency': 'PKR',
      'asOf': '2025-09-10',
      'deficit': {
        'carryForwardMinutes': 20,
        'minutesUntilNextUnpaidDay': 460,
        'wholeDaysSoFar': 0,
        'dayEquivalentMinutes': 480,
      },
    };

Map<String, dynamic> statementsJson() => {
      'status': 'SUCCESS',
      'enabled': true,
      'currentSalary': {
        'monthly': 5000,
        'daily': 192.31,
        'annual': 60000,
        'currency': 'PKR',
        'effectiveFrom': '2025-01-01',
        'blocked': false,
        'message': null,
      },
      // Deliberately out of order: the model keeps newest first.
      'periods': [publishedPayslipEntry(), legacyClosedEntry()],
      'estimate': estimateJson(),
      'latestPayslip': {'periodId': 'pp_jul', 'publishedAt': julyPublishedAt},
    };

void main() {
  group('Published payslip in the statements list', () {
    test('keeps the legacy fields and adds the payslip ones', () {
      final p = PayrollPeriodStatement.fromJson(publishedPayslipEntry());
      expect(p.periodId, 'pp_may');
      expect(p.name, 'May 2025');
      expect(p.status, 'CLOSED', reason: 'the legacy status field the old app reads');
      expect(p.basePayable, 3000);
      expect(p.netPayable, 2653.86);
      expect(p.adjustments.length, 3);

      expect(p.isPayslip, isTrue);
      expect(p.isPaid, isFalse);
      expect(p.payslipStatus, 'PUBLISHED');
      expect(p.payslipId, 'ps_0123456789abcdef');
      expect(p.payslipVersion, 1);
      expect(p.payDate, '2025-05-31');
      expect(p.cutoffDate, '2025-05-25');
      expect(p.publishedAt, mayPublishedAt);
      expect(p.paidAt, isNull);
      expect(p.deductionsTotal, 346.14);
    });

    test('parses every rich line item', () {
      final p = PayrollPeriodStatement.fromJson(publishedPayslipEntry());
      final lines = p.displayLines;
      expect(lines.length, 3);
      final absence = lines[1];
      expect(absence.adjustmentId, 'adj_2');
      expect(absence.type, 'UNAUTHORISED_ABSENCE_UNPAID');
      expect(absence.label, 'Unpaid absence');
      expect(absence.explanation, contains('confirmed by HR'));
      expect(absence.days, 1.0);
      expect(absence.amount, -115.38);
      expect(absence.isDeduction, isTrue);
      expect(absence.sourceReference, 'abs_13');
      expect(absence.date, '2025-05-13');
      expect(lines[0].sourceReference, isNull);
    });

    test('a paid payslip reads as PAID', () {
      final p = PayrollPeriodStatement.fromJson(
        publishedPayslipEntry(payslipStatus: 'PAID', paidAt: mayPublishedAt + 3 * 86400000),
      );
      expect(p.isPaid, isTrue);
      expect(p.paidAt, mayPublishedAt + 3 * 86400000);
      final d = PayslipDetail.fromStatement(p);
      expect(d.isPaid, isTrue);
      expect(d.isLegacy, isFalse);
    });

    test('epoch timestamps sent as strings still parse', () {
      final json = publishedPayslipEntry()..['publishedAt'] = '$mayPublishedAt';
      expect(PayrollPeriodStatement.fromJson(json).publishedAt, mayPublishedAt);
    });
  });

  group('Legacy CLOSED period', () {
    test('renders from the legacy fields, with adjustments as its lines', () {
      final p = PayrollPeriodStatement.fromJson(legacyClosedEntry());
      expect(p.status, 'CLOSED');
      expect(p.isPayslip, isFalse);
      expect(p.payslipStatus, isNull);
      expect(p.lines, isNull);
      expect(p.publishedAt, isNull);
      expect(p.deductionsTotal, isNull);
      expect(p.basePayable, 5000);
      expect(p.netPayable, 5250);

      final lines = p.displayLines;
      expect(lines.length, 1);
      expect(lines.first.label, 'Overtime bonus', reason: 'humanised from the type');
      expect(lines.first.amount, 250);
      expect(lines.first.days, isNull);
      expect(lines.first.isDeduction, isFalse);

      final d = PayslipDetail.fromStatement(p);
      expect(d.isLegacy, isTrue);
      expect(d.grossBaseline, 5000);
      expect(d.netPayable, 5250);
      expect(d.monthlySalary, 5000);
      expect(d.workingDays, 21);
      expect(d.salaryEffectiveFrom, '2025-01-01');
      expect(d.deductionsPositive, 0, reason: 'no negative lines, no deductionsTotal');
    });
  });

  group('Estimate', () {
    test('parses the running estimate', () {
      final e = PayrollEstimate.fromJson(estimateJson())!;
      expect(e.isEstimate, isTrue);
      expect(e.label, 'Estimate - not final until HR approves');
      expect(e.periodId, 'pp_sep');
      expect(e.periodName, 'September 2025');
      expect(e.periodStatus, 'OPEN');
      expect(e.cutoffDate, '2025-09-25');
      expect(e.payDate, '2025-09-30');
      expect(e.asOf, '2025-09-10');
      expect(e.grossBaseline, 5000);
      expect(e.estimatedNet, 4807.69);
      expect(e.currency, 'PKR');
      expect(e.deductions.length, 1);
      expect(e.deductions.first.type, 'UNAUTHORISED_ABSENCE_UNPAID');
      expect(e.deductions.first.label, 'Unpaid absence');
      expect(e.deductions.first.days, 1);
      expect(e.deductions.first.amount, -192.31);
      expect(e.deductions.first.explanation, contains('unauthorised absence'));
      expect(e.deductionsTotal, -192.31);

      final d = e.deficit!;
      expect(d.carryForwardMinutes, 20);
      expect(d.minutesUntilNextUnpaidDay, 460);
      expect(d.wholeDaysSoFar, 0);
      expect(d.dayEquivalentMinutes, 480);
      expect(d.progress, closeTo(20 / 480, 1e-9));
    });

    test('null when the backend sends none, and dayEquivalentMinutes falls back', () {
      expect(PayrollEstimate.fromJson(null), isNull);
      final deficit = EstimateDeficit.fromJson({
        'carryForwardMinutes': 100,
        'minutesUntilNextUnpaidDay': 380,
        'wholeDaysSoFar': 2,
      })!;
      expect(deficit.dayEquivalentMinutes, 480);
      expect(deficit.wholeDaysSoFar, 2);
    });
  });

  group('Statements response', () {
    test('carries periods newest first, the estimate and latestPayslip', () {
      final s = EmployeePayrollStatement.fromJson(statementsJson());
      expect(s.enabled, isTrue);
      expect(s.periods.map((p) => p.periodId), ['pp_aug_manual', 'pp_may']);
      expect(s.estimate?.estimatedNet, 4807.69);
      expect(s.latestPayslip?.periodId, 'pp_jul');
      expect(s.latestPayslip?.publishedAt, julyPublishedAt);
      expect(s.currentSalary?.monthly, 5000);
    });

    test('policy-restricted: nothing shown, the message kept', () {
      final s = EmployeePayrollStatement.fromJson({
        'status': 'SUCCESS',
        'enabled': false,
        'message': 'Salary and monthly statements are restricted by company HR policy.',
        'currentSalary': null,
        'periods': [],
        'estimate': null,
        'latestPayslip': null,
      });
      expect(s.enabled, isFalse);
      expect(s.message, contains('restricted by company HR policy'));
      expect(s.periods, isEmpty);
      expect(s.estimate, isNull);
      expect(s.latestPayslip, isNull);
      expect(s.currentSalary, isNull);
    });

    test('an estimate is ignored when salaries are not enabled', () {
      final json = statementsJson()..['enabled'] = false;
      final s = EmployeePayrollStatement.fromJson(json);
      expect(s.estimate, isNull);
      expect(s.latestPayslip, isNull);
    });
  });

  group('latestPayslip', () {
    test('parses and rejects malformed values', () {
      final l = LatestPayslip.fromJson({'periodId': 'pp_jul', 'publishedAt': julyPublishedAt})!;
      expect(l.periodId, 'pp_jul');
      expect(l.publishedAt, julyPublishedAt);
      expect(LatestPayslip.fromJson(null), isNull);
      expect(LatestPayslip.fromJson({'periodId': 'pp_jul'}), isNull);
      expect(LatestPayslip.fromJson({'publishedAt': julyPublishedAt}), isNull);
      expect(LatestPayslip.fromJson('pp_jul'), isNull);
    });
  });

  group('Payslip detail (GET /mine/payslips/:periodId)', () {
    test('parses presentPayslip plus the period dates', () {
      final d = PayslipDetail.fromJson({
        'id': 'ps_0123456789abcdef',
        'periodId': 'pp_may',
        'periodName': 'May 2025',
        'employeeId': 'emp_routine',
        'employeeName': 'Routine Employee',
        'employeeNumber': 'E001',
        'version': 1,
        'status': 'PUBLISHED',
        'payslipStatus': 'PAID',
        'currency': 'PKR',
        'exchangeRate': 350,
        'monthlySalary': 3000,
        'dailyRate': 115.38,
        'grossBaseline': 3000,
        'deductionsTotal': 346.14,
        'adjustmentsTotal': -346.14,
        'netPayable': 2653.86,
        'workingDays': 20,
        'fullPeriodDays': 22,
        'isPartial': true,
        'isStarter': true,
        'salaryEffectiveFrom': '2024-12-02',
        'lines': publishedPayslipEntry()['lines'],
        'cutoffDate': '2025-05-25',
        'payDate': '2025-05-31',
        'publishedAt': mayPublishedAt,
        'paidAt': mayPublishedAt + 86400000,
        'contentHash': 'abc',
        'integrityOk': true,
        'startDate': '2025-05-01',
        'endDate': '2025-05-31',
      });
      expect(d.periodName, 'May 2025');
      expect(d.payslipStatus, 'PAID');
      expect(d.isPaid, isTrue);
      expect(d.isLegacy, isFalse);
      expect(d.version, 1);
      expect(d.grossBaseline, 3000);
      expect(d.deductionsPositive, 346.14);
      expect(d.netPayable, 2653.86);
      expect(d.workingDays, 20);
      expect(d.fullPeriodDays, 22);
      expect(d.isPartial, isTrue);
      expect(d.isStarter, isTrue);
      expect(d.lines.length, 3);
      expect(d.lines.every((l) => l.isDeduction), isTrue);
      expect(d.publishedAt, mayPublishedAt);
      expect(d.paidAt, mayPublishedAt + 86400000);
      expect(d.integrityOk, isTrue);
      expect(d.startDate, '2025-05-01');
      expect(d.currency, 'PKR');
    });
  });

  group('Display helpers', () {
    test('money keeps the sign in front of the symbol', () {
      expect(formatPayrollMoney(1234.5, 'PKR'), '₨ 1,234.50');
      expect(formatPayrollMoney(-192.31, 'PKR'), '-₨ 192.31');
      expect(formatPayrollMoney(250, 'GBP', signed: true), '+£250.00');
      expect(formatPayrollMoney(-0.001, 'GBP'), '£0.00');
      expect(formatPayrollMoney(5, 'EUR'), 'EUR 5.00');
    });

    test('hours and minutes, days, dates', () {
      expect(formatHoursMinutes(460), '7 h 40 m');
      expect(formatHoursMinutes(40), '40 m');
      expect(formatHoursMinutes(480), '8 h');
      expect(formatDays(1), '1 day');
      expect(formatDays(2.5), '2.5 days');
      expect(formatPayrollDate('2025-05-31'), '31 May 2025');
      expect(formatPayrollDate(null), isNull);
      expect(formatPayrollDate('soon'), 'soon');
    });
  });

  group('PayslipWatcher', () {
    test('first run stores a baseline and never notifies', () {
      final older = PayslipWatcher.decide(
        stored: null,
        latest: const LatestPayslip(periodId: 'pp_jul', publishedAt: julyPublishedAt),
        nowMs: julyPublishedAt + 1000,
      );
      expect(older.notify, isFalse);
      expect(older.store, julyPublishedAt + 1000, reason: 'published before the device started watching');

      final none = PayslipWatcher.decide(stored: null, latest: null, nowMs: 42);
      expect(none.notify, isFalse);
      expect(none.store, 42);
    });

    test('a newer payslip notifies once; the same or an older one does not', () {
      const latest = LatestPayslip(periodId: 'pp_jul', publishedAt: julyPublishedAt);
      final fresh = PayslipWatcher.decide(stored: mayPublishedAt, latest: latest, nowMs: julyPublishedAt + 5);
      expect(fresh.notify, isTrue);
      expect(fresh.store, julyPublishedAt);

      final again = PayslipWatcher.decide(stored: fresh.store, latest: latest, nowMs: julyPublishedAt + 60000);
      expect(again.notify, isFalse);
      expect(again.store, isNull);

      final hidden = PayslipWatcher.decide(stored: julyPublishedAt, latest: null, nowMs: julyPublishedAt + 60000);
      expect(hidden.notify, isFalse, reason: 'salaries hidden: latestPayslip is null');
      expect(hidden.store, isNull);
    });

    test('notification text names the month', () {
      expect(PayslipWatcher.notificationTitle('September 2025'), 'Your September 2025 payslip is ready');
      expect(PayslipWatcher.notificationTitle(null), 'Your payslip is ready');
      expect(PayslipWatcher.notificationBody('2025-09-30'), contains('30 Sep 2025'));
      expect(PayslipWatcher.notificationPayload.toUpperCase(), contains('PAY'),
          reason: 'MainShell routes payloads containing PAY to the Salary tab');
    });

    test('observe on first run stores the baseline and settles a pending signal', () async {
      SharedPreferences.setMockInitialValues({NotificationService.payslipSignalPrefKey: true});
      final shown = await PayslipWatcher.observe(
        const LatestPayslip(periodId: 'pp_jul', publishedAt: julyPublishedAt),
        settlesSignal: true,
      );
      expect(shown, isFalse);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getInt(PayslipWatcher.lastSeenPrefKey), greaterThanOrEqualTo(julyPublishedAt));
      expect(prefs.getBool(NotificationService.payslipSignalPrefKey), isNull);
      expect(PayslipWatcher.latestPublishedAt.value, julyPublishedAt);
    });

    test('observe leaves the stored value alone for an already-seen payslip', () async {
      SharedPreferences.setMockInitialValues({PayslipWatcher.lastSeenPrefKey: julyPublishedAt});
      final shown = await PayslipWatcher.observe(
        const LatestPayslip(periodId: 'pp_may', publishedAt: mayPublishedAt),
      );
      expect(shown, isFalse);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getInt(PayslipWatcher.lastSeenPrefKey), julyPublishedAt);
    });
  });
}
