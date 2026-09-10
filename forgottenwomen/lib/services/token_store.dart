// Credential and preference storage.

import 'dart:developer';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

class TokenStore {
  static const _secure = FlutterSecureStorage(
    aOptions: AndroidOptions(
      encryptedSharedPreferences: false,
      resetOnError: true,
    ),
    iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
  );

  static const _kToken = 'device_token';
  static const _kDeviceId = 'device_id';

  static const _kServerUrl = 'server_url';
  static const _kEmployeeName = 'employee_name';
  static const _kEmployeeRole = 'employee_role';
  static const _kEmployeeId = 'employee_id';

  static const defaultServerUrl = String.fromEnvironment(
    'BACKEND_URL',
    defaultValue: 'https://backend-ten-lyart-57.vercel.app',
  );

  Future<String?> readToken() async {
    try {
      final val = await _secure.read(key: _kToken);
      if (val != null && val.isNotEmpty) return val;
    } catch (e) {
      log('TokenStore readToken secure error: $e');
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString(_kToken);
    } catch (e) {
      log('TokenStore readToken prefs error: $e');
      return null;
    }
  }

  Future<String?> readDeviceId() async {
    try {
      final val = await _secure.read(key: _kDeviceId);
      if (val != null && val.isNotEmpty) return val;
    } catch (e) {
      log('TokenStore readDeviceId secure error: $e');
    }
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString(_kDeviceId);
    } catch (e) {
      log('TokenStore readDeviceId prefs error: $e');
      return null;
    }
  }

  Future<void> saveEnrollment({
    required String token,
    required String deviceId,
    required String employeeId,
    required String employeeName,
    required String employeeRole,
  }) async {
    try {
      await _secure.write(key: _kToken, value: token);
      await _secure.write(key: _kDeviceId, value: deviceId);
    } catch (e) {
      log('TokenStore saveEnrollment secure error: $e');
    }

    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kToken, token);
      await prefs.setString(_kDeviceId, deviceId);
      await prefs.setString(_kEmployeeId, employeeId);
      await prefs.setString(_kEmployeeName, employeeName);
      await prefs.setString(_kEmployeeRole, employeeRole);
    } catch (e) {
      log('TokenStore saveEnrollment prefs error: $e');
    }
  }

  Future<void> clear() async {
    try {
      await _secure.delete(key: _kToken);
      await _secure.delete(key: _kDeviceId);
    } catch (_) {}

    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_kToken);
      await prefs.remove(_kDeviceId);
      await prefs.remove(_kEmployeeId);
      await prefs.remove(_kEmployeeName);
      await prefs.remove(_kEmployeeRole);
    } catch (_) {}
  }

  Future<bool> get isEnrolled async {
    try {
      final token = await readToken();
      return token != null && token.isNotEmpty;
    } catch (e) {
      return false;
    }
  }

  Future<String> readServerUrl() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString(_kServerUrl);
      if (saved == null ||
          saved.isEmpty ||
          saved.contains('192.168.18.68') ||
          saved.contains('localhost') ||
          saved.contains('127.0.0.1')) {
        await prefs.setString(_kServerUrl, defaultServerUrl);
        return defaultServerUrl;
      }
      return saved;
    } catch (_) {
      return defaultServerUrl;
    }
  }

  Future<void> saveServerUrl(String url) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kServerUrl, _normalise(url));
    } catch (_) {}
  }

  Future<String> readEmployeeName() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString(_kEmployeeName) ?? '';
    } catch (_) {
      return '';
    }
  }

  Future<String> readEmployeeRole() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString(_kEmployeeRole) ?? '';
    } catch (_) {
      return '';
    }
  }

  Future<void> clearToken() async {
    try {
      await _secure.delete(key: _kToken);
      await _secure.delete(key: _kDeviceId);
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_kToken);
      await prefs.remove(_kDeviceId);
      await prefs.remove(_kEmployeeId);
      await prefs.remove(_kEmployeeName);
      await prefs.remove(_kEmployeeRole);
    } catch (_) {}
  }

  static String _normalise(String url) {
    var u = url.trim();
    if (u.endsWith('/')) u = u.substring(0, u.length - 1);
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'http://$u';
    return u;
  }
}