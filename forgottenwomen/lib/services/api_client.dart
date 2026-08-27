// HTTP client.
//
// One place that knows the wire format, instead of jsonDecode and raw map
// indexing scattered through the UI.

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/attendance.dart';
import 'token_store.dart';

/// A failure the caller can act on, rather than a swallowed exception.
class ApiException implements Exception {
  final String message;
  final int? statusCode;

  /// The server's machine-readable code (REVOKED, EXPIRED, NO_TOKEN, ...).
  final String? code;

  ApiException(this.message, {this.statusCode, this.code});

  /// True when this device's credential is no longer valid and the app must
  /// return to enrolment rather than retrying forever.
  bool get needsReEnrollment =>
      code == 'REVOKED' ||
      code == 'EXPIRED' ||
      code == 'BAD_TOKEN' ||
      code == 'DEVICE_REVOKED' ||
      code == 'NO_TOKEN';

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
        final res = await _http
            .post(
              await _uri('/api/attendance/ping'),
              headers: await _authHeaders(),
              body: jsonEncode({
                'observations': observations.map((o) => o.toJson()).toList(),
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
