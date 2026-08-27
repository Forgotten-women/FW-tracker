// Presence dashboard for the employee.

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
    try {
      _employeeName = await _store.readEmployeeName();
    } catch (_) {}
    await _refresh();
  }

  Future<void> _refresh() async {
    if (_sending) return;
    if (mounted) setState(() => _sending = true);

    try {
      final facts = await _probe.network();
      PingResult? result;
      try {
        result = await sendHeartbeat(client: _api, probe: _probe, queue: _queue);
      } catch (e) {
        debugPrint('sendHeartbeat error: $e');
      }

      List<Attendance> history = const [];
      try {
        history = await _api.history(days: 7);
      } catch (e) {
        debugPrint('history fetch error: $e');
      }

      int pending = 0;
      try {
        pending = await _queue.length;
      } catch (_) {}

      bool running = false;
      try {
        running = await PresenceService.isRunning();
      } catch (_) {}

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
        try {
          await _store.clear();
          await PresenceService.stop();
        } catch (_) {}
        if (mounted) widget.onSignedOut();
        return;
      }
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } catch (e) {
      debugPrint('HomeScreen _refresh general error: $e');
      if (!mounted) return;
      setState(() {
        _error = 'Could not sync with server: $e';
        _loading = false;
      });
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _toggleService(bool enable) async {
    try {
      if (enable) {
        await PresenceService.start();
      } else {
        await PresenceService.stop();
      }
      final running = await PresenceService.isRunning();
      if (mounted) setState(() => _serviceRunning = running);
    } catch (e) {
      debugPrint('Service toggle error: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_employeeName.isEmpty ? 'Office Tracker' : _employeeName,
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            Text(
              _network.ssid == null ? 'Not on Wi-Fi' : 'Wi-Fi: ${_network.ssid}',
              style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            onPressed: () async {
              await Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => SettingsScreen(
                    onSignedOut: widget.onSignedOut,
                  ),
                ),
              );
              _refresh();
            },
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.teal))
          : RefreshIndicator(
              color: AppColors.teal,
              onRefresh: _refresh,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_error != null) ...[
                    _Banner(
                      icon: Icons.warning_amber_rounded,
                      color: Colors.amber.shade800,
                      title: 'Sync issue',
                      body: _error!,
                    ),
                    const SizedBox(height: 12),
                  ],
                  _StatusCard(
                    attendance: _attendance,
                    verified: _verified,
                    onRefresh: _sending ? null : _refresh,
                  ),
                  const SizedBox(height: 12),
                  _ServiceCard(
                    running: _serviceRunning,
                    pending: _pendingCount,
                    onToggle: _toggleService,
                    onSendNow: _sending ? null : _refresh,
                    sending: _sending,
                  ),
                  if (_attendance.sessions.isNotEmpty) ...[
                    const SizedBox(height: 20),
                    const _SectionHeader("Today's Sessions"),
                    const SizedBox(height: 8),
                    ..._attendance.sessions.map((s) => _SessionRow(session: s)),
                  ],
                  if (_history.isNotEmpty) ...[
                    const SizedBox(height: 20),
                    const _SectionHeader('Past 7 Days'),
                    const SizedBox(height: 8),
                    ..._history.map((d) => _DayRow(day: d)),
                  ],
                ],
              ),
            ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  final Attendance attendance;
  final bool verified;
  final VoidCallback? onRefresh;

  const _StatusCard({
    required this.attendance,
    required this.verified,
    this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    final (color, icon, label) = switch (attendance.status) {
      PresenceStatus.inOffice => (
          AppColors.teal,
          Icons.check_circle_outline,
          verified ? 'IN OFFICE' : 'ON NETWORK'
        ),
      PresenceStatus.gracePeriod => (
          Colors.amber.shade700,
          Icons.access_time_outlined,
          'GRACE PERIOD'
        ),
      PresenceStatus.away => (
          Colors.grey.shade700,
          Icons.logout_outlined,
          'AWAY / BREAK'
        ),
      PresenceStatus.closed => (
          Colors.blueGrey,
          Icons.bedtime_outlined,
          'DAY CLOSED'
        ),
      PresenceStatus.notCheckedIn => (
          Colors.grey.shade500,
          Icons.radio_button_unchecked,
          'NOT CHECKED IN'
        ),
    };

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(16),
        boxShadow: [
          BoxShadow(
            color: color.withValues(alpha: 0.3),
            blurRadius: 16,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: Colors.black26,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(icon, size: 14, color: Colors.white),
                    const SizedBox(width: 6),
                    Text(label,
                        style: const TextStyle(
                            color: Colors.white,
                            fontSize: 11,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 0.5)),
                  ],
                ),
              ),
              if (onRefresh != null)
                IconButton(
                  icon: const Icon(Icons.refresh, color: Colors.white70, size: 20),
                  onPressed: onRefresh,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(),
                ),
            ],
          ),
          const SizedBox(height: 16),
          Text(
            attendance.timeWorkedFormatted,
            style: const TextStyle(
              fontSize: 36,
              fontWeight: FontWeight.bold,
              color: Colors.white,
              letterSpacing: -0.5,
            ),
          ),
          Text(
            attendance.statusLabel,
            style: const TextStyle(color: Colors.white70, fontSize: 13),
          ),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: Colors.black12,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _Metric(
                  icon: Icons.login,
                  label: 'First In',
                  value: attendance.firstCheckIn,
                ),
                _Metric(
                  icon: Icons.timer_outlined,
                  label: 'Last Seen',
                  value: attendance.lastActiveTime,
                ),
                _Metric(
                  icon: Icons.timelapse,
                  label: 'Sessions',
                  value: '${attendance.sessions.length}',
                ),
              ],
            ),
          ),
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
        Icon(icon, color: Colors.white70, size: 18),
        const SizedBox(height: 4),
        Text(value,
            style: const TextStyle(
                color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13)),
        Text(label,
            style: TextStyle(
                color: Colors.white.withValues(alpha: 0.75), fontSize: 10)),
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
                      const Text('Background presence reporting',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                      Text(
                        running
                            ? 'Reports automatically while connected to office Wi-Fi.'
                            : 'Off. Attendance only records while app is open.',
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