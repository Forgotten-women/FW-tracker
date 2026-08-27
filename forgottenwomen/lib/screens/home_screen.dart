// Presence dashboard for the employee.
//
// The status shown here is whatever the SERVER derived. The app never computes
// it, which is what stops the phone and the office dashboard disagreeing about
// the same person.

import 'dart:async';

import 'package:flutter/material.dart';

import '../models/attendance.dart';
import '../services/api_client.dart';
import '../services/device_probe.dart';
import '../services/offline_queue.dart';
import '../services/presence_service.dart';
import '../services/token_store.dart';
import '../theme.dart';
import 'settings_screen.dart';

class HomeScreen extends StatefulWidget {
  final VoidCallback onSignedOut;
  const HomeScreen({super.key, required this.onSignedOut});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  final _api = ApiClient();
  final _store = TokenStore();
  final _probe = DeviceProbe();
  final _queue = OfflineQueue();

  Attendance _attendance = Attendance.empty();
  List<Attendance> _history = const [];
  NetworkFacts _network = const NetworkFacts();

  String _employeeName = '';
  bool _loading = true;
  bool _sending = false;
  bool _verified = false;
  bool _serviceRunning = false;
  int _pendingCount = 0;
  String? _error;
  Timer? _foregroundTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _bootstrap();
    // A faster refresh only while the screen is actually visible. The
    // background service is what keeps reporting when it is not - this timer
    // is for the UI, and is no longer mistaken for the reporting mechanism.
    _foregroundTimer = Timer.periodic(const Duration(seconds: 30), (_) => _refresh());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _foregroundTimer?.cancel();
    _api.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _bootstrap() async {
    _employeeName = await _store.readEmployeeName();
    await _refresh();
  }

  Future<void> _refresh() async {
    if (_sending) return;
    setState(() => _sending = true);

    try {
      final facts = await _probe.network();
      final result = await sendHeartbeat(client: _api, probe: _probe, queue: _queue);
      final history = await _api.history(days: 7);
      final pending = await _queue.length;
      final running = await PresenceService.isRunning();

      if (!mounted) return;
      setState(() {
        _network = facts;
        if (result != null) {
          _attendance = result.attendance;
          _verified = result.verified;
        }
        _history = history;
        _pendingCount = pending;
        _serviceRunning = running;
        _error = null;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.needsReEnrollment) {
        await _store.clear();
        await PresenceService.stop();
        if (mounted) widget.onSignedOut();
        return;
      }
      setState(() {
        _error = e.message;
        _loading = false;
        _pendingCount = 0;
      });
      final pending = await _queue.length;
      if (mounted) setState(() => _pendingCount = pending);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator(color: AppColors.teal)),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Office Tracker'),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => SettingsScreen(onSignedOut: widget.onSignedOut),
              ),
            ).then((_) => _refresh()),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _StatusCard(
              name: _employeeName,
              attendance: _attendance,
              verified: _verified,
              network: _network,
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              _Banner(
                icon: Icons.cloud_off,
                color: Colors.orange,
                title: 'Not reaching the server',
                body: _pendingCount > 0
                    ? '$_error\n$_pendingCount reading(s) buffered on this phone and '
                        'will upload automatically. Nothing has been lost.'
                    : _error!,
              ),
            ],
            if (!_verified && _error == null) ...[
              const SizedBox(height: 12),
              _Banner(
                icon: Icons.location_off_outlined,
                color: AppColors.amber,
                title: 'Not counted as office time',
                body: 'You are signed in, but this connection was not recognised '
                    'as an office network, so it is not being recorded as '
                    'attendance. Connect to the office Wi-Fi.',
              ),
            ],
            const SizedBox(height: 12),
            _ServiceCard(
              running: _serviceRunning,
              pending: _pendingCount,
              onToggle: (on) async {
                if (on) {
                  await _probe.ensureBackgroundLocationPermission();
                  await PresenceService.start();
                } else {
                  await PresenceService.stop();
                }
                final running = await PresenceService.isRunning();
                if (mounted) setState(() => _serviceRunning = running);
              },
              onSendNow: _sending ? null : _refresh,
              sending: _sending,
            ),
            const SizedBox(height: 20),
            if (_attendance.sessions.isNotEmpty) ...[
              const _SectionHeader('Today'),
              const SizedBox(height: 8),
              ..._attendance.sessions.map((s) => _SessionRow(session: s)),
              const SizedBox(height: 20),
            ],
            const _SectionHeader('Last 7 days'),
            const SizedBox(height: 8),
            ..._history.map((d) => _DayRow(day: d)),
          ],
        ),
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  final String name;
  final Attendance attendance;
  final bool verified;
  final NetworkFacts network;

  const _StatusCard({
    required this.name,
    required this.attendance,
    required this.verified,
    required this.network,
  });

  @override
  Widget build(BuildContext context) {
    final present = attendance.status.isPresent && verified;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: present
              ? const [AppColors.teal, AppColors.tealDark]
              : const [AppColors.slate, AppColors.slateDark],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(16),
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
                  color: Colors.white.withValues(alpha: 0.2),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  // The server's own label, so the app cannot invent a status.
                  attendance.statusLabel.toUpperCase(),
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 0.5,
                  ),
                ),
              ),
              Flexible(
                child: Text(
                  network.ssid ?? 'No Wi-Fi',
                  textAlign: TextAlign.right,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.85),
                    fontSize: 12,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),
          Text(
            name.isEmpty ? 'Employee' : name,
            style: const TextStyle(
                color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold),
          ),
          if (attendance.role.isNotEmpty)
            Text(
              attendance.role,
              style: TextStyle(color: Colors.white.withValues(alpha: 0.8), fontSize: 13),
            ),
          const SizedBox(height: 20),
          const Divider(color: Colors.white24),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: [
              _Metric(
                icon: Icons.login_rounded,
                label: 'First in',
                value: attendance.firstCheckIn,
              ),
              _Metric(
                icon: Icons.timer_outlined,
                label: 'Logged today',
                value: attendance.timeWorkedFormatted,
              ),
              _Metric(
                icon: Icons.update,
                label: 'Last seen',
                value: attendance.lastActiveTime,
              ),
            ],
          ),
          if (attendance.adjustmentMinutes != 0) ...[
            const SizedBox(height: 12),
            Text(
              'Includes a ${attendance.adjustmentMinutes > 0 ? '+' : ''}'
              '${attendance.adjustmentMinutes} min adjustment by an administrator',
              style: TextStyle(color: Colors.white.withValues(alpha: 0.8), fontSize: 11),
            ),
          ],
        ],
      ),
    );
  }
}

class _Metric extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _Metric({required this.icon, required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Icon(icon, color: Colors.white70, size: 20),
        const SizedBox(height: 6),
        Text(value,
            style: const TextStyle(
                color: Colors.white, fontWeight: FontWeight.bold, fontSize: 15)),
        Text(label,
            style: TextStyle(
                color: Colors.white.withValues(alpha: 0.75), fontSize: 11)),
      ],
    );
  }
}

class _ServiceCard extends StatelessWidget {
  final bool running;
  final int pending;
  final ValueChanged<bool> onToggle;
  final VoidCallback? onSendNow;
  final bool sending;

  const _ServiceCard({
    required this.running,
    required this.pending,
    required this.onToggle,
    required this.onSendNow,
    required this.sending,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
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
              children: [
                Icon(running ? Icons.autorenew : Icons.pause_circle_outline,
                    color: running ? AppColors.teal : Colors.grey),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Background reporting',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                      Text(
                        // Deliberately accurate. The old UI claimed a 15-second
                        // background heartbeat that could not and did not run.
                        running
                            ? 'Reports every ${heartbeatInterval.inMinutes} min while at the office. '
                                'On iOS, updates are driven by entering and leaving the office.'
                            : 'Off. Attendance is only recorded while this screen is open.',
                        style: TextStyle(color: Colors.grey.shade600, fontSize: 11),
                      ),
                    ],
                  ),
                ),
                Switch(
                  value: running,
                  activeThumbColor: AppColors.teal,
                  onChanged: onToggle,
                ),
              ],
            ),
            if (pending > 0) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Icon(Icons.inbox_outlined, size: 16, color: Colors.grey.shade600),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '$pending reading(s) waiting to upload',
                      style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                    ),
                  ),
                ],
              ),
            ],
            const Divider(height: 24),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: onSendNow,
                icon: sending
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.send_rounded, size: 16),
                label: Text(sending ? 'Sending...' : 'Send reading now'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String title;
  const _SectionHeader(this.title);

  @override
  Widget build(BuildContext context) => Text(
        title,
        style: const TextStyle(
            fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.slateDark),
      );
}

class _SessionRow extends StatelessWidget {
  final WorkSession session;
  const _SessionRow({required this.session});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Row(
        children: [
          Icon(
            session.open ? Icons.play_circle_outline : Icons.check_circle_outline,
            size: 18,
            color: session.open ? AppColors.teal : Colors.grey,
          ),
          const SizedBox(width: 12),
          Expanded(child: Text('${session.from}  ->  ${session.to}',
              style: const TextStyle(fontSize: 13))),
          Text(session.duration,
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

class _DayRow extends StatelessWidget {
  final Attendance day;
  const _DayRow({required this.day});

  @override
  Widget build(BuildContext context) {
    final worked = day.totalMinutes > 0;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(day.date, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                Text(
                  worked ? '${day.firstCheckIn} - ${day.lastActiveTime}' : 'No attendance',
                  style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                ),
              ],
            ),
          ),
          if (day.needsReview)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Tooltip(
                message: 'Unusually long session - flagged for review',
                child: Icon(Icons.flag_outlined, size: 16, color: Colors.orange.shade700),
              ),
            ),
          Text(
            day.timeWorkedFormatted,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.bold,
              color: worked ? AppColors.slateDark : Colors.grey,
            ),
          ),
        ],
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String body;

  const _Banner({
    required this.icon,
    required this.color,
    required this.title,
    required this.body,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: TextStyle(
                        fontWeight: FontWeight.bold, fontSize: 13, color: color)),
                const SizedBox(height: 2),
                Text(body,
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade800, height: 1.4)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
