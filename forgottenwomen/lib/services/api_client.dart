// HTTP client.
//
// One place that knows the wire format, instead of jsonDecode and raw map
// indexing scattered through the UI.

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/attendance.dart';
import '../models/hr.dart';
import 'token_store.dart';

/// A failure the caller can act on, rather than a swallowed exception.
class ApiException implements Exception {
  final String message;
  final int? statusCode;

  /// The server's machine-readable code (REVOKED, EXPIRED, NO_TOKEN, ...).
  final String? code;

  ApiException(this.message, {this.statusCode, this.code});

  /// True when this device's credential is confirmed permanently revoked by the server
  /// and the app must return to enrolment.
  /// Transient failures (timeouts, 500s, offline, or temporary reading delays)
  /// must NEVER wipe user credentials.
  bool get needsReEnrollment =>
      code == 'REVOKED' ||
      code == 'DEVICE_REVOKED';

  @override
  String toString() => message;
}

class ApiClient {
  final TokenStore _store;
  final http.Client _http;
  final Duration timeout;

  ApiClient({TokenStore? store, http.Client? client, this.timeout = const Duration(seconds: 25)})
      : _store = store ?? TokenStore(),
        _http = client ?? http.Client();

  Future<Uri> _uri(String path, [Map<String, dynamic>? query]) async {
    final base = Uri.parse('${await _store.readServerUrl()}$path');
    if (query == null || query.isEmpty) return base;
    return base.replace(queryParameters: query.map((k, v) => MapEntry(k, v.toString())));
  }

  Map<String, dynamic> _decode(http.Response res) {
    late final Map<String, dynamic> body;
    try {
      body = jsonDecode(res.body) as Map<String, dynamic>;
    } on FormatException {
      // The server now returns JSON for unknown /api routes, so this means
      // something is genuinely wrong (wrong host, a captive portal, a proxy).
      throw ApiException(
        'Server returned a non-JSON response (HTTP ${res.statusCode}). '
        'Check the server address.',
        statusCode: res.statusCode,
      );
    }

    if (res.statusCode >= 200 && res.statusCode < 300) return body;

    throw ApiException(
      body['message'] as String? ?? 'Request failed (HTTP ${res.statusCode})',
      statusCode: res.statusCode,
      code: body['code'] as String?,
    );
  }

  Future<Map<String, String>> _authHeaders() async {
    final token = await _store.readToken();
    if (token == null || token.isEmpty) {
      throw ApiException('This device is not enrolled.', code: 'NO_TOKEN');
    }
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $token',
    };
  }

  Future<T> _guard<T>(Future<T> Function() fn) async {
    try {
      return await fn();
    } on ApiException {
      rethrow;
    } on TimeoutException {
      throw ApiException('The server did not respond in time.');
    } catch (e) {
      throw ApiException('Could not reach the server: $e');
    }
  }

  // --- enrolment -----------------------------------------------------------

  /// Exchanges a single-use code from an administrator for a device token.
  Future<Map<String, dynamic>> enroll({
    required String code,
    required String platform,
    required String model,
  }) =>
      _guard(() async {
        final res = await _http
            .post(
              await _uri('/api/enroll'),
              headers: {'Content-Type': 'application/json'},
              body: jsonEncode({'code': code, 'platform': platform, 'model': model}),
            )
            .timeout(timeout);
        return _decode(res);
      });

  // --- presence ------------------------------------------------------------

  /// Sends one or more observations. Buffered observations keep their original
  /// timestamps; the server dedupes, so replay is safe.
  Future<PingResult> ping(List<QueuedObservation> observations) =>
      _guard(() async {
        // Extract the most recent localIp to send as a top-level field.
        // The backend uses it as a fallback subnet check when running on Vercel
        // (where req.ip is the public internet IP, not 192.168.x.x).
        final localIp = observations
            .where((o) => o.localIp != null)
            .map((o) => o.localIp)
            .lastOrNull;
        final res = await _http
            .post(
              await _uri('/api/attendance/ping'),
              headers: await _authHeaders(),
              body: jsonEncode({
                'observations': observations.map((o) => o.toJson()).toList(),
                if (localIp != null) 'localIp': localIp,
              }),
            )
            .timeout(timeout);
        return PingResult.fromJson(_decode(res));
      });

  Future<Attendance> today() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/attendance/me'), headers: await _authHeaders())
            .timeout(timeout);
        final body = _decode(res);
        return Attendance.fromJson(body['attendance'] as Map<String, dynamic>);
      });

  /// Fetches comprehensive attendance, break, and deficit details for today (Spec 8, 12, 19).
  Future<TodayAttendanceDetails> fetchTodayDetails() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/attendance/today'), headers: await _authHeaders())
            .timeout(timeout);
        return TodayAttendanceDetails.fromJson(_decode(res));
      });

  /// Fetches consolidated home screen summary in one single network round-trip.
  Future<HomeSummary> fetchHomeSummary() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/attendance/home-summary'), headers: await _authHeaders())
            .timeout(timeout);
        return HomeSummary.fromJson(_decode(res));
      });

  /// Fetches consolidated home screen summary and returns decoded raw JSON for caching.
  Future<Map<String, dynamic>> fetchHomeSummaryRaw() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/attendance/home-summary'), headers: await _authHeaders())
            .timeout(timeout);
        return _decode(res);
      });

  /// Starts a break for the employee (Spec 12).
  Future<BreakStartResult> startBreak() => _guard(() async {
        final res = await _http
            .post(await _uri('/api/attendance/break/start'), headers: await _authHeaders())
            .timeout(timeout);
        return BreakStartResult.fromJson(_decode(res));
      });

  /// Ends the currently active break for the employee (Spec 12).
  Future<BreakEndResult> endBreak() => _guard(() async {
        final res = await _http
            .post(await _uri('/api/attendance/break/end'), headers: await _authHeaders())
            .timeout(timeout);
        return BreakEndResult.fromJson(_decode(res));
      });

  /// Manually clocks out the employee for the day (Spec 2.2, 7, 23.6).
  Future<void> clockOut() => _guard(() async {
        final res = await _http
            .post(await _uri('/api/attendance/clock-out'), headers: await _authHeaders())
            .timeout(timeout);
        _decode(res);
      });

  Future<List<Attendance>> history({int days = 7}) => _guard(() async {
        final res = await _http
            .get(
              await _uri('/api/attendance/my-history?days=$days'),
              headers: await _authHeaders(),
            )
            .timeout(timeout);
        final body = _decode(res);
        return (body['days'] as List<dynamic>)
            .map((d) => Attendance.fromJson(d as Map<String, dynamic>))
            .toList();
      });
  /// Submits an attendance correction / dispute request to HR (Spec 11).
  Future<String> submitCorrection({
    required String dateKey,
    required String reason,
    Map<String, dynamic>? requestedChange,
  }) =>
      _guard(() async {
        final res = await _http
            .post(
              await _uri('/api/attendance/corrections'),
              headers: await _authHeaders(),
              body: jsonEncode({
                'dateKey': dateKey,
                'reason': reason,
                if (requestedChange != null) 'requestedChange': requestedChange,
              }),
            )
            .timeout(timeout);
        final body = _decode(res);
        return body['message'] as String? ?? 'Correction request submitted to HR.';
      });

  /// Fetches the employee's submitted attendance corrections and their review statuses (Spec 11).
  Future<List<CorrectionRequest>> fetchMyCorrections() => _guard(() async {
        final res = await _http
            .get(
              await _uri('/api/attendance/corrections/mine'),
              headers: await _authHeaders(),
            )
            .timeout(timeout);
        final body = _decode(res);
        return (body['corrections'] as List<dynamic>? ?? [])
            .map((c) => CorrectionRequest.fromJson(c as Map<String, dynamic>))
            .toList();
      });

  // --- leave (spec 13-15) --------------------------------------------------

  Future<Map<String, dynamic>> myLeave() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/leave/mine'), headers: await _authHeaders())
            .timeout(timeout);
        final body = _decode(res);
        return {
          'balance': LeaveBalance.fromJson(body['balance'] as Map<String, dynamic>),
          'requests': (body['requests'] as List<dynamic>? ?? [])
              .map((r) => LeaveRequest.fromJson(r as Map<String, dynamic>))
              .toList(),
        };
      });

  Future<MonthlyLeaveReport> fetchMonthlyLeaveReport({String? month}) => _guard(() async {
        final query = (month != null && month.isNotEmpty) ? {'month': month} : null;
        final res = await _http
            .get(await _uri('/api/leave/monthly-report', query), headers: await _authHeaders())
            .timeout(timeout);
        final body = _decode(res);
        return MonthlyLeaveReport.fromJson(body['report'] as Map<String, dynamic>);
      });

  Future<List<BankHoliday>> fetchBankHolidays({int? year}) => _guard(() async {
        final query = year != null ? {'year': year.toString()} : null;
        final res = await _http
            .get(await _uri('/api/leave/bank-holidays', query), headers: await _authHeaders())
            .timeout(timeout);
        final body = _decode(res);
        return (body['holidays'] as List<dynamic>? ?? [])
            .map((h) => BankHoliday.fromJson(h as Map<String, dynamic>))
            .toList();
      });

  Future<List<LeaveType>> leaveTypes() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/leave/types'), headers: await _authHeaders())
            .timeout(timeout);
        final body = _decode(res);
        return (body['types'] as List<dynamic>? ?? [])
            .map((t) => LeaveType.fromJson(t as Map<String, dynamic>))
            .toList();
      });

  Future<LeavePreview> previewLeave({
    required String leaveTypeId,
    required String startDate,
    required String endDate,
    String dayPortion = 'FULL_DAY',
  }) =>
      _guard(() async {
        final res = await _http
            .post(
              await _uri('/api/leave/preview'),
              headers: await _authHeaders(),
              body: jsonEncode({
                'leaveTypeId': leaveTypeId,
                'startDate': startDate,
                'endDate': endDate,
                'dayPortion': dayPortion,
              }),
            )
            .timeout(timeout);
        return LeavePreview.fromJson(_decode(res));
      });

  Future<void> requestLeave({
    required String leaveTypeId,
    required String startDate,
    required String endDate,
    String dayPortion = 'FULL_DAY',
    String? reason,
  }) =>
      _guard(() async {
        final res = await _http
            .post(
              await _uri('/api/leave/request'),
              headers: await _authHeaders(),
              body: jsonEncode({
                'leaveTypeId': leaveTypeId,
                'startDate': startDate,
                'endDate': endDate,
                'dayPortion': dayPortion,
                'reason': ?reason,
              }),
            )
            .timeout(timeout);
        _decode(res);
      });

  Future<void> cancelLeave(String requestId) => _guard(() async {
        final res = await _http
            .post(
              await _uri('/api/leave/request/$requestId/cancel'),
              headers: await _authHeaders(),
            )
            .timeout(timeout);
        _decode(res);
      });

  // --- warnings (spec 9, 19.5) --------------------------------------------

  Future<WarningView> myWarnings() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/warnings/mine'), headers: await _authHeaders())
            .timeout(timeout);
        return WarningView.fromJson(_decode(res));
      });

  Future<void> acknowledgeWarning(String warningId, {String? comments}) =>
      _guard(() async {
        final res = await _http
            .post(
              await _uri('/api/warnings/$warningId/acknowledge'),
              headers: await _authHeaders(),
              body: jsonEncode(comments == null ? {} : {'comments': comments}),
            )
            .timeout(timeout);
        _decode(res);
      });

  // --- documents & KYC (spec 5, 27) ---------------------------------------

  Future<KycChecklist> myKycChecklist() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/documents/mine/kyc-checklist'), headers: await _authHeaders())
            .timeout(timeout);
        return KycChecklist.fromJson(_decode(res));
      });

  Future<List<EmployeeDocument>> myDocuments() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/documents/mine'), headers: await _authHeaders())
            .timeout(timeout);
        final body = _decode(res);
        return (body['documents'] as List<dynamic>? ?? [])
            .map((d) => EmployeeDocument.fromJson(d as Map<String, dynamic>))
            .toList();
      });

  Future<Map<String, dynamic>> requestDocumentUpdate({
    required String documentTypeId,
    required String documentName,
    required String reason,
  }) =>
      _guard(() async {
        final res = await _http.post(
          await _uri('/api/documents/mine/request-update'),
          headers: await _authHeaders(),
          body: jsonEncode({
            'documentTypeId': documentTypeId,
            'documentName': documentName,
            'reason': reason,
          }),
        ).timeout(timeout);
        return _decode(res);
      });

  Future<Map<String, dynamic>> uploadDocument({
    required String documentTypeId,
    required String title,
    required List<int> fileBytes,
    required String filename,
    String? expiryDate,
  }) =>
      _guard(() async {
        final uri = await _uri('/api/documents/mine/upload');
        final request = http.MultipartRequest('POST', uri);
        final token = await _store.readToken();
        if (token != null) {
          request.headers['Authorization'] = 'Bearer $token';
        }
        request.fields['documentTypeId'] = documentTypeId;
        request.fields['title'] = title;
        if (expiryDate != null && expiryDate.isNotEmpty) {
          request.fields['expiryDate'] = expiryDate;
        }
        request.files.add(http.MultipartFile.fromBytes(
          'file',
          fileBytes,
          filename: filename,
        ));

        final streamed = await request.send().timeout(timeout);
        final res = await http.Response.fromStream(streamed);
        return _decode(res);
      });

  /// Deletes an uploaded document owned by this employee.
  Future<void> deleteMyDocument(String documentId) => _guard(() async {
        final res = await _http
            .delete(await _uri('/api/documents/mine/$documentId'), headers: await _authHeaders())
            .timeout(timeout);
        _decode(res);
      });

  /// Self-reports sickness or emergency absence (Spec 2.2 & 10).
  Future<Map<String, dynamic>> selfReportAbsence({
    required String dateKey,
    String absenceType = 'SICK',
    String reason = '',
    String? evidenceDocumentId,
  }) =>
      _guard(() async {
        final res = await _http
            .post(
              await _uri('/api/warnings/absences/self-report'),
              headers: await _authHeaders(),
              body: jsonEncode({
                'dateKey': dateKey,
                'absenceType': absenceType,
                'reason': reason,
                'evidenceDocumentId': evidenceDocumentId,
              }),
            )
            .timeout(timeout);
        return _decode(res);
      });

  /// Fetches this employee's reported absences & no-shows.
  Future<List<EmployeeAbsenceRecord>> myAbsences() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/warnings/absences/mine'), headers: await _authHeaders())
            .timeout(timeout);
        final body = _decode(res);
        return (body['absences'] as List<dynamic>? ?? [])
            .map((a) => EmployeeAbsenceRecord.fromJson(a as Map<String, dynamic>))
            .toList();
      });

  /// Fetches this employee's self-service profile and conditional salary info.
  Future<EmployeeProfile> getProfile() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/people/mine/profile'), headers: await _authHeaders())
            .timeout(timeout);
        final body = _decode(res);
        return EmployeeProfile.fromJson(body['profile'] as Map<String, dynamic>);
      });

  /// Updates this employee's personal details, identification, and residential address.
  Future<void> updateMyPersonalDetails({
    String? nationalId,
    String? mobilePhone,
    String? personalEmail,
    String? dateOfBirth,
    String? addressLine1,
    String? addressLine2,
    String? city,
    String? postcode,
  }) => _guard(() async {
        final payload = <String, dynamic>{
          if (nationalId != null) 'nationalId': nationalId,
          if (mobilePhone != null) 'mobilePhone': mobilePhone,
          if (personalEmail != null) 'personalEmail': personalEmail,
          if (dateOfBirth != null) 'dateOfBirth': dateOfBirth,
          if (addressLine1 != null) 'addressLine1': addressLine1,
          if (addressLine2 != null) 'addressLine2': addressLine2,
          if (city != null) 'city': city,
          if (postcode != null) 'postcode': postcode,
        };
        final res = await _http
            .post(
              await _uri('/api/people/mine/personal'),
              headers: await _authHeaders(),
              body: jsonEncode(payload),
            )
            .timeout(timeout);
        _decode(res);
      });

  /// Adds an emergency contact for this employee.
  Future<void> addEmergencyContact({
    required String name,
    required String relationship,
    required String phone,
    String? email,
    bool isPrimary = false,
  }) => _guard(() async {
        final payload = <String, dynamic>{
          'name': name,
          'relationship': relationship,
          'phone': phone,
          if (email != null && email.isNotEmpty) 'email': email,
          'isPrimary': isPrimary,
        };
        final res = await _http
            .post(
              await _uri('/api/people/mine/emergency-contacts'),
              headers: await _authHeaders(),
              body: jsonEncode(payload),
            )
            .timeout(timeout);
        _decode(res);
      });

  /// Updates an emergency contact for this employee.
  Future<void> updateEmergencyContact({
    required String contactId,
    required String name,
    required String relationship,
    required String phone,
    String? email,
    bool isPrimary = false,
  }) => _guard(() async {
        final payload = <String, dynamic>{
          'name': name,
          'relationship': relationship,
          'phone': phone,
          if (email != null && email.isNotEmpty) 'email': email,
          'isPrimary': isPrimary,
        };
        final res = await _http
            .put(
              await _uri('/api/people/mine/emergency-contacts/$contactId'),
              headers: await _authHeaders(),
              body: jsonEncode(payload),
            )
            .timeout(timeout);
        _decode(res);
      });

  /// Deletes an emergency contact.
  Future<void> deleteEmergencyContact(String contactId) => _guard(() async {
        final res = await _http
            .delete(
              await _uri('/api/people/mine/emergency-contacts/$contactId'),
              headers: await _authHeaders(),
            )
            .timeout(timeout);
        _decode(res);
      });

  /// Fetches this employee's monthly payroll statements across all periods.
  Future<EmployeePayrollStatement> fetchMyPayrollStatements() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/payroll/mine/statements'), headers: await _authHeaders())
            .timeout(timeout);
        return EmployeePayrollStatement.fromJson(_decode(res));
      });

  /// Fetches complaint categories and statuses.
  Future<List<String>> fetchComplaintCategories() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/complaints/categories'), headers: await _authHeaders())
            .timeout(timeout);
        final data = _decode(res);
        return (data['categories'] as List<dynamic>? ?? []).map((e) => e.toString()).toList();
      });

  /// Lists all complaints submitted by this employee.
  Future<List<ComplaintItem>> myComplaints() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/complaints/mine'), headers: await _authHeaders())
            .timeout(timeout);
        final data = _decode(res);
        final list = (data['complaints'] as List<dynamic>? ?? [])
            .map((c) => ComplaintItem.fromJson(c as Map<String, dynamic>))
            .toList();
        return list;
      });

  /// Submits a confidential employee complaint with optional attachments.
  Future<ComplaintSubmitResult> submitComplaint({
    required String category,
    required String subject,
    required String description,
    String priority = 'NORMAL',
    List<String> filePaths = const [],
  }) => _guard(() async {
        final token = await _store.readToken();
        if (token == null || token.isEmpty) {
          throw ApiException('This device is not enrolled.', code: 'NO_TOKEN');
        }
        final uri = await _uri('/api/complaints');

        if (filePaths.isEmpty) {
          final res = await _http
              .post(
                uri,
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer $token',
                },
                body: jsonEncode({
                  'category': category,
                  'subject': subject,
                  'description': description,
                  'priority': priority,
                }),
              )
              .timeout(timeout);
          return ComplaintSubmitResult.fromJson(_decode(res));
        }

        final req = http.MultipartRequest('POST', uri);
        req.headers['Authorization'] = 'Bearer $token';
        req.fields['category'] = category;
        req.fields['subject'] = subject;
        req.fields['description'] = description;
        req.fields['priority'] = priority;

        for (final path in filePaths) {
          req.files.add(await http.MultipartFile.fromPath('files', path));
        }

        final streamed = await req.send().timeout(timeout);
        final res = await http.Response.fromStream(streamed);
        return ComplaintSubmitResult.fromJson(_decode(res));
      });

  /// Unauthenticated reachability check, used by the settings screen so the
  /// user can tell a wrong address apart from a rejected credential.
  Future<bool> health() async {
    try {
      final res = await _http.get(await _uri('/api/health')).timeout(
            const Duration(seconds: 4),
          );
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  void dispose() => _http.close();
}


