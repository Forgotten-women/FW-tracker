// Presence, Break Management, Deficit & Attendance Dispute dashboard for the employee.
// Spec sections 7, 8, 11, 12, 19.1, 19.3 and 23.6.

import 'dart:async';

import 'package:flutter/material.dart';

import '../models/attendance.dart';
import '../services/api_client.dart';
import '../services/device_probe.dart';
import '../services/notification_service.dart';
import '../services/offline_queue.dart';
import '../services/presence_service.dart';
import '../services/token_store.dart';
import '../theme.dart';
import 'profile_screen.dart';
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
  TodayAttendanceDetails? _todayDetails;
  List<Attendance> _history = const [];
  List<CorrectionRequest> _myCorrections = const [];
  NetworkFacts _network = const NetworkFacts();

  String _employeeName = '';
  String _employeeRole = '';
  bool _loading = true;
  bool _sending = false;
  bool _verified = false;
  bool _serviceRunning = false;
  int _pendingCount = 0;
  String? _error;
  Timer? _foregroundTimer;
  Timer? _breakTimer;
  int _breakElapsedSeconds = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _bootstrap();
    _foregroundTimer = Timer.periodic(const Duration(seconds: 4), (_) => _refresh());
    _breakTimer = Timer.periodic(const Duration(seconds: 1), (_) => _tickBreak());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _foregroundTimer?.cancel();
    _breakTimer?.cancel();
    _api.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _refresh();
    }
  }

  Future<void> _bootstrap() async {
    final name = await _store.readEmployeeName();
    final running = await PresenceService.isRunning();
    if (mounted) {
      setState(() {
        _employeeName = name;
        _serviceRunning = running;
      });
    }
    await _refresh();
  }

  void _tickBreak() {
    if (_todayDetails?.breakInfo.onBreak == true) {
      final startedMs = _todayDetails!.breakInfo.startedAtMs;
      if (startedMs != null) {
        final nowMs = DateTime.now().millisecondsSinceEpoch;
        final elapsed = ((nowMs - startedMs) / 1000).floor();
        if (mounted && elapsed >= 0 && elapsed != _breakElapsedSeconds) {
          setState(() => _breakElapsedSeconds = elapsed);
        }
      }
    } else {
      if (_breakElapsedSeconds != 0 && mounted) {
        setState(() => _breakElapsedSeconds = 0);
      }
    }
  }

  Future<void> _refresh() async {
    if (_sending) return;
    setState(() {
      _sending = true;
      _error = null;
    });

    try {
      final net = await _probe.network();
      final pending = await _queue.readAll();
      final currentObs = QueuedObservation(
        observedAt: DateTime.now().millisecondsSinceEpoch,
        ssid: net.ssid,
        bssid: net.bssid,
      );

      final ping = await _api.ping([...pending, currentObs]);

      if (pending.isNotEmpty) {
        await _queue.removeDelivered(pending.length);
      }

      final hist = await _api.history(days: 7);
      final todayFull = await _api.fetchTodayDetails();
      final corrections = await _api.fetchMyCorrections();

      if (mounted) {
        setState(() {
          _attendance = ping.attendance;
          _verified = ping.verified;
          _network = net;
          _history = hist;
          _todayDetails = todayFull;
          _myCorrections = corrections;
          _pendingCount = 0;
          _loading = false;
          _sending = false;
          if (ping.attendance.employeeName.isNotEmpty) {
            _employeeName = ping.attendance.employeeName;
          }
          if (ping.attendance.role.isNotEmpty) {
            _employeeRole = ping.attendance.role;
          }
        });
      }

      // Check for incoming HR approvals and trigger status bar notifications
      try {
        await NotificationService().checkAndDispatchUnseenNotifications(store: _store);
      } catch (_) {}
    } on ApiException catch (e) {
      if (e.needsReEnrollment) {
        await _store.clearToken();
        if (mounted) widget.onSignedOut();
        return;
      }
      try {
        final cachedAttendance = await _api.today();
        final cachedDetails = await _api.fetchTodayDetails();
        final cachedCorrections = await _api.fetchMyCorrections();
        final pending = await _queue.readAll();
        if (mounted) {
          setState(() {
            _attendance = cachedAttendance;
            _todayDetails = cachedDetails;
            _myCorrections = cachedCorrections;
            _pendingCount = pending.length;
            _error = e.message;
            _loading = false;
            _sending = false;
          });
        }
      } catch (_) {
        if (mounted) {
          setState(() {
            _error = e.message;
            _loading = false;
            _sending = false;
          });
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = 'Could not update: $e';
          _loading = false;
          _sending = false;
        });
      }
    }
  }

  Future<void> _startBreak() async {
    try {
      final res = await _api.startBreak();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Break started. Due back at ${res.dueBackAt} (${res.permittedMinutes} mins)'),
            backgroundColor: AppColors.teal,
          ),
        );
      }
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: AppColors.danger),
        );
      }
    }
  }

  Future<void> _endBreak() async {
    try {
      final res = await _api.endBreak();
      if (mounted) {
        showDialog(
          context: context,
          builder: (ctx) => AlertDialog(
            backgroundColor: AppColors.surfaceDark,
            title: const Text('Break Concluded', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
            content: Text(
              res.message,
              style: const TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4),
            ),
            actions: [
              FilledButton(
                onPressed: () => Navigator.pop(ctx),
                style: FilledButton.styleFrom(
                  backgroundColor: res.excessMinutes > 0 ? AppColors.amber : AppColors.teal,
                ),
                child: const Text('Acknowledge'),
              ),
            ],
          ),
        );
      }
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: AppColors.danger),
        );
      }
    }
  }

  Future<void> _clockOut() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        title: const Text('Manual Clock Out', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        content: const Text(
          'This will conclude your working session for today. Use this if you are leaving the premises.',
          style: TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel', style: TextStyle(color: AppColors.textMuted)),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            child: const Text('Clock Out'),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    try {
      await _api.clockOut();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Clocked out successfully for today.'),
            backgroundColor: AppColors.teal,
          ),
        );
      }
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: AppColors.danger),
        );
      }
    }
  }

  void _openCorrectionForm([String? initialDateKey]) async {
    final now = DateTime.now();
    String selectedDateKey = initialDateKey ??
        '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
    final reasonController = TextEditingController();
    final minutesController = TextEditingController();
    String reasonCategory = 'Sensor Glitch / Failed Check-in';

    final submitted = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surfaceDark,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (context, setModalState) {
            return Padding(
              padding: EdgeInsets.fromLTRB(
                20,
                20,
                20,
                MediaQuery.of(context).viewInsets.bottom + 20,
              ),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text(
                          'File Attendance Dispute',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                        IconButton(
                          icon: const Icon(Icons.close, color: AppColors.textMuted),
                          onPressed: () => Navigator.pop(ctx, false),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      'Dispute an inaccurate clock-in, sensor glitch, or authorised absence. Preserved immutably for HR audit.',
                      style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                    ),
                    const Divider(height: 24, color: AppColors.border),

                    const Text('Affected Date', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: Colors.white70)),
                    const SizedBox(height: 6),
                    InkWell(
                      onTap: () async {
                        final picked = await showDatePicker(
                          context: context,
                          initialDate: DateTime.tryParse(selectedDateKey) ?? now,
                          firstDate: now.subtract(const Duration(days: 60)),
                          lastDate: now,
                        );
                        if (picked != null) {
                          setModalState(() {
                            selectedDateKey =
                                '${picked.year}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}';
                          });
                        }
                      },
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                        decoration: BoxDecoration(
                          color: AppColors.bgDark,
                          border: Border.all(color: AppColors.border),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(selectedDateKey, style: const TextStyle(fontSize: 13, color: Colors.white)),
                            const Icon(Icons.calendar_today, size: 16, color: AppColors.primaryLight),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),

                    const Text('Dispute Reason Category', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: Colors.white70)),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                      value: reasonCategory,
                      dropdownColor: AppColors.surfaceDark,
                      decoration: const InputDecoration(
                        contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      ),
                      items: const [
                        DropdownMenuItem(value: 'Sensor Glitch / Failed Check-in', child: Text('Sensor Glitch / Failed Check-in', style: TextStyle(fontSize: 13, color: Colors.white))),
                        DropdownMenuItem(value: 'Wi-Fi / Network Disconnection', child: Text('Wi-Fi / Network Disconnection', style: TextStyle(fontSize: 13, color: Colors.white))),
                        DropdownMenuItem(value: 'Off-site Business Meeting', child: Text('Off-site Business Meeting', style: TextStyle(fontSize: 13, color: Colors.white))),
                        DropdownMenuItem(value: 'Forgotten Phone / Device', child: Text('Forgotten Phone / Device', style: TextStyle(fontSize: 13, color: Colors.white))),
                        DropdownMenuItem(value: 'Approved Overtime / Late Shift', child: Text('Approved Overtime / Late Shift', style: TextStyle(fontSize: 13, color: Colors.white))),
                        DropdownMenuItem(value: 'Other Reason', child: Text('Other Reason', style: TextStyle(fontSize: 13, color: Colors.white))),
                      ],
                      onChanged: (val) {
                        if (val != null) {
                          setModalState(() => reasonCategory = val);
                        }
                      },
                    ),
                    const SizedBox(height: 14),

                    const Text('Proposed Adjustment Minutes (optional)', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: Colors.white70)),
                    const SizedBox(height: 6),
                    TextField(
                      controller: minutesController,
                      keyboardType: TextInputType.number,
                      style: const TextStyle(color: Colors.white, fontSize: 13),
                      decoration: const InputDecoration(
                        hintText: 'e.g. 30',
                        hintStyle: TextStyle(color: Colors.white30),
                        suffixText: 'mins',
                        suffixStyle: TextStyle(color: AppColors.textMuted),
                      ),
                    ),
                    const SizedBox(height: 14),

                    const Text('Detailed Explanation (Required)', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: Colors.white70)),
                    const SizedBox(height: 6),
                    TextField(
                      controller: reasonController,
                      maxLines: 3,
                      style: const TextStyle(color: Colors.white, fontSize: 13),
                      decoration: const InputDecoration(
                        hintText: 'Explain what occurred and why attendance should be amended...',
                        hintStyle: TextStyle(color: Colors.white30),
                      ),
                    ),
                    const SizedBox(height: 20),

                    SizedBox(
                      width: double.infinity,
                      height: 46,
                      child: FilledButton(
                        onPressed: () {
                          if (reasonController.text.trim().isEmpty) {
                            ScaffoldMessenger.of(ctx).showSnackBar(
                              const SnackBar(
                                content: Text('Please enter an explanation.'),
                                backgroundColor: AppColors.danger,
                              ),
                            );
                            return;
                          }
                          Navigator.pop(ctx, true);
                        },
                        style: FilledButton.styleFrom(backgroundColor: AppColors.primary),
                        child: const Text('Submit Dispute to HR', style: TextStyle(fontWeight: FontWeight.bold)),
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );

    if (submitted != true) return;

    final fullReason = '[$reasonCategory] ${reasonController.text.trim()}';
    final adjMinutes = int.tryParse(minutesController.text.trim());

    try {
      final msg = await _api.submitCorrection(
        dateKey: selectedDateKey,
        reason: fullReason,
        requestedChange: adjMinutes != null ? {'adjustmentMinutes': adjMinutes} : null,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(msg), backgroundColor: AppColors.teal),
        );
      }
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: AppColors.danger),
        );
      }
    }
  }

  void _showMyDisputesSheet() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surfaceDark,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return DraggableScrollableSheet(
          initialChildSize: 0.65,
          minChildSize: 0.4,
          maxChildSize: 0.92,
          expand: false,
          builder: (_, scrollController) {
            return Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'My Attendance Disputes',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                          color: Colors.white,
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.close, color: AppColors.textMuted),
                        onPressed: () => Navigator.pop(ctx),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'Track review status and feedback notes from HR regarding your dispute submissions.',
                    style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                  ),
                  const Divider(height: 20, color: AppColors.border),
                  Expanded(
                    child: _myCorrections.isEmpty
                        ? const Center(
                            child: Text(
                              'No disputes on record.',
                              style: TextStyle(color: AppColors.textMuted, fontSize: 13),
                            ),
                          )
                        : ListView.separated(
                            controller: scrollController,
                            itemCount: _myCorrections.length,
                            separatorBuilder: (_, __) => const SizedBox(height: 10),
                            itemBuilder: (_, i) {
                              final c = _myCorrections[i];
                              final Color statusTone;
                              if (c.isApproved) {
                                statusTone = AppColors.teal;
                              } else if (c.isAmended) {
                                statusTone = AppColors.primaryLight;
                              } else if (c.isRejected) {
                                statusTone = AppColors.danger;
                              } else {
                                statusTone = AppColors.amber;
                              }

                              return Container(
                                padding: const EdgeInsets.all(14),
                                decoration: BoxDecoration(
                                  border: Border.all(color: statusTone.withOpacity(0.3)),
                                  borderRadius: BorderRadius.circular(12),
                                  color: statusTone.withOpacity(0.06),
                                ),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                      children: [
                                        Text(
                                          c.date,
                                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Colors.white),
                                        ),
                                        Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                          decoration: BoxDecoration(
                                            color: statusTone.withOpacity(0.2),
                                            borderRadius: BorderRadius.circular(6),
                                            border: Border.all(color: statusTone.withOpacity(0.5)),
                                          ),
                                          child: Text(
                                            c.status,
                                            style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: statusTone),
                                          ),
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 8),
                                    Text(
                                      c.reason,
                                      style: const TextStyle(fontSize: 12, color: Colors.white70),
                                    ),
                                    if (c.reviewNotes != null && c.reviewNotes!.isNotEmpty) ...[
                                      const SizedBox(height: 8),
                                      Container(
                                        padding: const EdgeInsets.all(10),
                                        decoration: BoxDecoration(
                                          color: AppColors.bgDark,
                                          borderRadius: BorderRadius.circular(8),
                                          border: Border.all(color: AppColors.border),
                                        ),
                                        child: Row(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            const Icon(Icons.feedback_outlined, size: 14, color: AppColors.primaryLight),
                                            const SizedBox(width: 8),
                                            Expanded(
                                              child: Text(
                                                'HR Decision Note: ${c.reviewNotes}',
                                                style: const TextStyle(fontSize: 11, fontStyle: FontStyle.italic, color: Colors.white70),
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                              );
                            },
                          ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  void _onDayTapped(Attendance day) {
    final existingDispute = _myCorrections.where((c) => c.date == day.date).firstOrNull;

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        title: Text('Timesheet: ${day.date}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16)),
        content: SizedBox(
          width: double.maxFinite,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('First In: ${day.firstCheckIn}', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                  Text('Last Seen: ${day.lastActiveTime}', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                ],
              ),
              const SizedBox(height: 8),
              Text('Total Worked: ${day.timeWorkedFormatted}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Colors.white)),
              const Divider(height: 20, color: AppColors.border),
              if (existingDispute != null) ...[
                const Text('Dispute History', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Colors.white)),
                const SizedBox(height: 4),
                Text('Status: ${existingDispute.status}', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: AppColors.amber)),
                const SizedBox(height: 2),
                Text('Reason: ${existingDispute.reason}', style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
              ] else ...[
                const Text(
                  'Was your check-in or hours recorded inaccurately? You can submit a formal dispute to HR for adjustment.',
                  style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                ),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Close', style: TextStyle(color: AppColors.textMuted)),
          ),
          if (existingDispute == null)
            FilledButton(
              onPressed: () {
                Navigator.pop(ctx);
                _openCorrectionForm(day.date);
              },
              child: const Text('Dispute Record'),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final breakInfo = _todayDetails?.breakInfo ?? ActiveBreakInfo.empty();
    final deficit = _todayDetails?.deficitBalance ?? DeficitBalance.empty();
    final isPresent = _attendance.status == PresenceStatus.inOffice ||
        _attendance.status == PresenceStatus.gracePeriod;

    final disputesByDate = <String, CorrectionRequest>{};
    for (final c in _myCorrections) {
      disputesByDate[c.date] = c;
    }

    final int pendingDisputesCount = _myCorrections.where((c) => c.status == 'PENDING_HR' || c.status == 'PENDING').length;

    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        backgroundColor: AppColors.surfaceDark,
        elevation: 0,
        titleSpacing: 12,
        title: GestureDetector(
          onTap: () {
            Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => const ProfileScreen(),
              ),
            );
          },
          child: Row(
            children: [
              CircleAvatar(
                radius: 17,
                backgroundColor: AppColors.primary.withValues(alpha: 0.2),
                child: Text(
                  _employeeName.isNotEmpty ? _employeeName.substring(0, 1).toUpperCase() : 'U',
                  style: const TextStyle(color: AppColors.primaryLight, fontWeight: FontWeight.bold, fontSize: 13),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      _employeeName.isEmpty ? 'Employee Portal' : _employeeName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Colors.white),
                    ),
                    Text(
                      _employeeRole.isNotEmpty ? _employeeRole : 'Staff Attendance',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        actions: [
          Stack(
            children: [
              IconButton(
                icon: const Icon(Icons.rate_review_outlined, color: Colors.white70, size: 20),
                tooltip: 'My Disputes',
                onPressed: _showMyDisputesSheet,
              ),
              if (pendingDisputesCount > 0)
                Positioned(
                  right: 8,
                  top: 8,
                  child: Container(
                    padding: const EdgeInsets.all(4),
                    decoration: const BoxDecoration(color: AppColors.amber, shape: BoxShape.circle),
                    child: Text(
                      '$pendingDisputesCount',
                      style: const TextStyle(color: Colors.black, fontSize: 9, fontWeight: FontWeight.bold),
                    ),
                  ),
                ),
            ],
          ),
          IconButton(
            icon: const Icon(Icons.settings_outlined, color: Colors.white70, size: 20),
            tooltip: 'Settings',
            onPressed: () async {
              await Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => SettingsScreen(onSignedOut: widget.onSignedOut),
                ),
              );
              _refresh();
            },
          ),
          IconButton(
            icon: _sending
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.refresh, color: Colors.white70, size: 20),
            tooltip: 'Refresh',
            onPressed: _sending ? null : _refresh,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.primary))
          : RefreshIndicator(
              color: AppColors.primary,
              onRefresh: _refresh,
              child: Align(
                alignment: Alignment.topCenter,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 720),
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 30),
                    children: [
                  if (_error != null) ...[
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: AppColors.amber.withOpacity(0.15),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppColors.amber.withOpacity(0.4)),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.warning_amber_rounded, color: AppColors.amber, size: 20),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              _error!,
                              style: const TextStyle(color: AppColors.amber, fontSize: 12),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 14),
                  ],

                  // 1. Live Shift Hero Card
                  _buildShiftHeroCard(breakInfo, deficit, isPresent),
                  const SizedBox(height: 16),

                  // 2. Action Hub (Break In/Out, Clock Out, Dispute)
                  _buildActionHub(breakInfo, isPresent),
                  const SizedBox(height: 20),

                  // 3. Today's Punch Sessions
                  if (_attendance.sessions.isNotEmpty) ...[
                    const Text(
                      'TODAY\'S WORKING SESSIONS',
                      style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.1, color: AppColors.textMuted),
                    ),
                    const SizedBox(height: 8),
                    ..._attendance.sessions.map((s) => _buildSessionTile(s)),
                    const SizedBox(height: 20),
                  ],

                  // 4. Past 7 Days History
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Expanded(
                        child: Text(
                          'ATTENDANCE LOG (PAST 7 DAYS)',
                          style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.1, color: AppColors.textMuted),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      TextButton.icon(
                        onPressed: () => _openCorrectionForm(),
                        icon: const Icon(Icons.edit_note, size: 16, color: AppColors.primaryLight),
                        label: const Text('Dispute a Day', style: TextStyle(fontSize: 12, color: AppColors.primaryLight, fontWeight: FontWeight.bold)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  if (_history.isEmpty)
                    Container(
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        color: AppColors.surfaceDark,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppColors.border),
                      ),
                      child: const Center(
                        child: Text('No attendance history recorded yet.', style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
                      ),
                    )
                  else
                    ..._history.map((d) => _buildHistoryTile(d, disputesByDate[d.date])),
                ],
              ),
            ),
          ),
        ),
    );
  }

  Widget _buildShiftHeroCard(ActiveBreakInfo breakInfo, DeficitBalance deficit, bool isPresent) {
    Color statusTone;
    String statusTitle;
    IconData statusIcon;

    if (breakInfo.onBreak) {
      statusTone = AppColors.amber;
      statusTitle = 'ON BREAK';
      statusIcon = Icons.coffee;
    } else if (isPresent) {
      statusTone = AppColors.teal;
      statusTitle = _verified ? 'IN OFFICE' : 'ON NETWORK';
      statusIcon = Icons.verified;
    } else if (_attendance.status == PresenceStatus.gracePeriod) {
      statusTone = AppColors.amber;
      statusTitle = 'GRACE PERIOD';
      statusIcon = Icons.timelapse;
    } else if (_attendance.status == PresenceStatus.away) {
      statusTone = const Color(0xFF64748B);
      statusTitle = 'AWAY / OFF-SITE';
      statusIcon = Icons.logout;
    } else {
      statusTone = const Color(0xFF64748B);
      statusTitle = 'NOT CHECKED IN';
      statusIcon = Icons.radio_button_unchecked;
    }

    final double progressPercent = (_attendance.totalMinutes / 480.0).clamp(0.0, 1.0);

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: statusTone.withOpacity(0.35)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.3),
            blurRadius: 16,
            offset: const Offset(0, 6),
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
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                  color: statusTone.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: statusTone.withOpacity(0.5)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(statusIcon, size: 14, color: statusTone),
                    const SizedBox(width: 6),
                    Text(
                      statusTitle,
                      style: TextStyle(
                        color: statusTone,
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                        letterSpacing: 0.5,
                      ),
                    ),
                  ],
                ),
              ),
              Text(
                'Shift Target: 8h 00m',
                style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
              ),
            ],
          ),
          const SizedBox(height: 16),

          // Big Hours Display
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('TIME WORKED TODAY', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppColors.textMuted)),
                  const SizedBox(height: 2),
                  Text(
                    _attendance.timeWorkedFormatted,
                    style: const TextStyle(fontSize: 28, fontWeight: FontWeight.bold, color: Colors.white, letterSpacing: -0.5),
                  ),
                ],
              ),
              Text(
                '${(progressPercent * 100).toInt()}% Done',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: statusTone),
              ),
            ],
          ),
          const SizedBox(height: 10),

          // Progress Bar
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              value: progressPercent,
              minHeight: 8,
              backgroundColor: AppColors.bgDark,
              valueColor: AlwaysStoppedAnimation<Color>(statusTone),
            ),
          ),
          const SizedBox(height: 16),

          // Sub-metrics Row
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.bgDark,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.border),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _buildMetricCol('First Check-In', _attendance.firstCheckIn),
                Container(width: 1, height: 26, color: AppColors.border),
                _buildMetricCol('Break Taken', '${breakInfo.breakMinutesTaken} mins'),
                Container(width: 1, height: 26, color: AppColors.border),
                _buildMetricCol('Deficit', '${deficit.minutes} mins'),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMetricCol(String label, String value) {
    return Column(
      children: [
        Text(value, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13)),
        const SizedBox(height: 2),
        Text(label, style: const TextStyle(color: AppColors.textMuted, fontSize: 10)),
      ],
    );
  }

  Widget _buildActionHub(ActiveBreakInfo breakInfo, bool isPresent) {
    final int minutes = _breakElapsedSeconds ~/ 60;
    final int seconds = _breakElapsedSeconds % 60;
    final elapsedText = '${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}';

    return Row(
      children: [
        // Break Action Button
        Expanded(
          flex: 3,
          child: breakInfo.onBreak
              ? ElevatedButton.icon(
                  onPressed: _endBreak,
                  icon: const Icon(Icons.free_breakfast, color: Colors.black),
                  label: Text('End Break ($elapsedText)', style: const TextStyle(color: Colors.black, fontWeight: FontWeight.bold, fontSize: 13)),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.amber,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                )
              : OutlinedButton.icon(
                  onPressed: isPresent ? _startBreak : null,
                  icon: const Icon(Icons.coffee_outlined, size: 18),
                  label: const Text('Take Break', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppColors.teal,
                    side: BorderSide(color: isPresent ? AppColors.teal.withOpacity(0.5) : AppColors.border),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),
        ),
        const SizedBox(width: 10),

        // Clock Out Button
        if (isPresent)
          Expanded(
            flex: 2,
            child: OutlinedButton.icon(
              onPressed: _clockOut,
              icon: const Icon(Icons.logout, size: 16),
              label: const Text('Clock Out', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.danger,
                side: BorderSide(color: AppColors.danger.withOpacity(0.5)),
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildSessionTile(WorkSession s) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: s.open ? AppColors.teal : AppColors.textMuted,
                ),
              ),
              const SizedBox(width: 10),
              Text(
                '${s.from} → ${s.to}',
                style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w500),
              ),
            ],
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: AppColors.bgDark,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: AppColors.border),
            ),
            child: Text(
              s.duration,
              style: const TextStyle(color: AppColors.primaryLight, fontSize: 11, fontWeight: FontWeight.bold),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHistoryTile(Attendance d, CorrectionRequest? correction) {
    final parsedDate = DateTime.tryParse(d.date);
    final isWeekend = parsedDate != null &&
        (parsedDate.weekday == DateTime.saturday || parsedDate.weekday == DateTime.sunday);
    final isToday = d.date == _attendance.date;

    String statusText;
    Color statusColor;
    String timingSubtext;

    if (isWeekend) {
      if (d.totalMinutes == 0) {
        statusText = 'Weekend / Off Day';
        statusColor = AppColors.textMuted;
        timingSubtext = 'Non-working day';
      } else {
        statusText = 'Overtime (+${d.timeWorkedFormatted})';
        statusColor = AppColors.teal;
        timingSubtext = 'In: ${d.firstCheckIn} • Last: ${d.lastActiveTime}';
      }
    } else if (isToday) {
      timingSubtext = 'In: ${d.firstCheckIn} • Last: ${d.lastActiveTime}';
      if (d.totalMinutes >= 480) {
        statusText = 'Completed';
        statusColor = AppColors.teal;
      } else {
        final rem = 480 - d.totalMinutes;
        final h = rem ~/ 60;
        final m = rem % 60;
        statusText = h > 0 ? '${h}h ${m}m left' : '${m}m left';
        statusColor = AppColors.amber;
      }
    } else {
      timingSubtext = 'In: ${d.firstCheckIn} • Last: ${d.lastActiveTime}';
      if (d.totalMinutes >= 480) {
        statusText = 'Completed';
        statusColor = AppColors.teal;
      } else if (d.totalMinutes == 0) {
        statusText = 'Not checked in';
        statusColor = AppColors.textMuted;
      } else {
        statusText = '${480 - d.totalMinutes}m deficit';
        statusColor = AppColors.amber;
      }
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => _onDayTapped(d),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: isWeekend
                      ? AppColors.slateDark
                      : AppColors.primary.withOpacity(0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(
                  isWeekend ? Icons.weekend_outlined : Icons.calendar_month,
                  color: isWeekend ? AppColors.textMuted : AppColors.primaryLight,
                  size: 18,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Wrap(
                      crossAxisAlignment: WrapCrossAlignment.center,
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        Text(
                          d.date,
                          style: TextStyle(
                            color: isWeekend ? AppColors.textMuted : Colors.white,
                            fontWeight: FontWeight.bold,
                            fontSize: 13,
                          ),
                        ),
                        if (isWeekend && d.totalMinutes == 0)
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: AppColors.slateDark,
                              borderRadius: BorderRadius.circular(4),
                              border: Border.all(color: AppColors.border),
                            ),
                            child: const Text(
                              'WEEKEND',
                              style: TextStyle(color: AppColors.textMuted, fontSize: 9, fontWeight: FontWeight.bold),
                            ),
                          ),
                        if (correction != null)
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: AppColors.amber.withOpacity(0.2),
                              borderRadius: BorderRadius.circular(4),
                              border: Border.all(color: AppColors.amber.withOpacity(0.4)),
                            ),
                            child: Text(
                              'DISPUTED (${correction.status})',
                              style: const TextStyle(color: AppColors.amber, fontSize: 9, fontWeight: FontWeight.bold),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      timingSubtext,
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    isWeekend && d.totalMinutes == 0 ? '—' : d.timeWorkedFormatted,
                    style: TextStyle(
                      color: isWeekend && d.totalMinutes == 0 ? AppColors.textMuted : Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    statusText,
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                      color: statusColor,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}