// Presence, Break Management, Deficit & Attendance Dispute dashboard for the employee.
// Spec sections 7, 8, 11, 12, 19.1, 19.3 and 23.6.

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
  TodayAttendanceDetails? _todayDetails;
  List<Attendance> _history = const [];
  List<CorrectionRequest> _myCorrections = const [];
  NetworkFacts _network = const NetworkFacts();

  String _employeeName = '';
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
    _foregroundTimer =
        Timer.periodic(const Duration(seconds: 30), (_) => _refresh());
    _breakTimer =
        Timer.periodic(const Duration(seconds: 1), (_) => _tickBreak());
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
    if (state == AppLifecycleState.resumed) _refresh();
  }

  void _tickBreak() {
    if (_todayDetails?.breakInfo.onBreak == true &&
        _todayDetails?.breakInfo.startedAtMs != null) {
      final now = DateTime.now().millisecondsSinceEpoch;
      final started = _todayDetails!.breakInfo.startedAtMs!;
      if (mounted) {
        setState(() {
          _breakElapsedSeconds = MathMax(0, (now - started) ~/ 1000);
        });
      }
    }
  }

  static int MathMax(int a, int b) => a > b ? a : b;

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
        result =
            await sendHeartbeat(client: _api, probe: _probe, queue: _queue);
      } catch (e) {
        debugPrint('sendHeartbeat error: $e');
      }

      TodayAttendanceDetails? todayDetails;
      try {
        todayDetails = await _api.fetchTodayDetails();
      } catch (e) {
        debugPrint('fetchTodayDetails error: $e');
      }

      List<Attendance> history = const [];
      try {
        history = await _api.history(days: 7);
      } catch (e) {
        debugPrint('history fetch error: $e');
      }

      List<CorrectionRequest> corrections = const [];
      try {
        corrections = await _api.fetchMyCorrections();
      } catch (e) {
        debugPrint('fetchMyCorrections error: $e');
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
        if (todayDetails != null) {
          _todayDetails = todayDetails;
          if (_employeeName.isEmpty && todayDetails.employeeName.isNotEmpty) {
            _employeeName = todayDetails.employeeName;
          }
          if (todayDetails.breakInfo.onBreak &&
              todayDetails.breakInfo.startedAtMs != null) {
            final now = DateTime.now().millisecondsSinceEpoch;
            _breakElapsedSeconds =
                MathMax(0, (now - todayDetails.breakInfo.startedAtMs!) ~/ 1000);
          }
        }
        _history = history;
        _myCorrections = corrections;
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

  Future<void> _startBreak() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Start Break'),
        content: const Text(
          'You are permitted 30 minutes of break per working day. '
          'Taking more than 30 minutes will add excess time to your attendance deficit ledger.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: AppColors.teal),
            child: const Text('Start 30m Break'),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    try {
      final res = await _api.startBreak();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
                'Break started. Permitted: ${res.permittedMinutes}m (due back by ${res.dueBackAt})'),
            backgroundColor: AppColors.teal,
          ),
        );
      }
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: Colors.red),
        );
      }
    }
  }

  Future<void> _endBreak() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('End Break'),
        content: const Text('Are you ready to resume work?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Keep on Break'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: AppColors.teal),
            child: const Text('End Break Now'),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    try {
      final res = await _api.endBreak();
      if (mounted) {
        await showDialog(
          context: context,
          builder: (ctx) => AlertDialog(
            title: Text(res.excessMinutes > 0
                ? 'Break Overrun'
                : 'Break Complete'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(res.message),
                const SizedBox(height: 8),
                Text(
                  'Duration: ${res.actualMinutes} mins (Permitted: ${res.permittedMinutes} mins)',
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                if (res.excessMinutes > 0)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      '+${res.excessMinutes} minutes added to your attendance deficit.',
                      style: TextStyle(
                          color: Colors.red.shade700,
                          fontWeight: FontWeight.w600),
                    ),
                  ),
              ],
            ),
            actions: [
              FilledButton(
                onPressed: () => Navigator.pop(ctx),
                style: FilledButton.styleFrom(
                  backgroundColor: res.excessMinutes > 0
                      ? Colors.orange.shade800
                      : AppColors.teal,
                ),
                child: const Text('OK'),
              ),
            ],
          ),
        );
      }
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: Colors.red),
        );
      }
    }
  }

  Future<void> _clockOut() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Manual Clock Out'),
        content: const Text(
          'This will end your working sessions for today. '
          'Use this if you are leaving the office.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade700),
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
            content: Text('Clocked out successfully.'),
            backgroundColor: AppColors.slateDark,
          ),
        );
      }
      await _refresh();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: Colors.red),
        );
      }
    }
  }

  Future<void> _openCorrectionForm([String? initialDateKey]) async {
    final now = DateTime.now();
    String selectedDateKey = initialDateKey ??
        '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
    String reasonCategory = 'Wi-Fi / device failure';
    final reasonController = TextEditingController();
    final minutesController = TextEditingController(text: '30');

    final submitted = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (context, setModalState) {
            return Padding(
              padding: EdgeInsets.only(
                left: 20,
                right: 20,
                top: 20,
                bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
              ),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Flexible(
                          child: Text(
                            'Attendance Dispute / Correction',
                            style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.bold,
                              color: AppColors.slateDark,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        IconButton(
                          icon: const Icon(Icons.close),
                          onPressed: () => Navigator.pop(ctx, false),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Dispute an inaccurate clock-in, sensor glitch, or authorised absence. '
                      'Your original record stays preserved for audit integrity (Spec 11).',
                      style:
                          TextStyle(fontSize: 12, color: Colors.grey.shade600),
                    ),
                    const Divider(height: 24),

                    // Date selector
                    const Text('Affected Date',
                        style: TextStyle(
                            fontWeight: FontWeight.bold, fontSize: 13)),
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
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 12),
                        decoration: BoxDecoration(
                          border: Border.all(color: Colors.grey.shade300),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(selectedDateKey,
                                style: const TextStyle(fontSize: 14)),
                            const Icon(Icons.calendar_today,
                                size: 16, color: AppColors.teal),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),

                    // Reason category
                    const Text('Reason Category',
                        style: TextStyle(
                            fontWeight: FontWeight.bold, fontSize: 13)),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                      initialValue: reasonCategory,
                      decoration: InputDecoration(
                        border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(8)),
                        contentPadding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 10),
                      ),
                      items: const [
                        DropdownMenuItem(
                            value: 'Wi-Fi / device failure',
                            child: Text('Wi-Fi / Device failure')),
                        DropdownMenuItem(
                            value: 'Phone battery died',
                            child: Text('Phone battery died')),
                        DropdownMenuItem(
                            value: 'Manager authorised late arrival',
                            child: Text('Manager authorised late arrival')),
                        DropdownMenuItem(
                            value: 'Work-related external visit',
                            child: Text('Work-related external visit')),
                        DropdownMenuItem(
                            value: 'Office errands',
                            child: Text('Office errands')),
                        DropdownMenuItem(
                            value: 'Approved remote work',
                            child: Text('Approved remote work')),
                        DropdownMenuItem(
                            value: 'Employee forgot to clock',
                            child: Text('Forgot to clock in/out')),
                        DropdownMenuItem(
                            value: 'System clocking error',
                            child: Text('System clocking error')),
                        DropdownMenuItem(value: 'Other', child: Text('Other')),
                      ],
                      onChanged: (val) {
                        if (val != null) {
                          setModalState(() => reasonCategory = val);
                        }
                      },
                    ),
                    const SizedBox(height: 14),

                    // Proposed adjustment minutes
                    const Text('Proposed Adjustment Minutes (optional)',
                        style: TextStyle(
                            fontWeight: FontWeight.bold, fontSize: 13)),
                    const SizedBox(height: 6),
                    TextField(
                      controller: minutesController,
                      keyboardType: TextInputType.number,
                      decoration: InputDecoration(
                        hintText: 'e.g. 30',
                        suffixText: 'mins',
                        border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(8)),
                        contentPadding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 10),
                      ),
                    ),
                    const SizedBox(height: 14),

                    // Explanation textarea
                    const Text('Detailed Explanation (Required)',
                        style: TextStyle(
                            fontWeight: FontWeight.bold, fontSize: 13)),
                    const SizedBox(height: 6),
                    TextField(
                      controller: reasonController,
                      maxLines: 3,
                      decoration: InputDecoration(
                        hintText:
                            'Explain what occurred and why attendance should be adjusted...',
                        border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(8)),
                        contentPadding: const EdgeInsets.all(12),
                      ),
                    ),
                    const SizedBox(height: 20),

                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        onPressed: () {
                          if (reasonController.text.trim().isEmpty) {
                            ScaffoldMessenger.of(ctx).showSnackBar(
                              const SnackBar(
                                content: Text('Please enter an explanation.'),
                                backgroundColor: Colors.red,
                              ),
                            );
                            return;
                          }
                          Navigator.pop(ctx, true);
                        },
                        style: FilledButton.styleFrom(
                          backgroundColor: AppColors.teal,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                        ),
                        child: const Text('Submit Dispute to HR'),
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

    final fullReason =
        '[$reasonCategory] ${reasonController.text.trim()}';
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
          SnackBar(content: Text(e.message), backgroundColor: Colors.red),
        );
      }
    }
  }

  void _showMyDisputesSheet() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return DraggableScrollableSheet(
          initialChildSize: 0.6,
          minChildSize: 0.4,
          maxChildSize: 0.9,
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
                            color: AppColors.slateDark),
                      ),
                      IconButton(
                        icon: const Icon(Icons.close),
                        onPressed: () => Navigator.pop(ctx),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Track status and review notes from HR for your submitted correction requests.',
                    style:
                        TextStyle(fontSize: 12, color: Colors.grey.shade600),
                  ),
                  const Divider(height: 20),
                  Expanded(
                    child: _myCorrections.isEmpty
                        ? const Center(
                            child: Text(
                              'No dispute requests submitted.',
                              style: TextStyle(color: Colors.grey),
                            ),
                          )
                        : ListView.separated(
                            controller: scrollController,
                            itemCount: _myCorrections.length,
                            separatorBuilder: (_, __) =>
                                const SizedBox(height: 10),
                            itemBuilder: (_, i) {
                              final c = _myCorrections[i];
                              final statusTone = c.isApproved
                                  ? Colors.green
                                  : c.isAmended
                                      ? Colors.blue.shade700
                                      : c.isRejected
                                          ? Colors.red
                                          : Colors.amber.shade800;

                              return Container(
                                padding: const EdgeInsets.all(12),
                                decoration: BoxDecoration(
                                  border: Border.all(
                                      color: statusTone.withValues(alpha: 0.3)),
                                  borderRadius: BorderRadius.circular(10),
                                  color: statusTone.withValues(alpha: 0.04),
                                ),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      mainAxisAlignment:
                                          MainAxisAlignment.spaceBetween,
                                      children: [
                                        Text(
                                          c.date,
                                          style: const TextStyle(
                                              fontWeight: FontWeight.bold,
                                              fontSize: 13),
                                        ),
                                        Container(
                                          padding: const EdgeInsets.symmetric(
                                              horizontal: 8, vertical: 3),
                                          decoration: BoxDecoration(
                                            color: statusTone
                                                .withValues(alpha: 0.15),
                                            borderRadius:
                                                BorderRadius.circular(6),
                                          ),
                                          child: Text(
                                            c.status,
                                            style: TextStyle(
                                              fontSize: 11,
                                              fontWeight: FontWeight.bold,
                                              color: statusTone,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 6),
                                    Text(
                                      c.reason,
                                      style: const TextStyle(fontSize: 12),
                                    ),
                                    if (c.reviewNotes != null &&
                                        c.reviewNotes!.isNotEmpty) ...[
                                      const SizedBox(height: 6),
                                      Container(
                                        padding: const EdgeInsets.all(8),
                                        decoration: BoxDecoration(
                                          color: Colors.white,
                                          borderRadius:
                                              BorderRadius.circular(6),
                                          border: Border.all(
                                              color: Colors.grey.shade200),
                                        ),
                                        child: Row(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            const Icon(Icons.feedback_outlined,
                                                size: 14, color: Colors.blueGrey),
                                            const SizedBox(width: 6),
                                            Expanded(
                                              child: Text(
                                                'HR Note: ${c.reviewNotes}',
                                                style: const TextStyle(
                                                    fontSize: 11,
                                                    fontStyle:
                                                        FontStyle.italic),
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
    final existingDispute = _myCorrections
        .where((c) => c.date == day.date)
        .firstOrNull;

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Attendance on ${day.date}'),
        content: SizedBox(
          width: double.maxFinite,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                alignment: WrapAlignment.spaceBetween,
                runSpacing: 4,
                spacing: 8,
                children: [
                  Text('First in: ${day.firstCheckIn}',
                      style: const TextStyle(fontSize: 13)),
                  Text('Last seen: ${day.lastActiveTime}',
                      style: const TextStyle(fontSize: 13)),
                ],
              ),
              const SizedBox(height: 6),
              Text('Time worked: ${day.timeWorkedFormatted}',
                  style:
                      const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
              const Divider(height: 20),
            if (existingDispute != null) ...[
              const Text('Dispute Status',
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
              const SizedBox(height: 4),
              Text('Status: ${existingDispute.status}',
                  style: TextStyle(
                      fontWeight: FontWeight.w600,
                      color: existingDispute.isApproved
                          ? Colors.green
                          : existingDispute.isAmended
                              ? Colors.blue.shade700
                              : existingDispute.isRejected
                                  ? Colors.red
                                  : Colors.orange.shade800)),
              Text('Reason: ${existingDispute.reason}',
                  style: const TextStyle(fontSize: 12)),
              if (existingDispute.reviewNotes != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text('HR Note: ${existingDispute.reviewNotes}',
                      style: const TextStyle(
                          fontSize: 12, fontStyle: FontStyle.italic)),
                ),
            ] else ...[
              const Text(
                'Was something incorrect with this day\'s records? You can submit a dispute for HR review.',
                style: TextStyle(fontSize: 12, color: Colors.grey),
              ),
            ],
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Close'),
          ),
          if (existingDispute == null)
            FilledButton.tonal(
              onPressed: () {
                Navigator.pop(ctx);
                _openCorrectionForm(day.date);
              },
              child: const Text('Request Correction'),
            ),
        ],
      ),
    );
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
    final breakInfo = _todayDetails?.breakInfo ?? ActiveBreakInfo.empty();
    final deficit = _todayDetails?.deficitBalance ?? DeficitBalance.empty();
    final isPresent = _attendance.status == PresenceStatus.inOffice ||
        _attendance.status == PresenceStatus.gracePeriod;

    // Create lookup map for disputes on history dates
    final disputesByDate = <String, CorrectionRequest>{};
    for (final c in _myCorrections) {
      disputesByDate[c.date] = c;
    }

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              _employeeName.isEmpty ? 'Office Tracker' : _employeeName,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            Text(
              _network.ssid == null
                  ? 'Not on Wi-Fi'
                  : 'Wi-Fi: ${_network.ssid}',
              style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.history_edu_outlined),
            tooltip: 'My Disputes',
            onPressed: _showMyDisputesSheet,
          ),
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

                  // 1. Status Card (Spec 19.1)
                  _StatusCard(
                    attendance: _attendance,
                    verified: _verified,
                    breakMinutesTaken: breakInfo.breakMinutesTaken,
                    onRefresh: _sending ? null : _refresh,
                    onClockOut: isPresent ? _clockOut : null,
                  ),
                  const SizedBox(height: 12),

                  // 2. Break Controls Card (Spec 12, 19.1)
                  _BreakCard(
                    breakInfo: breakInfo,
                    isPresent: isPresent,
                    elapsedSeconds: _breakElapsedSeconds,
                    onStartBreak: isPresent && !breakInfo.onBreak ? _startBreak : null,
                    onEndBreak: breakInfo.onBreak ? _endBreak : null,
                  ),
                  const SizedBox(height: 12),

                  // 3. Attendance Deficit & 480-Min Whole-Day Progress (Spec 8, 19.3)
                  _DeficitCard(deficit: deficit),
                  const SizedBox(height: 12),

                  // 4. Background Presence Service Card
                  _ServiceCard(
                    running: _serviceRunning,
                    pending: _pendingCount,
                    onToggle: _toggleService,
                    onSendNow: _sending ? null : _refresh,
                    sending: _sending,
                  ),

                  // 5. Today's Working Sessions
                  if (_attendance.sessions.isNotEmpty) ...[
                    const SizedBox(height: 20),
                    const _SectionHeader("Today's Sessions"),
                    const SizedBox(height: 8),
                    ..._attendance.sessions.map((s) => _SessionRow(session: s)),
                  ],

                  // 6. History past 7 days with dispute badges & tap to dispute
                  if (_history.isNotEmpty) ...[
                    const SizedBox(height: 20),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const _SectionHeader('Past 7 Days'),
                        TextButton.icon(
                          onPressed: () => _openCorrectionForm(),
                          icon: const Icon(Icons.edit_note, size: 16),
                          label: const Text('Dispute a Day',
                              style: TextStyle(fontSize: 12)),
                          style: TextButton.styleFrom(
                              foregroundColor: AppColors.teal),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    ..._history.map((d) => _DayRow(
                          day: d,
                          correction: disputesByDate[d.date],
                          onTap: () => _onDayTapped(d),
                        )),
                  ],
                ],
              ),
            ),
    );
  }
}

// ---------------------------------------------------------------------------
// Status Card (Spec 19.1)
// ---------------------------------------------------------------------------

class _StatusCard extends StatelessWidget {
  final Attendance attendance;
  final bool verified;
  final int breakMinutesTaken;
  final VoidCallback? onRefresh;
  final VoidCallback? onClockOut;

  const _StatusCard({
    required this.attendance,
    required this.verified,
    this.breakMinutesTaken = 0,
    this.onRefresh,
    this.onClockOut,
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
          'AWAY / OFF-SITE'
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
              Flexible(
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: Colors.black26,
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(icon, size: 14, color: Colors.white),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          label,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 11,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 0.5,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (onClockOut != null)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: InkWell(
                        onTap: onClockOut,
                        borderRadius: BorderRadius.circular(6),
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 8, vertical: 4),
                          decoration: BoxDecoration(
                            color: Colors.red.shade800.withValues(alpha: 0.8),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: const Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.power_settings_new,
                                  color: Colors.white, size: 13),
                              SizedBox(width: 4),
                              Text(
                                'Clock Out',
                                style: TextStyle(
                                    color: Colors.white,
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  if (onRefresh != null)
                    IconButton(
                      icon: const Icon(Icons.refresh,
                          color: Colors.white70, size: 20),
                      onPressed: onRefresh,
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(),
                    ),
                ],
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
                  icon: Icons.coffee_outlined,
                  label: 'Break Used',
                  value: '$breakMinutesTaken / 30m',
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Break Management Card (Spec 12, 19.1)
// ---------------------------------------------------------------------------

class _BreakCard extends StatelessWidget {
  final ActiveBreakInfo breakInfo;
  final bool isPresent;
  final int elapsedSeconds;
  final VoidCallback? onStartBreak;
  final VoidCallback? onEndBreak;

  const _BreakCard({
    required this.breakInfo,
    required this.isPresent,
    required this.elapsedSeconds,
    this.onStartBreak,
    this.onEndBreak,
  });

  @override
  Widget build(BuildContext context) {
    if (breakInfo.onBreak) {
      final permittedSeconds = breakInfo.permittedMinutes * 60;
      final remainingSeconds = permittedSeconds - elapsedSeconds;
      final isOvertime = remainingSeconds < 0;

      final displayTime = isOvertime
          ? _formatDuration(elapsedSeconds - permittedSeconds)
          : _formatDuration(remainingSeconds);

      final cardColor = isOvertime ? Colors.red.shade50 : Colors.teal.shade50;
      final borderColor =
          isOvertime ? Colors.red.shade300 : AppColors.teal.withValues(alpha: 0.4);
      final primaryColor = isOvertime ? Colors.red.shade800 : AppColors.tealDark;

      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: cardColor,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: borderColor, width: 1.5),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    Icon(
                      isOvertime ? Icons.warning_amber_rounded : Icons.coffee,
                      color: primaryColor,
                      size: 20,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      isOvertime ? 'Break Overtime' : 'Break in Progress',
                      style: TextStyle(
                        fontWeight: FontWeight.bold,
                        fontSize: 14,
                        color: primaryColor,
                      ),
                    ),
                  ],
                ),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: primaryColor.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    isOvertime ? '+$displayTime excess' : '$displayTime left',
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontWeight: FontWeight.bold,
                      fontSize: 13,
                      color: primaryColor,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: isOvertime
                    ? 1.0
                    : (elapsedSeconds / permittedSeconds).clamp(0.0, 1.0),
                backgroundColor: Colors.grey.shade200,
                color: isOvertime ? Colors.red.shade600 : AppColors.teal,
                minHeight: 6,
              ),
            ),
            const SizedBox(height: 10),
            Text(
              isOvertime
                  ? 'You have exceeded the permitted 30-minute allowance. Excess break time will be added to your attendance deficit.'
                  : 'Permitted: ${breakInfo.permittedMinutes} mins. Due back by ${breakInfo.dueBackDisplay ?? '--'}',
              style: TextStyle(fontSize: 11, color: Colors.grey.shade700),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: onEndBreak,
                icon: const Icon(Icons.stop_circle_outlined, size: 18),
                label: const Text('End Break & Resume Work'),
                style: FilledButton.styleFrom(
                  backgroundColor:
                      isOvertime ? Colors.red.shade700 : AppColors.teal,
                  padding: const EdgeInsets.symmetric(vertical: 12),
                ),
              ),
            ),
          ],
        ),
      );
    }

    // When not on break
    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: Colors.grey.shade200),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: AppColors.teal.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Icon(Icons.coffee_outlined,
                  color: AppColors.teal, size: 20),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Take a Break',
                      style:
                          TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                  Text(
                    '30 minutes permitted per day (${breakInfo.breakMinutesTaken}m used today)',
                    style: TextStyle(color: Colors.grey.shade600, fontSize: 11),
                  ),
                ],
              ),
            ),
            FilledButton.tonal(
              onPressed: onStartBreak,
              style: FilledButton.styleFrom(
                backgroundColor: isPresent
                    ? AppColors.teal.withValues(alpha: 0.15)
                    : Colors.grey.shade100,
                foregroundColor: isPresent ? AppColors.tealDark : Colors.grey,
              ),
              child: const Text('Start Break'),
            ),
          ],
        ),
      ),
    );
  }

  String _formatDuration(int totalSecs) {
    final m = totalSecs ~/ 60;
    final s = totalSecs % 60;
    return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }
}

// ---------------------------------------------------------------------------
// Attendance Deficit Ledger Card (Spec 8, 19.3)
// ---------------------------------------------------------------------------

class _DeficitCard extends StatefulWidget {
  final DeficitBalance deficit;
  const _DeficitCard({required this.deficit});

  @override
  State<_DeficitCard> createState() => _DeficitCardState();
}

class _DeficitCardState extends State<_DeficitCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final d = widget.deficit;
    final b = d.todayBreakdown;
    final progress =
        (d.minutes % d.dayEquivalentMinutes) / d.dayEquivalentMinutes;
    final hasDeficit = d.minutes > 0;

    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(
          color: d.wholeDayEquivalents > 0
              ? Colors.red.shade200
              : hasDeficit
                  ? Colors.orange.shade200
                  : Colors.grey.shade200,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    Icon(
                      d.wholeDayEquivalents > 0
                          ? Icons.warning_amber_rounded
                          : Icons.account_balance_wallet_outlined,
                      size: 18,
                      color: d.wholeDayEquivalents > 0
                          ? Colors.red.shade700
                          : hasDeficit
                              ? Colors.orange.shade800
                              : AppColors.slateDark,
                    ),
                    const SizedBox(width: 8),
                    const Text('Attendance Deficit Ledger',
                        style: TextStyle(
                            fontWeight: FontWeight.bold, fontSize: 13)),
                  ],
                ),
                Text(
                  d.formatted,
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 14,
                    color: d.wholeDayEquivalents > 0
                        ? Colors.red.shade700
                        : hasDeficit
                            ? Colors.orange.shade800
                            : Colors.green.shade700,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),

            // 480-minute progress bar (Spec 8.3)
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: progress.clamp(0.0, 1.0),
                backgroundColor: Colors.grey.shade200,
                color: d.wholeDayEquivalents > 0
                    ? Colors.red.shade600
                    : Colors.orange.shade600,
                minHeight: 6,
              ),
            ),
            const SizedBox(height: 6),

            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Text(
                    d.wholeDayEquivalents > 0
                        ? '${d.wholeDayEquivalents} whole-day eq. (${d.carryForwardMinutes}m carry forward)'
                        : '${d.minutes} / 480m to 1 whole-day eq.',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: d.wholeDayEquivalents > 0
                          ? FontWeight.bold
                          : FontWeight.normal,
                      color: d.wholeDayEquivalents > 0
                          ? Colors.red.shade700
                          : Colors.grey.shade600,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 8),
                InkWell(
                  onTap: () => setState(() => _expanded = !_expanded),
                  child: Row(
                    children: [
                      Text(_expanded ? 'Hide today' : "Today's breakdown",
                          style: const TextStyle(
                              fontSize: 11,
                              color: AppColors.teal,
                              fontWeight: FontWeight.w600)),
                      Icon(
                        _expanded
                            ? Icons.keyboard_arrow_up
                            : Icons.keyboard_arrow_down,
                        size: 14,
                        color: AppColors.teal,
                      ),
                    ],
                  ),
                ),
              ],
            ),

            // Expandable breakdown terms (Spec 8.1, 19.3)
            if (_expanded) ...[
              const Divider(height: 16),
              _TermRow('Late arrival', '+${b.lateMinutes}m',
                  b.lateMinutes > 0 ? Colors.orange.shade800 : Colors.grey),
              _TermRow(
                  'Excess break (>30m)',
                  '+${b.excessBreakMinutes}m',
                  b.excessBreakMinutes > 0
                      ? Colors.orange.shade800
                      : Colors.grey),
              _TermRow(
                  'Early departure',
                  '+${b.earlyDepartureMinutes}m',
                  b.earlyDepartureMinutes > 0
                      ? Colors.orange.shade800
                      : Colors.grey),
              _TermRow(
                  'Unauthorised missing time',
                  '+${b.unauthorisedMissingMinutes}m',
                  b.unauthorisedMissingMinutes > 0
                      ? Colors.orange.shade800
                      : Colors.grey),
              _TermRow(
                  'Approved HR adjustment',
                  b.approvedAdjustmentMinutes > 0
                      ? '-${b.approvedAdjustmentMinutes.abs()}m'
                      : '-0m',
                  b.approvedAdjustmentMinutes > 0
                      ? Colors.green.shade700
                      : Colors.grey),
            ],
          ],
        ),
      ),
    );
  }

  Widget _TermRow(String label, String value, Color color) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label,
              style: TextStyle(fontSize: 11, color: Colors.grey.shade700)),
          Text(value,
              style: TextStyle(
                  fontSize: 11, fontWeight: FontWeight.w600, color: color)),
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
                          style: TextStyle(
                              fontWeight: FontWeight.bold, fontSize: 14)),
                      Text(
                        running
                            ? 'Reports automatically while connected to office Wi-Fi.'
                            : 'Off. Attendance only records while app is open.',
                        style: TextStyle(
                            color: Colors.grey.shade600, fontSize: 11),
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
                  Icon(Icons.inbox_outlined,
                      size: 16, color: Colors.grey.shade600),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '$pending reading(s) waiting to upload',
                      style:
                          TextStyle(fontSize: 11, color: Colors.grey.shade600),
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
            fontSize: 16,
            fontWeight: FontWeight.bold,
            color: AppColors.slateDark),
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
            session.open
                ? Icons.play_circle_outline
                : Icons.check_circle_outline,
            size: 18,
            color: session.open ? AppColors.teal : Colors.grey,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              '${session.from}  ->  ${session.to}',
              style: const TextStyle(fontSize: 13),
            ),
          ),
          Text(
            session.duration,
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}

class _DayRow extends StatelessWidget {
  final Attendance day;
  final CorrectionRequest? correction;
  final VoidCallback? onTap;

  const _DayRow({
    required this.day,
    this.correction,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final worked = day.totalMinutes > 0;
    final hasDispute = correction != null;

    final (badgeColor, badgeText) = hasDispute
        ? (correction!.isApproved
            ? (Colors.green, 'Dispute Approved')
            : correction!.isAmended
                ? (Colors.blue.shade700, 'Dispute Amended')
                : correction!.isRejected
                    ? (Colors.red, 'Dispute Rejected')
                    : (Colors.orange.shade800, 'Dispute Pending'))
        : (Colors.transparent, '');

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: hasDispute
                ? badgeColor.withValues(alpha: 0.4)
                : Colors.grey.shade200,
          ),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 8,
                    runSpacing: 4,
                    children: [
                      Text(day.date,
                          style: const TextStyle(
                              fontSize: 13, fontWeight: FontWeight.w600)),
                      if (hasDispute)
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: badgeColor.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            badgeText,
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.bold,
                              color: badgeColor,
                            ),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    worked
                        ? '${day.firstCheckIn} - ${day.lastActiveTime}'
                        : 'No attendance',
                    style:
                        TextStyle(fontSize: 11, color: Colors.grey.shade600),
                  ),
                ],
              ),
            ),
            if (day.needsReview)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: Tooltip(
                  message: 'Unusually long session - flagged for review',
                  child: Icon(Icons.flag_outlined,
                      size: 16, color: Colors.orange.shade700),
                ),
              ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  day.timeWorkedFormatted,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.bold,
                    color: worked ? AppColors.slateDark : Colors.grey,
                  ),
                ),
                const Text('Tap to dispute',
                    style: TextStyle(fontSize: 10, color: AppColors.teal)),
              ],
            ),
          ],
        ),
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
                        fontWeight: FontWeight.bold,
                        fontSize: 13,
                        color: color)),
                const SizedBox(height: 2),
                Text(body,
                    style: TextStyle(
                        fontSize: 12,
                        color: Colors.grey.shade800,
                        height: 1.4)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}