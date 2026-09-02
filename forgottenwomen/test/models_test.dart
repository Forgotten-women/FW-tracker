// Replaces the default counter-app scaffold test, which tested a widget this
// app never had and failed on every run.

import 'package:flutter_test/flutter_test.dart';
import 'package:office_tracker/models/attendance.dart';
import 'package:office_tracker/models/hr.dart';
import 'package:office_tracker/services/offline_queue.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  group('PresenceStatus', () {
    test('parses every status the server can send', () {
      expect(PresenceStatus.parse('IN_OFFICE'), PresenceStatus.inOffice);
      expect(PresenceStatus.parse('GRACE_PERIOD'), PresenceStatus.gracePeriod);
      expect(PresenceStatus.parse('AWAY'), PresenceStatus.away);
      expect(PresenceStatus.parse('CLOSED'), PresenceStatus.closed);
      expect(PresenceStatus.parse('NOT_CHECKED_IN'), PresenceStatus.notCheckedIn);
    });

    test('an unknown status degrades to not-checked-in rather than throwing', () {
      expect(PresenceStatus.parse('SOMETHING_NEW'), PresenceStatus.notCheckedIn);
      expect(PresenceStatus.parse(null), PresenceStatus.notCheckedIn);
    });

    test('grace period still counts as present', () {
      expect(PresenceStatus.inOffice.isPresent, isTrue);
      expect(PresenceStatus.gracePeriod.isPresent, isTrue);
      expect(PresenceStatus.away.isPresent, isFalse);
      expect(PresenceStatus.notCheckedIn.isPresent, isFalse);
    });
  });

  group('Attendance', () {
    test('parses a full server payload', () {
      final a = Attendance.fromJson({
        'employeeId': 'emp_abc',
        'employeeName': 'Abdullah Shahid',
        'role': 'Engineering',
        'date': '2026-08-27',
        'status': 'IN_OFFICE',
        'statusLabel': 'Active in Office',
        'firstCheckIn': '9:02:11 AM',
        'lastActiveTime': '1:20:00 PM',
        'totalMinutes': 258,
        'timeWorkedFormatted': '4h 18m',
        'adjustmentMinutes': 0,
        'needsReview': false,
        'sessions': [
          {'from': '9:02 AM', 'to': 'now', 'duration': '4h 18m', 'open': true},
        ],
      });

      expect(a.status, PresenceStatus.inOffice);
      expect(a.totalMinutes, 258);
      expect(a.sessions.single.open, isTrue);
      expect(a.sessions.single.to, 'now');
    });

    test('missing fields fall back instead of throwing', () {
      // The old app did data['employee']['status'] on raw maps, so any change
      // to the response shape was a runtime crash.
      final a = Attendance.fromJson({});
      expect(a.status, PresenceStatus.notCheckedIn);
      expect(a.totalMinutes, 0);
      expect(a.firstCheckIn, '--');
      expect(a.sessions, isEmpty);
    });
  });

  group('PingResult', () {
    test('an unverified ping is reported as unverified', () {
      final r = PingResult.fromJson({
        'accepted': 1,
        'duplicates': 0,
        'rejected': 0,
        'verified': false,
        'serverTime': '2:00:00 PM',
        'attendance': {'status': 'NOT_CHECKED_IN'},
      });
      // The old UI showed "IN OFFICE" whenever a request succeeded, regardless
      // of whether the server actually counted it.
      expect(r.verified, isFalse);
      expect(r.attendance.status, PresenceStatus.notCheckedIn);
    });
  });

  group('OfflineQueue', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('buffers observations so a failed upload loses nothing', () async {
      final q = OfflineQueue();
      await q.add(const QueuedObservation(observedAt: 1000, ssid: 'Office'));
      await q.add(const QueuedObservation(observedAt: 2000, ssid: 'Office'));

      final all = await q.readAll();
      expect(all.length, 2);
      expect(all.first.observedAt, 1000);
      expect(all.first.ssid, 'Office');
    });

    test('preserves original timestamps for replay', () async {
      final q = OfflineQueue();
      const original = 1756000000000;
      await q.add(const QueuedObservation(observedAt: original));
      // Replay must carry the time the sighting HAPPENED, not the time it was
      // finally delivered, or offline periods land on the wrong day.
      expect((await q.readAll()).single.observedAt, original);
    });

    test('drops the oldest entries when full rather than growing without limit', () async {
      final q = OfflineQueue();
      for (var i = 0; i < OfflineQueue.maxEntries + 25; i++) {
        await q.add(QueuedObservation(observedAt: i));
      }
      final all = await q.readAll();
      expect(all.length, OfflineQueue.maxEntries);
      expect(all.first.observedAt, 25, reason: 'oldest dropped, newest kept');
    });

    test('removes only the entries that were delivered', () async {
      final q = OfflineQueue();
      await q.add(const QueuedObservation(observedAt: 1));
      await q.add(const QueuedObservation(observedAt: 2));
      await q.add(const QueuedObservation(observedAt: 3));

      // Two uploaded; a third arrived while the request was in flight.
      await q.removeDelivered(2);

      final remaining = await q.readAll();
      expect(remaining.length, 1);
      expect(remaining.single.observedAt, 3);
    });
  });

  group('Break and Deficit Models (Spec 8, 12, 19)', () {
    test('BreakStartResult parses start response', () {
      final res = BreakStartResult.fromJson({
        'breakId': 'brk_123',
        'startedAt': '2:14 PM',
        'permittedMinutes': 30,
        'dueBackAt': '2:44 PM',
        'dueBackAtMs': 1756000000000,
      });

      expect(res.breakId, 'brk_123');
      expect(res.startedAt, '2:14 PM');
      expect(res.permittedMinutes, 30);
      expect(res.dueBackAt, '2:44 PM');
      expect(res.dueBackAtMs, 1756000000000);
    });

    test('BreakEndResult parses end response with excess deficit', () {
      final res = BreakEndResult.fromJson({
        'actualMinutes': 37,
        'permittedMinutes': 30,
        'excessMinutes': 7,
        'message':
            'Break was 37 minutes. 7 minutes over the permitted 30 have been added to your attendance deficit.',
      });

      expect(res.actualMinutes, 37);
      expect(res.permittedMinutes, 30);
      expect(res.excessMinutes, 7);
      expect(res.message, contains('7 minutes over'));
    });

    test('DeficitBalance parses 480-minute whole-day rule correctly', () {
      final balance = DeficitBalance.fromJson({
        'minutes': 527,
        'formatted': '8h 47m',
        'wholeDayEquivalents': 1,
        'carryForwardMinutes': 47,
        'dayEquivalentMinutes': 480,
      }, todayBreakdown: const DeficitBreakdown(
        lateMinutes: 21,
        excessBreakMinutes: 9,
        earlyDepartureMinutes: 0,
        unauthorisedMissingMinutes: 0,
        approvedAdjustmentMinutes: 0,
        totalMinutes: 30,
        formatted: '30 mins',
      ));

      expect(balance.minutes, 527);
      expect(balance.wholeDayEquivalents, 1);
      expect(balance.carryForwardMinutes, 47);
      expect(balance.todayBreakdown.lateMinutes, 21);
      expect(balance.todayBreakdown.excessBreakMinutes, 9);
      expect(balance.todayBreakdown.totalMinutes, 30);
    });

    test('TodayAttendanceDetails parses full today payload with active break', () {
      final today = TodayAttendanceDetails.fromJson({
        'status': 'SUCCESS',
        'employee': {'id': 'emp_123', 'name': 'Amina Ali'},
        'today': {
          'status': 'IN_OFFICE',
          'statusLabel': 'Active in Office',
          'firstIn': '9:00 AM',
          'lastSeen': '2:30 PM',
          'worked': '5h 30m',
          'workedMinutes': 330,
          'onBreak': true,
          'breakDueBack': '2:44 PM',
          'breakDueBackAtMs': 1756001800000,
          'activeBreakStartedAtMs': 1756000000000,
          'permittedBreakMinutes': 30,
          'breakMinutesTaken': 14,
          'deficit': {
            'lateMinutes': 10,
            'excessBreakMinutes': 0,
            'earlyDepartureMinutes': 0,
            'unauthorisedMissingMinutes': 0,
            'approvedAdjustmentMinutes': 0,
            'totalMinutes': 10,
            'formatted': '10 mins',
          },
          'breaks': [],
          'sessions': [],
        },
        'lateness': {'message': 'On time'},
        'deficitBalance': {
          'minutes': 10,
          'formatted': '10 mins',
          'wholeDayEquivalents': 0,
          'carryForwardMinutes': 10,
          'dayEquivalentMinutes': 480,
        },
      });

      expect(today.employeeName, 'Amina Ali');
      expect(today.breakInfo.onBreak, isTrue);
      expect(today.breakInfo.breakMinutesTaken, 14);
      expect(today.breakInfo.dueBackDisplay, '2:44 PM');
      expect(today.deficitBalance.minutes, 10);
      expect(today.deficitBalance.todayBreakdown.lateMinutes, 10);
    });

    test('CorrectionRequest parses pending and approved dispute payloads (Spec 11)', () {
      final req = CorrectionRequest.fromJson({
        'id': 'corr_abc123',
        'dateKey': '2026-08-27',
        'reason': '[Wi-Fi failure] Phone was in office but Wi-Fi disconnected',
        'status': 'PENDING',
        'requestedChange': {'adjustmentMinutes': 30},
        'requestedAt': '3:15 PM',
      });

      expect(req.id, 'corr_abc123');
      expect(req.date, '2026-08-27');
      expect(req.reason, contains('Wi-Fi failure'));
      expect(req.isPending, isTrue);
      expect(req.isApproved, isFalse);
      expect(req.requestedChange['adjustmentMinutes'], 30);

      final approved = CorrectionRequest.fromJson({
        'id': 'corr_xyz789',
        'date': '2026-08-26',
        'reason': '[Manager authorised] External client visit',
        'status': 'APPROVED',
        'appliedChange': {'adjustmentMinutes': 45},
        'requestedAt': '10:00 AM',
        'reviewedAt': '11:30 AM',
        'reviewNotes': 'Approved as authorised by manager',
      });

      expect(approved.isApproved, isTrue);
      expect(approved.appliedChange['adjustmentMinutes'], 45);
      expect(approved.reviewNotes, 'Approved as authorised by manager');
    });

    test('WarningView and FormalWarning parse full disciplinary payload (Spec 9, 21)', () {
      final view = WarningView.fromJson({
        'band': 'AMBER',
        'bandLabel': 'Warning band (2-3 lates)',
        'pendingReview': false,
        'lateness': {
          'resolved': true,
          'count': 2,
          'allowed': 3,
          'remaining': 1,
          'message': '2 of 3 late arrivals this month',
          'thresholdReached': false,
        },
        'standing': {
          'warningsIssued': 1,
          'highestLevel': 'INFORMAL',
          'highestLevelLabel': 'Informal notice',
          'nextLevel': 'FIRST_WRITTEN',
          'nextLevelIfConfirmed': 'First written warning',
          'sequenceExhausted': false,
          'activeWarnings': 1,
        },
        'warnings': [
          {
            'id': 'fw_123',
            'level': 'INFORMAL',
            'levelLabel': 'Informal notice',
            'explanation': 'Arrived past grace period on 4 occasions',
            'issuedOn': '2026-08-15',
            'expiryDate': '2026-09-15',
            'status': 'ACTIVE',
            'acknowledgementRequired': true,
            'acknowledgedAt': null,
          }
        ],
      });

      expect(view.band, 'AMBER');
      expect(view.bandLabel, contains('Warning band'));
      expect(view.lateness.count, 2);
      expect(view.lateness.allowed, 3);
      expect(view.activeWarnings, 1);
      expect(view.nextLevelIfConfirmed, 'First written warning');
      expect(view.warnings.length, 1);
      expect(view.warnings.first.acknowledgementRequired, isTrue);
      expect(view.warnings.first.status, 'ACTIVE');
    });

    test('LeaveBalance and LeaveRequest parse full leave payload (Spec 13, 14, 15)', () {
      final bal = LeaveBalance.fromJson({
        'blocked': false,
        'holidayYear': {'from': '2026-03-01', 'to': '2027-02-28', 'monthsCompleted': 5},
        'nextAccrualDate': '2026-09-01',
        'annualEntitlement': 20.0,
        'accrued': 8.33,
        'taken': 2.0,
        'booked': 1.0,
        'available': 5.33,
        'isNegative': false,
      });

      expect(bal.blocked, isFalse);
      expect(bal.annualEntitlement, 20.0);
      expect(bal.accrued, 8.33);
      expect(bal.taken, 2.0);
      expect(bal.booked, 1.0);
      expect(bal.available, 5.33);
      expect(bal.yearFrom, '2026-03-01');

      final req = LeaveRequest.fromJson({
        'id': 'lr_123',
        'type': 'Annual Leave',
        'from': '2026-09-10',
        'to': '2026-09-12',
        'days': 3.0,
        'status': 'PENDING_HR',
        'submittedAt': '10:15 AM',
      });

      expect(req.id, 'lr_123');
      expect(req.type, 'Annual Leave');
      expect(req.days, 3.0);
      expect(req.isPending, isTrue);
      expect(req.isApproved, isFalse);
    });

    test('EmployeeDocument and KycChecklist parse full KYC and cloud storage payload (Spec 5, 27)', () {
      final doc = EmployeeDocument.fromJson({
        'id': 'doc_abc123',
        'type': 'National Identity Card (CNIC)',
        'typeId': 'nic_card',
        'title': 'CNIC Scan 2026.pdf',
        'version': 2,
        'filename': 'cnic_front_back.pdf',
        'sizeBytes': 2048500,
        'mimeType': 'application/pdf',
        'storageProvider': 'supabase',
        'confidentiality': 'highly_confidential',
        'verificationStatus': 'VERIFIED',
        'verifiedBy': 'admin_usr',
        'verifiedAt': '2:30 PM',
        'effectiveDate': '2026-01-01',
        'expiryDate': '2030-01-01',
        'uploadedAt': '10:00 AM',
      });

      expect(doc.id, 'doc_abc123');
      expect(doc.typeId, 'nic_card');
      expect(doc.version, 2);
      expect(doc.storageProvider, 'supabase');
      expect(doc.isVerified, isTrue);
      expect(doc.isPending, isFalse);
      expect(doc.expiryDate, '2030-01-01');

      final kyc = KycChecklist.fromJson({
        'employeeId': 'emp_8619',
        'employeeName': 'Abdullah Shahid',
        'employeeRole': 'Engineering',
        'overallKycStatus': 'PENDING_REVIEW',
        'completionPercentage': 80,
        'summary': {
          'totalMandatory': 5,
          'verifiedCount': 4,
          'pendingCount': 1,
          'rejectedCount': 0,
          'missingCount': 0,
        },
        'mandatoryChecklist': [
          {
            'typeId': 'cv_resume',
            'name': 'CV / Resume',
            'description': 'Up to date CV',
            'isMandatory': true,
            'status': 'VERIFIED',
            'filename': 'cv.pdf',
          },
          {
            'typeId': 'utility_bill',
            'name': 'Home Utility Bill',
            'description': 'Recent electricity bill',
            'isMandatory': true,
            'status': 'PENDING_VERIFICATION',
            'filename': 'bill.jpg',
          }
        ],
        'optionalChecklist': [],
      });

      expect(kyc.employeeId, 'emp_8619');
      expect(kyc.completionPercentage, 80);
      expect(kyc.totalMandatory, 5);
      expect(kyc.verifiedCount, 4);
      expect(kyc.pendingCount, 1);
      expect(kyc.mandatoryChecklist.length, 2);
      expect(kyc.mandatoryChecklist.first.isVerified, isTrue);
      expect(kyc.mandatoryChecklist.last.isPending, isTrue);
    });

    test('EmployeeAbsenceRecord parses sickness self-report and no-show payload (Spec 10 & 2.2)', () {
      final abs = EmployeeAbsenceRecord.fromJson({
        'id': 'abs_101',
        'date': '2026-09-02',
        'absenceType': 'SICK',
        'reason': 'Severe migraine and fever',
        'evidenceDocumentId': 'doc_med_99',
        'documentTitle': 'Doctor Fit Note.pdf',
        'detectedAt': '08:30 AM',
        'status': 'PENDING_REVIEW',
        'deductAnnualLeave': false,
        'treatAsUnpaid': false,
        'createWarningTrigger': false,
      });

      expect(abs.id, 'abs_101');
      expect(abs.date, '2026-09-02');
      expect(abs.absenceType, 'SICK');
      expect(abs.reason, contains('Severe migraine'));
      expect(abs.documentTitle, 'Doctor Fit Note.pdf');
      expect(abs.status, 'PENDING_REVIEW');
      expect(abs.deductAnnualLeave, isFalse);

      final confirmed = EmployeeAbsenceRecord.fromJson({
        'id': 'abs_102',
        'date': '2026-09-01',
        'absenceType': 'SUSPECTED_NO_SHOW',
        'reason': null,
        'detectedAt': '07:30 PM',
        'status': 'CONFIRMED',
        'reviewNotes': 'Unexcused no-show confirmed by manager',
        'deductAnnualLeave': true,
        'treatAsUnpaid': true,
        'createWarningTrigger': false,
      });

      expect(confirmed.status, 'CONFIRMED');
      expect(confirmed.deductAnnualLeave, isTrue);
      expect(confirmed.treatAsUnpaid, isTrue);
      expect(confirmed.createWarningTrigger, isFalse);
      expect(confirmed.reviewNotes, contains('Unexcused no-show'));
    });

    test('EmployeeProfile and SalaryInfo parse profile and conditional salary payload', () {
      final prof = EmployeeProfile.fromJson({
        'id': 'emp_123',
        'name': 'Abdullah Shahid',
        'role': 'Senior Software Engineer',
        'employeeNumber': 'FW-042',
        'workEmail': 'abdullah@forgottenwomen.org',
        'departmentName': 'Engineering',
        'officeName': 'Trans K Office (Pakistan)',
        'active': true,
        'employment': {
          'jobTitle': 'Senior Software Engineer',
          'employmentType': 'Full-time',
          'startDate': '2025-01-15',
          'holidayEntitlementDays': 20,
        },
        'schedule': {
          'startTime': '11:00',
          'endTime': '19:00',
          'graceMinutes': 10,
          'breakMinutes': 30,
          'workDays': 'MON,TUE,WED,THU,FRI',
        },
        'personal': {
          'nationalId': '42101-1234567-1',
          'mobilePhone': '+92 300 1234567',
          'personalEmail': 'personal@example.com',
          'addressLine1': 'Gulshan-e-Iqbal',
          'city': 'Karachi',
        },
        'emergencyContacts': [
          {
            'name': 'Sarah Shahid',
            'relationship': 'Spouse / Next of Kin',
            'phone': '+92 300 9876543',
            'isPrimary': true,
          }
        ],
        'salary': {
          'enabled': true,
          'blocked': false,
          'monthly': 100000.0,
          'daily': 4615.38,
          'annual': 1200000.0,
          'currency': 'PKR',
          'effectiveFrom': '2026-08-01',
        },
        'kyc': {
          'verifiedCount': 3,
          'totalCount': 3,
        },
      });

      expect(prof.name, 'Abdullah Shahid');
      expect(prof.role, 'Senior Software Engineer');
      expect(prof.officeName, 'Trans K Office (Pakistan)');
      expect(prof.emergencyContacts.length, 1);
      expect(prof.emergencyContacts.first.isPrimary, isTrue);
      expect(prof.emergencyContacts.first.relationship, 'Spouse / Next of Kin');
      
      // Salary check
      expect(prof.salary.enabled, isTrue);
      expect(prof.salary.blocked, isFalse);
      expect(prof.salary.monthly, 100000.0);
      expect(prof.salary.daily, 4615.38);
      expect(prof.salary.currency, 'PKR');
      expect(prof.salary.effectiveFrom, '2026-08-01');

      // Hidden salary check
      final hiddenSalary = SalaryInfo.fromJson({
        'enabled': false,
        'message': 'Salary visibility is disabled by HR policy.',
      });
      expect(hiddenSalary.enabled, isFalse);
      expect(hiddenSalary.message, contains('disabled by HR policy'));
    });

    test('EmployeePayrollStatement parses full period history & adjustments', () {
      final stmt = EmployeePayrollStatement.fromJson({
        'enabled': true,
        'currentSalary': {
          'monthly': 200000.0,
          'daily': 9230.77,
          'annual': 2400000.0,
          'currency': 'PKR',
          'effectiveFrom': '2026-08-01',
        },
        'periods': [
          {
            'periodId': 'pp_aug2026',
            'name': 'August 2026 Payroll',
            'startDate': '2026-08-01',
            'endDate': '2026-08-31',
            'status': 'OPEN',
            'exchangeRate': 365.0,
            'currency': 'PKR',
            'monthlyGross': 200000.0,
            'dailyRate': 9230.77,
            'workingDaysCount': 21,
            'fullPeriodDays': 21,
            'isStarter': false,
            'basePayable': 193846.15,
            'adjustmentsTotal': 15000.0,
            'netPayable': 208846.15,
            'adjustments': [
              {
                'id': 'adj_1',
                'type': 'OVERTIME',
                'explanation': 'Server migration support',
                'amount': 15000.0,
                'days': 1.0,
              }
            ],
            'effectiveFrom': '2026-08-01',
          }
        ],
      });

      expect(stmt.enabled, isTrue);
      expect(stmt.currentSalary?.monthly, 200000.0);
      expect(stmt.periods.length, 1);
      final p = stmt.periods.first;
      expect(p.periodId, 'pp_aug2026');
      expect(p.name, 'August 2026 Payroll');
      expect(p.workingDaysCount, 21);
      expect(p.fullPeriodDays, 21);
      expect(p.exchangeRate, 365.0);
      expect(p.adjustmentsTotal, 15000.0);
      expect(p.netPayable, 208846.15);
      expect(p.adjustments.length, 1);
      expect(p.adjustments.first.type, 'OVERTIME');
    });
  });
}


