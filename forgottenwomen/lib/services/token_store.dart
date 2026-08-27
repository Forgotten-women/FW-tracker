// Credential and preference storage.
//
// The device token authenticates this person to the attendance system, so it
// lives in the platform keystore/keychain rather than SharedPreferences, where
// the old app kept its whole profile in plaintext.

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

class TokenStore {
  static const _secure = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
    iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
  );

  static const _kToken = 'device_token';
  static const _kDeviceId = 'device_id';

  // Non-secret, and needed by the background isolate without a keystore
  // round-trip on every tick.
  static const _kServerUrl = 'server_url';
  static const _kEmployeeName = 'employee_name';
  static const _kEmployeeRole = 'employee_role';
  static const _kEmployeeId = 'employee_id';

  static const defaultServerUrl = 'http://192.168.18.68:5000';

  Future<String?> readToken() => _secure.read(key: _kToken);
  Future<String?> readDeviceId() => _secure.read(key: _kDeviceId);

  Future<void> saveEnrollment({
    required String token,
    required String deviceId,
    required String employeeId,
    required String employeeName,
    required String employeeRole,
  }) async {
    await _secure.write(key: _kToken, value: token);
    await _secure.write(key: _kDeviceId, value: deviceId);

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kEmployeeId, employeeId);
    await prefs.setString(_kEmployeeName, employeeName);
    await prefs.setString(_kEmployeeRole, employeeRole);
  }

  /// Wipes the credential. Used on sign-out and when the server reports the
  /// token has been revoked or has expired.
  Future<void> clear() async {
    await _secure.delete(key: _kToken);
    await _secure.delete(key: _kDeviceId);
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kEmployeeId);
    await prefs.remove(_kEmployeeName);
    await prefs.remove(_kEmployeeRole);
  }

  Future<bool> get isEnrolled async => (await readToken())?.isNotEmpty ?? false;

  Future<String> readServerUrl() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_kServerUrl) ?? defaultServerUrl;
  }

  Future<void> saveServerUrl(String url) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kServerUrl, _normalise(url));
  }

  Future<String> readEmployeeName() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_kEmployeeName) ?? '';
  }

  Future<String> readEmployeeRole() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_kEmployeeRole) ?? '';
  }

  static String _normalise(String url) {
    var u = url.trim();
    if (u.endsWith('/')) u = u.substring(0, u.length - 1);
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'http://$u';
    return u;
  }
}
