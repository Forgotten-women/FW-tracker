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
import '../widgets/home/today_timeline_card.dart';
import '../widgets/home/week_strip.dart';
import '../widgets/glass/glass.dart';
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

    Widget tile(String label, String value, Color tone) => Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: tone.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(16),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.textSecondary)),
                const SizedBox(height: 2),
                Text(value, style: monoStyle(fontSize: 19, color: tone)),
              ],
            ),
          ),
        );

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 10, 20, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(color: AppColors.overlay(0.2), borderRadius: BorderRadius.circular(2)),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                'Deficit breakdown',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  tile('All-time balance', deficit.formatted, deficit.minutes > 0 ? AppColors.amber : AppColors.primaryLight),
                  const SizedBox(width: 10),
                  tile('Today so far', b.formatted, b.totalMinutes > 0 ? AppColors.amber : AppColors.teal),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                "The all-time balance carries across every day, so it can be larger than today's "
                'components below even on a perfect day, and smaller than their sum once HR approves an adjustment.',
                style: TextStyle(fontSize: 11, color: AppColors.textTertiary, height: 1.35),
              ),
              const SizedBox(height: 14),
              SectionLabel("Today's components"),
              _buildDeficitRow('Late arrival', '${b.lateMinutes}m'),
              _buildDeficitRow('Excess break', '${b.excessBreakMinutes}m'),
              _buildDeficitRow('Early departure', '${b.earlyDepartureMinutes}m'),
              _buildDeficitRow('Unauthorised absence', '${b.unauthorisedMissingMinutes}m'),
              if (b.approvedAdjustmentMinutes > 0)
                _buildDeficitRow('HR-approved adjustments', '−${b.approvedAdjustmentMinutes}m', isPositive: true),
              Divider(height: 24, color: AppColors.border),
              Text(
                'Deficit builds when you work under the daily target or go over the 30-minute break. '
                "Dispute it if it doesn't look right.",
                style: TextStyle(fontSize: 11.5, color: AppColors.textSecondary, height: 1.4),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => Navigator.pop(ctx),
                      style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                      child: const Text('Close'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton(
                      onPressed: () {
                        Navigator.pop(ctx);
                        _openCorrectionForm();
                      },
                      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                      child: const Text('Dispute deficit'),
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

  Widget _buildDeficitRow(String label, String value, {bool isPositive = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: monoStyle(
              fontSize: 12.5,
              color: isPositive ? AppColors.teal : AppColors.textPrimary,
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
        backgroundColor: AppColors.sheet,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: Text('Manual Clock Out', style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.bold)),
        content: Text(
          'This will conclude your working session for today. Use this if you are leaving the office premises.',
          style: TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel', style: TextStyle(color: AppColors.textMuted)),
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
      backgroundColor: AppColors.sheet,
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
                        Text(
                          'File Attendance Dispute',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: AppColors.textPrimary,
                          ),
                        ),
                        IconButton(
                          icon: Icon(Icons.close, color: AppColors.textMuted),
                          onPressed: () => Navigator.pop(ctx, false),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Dispute an inaccurate clock-in, sensor glitch, or authorised absence. Preserved immutably for HR audit.',
                      style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                    ),
                    Divider(height: 24, color: AppColors.border),

                    Text('Affected Date', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: AppColors.textSecondary)),
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
                            Text(selectedDateKey, style: TextStyle(fontSize: 13, color: AppColors.textPrimary)),
                            Icon(Icons.calendar_today, size: 16, color: AppColors.primaryLight),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),

                    Text('Dispute Reason Category', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: AppColors.textSecondary)),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                      initialValue: reasonCategory,
                      dropdownColor: AppColors.sheet,
                      decoration: const InputDecoration(
                        contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      ),
                      items: [
                        DropdownMenuItem(value: 'Sensor Glitch / Failed Check-in', child: Text('Sensor Glitch / Failed Check-in', style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                        DropdownMenuItem(value: 'Wi-Fi / Network Disconnection', child: Text('Wi-Fi / Network Disconnection', style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                        DropdownMenuItem(value: 'Off-site Business Meeting', child: Text('Off-site Business Meeting', style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                        DropdownMenuItem(value: 'Forgotten Phone / Device', child: Text('Forgotten Phone / Device', style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                        DropdownMenuItem(value: 'Approved Overtime / Late Shift', child: Text('Approved Overtime / Late Shift', style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                        DropdownMenuItem(value: 'Other Reason', child: Text('Other Reason', style: TextStyle(fontSize: 13, color: AppColors.textPrimary))),
                      ],
                      onChanged: (val) {
                        if (val != null) {
                          setModalState(() => reasonCategory = val);
                        }
                      },
                    ),
                    const SizedBox(height: 14),

                    Text('Proposed Adjustment Minutes (optional)', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: AppColors.textSecondary)),
                    const SizedBox(height: 6),
                    TextField(
                      controller: minutesController,
                      keyboardType: TextInputType.number,
                      style: TextStyle(color: AppColors.textPrimary, fontSize: 13),
                      decoration: InputDecoration(
                        hintText: 'e.g. 30',
                        hintStyle: TextStyle(color: AppColors.textTertiary),
                        suffixText: 'mins',
                        suffixStyle: TextStyle(color: AppColors.textMuted),
                      ),
                    ),
                    const SizedBox(height: 14),

                    Text('Detailed Explanation (Required)', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: AppColors.textSecondary)),
                    const SizedBox(height: 6),
                    TextField(
                      controller: reasonController,
                      maxLines: 3,
                      style: TextStyle(color: AppColors.textPrimary, fontSize: 13),
                      decoration: InputDecoration(
                        hintText: 'Explain what occurred and why attendance should be amended...',
                        hintStyle: TextStyle(color: AppColors.textTertiary),
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
                              SnackBar(
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
      backgroundColor: AppColors.sheet,
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
                      Text(
                        'My Attendance Disputes',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                          color: AppColors.textPrimary,
                        ),
                      ),
                      IconButton(
                        icon: Icon(Icons.close, color: AppColors.textMuted),
                        onPressed: () => Navigator.pop(ctx),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Track review status and feedback notes from HR regarding your dispute submissions.',
                    style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                  ),
                  Divider(height: 20, color: AppColors.border),
                  Expanded(
                    child: corrections.isEmpty
                        ? Center(
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
                              if (c.isHRDirectEntry) {
                                statusTone = AppColors.primaryLight;
                              } else if (c.isApproved) {
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
                                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: AppColors.textPrimary),
                                        ),
                                        Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                          decoration: BoxDecoration(
                                            color: statusTone.withValues(alpha: 0.2),
                                            borderRadius: BorderRadius.circular(6),
                                            border: Border.all(color: statusTone.withValues(alpha: 0.5)),
                                          ),
                                          child: Text(
                                            c.isHRDirectEntry ? 'HR Added Adjustment' : c.status,
                                            style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: statusTone),
                                          ),
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 8),
                                    Text(
                                      c.reason,
                                      style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
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
                                            Icon(Icons.feedback_outlined, size: 14, color: AppColors.primaryLight),
                                            const SizedBox(width: 8),
                                            Expanded(
                                              child: Text(
                                                'HR Decision Note: ${c.reviewNotes}',
                                                style: TextStyle(fontSize: 11, fontStyle: FontStyle.italic, color: AppColors.textSecondary),
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
        backgroundColor: AppColors.sheet,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: Text(
          'Timesheet: ${day.date}',
          style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.bold, fontSize: 16),
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
                  Expanded(
                    child: Text(
                      'First In: ${day.firstCheckIn}',
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Last Seen: ${day.lastActiveTime}',
                      textAlign: TextAlign.end,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text('Total Worked: ${day.timeWorkedFormatted}', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: AppColors.textPrimary)),
              if (day.hasDeficit) ...[
                const SizedBox(height: 14),
                Text(
                  'DEFICIT BREAKDOWN',
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 0.8, color: AppColors.textMuted),
                ),
                const SizedBox(height: 6),
                if (day.lateMinutes > 0) _buildDeficitRow('Late arrival time', '${day.lateMinutes} mins'),
                if (day.excessBreakMinutes > 0) _buildDeficitRow('Excess break time', '${day.excessBreakMinutes} mins'),
                if (day.earlyDepartureMinutes > 0) _buildDeficitRow('Early departure time', '${day.earlyDepartureMinutes} mins'),
                if (day.unauthorisedMissingMinutes > 0) _buildDeficitRow('Unauthorised absence', '${day.unauthorisedMissingMinutes} mins'),
                if (day.approvedAdjustmentMinutes > 0)
                  _buildDeficitRow('HR Approved Adjustments', '-${day.approvedAdjustmentMinutes} mins', isPositive: true),
                const SizedBox(height: 4),
                _buildDeficitRow('Total deficit for this day', '${day.dailyDeficitMinutes} mins'),
              ],
              Divider(height: 20, color: AppColors.border),
              if (existingDispute != null) ...[
                Text('Dispute History', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: AppColors.textPrimary)),
                const SizedBox(height: 4),
                Text('Status: ${existingDispute.status}', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12, color: AppColors.amber)),
                const SizedBox(height: 2),
                Text('Reason: ${existingDispute.reason}', style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
              ] else ...[
                Text(
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
            child: Text('Close', style: TextStyle(color: AppColors.textMuted)),
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
            backgroundColor: Colors.transparent,
            appBar: _buildAppBar(context, null),
            body: const HomeSkeletonLoader(),
          );
        }

        if (state is HomeFailure) {
          return Scaffold(
            backgroundColor: Colors.transparent,
            appBar: _buildAppBar(context, null),
            body: Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.cloud_off_rounded, size: 48, color: AppColors.danger),
                    const SizedBox(height: 16),
                    Text(
                      'Connection Failure',
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppColors.textPrimary),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      state.message,
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 13, color: AppColors.textMuted),
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

        final int serverTarget = today.workingHours.daily.requiredMinutes;
        final int dailyTarget = serverTarget > 0 ? serverTarget : 480;
        final DateTime now = loaded.liveNow;
        final String todayKey = WeekStrip.dateKey(now);
        final daysByDate = <String, Attendance>{
          for (final d in history) d.date: d,
        };

        // Mon–Fri bars: share of the daily target worked; null for days
        // that haven't happened yet.
        final weekProgress = <double?>[
          for (final d in WeekStrip.weekdaysOf(now))
            if (d.isAfter(now) && WeekStrip.dateKey(d) != todayKey)
              null
            else
              (WeekStrip.dateKey(d) == todayKey
                      ? today.attendance.totalMinutes
                      : (daysByDate[WeekStrip.dateKey(d)]?.totalMinutes ?? 0)) /
                  dailyTarget,
        ];
        final int todayIndex = now.weekday <= DateTime.friday ? now.weekday - 1 : -1;

        String liveSessionDuration(WorkSession s) {
          if (loaded.summary.serverTimeMs <= 0) return s.duration;
          final elapsedMs = now.millisecondsSinceEpoch - loaded.summary.serverTimeMs;
          final extra = (elapsedMs > 0 && elapsedMs < 12 * 3600 * 1000) ? elapsedMs ~/ 60000 : 0;
          final mins = s.minutes + extra;
          return mins > 0 ? '${mins ~/ 60}h ${(mins % 60).toString().padLeft(2, '0')}m' : s.duration;
        }

        return Scaffold(
          backgroundColor: Colors.transparent,
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
                LinearProgressIndicator(
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
                          if (loaded.isOffline) ...[
                            GlassCard(
                              radius: 16,
                              tint: AppColors.amber.withValues(alpha: 0.12),
                              borderColor: AppColors.amber.withValues(alpha: 0.35),
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                              child: Row(
                                children: [
                                  Icon(Icons.wifi_off_rounded, color: AppColors.amber, size: 18),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Text(
                                      "You're offline — showing saved records. They'll sync when you reconnect.",
                                      style: TextStyle(color: AppColors.amber, fontSize: 11.5, fontWeight: FontWeight.w600),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 14),
                          ],

                          WeekStrip(
                            today: loaded.liveNow,
                            daysByDate: daysByDate,
                            dailyTargetMinutes: dailyTarget,
                            onDayTapped: (day) => _onDayTapped(day, corrections),
                          ),
                          const SizedBox(height: 14),

                          ShiftHeroCard(
                            todayDetails: today,
                            liveNow: loaded.liveNow,
                            // The server only reports IN_OFFICE once office
                            // Wi-Fi has been verified; grace/away don't count.
                            isVerified: today.attendance.status == PresenceStatus.inOffice,
                            serverTimeMs: loaded.summary.serverTimeMs,
                          ),
                          const SizedBox(height: 14),

                          BreakControlCard(
                            breakInfo: today.breakInfo,
                            liveNow: loaded.liveNow,
                            isSubmitting: loaded.isSubmittingAction,
                            onToggleBreak: () {
                              context.read<HomeBloc>().add(const HomeBreakToggleRequested());
                            },
                            onClockOut: _confirmClockOut,
                            onOpenDispute: () => _openCorrectionForm(),
                            onOpenConcerns: () {
                              Navigator.of(context).push(
                                MaterialPageRoute(builder: (_) => const ComplaintsScreen()),
                              );
                            },
                          ),
                          const SizedBox(height: 14),

                          ProductivityMetricsCard(
                            workingHours: today.workingHours,
                            deficit: today.deficitBalance,
                            onDeficitTapped: () => _showDeficitDialog(context, today.deficitBalance),
                            weekProgress: weekProgress,
                            todayIndex: todayIndex,
                          ),
                          const SizedBox(height: 14),

                          if (today.attendance.sessions.isNotEmpty) ...[
                            TodayTimelineCard(
                              sessions: today.attendance.sessions,
                              liveDuration: liveSessionDuration,
                            ),
                            const SizedBox(height: 20),
                          ],

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
    final String initials = displayName
        .split(' ')
        .where((w) => w.isNotEmpty)
        .take(2)
        .map((w) => w[0].toUpperCase())
        .join();
    final int hour = DateTime.now().hour;
    final String greeting = hour < 12
        ? 'Good morning'
        : hour < 17
            ? 'Good afternoon'
            : 'Good evening';
    final bool refreshing = loaded?.isRefreshing == true;

    return AppBar(
      backgroundColor: Colors.transparent,
      toolbarHeight: 72,
      titleSpacing: 16,
      title: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () {
          Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const ProfileScreen()),
          );
        },
        child: Row(
          children: [
            Container(
              width: 46,
              height: 46,
              padding: const EdgeInsets.all(2),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: LinearGradient(
                  colors: [AppColors.primary, AppColors.accentEnd, const Color(0xFFEC4899)],
                ),
              ),
              child: Container(
                decoration: BoxDecoration(shape: BoxShape.circle, color: AppColors.bg),
                alignment: Alignment.center,
                child: Text(
                  initials.isEmpty ? 'U' : initials,
                  style: TextStyle(color: AppColors.primaryLight, fontWeight: FontWeight.w800, fontSize: 15),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    greeting,
                    maxLines: 1,
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500, color: AppColors.textSecondary),
                  ),
                  Text(
                    displayName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 19,
                      fontWeight: FontWeight.w800,
                      letterSpacing: -0.4,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      actions: [
        _glassAction(
          icon: Icons.rate_review_outlined,
          tooltip: 'My disputes',
          badge: pendingDisputesCount,
          onPressed: onDisputesPressed,
        ),
        _glassAction(
          icon: Icons.settings_outlined,
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
        _glassAction(
          icon: Icons.refresh_rounded,
          tooltip: 'Refresh',
          busy: refreshing,
          onPressed: refreshing
              ? null
              : () => context.read<HomeBloc>().add(const HomeRefreshRequested()),
        ),
        const SizedBox(width: 12),
      ],
    );
  }

  Widget _glassAction({
    required IconData icon,
    required String tooltip,
    VoidCallback? onPressed,
    int badge = 0,
    bool busy = false,
  }) {
    Widget child = busy
        ? SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.textPrimary),
          )
        : Icon(icon, size: 19, color: AppColors.textPrimary);
    if (badge > 0) {
      child = Badge(
        label: Text('$badge'),
        backgroundColor: AppColors.amber,
        textColor: Colors.black,
        child: child,
      );
    }
    return Padding(
      padding: const EdgeInsets.only(left: 6),
      child: Tooltip(
        message: tooltip,
        child: SizedBox(
          width: 44,
          height: 44,
          child: GlassCard(
            radius: 15,
            padding: EdgeInsets.zero,
            onTap: onPressed,
            child: Center(child: child),
          ),
        ),
      ),
    );
  }
}
