// Presence, Break Management, Deficit & Attendance Dispute dashboard for the employee.
// Spec sections 7, 8, 11, 12, 19.1, 19.3 and 23.6.
// Refactored to utilize BLoC state management and instant stale-while-revalidate caching.

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../blocs/home/home_bloc.dart';
import '../blocs/home/home_event.dart';
import '../blocs/home/home_state.dart';
import '../models/attendance.dart';
import '../services/api_client.dart';
import '../services/token_store.dart';
import '../theme.dart';
import '../widgets/home/attendance_timeline_card.dart';
import '../widgets/home/break_control_card.dart';
import '../widgets/home/home_skeleton_loader.dart';
import '../widgets/home/productivity_metrics_card.dart';
import '../widgets/home/shift_hero_card.dart';
import 'profile_screen.dart';
import 'settings_screen.dart';
import 'complaints_screen.dart';

class HomeScreen extends StatefulWidget {
  final VoidCallback onSignedOut;
  const HomeScreen({super.key, required this.onSignedOut});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  final _store = TokenStore();
  final _api = ApiClient();
  String _employeeName = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadEmployeeName();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _api.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && mounted) {
      context.read<HomeBloc>().add(const HomeRefreshRequested());
    }
  }

  Future<void> _loadEmployeeName() async {
    final name = await _store.readEmployeeName();
    if (mounted) {
      setState(() => _employeeName = name);
    }
  }

  void _showDeficitDialog(BuildContext context, DeficitBalance deficit) {
    final b = deficit.todayBreakdown;
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Row(
          children: [
            Icon(Icons.pie_chart_outline_rounded, color: AppColors.amber, size: 22),
            SizedBox(width: 10),
            Text(
              'Deficit Breakdown',
              style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16),
            ),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: AppColors.bgDark,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.border),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Total Accumulated Deficit', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                  Text(
                    deficit.formatted,
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.amber),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            const Text(
              'TODAY\'S COMPONENTS',
              style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 0.8, color: AppColors.textMuted),
            ),
            const SizedBox(height: 8),
            _buildDeficitRow('Late arrival time', '${b.lateMinutes} mins'),
            _buildDeficitRow('Excess break time', '${b.excessBreakMinutes} mins'),
            _buildDeficitRow('Early departure time', '${b.earlyDepartureMinutes} mins'),
            _buildDeficitRow('Unauthorised absence', '${b.unauthorisedMissingMinutes} mins'),
            if (b.approvedAdjustmentMinutes > 0)
              _buildDeficitRow('HR Approved Adjustments', '-${b.approvedAdjustmentMinutes} mins', isPositive: true),
            const Divider(height: 20, color: AppColors.border),
            const Text(
              'Deficit time accumulates when working less than 8h 00m or overstaying the 30-minute break. Submit a dispute if this is inaccurate.',
              style: TextStyle(fontSize: 11, color: AppColors.textMuted, height: 1.4),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Close', style: TextStyle(color: AppColors.textMuted)),
          ),
          FilledButton(
            onPressed: () {
              Navigator.pop(ctx);
              _openCorrectionForm();
            },
            style: FilledButton.styleFrom(backgroundColor: AppColors.primary),
            child: const Text('Dispute Deficit'),
          ),
        ],
      ),
    );
  }

  Widget _buildDeficitRow(String label, String value, {bool isPositive = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(fontSize: 12, color: Colors.white70)),
          Text(
            value,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: isPositive ? AppColors.teal : Colors.white,
            ),
          ),
        ],
      ),
    );
  }

  void _confirmClockOut() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: const Text('Manual Clock Out', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        content: const Text(
          'This will conclude your working session for today. Use this if you are leaving the office premises.',
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

    if (!mounted) return;
    if (confirm == true) {
      context.read<HomeBloc>().add(const HomeClockOutRequested());
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
                      initialValue: reasonCategory,
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
        context.read<HomeBloc>().add(const HomeRefreshRequested());
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: AppColors.danger),
        );
      }
    }
  }

  void _showMyDisputesSheet(List<CorrectionRequest> corrections) {
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
                    child: corrections.isEmpty
                        ? const Center(
                            child: Text(
                              'No disputes on record.',
                              style: TextStyle(color: AppColors.textMuted, fontSize: 13),
                            ),
                          )
                        : ListView.separated(
                            controller: scrollController,
                            itemCount: corrections.length,
                            separatorBuilder: (_, _) => const SizedBox(height: 10),
                            itemBuilder: (_, i) {
                              final c = corrections[i];
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
                                  border: Border.all(color: statusTone.withValues(alpha: 0.3)),
                                  borderRadius: BorderRadius.circular(12),
                                  color: statusTone.withValues(alpha: 0.06),
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
                                            color: statusTone.withValues(alpha: 0.2),
                                            borderRadius: BorderRadius.circular(6),
                                            border: Border.all(color: statusTone.withValues(alpha: 0.5)),
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

  void _onDayTapped(Attendance day, List<CorrectionRequest> corrections) {
    final existingDispute = corrections.where((c) => c.date == day.date).firstOrNull;

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: Text(
          'Timesheet: ${day.date}',
          style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16),
        ),
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
    return BlocConsumer<HomeBloc, HomeState>(
      listener: (context, state) {
        if (state is HomeLoaded) {
          if (state.errorMessage != null && state.errorMessage!.isNotEmpty) {
            ScaffoldMessenger.of(context).clearSnackBars();
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(state.errorMessage!),
                backgroundColor: AppColors.danger,
                duration: const Duration(seconds: 3),
              ),
            );
          } else if (state.actionMessage != null && state.actionMessage!.isNotEmpty) {
            ScaffoldMessenger.of(context).clearSnackBars();
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(state.actionMessage!),
                backgroundColor: AppColors.teal,
                duration: const Duration(seconds: 3),
              ),
            );
          }
        } else if (state is HomeFailure) {
          ScaffoldMessenger.of(context).clearSnackBars();
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(state.message),
              backgroundColor: AppColors.danger,
              duration: const Duration(seconds: 4),
            ),
          );
        }
      },
      builder: (context, state) {
        if (state is HomeInitial || state is HomeLoading) {
          return Scaffold(
            backgroundColor: AppColors.bgDark,
            appBar: _buildAppBar(context, null),
            body: const HomeSkeletonLoader(),
          );
        }

        if (state is HomeFailure) {
          return Scaffold(
            backgroundColor: AppColors.bgDark,
            appBar: _buildAppBar(context, null),
            body: Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.cloud_off_rounded, size: 48, color: AppColors.danger),
                    const SizedBox(height: 16),
                    const Text(
                      'Connection Failure',
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Colors.white),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      state.message,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 13, color: AppColors.textMuted),
                    ),
                    const SizedBox(height: 20),
                    FilledButton.icon(
                      onPressed: () => context.read<HomeBloc>().add(const HomeRefreshRequested()),
                      icon: const Icon(Icons.refresh),
                      label: const Text('Retry Connection'),
                    ),
                  ],
                ),
              ),
            ),
          );
        }

        final loaded = state as HomeLoaded;
        final summary = loaded.summary;
        final today = summary.todayDetails;
        final history = summary.history;
        final corrections = summary.corrections;

        final disputesByDate = <String, CorrectionRequest>{};
        for (final c in corrections) {
          disputesByDate[c.date] = c;
        }

        final int pendingDisputesCount = corrections
            .where((c) => c.status == 'PENDING_HR' || c.status == 'PENDING')
            .length;

        return Scaffold(
          backgroundColor: AppColors.bgDark,
          appBar: _buildAppBar(
            context,
            loaded,
            pendingDisputesCount: pendingDisputesCount,
            onDisputesPressed: () => _showMyDisputesSheet(corrections),
          ),
          body: Column(
            children: [
              // Non-blocking top progress bar during background revalidation
              if (loaded.isRefreshing)
                const LinearProgressIndicator(
                  minHeight: 2.5,
                  backgroundColor: Colors.transparent,
                  valueColor: AlwaysStoppedAnimation<Color>(AppColors.primaryLight),
                ),

              Expanded(
                child: RefreshIndicator(
                  color: AppColors.primary,
                  onRefresh: () async {
                    context.read<HomeBloc>().add(const HomeRefreshRequested());
                  },
                  child: Align(
                    alignment: Alignment.topCenter,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 720),
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(16, 14, 16, 30),
                        children: [
                          // Offline Warning Pill
                          if (loaded.isOffline) ...[
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                              decoration: BoxDecoration(
                                color: AppColors.amber.withValues(alpha: 0.14),
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: AppColors.amber.withValues(alpha: 0.35)),
                              ),
                              child: const Row(
                                children: [
                                  Icon(Icons.wifi_off_rounded, color: AppColors.amber, size: 18),
                                  SizedBox(width: 10),
                                  Expanded(
                                    child: Text(
                                      'Offline mode: Displaying cached records. Syncing automatically when reconnected.',
                                      style: TextStyle(color: AppColors.amber, fontSize: 11.5, fontWeight: FontWeight.w500),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 14),
                          ],

                          // 1. Shift Hero Card (Glassmorphic + Live Timer + Target Progress)
                          ShiftHeroCard(
                            todayDetails: today,
                            liveNow: loaded.liveNow,
                            isVerified: true,
                            serverTimeMs: loaded.summary.serverTimeMs,
                          ),
                          const SizedBox(height: 14),

                          // 2. Break Control & Quick Action Card
                          BreakControlCard(
                            breakInfo: today.breakInfo,
                            liveNow: loaded.liveNow,
                            isSubmitting: loaded.isSubmittingAction,
                            onToggleBreak: () {
                              context.read<HomeBloc>().add(const HomeBreakToggleRequested());
                            },
                            onClockOut: _confirmClockOut,
                            onOpenDispute: () => _openCorrectionForm(),
                          ),
                          const SizedBox(height: 14),

                          // 3. Productivity & Deficit Standing Card
                          ProductivityMetricsCard(
                            workingHours: today.workingHours,
                            deficit: today.deficitBalance,
                            onDeficitTapped: () => _showDeficitDialog(context, today.deficitBalance),
                          ),
                          const SizedBox(height: 14),

                          // Confidential Concerns Quick Action Banner
                          InkWell(
                            borderRadius: BorderRadius.circular(16),
                            onTap: () {
                              Navigator.of(context).push(
                                MaterialPageRoute(builder: (_) => const ComplaintsScreen()),
                              );
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                              decoration: BoxDecoration(
                                color: AppColors.surfaceDark,
                                borderRadius: BorderRadius.circular(16),
                                border: Border.all(color: AppColors.primary.withOpacity(0.35)),
                              ),
                              child: Row(
                                children: [
                                  Container(
                                    padding: const EdgeInsets.all(8),
                                    decoration: BoxDecoration(
                                      color: AppColors.primary.withOpacity(0.15),
                                      shape: BoxShape.circle,
                                    ),
                                    child: const Icon(Icons.shield_outlined, color: AppColors.primaryLight, size: 20),
                                  ),
                                  const SizedBox(width: 12),
                                  const Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          'Confidential Concerns & HR Issues',
                                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Colors.white),
                                        ),
                                        SizedBox(height: 2),
                                        Text(
                                          'Submit payroll, hours, or workplace concerns to HR',
                                          style: TextStyle(fontSize: 11, color: AppColors.textMuted),
                                        ),
                                      ],
                                    ),
                                  ),
                                  const Icon(Icons.chevron_right, color: AppColors.textMuted, size: 20),
                                ],
                              ),
                            ),
                          ),
                          const SizedBox(height: 20),

                          // 4. Today's Working Sessions (if any recorded)
                          if (today.attendance.sessions.isNotEmpty) ...[
                            const Text(
                              'TODAY\'S WORKING SESSIONS',
                              style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.bold,
                                letterSpacing: 1.1,
                                color: AppColors.textMuted,
                              ),
                            ),
                            const SizedBox(height: 8),
                            ...today.attendance.sessions.map((s) {
                              if (!s.open || loaded.summary.serverTimeMs <= 0) {
                                return _buildSessionTile(s);
                              }
                              final elapsedMs = loaded.liveNow.millisecondsSinceEpoch - loaded.summary.serverTimeMs;
                              final extraMins = elapsedMs > 0 ? (elapsedMs ~/ 60000) : 0;
                              final liveMins = s.minutes + extraMins;
                              final liveDuration = liveMins > 0 ? '${liveMins ~/ 60}h ${(liveMins % 60).toString().padLeft(2, '0')}m' : s.duration;
                              return _buildSessionTile(s, liveDurationOverride: liveDuration);
                            }),
                            const SizedBox(height: 20),
                          ],

                          // 5. Past 7 Days Attendance Timeline
                          AttendanceTimelineCard(
                            history: history,
                            disputesByDate: disputesByDate,
                            onDayTapped: (day) => _onDayTapped(day, corrections),
                            onDisputeDay: () => _openCorrectionForm(),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  PreferredSizeWidget _buildAppBar(
    BuildContext context,
    HomeLoaded? loaded, {
    int pendingDisputesCount = 0,
    VoidCallback? onDisputesPressed,
  }) {
    final String displayName = loaded?.summary.todayDetails.employeeName.isNotEmpty == true
        ? loaded!.summary.todayDetails.employeeName
        : (_employeeName.isNotEmpty ? _employeeName : 'Employee Portal');

    return AppBar(
      backgroundColor: AppColors.surfaceDark,
      elevation: 0,
      titleSpacing: 12,
      title: GestureDetector(
        onTap: () {
          Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const ProfileScreen()),
          );
        },
        child: Row(
          children: [
            CircleAvatar(
              radius: 18,
              backgroundColor: AppColors.primary.withValues(alpha: 0.2),
              child: Text(
                displayName.isNotEmpty ? displayName.substring(0, 1).toUpperCase() : 'U',
                style: const TextStyle(
                  color: AppColors.primaryLight,
                  fontWeight: FontWeight.bold,
                  fontSize: 14,
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    displayName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Colors.white),
                  ),
                  const Text(
                    'Staff Attendance',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: AppColors.textMuted),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      actions: [
        // Dispute Badge Button
        Stack(
          children: [
            IconButton(
              icon: const Icon(Icons.rate_review_outlined, color: Colors.white70, size: 20),
              tooltip: 'My Disputes',
              onPressed: onDisputesPressed,
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

        // Confidential Concerns Button
        IconButton(
          icon: const Icon(Icons.shield_outlined, color: AppColors.primaryLight, size: 20),
          tooltip: 'Confidential Concerns & Complaints',
          onPressed: () async {
            await Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const ComplaintsScreen()),
            );
          },
        ),

        // Settings Button
        IconButton(
          icon: const Icon(Icons.settings_outlined, color: Colors.white70, size: 20),
          tooltip: 'Settings',
          onPressed: () async {
            await Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => SettingsScreen(onSignedOut: widget.onSignedOut),
              ),
            );
            if (context.mounted) {
              context.read<HomeBloc>().add(const HomeRefreshRequested());
            }
          },
        ),

        // Refresh Button
        IconButton(
          icon: loaded?.isRefreshing == true
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : const Icon(Icons.refresh, color: Colors.white70, size: 20),
          tooltip: 'Refresh',
          onPressed: loaded?.isRefreshing == true
              ? null
              : () => context.read<HomeBloc>().add(const HomeRefreshRequested()),
        ),
      ],
    );
  }

  Widget _buildSessionTile(WorkSession s, {String? liveDurationOverride}) {
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
              liveDurationOverride ?? s.duration,
              style: const TextStyle(color: AppColors.primaryLight, fontSize: 11, fontWeight: FontWeight.bold),
            ),
          ),
        ],
      ),
    );
  }
}