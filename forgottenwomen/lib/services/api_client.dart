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

  ApiClient({TokenStore? store, http.Client? client, this.timeout = const Duration(seconds: 8)})
      : _store = store ?? TokenStore(),
        _http = client ?? http.Client();

  Future<Uri> _uri(String path) async =>
      Uri.parse('${await _store.readServerUrl()}$path');

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

  /// Fetches this employee's monthly payroll statements across all periods.
  Future<EmployeePayrollStatement> fetchMyPayrollStatements() => _guard(() async {
        final res = await _http
            .get(await _uri('/api/payroll/mine/statements'), headers: await _authHeaders())
            .timeout(timeout);
        return EmployeePayrollStatement.fromJson(_decode(res));
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

