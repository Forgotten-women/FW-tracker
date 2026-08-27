import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const OfficeTrackerApp());
}

class OfficeTrackerApp extends StatelessWidget {
  const OfficeTrackerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Office Presence Sentinel',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF0F766E),
          brightness: Brightness.light,
        ),
        useMaterial3: true,
        fontFamily: 'Roboto',
      ),
      home: const PresenceDashboardScreen(),
    );
  }
}

class PresenceDashboardScreen extends StatefulWidget {
  const PresenceDashboardScreen({super.key});

  @override
  State<PresenceDashboardScreen> createState() => _PresenceDashboardScreenState();
}

class _PresenceDashboardScreenState extends State<PresenceDashboardScreen> with WidgetsBindingObserver {
  // Config
  String _serverUrl = 'http://192.168.18.68:5000';
  String _employeeName = '';
  String _employeeRole = 'Engineering';
  String _employeeId = '';
  final String _deviceModel = 'CPH2119';

  // State
  bool _isLoadingPrefs = true;
  bool _isRegistered = false;
  bool _isAutoHeartbeatActive = true;
  bool _isPinging = false;
  String _status = 'IN_OFFICE';
  String _checkInTime = '--:--';
  String _timeWorkedFormatted = '0 mins';
  DateTime? _lastPingTime;
  int _lastPingLatencyMs = 0;
  String _lastErrorMessage = '';
  
  List<dynamic> _recentLogs = [];
  Timer? _heartbeatTimer;

  final TextEditingController _nameInputController = TextEditingController();
  final TextEditingController _roleInputController = TextEditingController(text: 'Engineering');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadSavedProfile();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _heartbeatTimer?.cancel();
    _nameInputController.dispose();
    _roleInputController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _isRegistered) {
      // Instantly ping server on app unlock or return
      _sendHeartbeat();
      _fetchLiveLogs();
    }
  }

  Future<void> _loadSavedProfile() async {
    final prefs = await SharedPreferences.getInstance();
    final savedName = prefs.getString('employee_name') ?? '';
    final savedRole = prefs.getString('employee_role') ?? 'Engineering';
    final savedId = prefs.getString('employee_id') ?? 'emp_${DateTime.now().millisecondsSinceEpoch % 10000}';
    final savedUrl = prefs.getString('server_url') ?? _serverUrl;
    final isReg = prefs.getBool('is_registered') ?? false;

    setState(() {
      _employeeName = savedName;
      _employeeRole = savedRole;
      _employeeId = savedId;
      _serverUrl = savedUrl;
      _isRegistered = isReg && savedName.isNotEmpty;
      _isLoadingPrefs = false;
    });

    if (_isRegistered) {
      _sendHeartbeat();
      _startHeartbeatTimer();
    }
  }

  Future<void> _saveProfileLocally() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('employee_name', _employeeName);
    await prefs.setString('employee_role', _employeeRole);
    await prefs.setString('employee_id', _employeeId);
    await prefs.setString('server_url', _serverUrl);
    await prefs.setBool('is_registered', true);
  }

  void _startHeartbeatTimer() {
    _heartbeatTimer?.cancel();
    if (_isAutoHeartbeatActive && _isRegistered) {
      _heartbeatTimer = Timer.periodic(const Duration(seconds: 15), (timer) {
        if (_isAutoHeartbeatActive && _isRegistered) {
          _sendHeartbeat();
        }
      });
    }
  }

  Future<void> _registerDevice() async {
    final name = _nameInputController.text.trim();
    final role = _roleInputController.text.trim();
    if (name.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter your full name')),
      );
      return;
    }

    setState(() => _isPinging = true);
    try {
      final url = Uri.parse('$_serverUrl/api/attendance/register-device');
      final response = await http.post(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'id': _employeeId,
          'name': name,
          'role': role,
          'deviceModel': _deviceModel,
        }),
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        final attendance = data['todayAttendance'];

        setState(() {
          _employeeName = name;
          _employeeRole = role;
          _isRegistered = true;
          _status = 'IN_OFFICE';
          _lastPingTime = DateTime.now();
          _lastErrorMessage = '';
          if (attendance != null) {
            _checkInTime = attendance['firstCheckInDisplay'] ?? attendance['checkInDisplay'] ?? '--:--';
            _timeWorkedFormatted = attendance['timeWorkedFormatted'] ?? '1 min';
          }
        });

        await _saveProfileLocally();
        _startHeartbeatTimer();
        _fetchLiveLogs();
      } else {
        setState(() {
          _lastErrorMessage = 'Registration failed: HTTP ${response.statusCode}';
        });
      }
    } catch (e) {
      setState(() {
        _lastErrorMessage = 'Cannot reach backend server at $_serverUrl';
      });
    } finally {
      setState(() => _isPinging = false);
    }
  }

  Future<void> _sendHeartbeat() async {
    if (_isPinging) return;
    setState(() => _isPinging = true);

    final stopwatch = Stopwatch()..start();
    try {
      final url = Uri.parse('$_serverUrl/api/attendance/mobile-ping');
      final response = await http.post(
        url,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'employeeId': _employeeId,
          'employeeName': _employeeName,
          'employeeRole': _employeeRole,
          'deviceModel': _deviceModel,
        }),
      ).timeout(const Duration(seconds: 5));

      stopwatch.stop();
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        final emp = data['employee'];
        final attendance = data['todayAttendance'];

        setState(() {
          _status = emp != null ? emp['status'] : 'IN_OFFICE';
          _lastPingTime = DateTime.now();
          _lastPingLatencyMs = stopwatch.elapsedMilliseconds;
          _lastErrorMessage = '';
          if (attendance != null) {
            _checkInTime = attendance['firstCheckInDisplay'] ?? attendance['checkInDisplay'] ?? _checkInTime;
            _timeWorkedFormatted = attendance['timeWorkedFormatted'] ?? _timeWorkedFormatted;
          }
        });
        _fetchLiveLogs();
      } else {
        setState(() {
          _lastErrorMessage = 'Server returned HTTP ${response.statusCode}';
        });
      }
    } catch (e) {
      setState(() {
        _lastErrorMessage = 'Could not reach server at $_serverUrl';
      });
    } finally {
      setState(() => _isPinging = false);
    }
  }

  Future<void> _fetchLiveLogs() async {
    try {
      final url = Uri.parse('$_serverUrl/api/attendance/logs?limit=15');
      final response = await http.get(url).timeout(const Duration(seconds: 4));
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        setState(() {
          _recentLogs = data['logs'] ?? [];
        });
      }
    } catch (_) {}
  }

  void _openSettingsDialog() {
    final serverController = TextEditingController(text: _serverUrl);
    final nameController = TextEditingController(text: _employeeName);
    final roleController = TextEditingController(text: _employeeRole);

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Presence Settings'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: serverController,
                decoration: const InputDecoration(
                  labelText: 'Backend Server URL',
                  hintText: 'http://192.168.18.68:5000',
                  prefixIcon: Icon(Icons.dns),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: nameController,
                decoration: const InputDecoration(
                  labelText: 'Full Name',
                  prefixIcon: Icon(Icons.person),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: roleController,
                decoration: const InputDecoration(
                  labelText: 'Department / Role',
                  prefixIcon: Icon(Icons.work_outline),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () async {
              setState(() {
                _serverUrl = serverController.text.trim();
                _employeeName = nameController.text.trim();
                _employeeRole = roleController.text.trim();
              });
              await _saveProfileLocally();
              Navigator.pop(ctx);
              _registerDevice();
            },
            child: const Text('Save & Sync'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoadingPrefs) {
      return const Scaffold(
        backgroundColor: Color(0xFFF8FAFC),
        body: Center(
          child: CircularProgressIndicator(color: Color(0xFF0F766E)),
        ),
      );
    }

    if (!_isRegistered) {
      return Scaffold(
        backgroundColor: const Color(0xFFF8FAFC),
        appBar: AppBar(
          title: const Text('Register Your Device', style: TextStyle(fontWeight: FontWeight.bold)),
          backgroundColor: Colors.white,
          elevation: 0.5,
          actions: [
            IconButton(
              icon: const Icon(Icons.settings_outlined),
              onPressed: _openSettingsDialog,
            )
          ],
        ),
        body: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  padding: const EdgeInsets.all(24),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withOpacity(0.04),
                        blurRadius: 16,
                        offset: const Offset(0, 4),
                      ),
                    ],
                  ),
                  child: Column(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: const Color(0xFF0F766E).withOpacity(0.1),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.badge_outlined, size: 40, color: Color(0xFF0F766E)),
                      ),
                      const SizedBox(height: 16),
                      const Text(
                        'Welcome to Office Tracker',
                        style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Pair your phone once to start automated 24/7 attendance logging.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Colors.grey, fontSize: 13),
                      ),
                      const SizedBox(height: 24),
                      TextField(
                        controller: _nameInputController,
                        decoration: const InputDecoration(
                          labelText: 'Your Full Name',
                          hintText: 'e.g. Abdullah Shahid',
                          prefixIcon: Icon(Icons.person),
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 16),
                      TextField(
                        controller: _roleInputController,
                        decoration: const InputDecoration(
                          labelText: 'Department / Role',
                          hintText: 'e.g. Engineering, Sales, HR',
                          prefixIcon: Icon(Icons.work_outline),
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 24),
                      SizedBox(
                        width: double.infinity,
                        height: 50,
                        child: FilledButton.icon(
                          onPressed: _isPinging ? null : _registerDevice,
                          style: FilledButton.styleFrom(
                            backgroundColor: const Color(0xFF0F766E),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                          ),
                          icon: _isPinging
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                                )
                              : const Icon(Icons.check_circle_outline),
                          label: Text(_isPinging ? 'Pairing Device...' : 'Register & Check In'),
                        ),
                      ),
                    ],
                  ),
                ),
                if (_lastErrorMessage.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.red.shade50,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: Colors.red.shade200),
                    ),
                    child: Text(
                      _lastErrorMessage,
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.red.shade800, fontSize: 12),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      );
    }

    final isOnline = _status == 'IN_OFFICE';

    return Scaffold(
      backgroundColor: const Color(0xFFF8FAFC),
      appBar: AppBar(
        title: const Text(
          'Office Presence Sentinel',
          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18),
        ),
        backgroundColor: Colors.white,
        elevation: 0.5,
        actions: [
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            onPressed: _openSettingsDialog,
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          await _sendHeartbeat();
          await _fetchLiveLogs();
        },
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            // Status Hero Card
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: isOnline
                      ? [const Color(0xFF0F766E), const Color(0xFF047857)]
                      : [const Color(0xFF334155), const Color(0xFF1E293B)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(16),
                boxShadow: [
                  BoxShadow(
                    color: (isOnline ? const Color(0xFF0F766E) : Colors.black).withOpacity(0.2),
                    blurRadius: 12,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: Colors.white.withOpacity(0.2),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: isOnline ? const Color(0xFF4ADE80) : Colors.amberAccent,
                              ),
                            ),
                            const SizedBox(width: 6),
                            Text(
                              isOnline ? 'IN OFFICE' : 'AWAY / CONNECTING',
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 11,
                                fontWeight: FontWeight.bold,
                                letterSpacing: 0.5,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Text(
                        'Wi-Fi: Trans K 2.4G',
                        style: TextStyle(
                          color: Colors.white.withOpacity(0.85),
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 18),
                  Text(
                    _employeeName,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 22,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  Text(
                    'Device: $_deviceModel • Role: $_employeeRole',
                    style: TextStyle(
                      color: Colors.white.withOpacity(0.8),
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(height: 20),
                  const Divider(color: Colors.white24),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceAround,
                    children: [
                      _buildMetricItem(
                        icon: Icons.login_rounded,
                        label: 'Check-In Today',
                        value: _checkInTime,
                      ),
                      _buildMetricItem(
                        icon: Icons.timer_outlined,
                        label: 'Time Logged',
                        value: _timeWorkedFormatted,
                      ),
                      _buildMetricItem(
                        icon: Icons.speed,
                        label: 'Ping Latency',
                        value: _lastPingLatencyMs > 0 ? '${_lastPingLatencyMs}ms' : '--',
                      ),
                    ],
                  ),
                ],
              ),
            ),

            if (_lastErrorMessage.isNotEmpty) ...[
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.red.shade50,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Colors.red.shade200),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.error_outline, color: Colors.red, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _lastErrorMessage,
                        style: TextStyle(color: Colors.red.shade800, fontSize: 12),
                      ),
                    ),
                  ],
                ),
              ),
            ],

            const SizedBox(height: 16),

            // Controls Card
            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: BorderSide(color: Colors.grey.shade200),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Row(
                          children: [
                            Icon(Icons.autorenew, color: Color(0xFF0F766E)),
                            SizedBox(width: 10),
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '24/7 Presence Heartbeat',
                                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                                ),
                                Text(
                                  'Pings server every 15s in background',
                                  style: TextStyle(color: Colors.grey, fontSize: 11),
                                ),
                              ],
                            ),
                          ],
                        ),
                        Switch(
                          value: _isAutoHeartbeatActive,
                          activeColor: const Color(0xFF0F766E),
                          onChanged: (val) {
                            setState(() => _isAutoHeartbeatActive = val);
                            _startHeartbeatTimer();
                          },
                        ),
                      ],
                    ),
                    const Divider(height: 24),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: _isPinging ? null : _sendHeartbeat,
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFF0F766E),
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(10),
                          ),
                        ),
                        icon: _isPinging
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                              )
                            : const Icon(Icons.send_rounded, size: 18),
                        label: Text(_isPinging ? 'Pinging Server...' : 'Send Manual Heartbeat Now'),
                      ),
                    ),
                  ],
                ),
              ),
            ),

            const SizedBox(height: 20),

            // Live Activity Header
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'Live Movement Logs',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: Color(0xFF1E293B),
                  ),
                ),
                Text(
                  _lastPingTime != null
                      ? 'Last ping: ${_lastPingTime!.hour.toString().padLeft(2, '0')}:${_lastPingTime!.minute.toString().padLeft(2, '0')}:${_lastPingTime!.second.toString().padLeft(2, '0')}'
                      : '',
                  style: const TextStyle(color: Colors.grey, fontSize: 11),
                ),
              ],
            ),
            const SizedBox(height: 10),

            if (_recentLogs.isEmpty)
              Container(
                padding: const EdgeInsets.all(24),
                alignment: Alignment.center,
                child: const Text(
                  'No movements recorded yet. Send a ping or wait for ESP8266 sweep!',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.grey, fontSize: 13),
                ),
              )
            else
              ListView.separated(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: _recentLogs.length,
                separatorBuilder: (ctx, idx) => const SizedBox(height: 8),
                itemBuilder: (ctx, idx) {
                  final log = _recentLogs[idx];
                  final type = log['type'] ?? 'UNKNOWN';
                  final name = log['employeeName'] ?? 'Unknown Device';
                  final time = log['displayTime'] ?? '';
                  final details = log['details'] ?? '';

                  Color typeColor = Colors.blue;
                  IconData icon = Icons.info_outline;

                  if (type == 'ARRIVED' || type == 'RECONNECTED') {
                    typeColor = Colors.green;
                    icon = Icons.login_rounded;
                  } else if (type == 'DEPARTED') {
                    typeColor = Colors.orange;
                    icon = Icons.logout_rounded;
                  } else if (type == 'DEVICE_DISCOVERED') {
                    typeColor = Colors.purple;
                    icon = Icons.wifi_find_rounded;
                  } else if (type == 'DEVICE_REGISTERED' || type == 'EMPLOYEE_REGISTERED') {
                    typeColor = Colors.teal;
                    icon = Icons.app_registration_rounded;
                  }

                  return Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: Colors.grey.shade200),
                    ),
                    child: Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: typeColor.withOpacity(0.1),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Icon(icon, color: typeColor, size: 18),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '$name ($type)',
                                style: const TextStyle(
                                  fontWeight: FontWeight.bold,
                                  fontSize: 13,
                                  color: Color(0xFF1E293B),
                                ),
                              ),
                              if (details.isNotEmpty)
                                Text(
                                  details,
                                  style: TextStyle(
                                    color: Colors.grey.shade600,
                                    fontSize: 11,
                                  ),
                                ),
                            ],
                          ),
                        ),
                        Text(
                          time,
                          style: TextStyle(
                            color: Colors.grey.shade500,
                            fontSize: 11,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ],
                    ),
                  );
                },
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildMetricItem({
    required IconData icon,
    required String label,
    required String value,
  }) {
    return Column(
      children: [
        Icon(icon, color: Colors.white70, size: 20),
        const SizedBox(height: 6),
        Text(
          value,
          style: const TextStyle(
            color: Colors.white,
            fontWeight: FontWeight.bold,
            fontSize: 15,
          ),
        ),
        Text(
          label,
          style: TextStyle(
            color: Colors.white.withOpacity(0.75),
            fontSize: 11,
          ),
        ),
      ],
    );
  }
}
