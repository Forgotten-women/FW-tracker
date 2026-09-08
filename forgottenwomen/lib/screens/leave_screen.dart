// Employee leave screen. Spec sections 14, 15 and 19.4.

import 'dart:async';
import 'package:flutter/material.dart';

import '../models/hr.dart';
import '../services/api_client.dart';
import '../services/notification_service.dart';
import '../theme.dart';

class LeaveScreen extends StatefulWidget {
  const LeaveScreen({super.key});

  @override
  State<LeaveScreen> createState() => _LeaveScreenState();
}

class _LeaveScreenState extends State<LeaveScreen> {
  final _api = ApiClient();
  Timer? _pollTimer;

  LeaveBalance? _balance;
  List<LeaveRequest> _requests = const [];
  List<EmployeeAbsenceRecord> _absences = const [];
  MonthlyLeaveReport? _monthlyReport;
  int _selectedTab = 0; // 0: Overview, 1: Monthly Statement
  bool _loading = true;
  bool _loadingMonthly = false;
  String? _selectedMonthKey;
  String? _error;

  @override
  void dispose() {
    _pollTimer?.cancel();
    _api.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _load();
    _pollTimer = Timer.periodic(const Duration(seconds: 4), (_) => _loadSilently());
  }

  Future<void> _loadSilently() async {
    try {
      final results = await Future.wait([
        _api.myLeave(),
        _api.myAbsences(),
        _api.fetchMonthlyLeaveReport(month: _selectedMonthKey),
      ]);
      if (!mounted) return;
      final leaveData = results[0] as Map<String, dynamic>;
      final absList = results[1] as List<EmployeeAbsenceRecord>;
      final report = results[2] as MonthlyLeaveReport;

      setState(() {
        _balance = leaveData['balance'] as LeaveBalance;
        _requests = (leaveData['requests'] as List).cast<LeaveRequest>();
        _absences = absList;
        _monthlyReport = report;
        _selectedMonthKey ??= report.monthKey;
        _error = null;
      });

      try {
        await NotificationService().checkAndDispatchUnseenNotifications();
      } catch (_) {}
    } catch (_) {}
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        _api.myLeave(),
        _api.myAbsences(),
        _api.fetchMonthlyLeaveReport(month: _selectedMonthKey),
      ]);
      if (!mounted) return;
      final leaveData = results[0] as Map<String, dynamic>;
      final absList = results[1] as List<EmployeeAbsenceRecord>;
      final report = results[2] as MonthlyLeaveReport;

      setState(() {
        _balance = leaveData['balance'] as LeaveBalance;
        _requests = (leaveData['requests'] as List).cast<LeaveRequest>();
        _absences = absList;
        _monthlyReport = report;
        _selectedMonthKey ??= report.monthKey;
        _error = null;
        _loading = false;
        _loadingMonthly = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
        _loadingMonthly = false;
      });
    }
  }

  Future<void> _loadMonthlyReport([String? monthKey]) async {
    try {
      final report = await _api.fetchMonthlyLeaveReport(month: monthKey ?? _selectedMonthKey);
      if (!mounted) return;
      setState(() {
        _monthlyReport = report;
        _selectedMonthKey = report.monthKey;
        _loadingMonthly = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loadingMonthly = false);
    }
  }

  Future<void> _openBooking() async {
    final booked = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surfaceDark,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => _BookingSheet(api: _api),
    );
    if (booked == true) _load();
  }

  Future<void> _openReportAbsence() async {
    final reported = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surfaceDark,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => _ReportAbsenceSheet(api: _api),
    );
    if (reported == true) _load();
  }

  Future<void> _cancel(LeaveRequest r) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        title: const Text('Cancel Request?', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        content: Text(
          'Are you sure you want to cancel this leave application (${r.type}: ${r.from} to ${r.to})?',
          style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Keep', style: TextStyle(color: AppColors.textMuted)),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            child: const Text('Cancel Request'),
          ),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await _api.cancelLeave(r.id);
      _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message), backgroundColor: AppColors.danger));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        backgroundColor: AppColors.surfaceDark,
        elevation: 0,
        title: const Text('Leave & Time Off', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17, color: Colors.white)),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: Colors.white70),
            onPressed: _loading ? null : _load,
          ),
        ],
      ),
      floatingActionButton: (_selectedTab == 0 && _balance != null && !_balance!.blocked)
          ? FloatingActionButton.extended(
              onPressed: _openBooking,
              backgroundColor: AppColors.primary,
              icon: const Icon(Icons.add, color: Colors.white),
              label: const Text('Apply for Leave', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
            )
          : null,
      body: Column(
        children: [
          _tabSelector(),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator(color: AppColors.primary))
                : RefreshIndicator(
                    color: AppColors.primary,
                    onRefresh: _load,
                    child: _selectedTab == 0 ? _overviewTab() : _monthlyStatementTab(),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _tabSelector() => Container(
        margin: const EdgeInsets.fromLTRB(16, 12, 16, 6),
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(
          color: AppColors.surfaceDark,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: [
            Expanded(
              child: GestureDetector(
                onTap: () => setState(() => _selectedTab = 0),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  decoration: BoxDecoration(
                    color: _selectedTab == 0 ? AppColors.primary : Colors.transparent,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Center(
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.dashboard_outlined, size: 15, color: _selectedTab == 0 ? Colors.white : AppColors.textMuted),
                        const SizedBox(width: 6),
                        Text(
                          'Overview',
                          style: TextStyle(
                            color: _selectedTab == 0 ? Colors.white : AppColors.textMuted,
                            fontWeight: _selectedTab == 0 ? FontWeight.bold : FontWeight.normal,
                            fontSize: 13,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            Expanded(
              child: GestureDetector(
                onTap: () => setState(() => _selectedTab = 1),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  decoration: BoxDecoration(
                    color: _selectedTab == 1 ? AppColors.primary : Colors.transparent,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Center(
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.calendar_month_outlined, size: 15, color: _selectedTab == 1 ? Colors.white : AppColors.textMuted),
                        const SizedBox(width: 6),
                        Text(
                          'Monthly Statement',
                          style: TextStyle(
                            color: _selectedTab == 1 ? Colors.white : AppColors.textMuted,
                            fontWeight: _selectedTab == 1 ? FontWeight.bold : FontWeight.normal,
                            fontSize: 13,
                          ),
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

  Widget _overviewTab() => Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 90),
            children: [
              if (_error != null) _errorBanner(_error!),
              if (_balance != null) _balanceCard(_balance!),
              const SizedBox(height: 16),
              _actionButtons(),
              const SizedBox(height: 24),
              const Text(
                'LEAVE APPLICATIONS & HISTORY',
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.1, color: AppColors.textMuted),
              ),
              const SizedBox(height: 10),
              if (_requests.isEmpty)
                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: AppColors.surfaceDark,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: const Center(
                    child: Text(
                      'No leave requests on record.\nTap "Apply for Leave" to submit a holiday or leave request.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: AppColors.textMuted, fontSize: 12, height: 1.5),
                    ),
                  ),
                )
              else
                ..._requests.map(_requestRow),
              const SizedBox(height: 24),
              const Text(
                'SELF-REPORTED SICKNESS & ABSENCES',
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.1, color: AppColors.textMuted),
              ),
              const SizedBox(height: 10),
              if (_absences.isEmpty)
                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: AppColors.surfaceDark,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: const Center(
                    child: Text(
                      'No sickness reports or absences on record.\nUse "Report Sickness / Absence" above if unwell or experiencing an emergency.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: AppColors.textMuted, fontSize: 12, height: 1.5),
                    ),
                  ),
                )
              else
                ..._absences.map(_absenceRow),
            ],
          ),
        ),
      );

  Widget _monthlyStatementTab() {
    if (_loadingMonthly && _monthlyReport == null) {
      return const Center(child: CircularProgressIndicator(color: AppColors.primary));
    }

    final r = _monthlyReport;
    if (r == null || r.blocked) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.info_outline, size: 48, color: AppColors.amber),
              const SizedBox(height: 12),
              Text(
                r?.blockedMessage ?? 'Monthly leave statement is not available yet.',
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4),
              ),
            ],
          ),
        ),
      );
    }

    String d(double v) => v.toStringAsFixed(2);

    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 720),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 90),
          children: [
            _monthSelectorCard(r),
            const SizedBox(height: 14),
            _plainEnglishBanner(r),
            const SizedBox(height: 16),
            _coreMetricsGrid(r, d),
            const SizedBox(height: 16),
            _usageBreakdownCard(r, d),
            const SizedBox(height: 16),
            _sufficiencyCard(r, d),
            const SizedBox(height: 16),
            _adjustmentsCard(r, d),
          ],
        ),
      ),
    );
  }

  Widget _monthSelectorCard(MonthlyLeaveReport r) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Row(
                children: [
                  Icon(Icons.event_note, size: 16, color: AppColors.primaryLight),
                  SizedBox(width: 8),
                  Text(
                    'STATEMENT PERIOD',
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.0, color: AppColors.textMuted),
                  ),
                ],
              ),
              if (_loadingMonthly)
                const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.primary)),
            ],
          ),
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
            decoration: BoxDecoration(
              color: AppColors.bgDark,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: AppColors.primary.withOpacity(0.3)),
            ),
            child: DropdownButtonHideUnderline(
              child: DropdownButton<String>(
                value: r.monthKey.isNotEmpty ? r.monthKey : null,
                isExpanded: true,
                dropdownColor: AppColors.surfaceDark,
                icon: const Icon(Icons.arrow_drop_down, color: AppColors.primaryLight),
                items: r.availableMonths.map((m) {
                  return DropdownMenuItem<String>(
                    value: m.monthKey,
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          m.label,
                          style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 13),
                        ),
                        if (m.isCurrent)
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: AppColors.teal.withOpacity(0.2),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: const Text(
                              'Current',
                              style: TextStyle(color: AppColors.teal, fontSize: 10, fontWeight: FontWeight.bold),
                            ),
                          ),
                      ],
                    ),
                  );
                }).toList(),
                onChanged: (val) {
                  if (val != null && val != _selectedMonthKey) {
                    setState(() {
                      _selectedMonthKey = val;
                      _loadingMonthly = true;
                    });
                    _loadMonthlyReport(val);
                  }
                },
              ),
            ),
          ),
          if (r.cycleStartDate != null && r.cycleEndDate != null) ...[
            const SizedBox(height: 8),
            Text(
              'Work Anniversary Cycle: ${r.cycleStartDate} → ${r.cycleEndDate} (Renews: ${r.nextRenewalDate ?? '--'})',
              style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
            ),
          ],
        ],
      ),
    );
  }

  Widget _plainEnglishBanner(MonthlyLeaveReport r) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            AppColors.primary.withOpacity(0.22),
            AppColors.surfaceDark,
          ],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.primary.withOpacity(0.45)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.2),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: AppColors.primary.withOpacity(0.25),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.lightbulb_outline, size: 20, color: AppColors.primaryLight),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  r.summaryExplanation,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    height: 1.4,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          const Divider(color: AppColors.border, height: 1),
          const SizedBox(height: 8),
          const Text(
            'This monthly statement updates automatically on the 1st of every month.',
            style: TextStyle(color: AppColors.textMuted, fontSize: 10.5),
          ),
        ],
      ),
    );
  }

  Widget _coreMetricsGrid(MonthlyLeaveReport r, String Function(double) d) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'ENTITLEMENT & ACCRUAL SUMMARY',
          style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.1, color: AppColors.textMuted),
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: _metricBox(
                label: 'Annual Entitlement',
                value: '${d(r.annualEntitlementDays)}d',
                subtext: 'Yearly base',
                icon: Icons.flag_outlined,
                color: Colors.white,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _metricBox(
                label: 'Accrued to Date',
                value: '${d(r.accruedUpToMonth)}d',
                subtext: 'Earned so far',
                icon: Icons.hourglass_top_outlined,
                color: AppColors.primaryLight,
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: _metricBox(
                label: 'Currently Entitled',
                value: '${d(r.currentlyEntitledPaidLeave)}d',
                subtext: 'Available without overdraft',
                icon: Icons.check_circle_outline,
                color: AppColors.teal,
                highlight: true,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _metricBox(
                label: 'Remaining Annual',
                value: '${d(r.remainingAnnualLeave)}d',
                subtext: 'Total year remaining',
                icon: Icons.event_available_outlined,
                color: Colors.white,
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _metricBox({
    required String label,
    required String value,
    required String subtext,
    required IconData icon,
    required Color color,
    bool highlight = false,
  }) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: highlight ? AppColors.teal.withOpacity(0.5) : AppColors.border,
          width: highlight ? 1.5 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(color: AppColors.textMuted, fontSize: 11, fontWeight: FontWeight.w500),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Icon(icon, size: 16, color: color.withOpacity(0.8)),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            value,
            style: TextStyle(color: color, fontSize: 22, fontWeight: FontWeight.bold, letterSpacing: -0.5),
          ),
          const SizedBox(height: 2),
          Text(
            subtext,
            style: const TextStyle(color: AppColors.textMuted, fontSize: 10),
          ),
        ],
      ),
    );
  }

  Widget _usageBreakdownCard(MonthlyLeaveReport r, String Function(double) d) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'LEAVE USAGE BREAKDOWN',
            style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.0, color: AppColors.textMuted),
          ),
          const SizedBox(height: 14),
          _usageRow(
            icon: Icons.payments_outlined,
            iconColor: AppColors.teal,
            title: 'Paid Leave Used',
            monthValue: '${d(r.monthPaidLeaveUsed)}d this month',
            cycleValue: '${d(r.cyclePaidLeaveUsed)}d cycle total',
          ),
          const Divider(color: AppColors.border, height: 20),
          _usageRow(
            icon: Icons.money_off_csred_outlined,
            iconColor: AppColors.amber,
            title: 'Unpaid Leave Taken',
            monthValue: '${d(r.monthUnpaidLeaveTaken)}d this month',
            cycleValue: '${d(r.cycleUnpaidLeaveTaken)}d cycle total',
          ),
          if (r.approvedCarryForwardDays > 0) ...[
            const Divider(color: AppColors.border, height: 20),
            _usageRow(
              icon: Icons.forward_outlined,
              iconColor: AppColors.primaryLight,
              title: 'Approved Carry-Forward',
              monthValue: '+${d(r.approvedCarryForwardDays)}d credited in cycle',
              cycleValue: 'Carried from previous cycle',
            ),
          ],
        ],
      ),
    );
  }

  Widget _usageRow({
    required IconData icon,
    required Color iconColor,
    required String title,
    required String monthValue,
    required String cycleValue,
  }) {
    return Row(
      children: [
        Container(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: iconColor.withOpacity(0.15),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Icon(icon, size: 18, color: iconColor),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 13)),
              const SizedBox(height: 2),
              Text(cycleValue, style: const TextStyle(color: AppColors.textMuted, fontSize: 11)),
            ],
          ),
        ),
        Text(
          monthValue,
          style: TextStyle(color: iconColor, fontWeight: FontWeight.bold, fontSize: 12),
        ),
      ],
    );
  }

  Widget _sufficiencyCard(MonthlyLeaveReport r, String Function(double) d) {
    final suff = r.requestedLeaveSufficiency;
    final isOk = suff.isSufficient;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: isOk ? AppColors.teal.withOpacity(0.4) : AppColors.amber.withOpacity(0.5),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'REQUESTED LEAVE SUFFICIENCY',
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.0, color: AppColors.textMuted),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: (isOk ? AppColors.teal : AppColors.amber).withOpacity(0.18),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      isOk ? Icons.check_circle_outline : Icons.warning_amber_rounded,
                      size: 13,
                      color: isOk ? AppColors.teal : AppColors.amber,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      isOk ? 'Sufficient Entitlement' : 'Advance / Overdraft Needed',
                      style: TextStyle(
                        color: isOk ? AppColors.teal : AppColors.amber,
                        fontSize: 10,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            suff.message,
            style: const TextStyle(color: Colors.white, fontSize: 12.5, height: 1.4),
          ),
          if (suff.pendingRequests.isNotEmpty) ...[
            const SizedBox(height: 12),
            const Divider(color: AppColors.border, height: 1),
            const SizedBox(height: 10),
            const Text(
              'PENDING APPLICATIONS EVALUATED:',
              style: TextStyle(color: AppColors.textMuted, fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 0.8),
            ),
            const SizedBox(height: 6),
            ...suff.pendingRequests.map(
              (p) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      '${p.startDate} → ${p.endDate} (${p.typeName})',
                      style: const TextStyle(color: Colors.white70, fontSize: 11),
                    ),
                    Text(
                      '${d(p.days)} days',
                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 11),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _adjustmentsCard(MonthlyLeaveReport r, String Function(double) d) {
    final adjs = r.monthAdjustments;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'LEAVE ADJUSTMENTS IN THIS MONTH',
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.0, color: AppColors.textMuted),
              ),
              if (r.totalMonthAdjustments != 0)
                Text(
                  r.totalMonthAdjustments > 0 ? '+${d(r.totalMonthAdjustments)}d' : '${d(r.totalMonthAdjustments)}d',
                  style: TextStyle(
                    color: r.totalMonthAdjustments > 0 ? AppColors.teal : AppColors.danger,
                    fontWeight: FontWeight.bold,
                    fontSize: 11,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 10),
          if (adjs.isEmpty)
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColors.bgDark,
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Row(
                children: [
                  Icon(Icons.tune_outlined, size: 16, color: AppColors.textMuted),
                  SizedBox(width: 8),
                  Text(
                    'No adjustments were recorded in this month.',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 11.5),
                  ),
                ],
              ),
            )
          else
            ...adjs.map((a) {
              final isPositive = a.days >= 0;
              return Container(
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.bgDark,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.border),
                ),
                child: Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: (isPositive ? AppColors.teal : AppColors.danger).withOpacity(0.18),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        isPositive ? '+${d(a.days)}d' : '${d(a.days)}d',
                        style: TextStyle(
                          color: isPositive ? AppColors.teal : AppColors.danger,
                          fontWeight: FontWeight.bold,
                          fontSize: 11.5,
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            a.description,
                            style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w500),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Date: ${a.date}${a.createdBy != null ? ' • by ${a.createdBy}' : ''}',
                            style: const TextStyle(color: AppColors.textMuted, fontSize: 10),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              );
            }),
        ],
      ),
    );
  }

  Widget _actionButtons() => Row(
        children: [
          Expanded(
            child: OutlinedButton.icon(
              onPressed: _openReportAbsence,
              style: OutlinedButton.styleFrom(
                side: BorderSide(color: AppColors.amber.withOpacity(0.8)),
                padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 10),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                backgroundColor: AppColors.amber.withOpacity(0.05),
              ),
              icon: const Icon(Icons.sick_outlined, size: 16, color: AppColors.amber),
              label: const Text(
                'Report Sickness / Absence',
                style: TextStyle(color: AppColors.amber, fontWeight: FontWeight.bold, fontSize: 12),
              ),
            ),
          ),
        ],
      );

  Widget _errorBanner(String msg) => Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppColors.danger.withOpacity(0.15),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppColors.danger.withOpacity(0.4)),
        ),
        child: Text(msg, style: const TextStyle(color: AppColors.danger, fontSize: 12)),
      );

  Widget _balanceCard(LeaveBalance b) {
    if (b.blocked) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.amber.withOpacity(0.15),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.amber.withOpacity(0.4)),
        ),
        child: Row(
          children: [
            const Icon(Icons.info_outline, color: AppColors.amber),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                b.blockedMessage ?? 'Your leave balance is not available yet.',
                style: const TextStyle(fontSize: 12, color: AppColors.amber, height: 1.4),
              ),
            ),
          ],
        ),
      );
    }

    String d(double v) => v.toStringAsFixed(2);
    final cycleStart = b.cycleStartDate ?? b.yearFrom;
    final cycleEnd = b.cycleEndDate ?? b.yearTo;
    final renewal = b.nextRenewalDate ?? b.renewalDate;

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.primary.withOpacity(0.35)),
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
              const Text(
                'AVAILABLE LEAVE',
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.0, color: AppColors.textMuted),
              ),
              if (renewal != null)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withOpacity(0.2),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppColors.primary.withOpacity(0.4)),
                  ),
                  child: Text(
                    'Renews: $renewal',
                    style: const TextStyle(color: AppColors.primaryLight, fontSize: 10, fontWeight: FontWeight.bold),
                  ),
                ),
            ],
          ),
          if (cycleStart != null && cycleEnd != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'Work Anniversary Cycle: $cycleStart → $cycleEnd',
                style: const TextStyle(color: AppColors.textMuted, fontSize: 10),
              ),
            ),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                d(b.available),
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 32,
                  fontWeight: FontWeight.bold,
                  letterSpacing: -0.5,
                ),
              ),
              const SizedBox(width: 8),
              const Text(
                'days available',
                style: TextStyle(color: AppColors.teal, fontWeight: FontWeight.bold, fontSize: 14),
              ),
            ],
          ),
          if (b.isNegative)
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Text(
                '⚠️ Negative balance: Leave taken in advance of monthly accruals.',
                style: TextStyle(color: AppColors.amber, fontSize: 11),
              ),
            ),
          if (b.dueToExpire > 0)
            Container(
              margin: const EdgeInsets.only(top: 10),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.amber.withOpacity(0.12),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppColors.amber.withOpacity(0.35)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.warning_amber_rounded, size: 16, color: AppColors.amber),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${d(b.dueToExpire)} days due to expire at cycle end. Management can approve up to 5 days to carry forward.',
                      style: const TextStyle(color: AppColors.amber, fontSize: 11, height: 1.3),
                    ),
                  ),
                ],
              ),
            ),
          const SizedBox(height: 16),
          // 8-Metric Breakdown Grid
          Container(
            padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
            decoration: BoxDecoration(
              color: AppColors.bgDark,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.border),
            ),
            child: Column(
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  children: [
                    _metric('Entitlement', '${d(b.annualEntitlement)}d'),
                    Container(width: 1, height: 26, color: AppColors.border),
                    _metric('Accrued', '${d(b.accrued)}d'),
                    Container(width: 1, height: 26, color: AppColors.border),
                    _metric('Taken', '${d(b.taken)}d'),
                    Container(width: 1, height: 26, color: AppColors.border),
                    _metric('Booked', '${d(b.booked)}d'),
                  ],
                ),
                const SizedBox(height: 10),
                const Divider(color: AppColors.border, height: 1),
                const SizedBox(height: 10),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  children: [
                    _metric('Carried In', '+${d(b.approvedCarryForward)}d'),
                    Container(width: 1, height: 26, color: AppColors.border),
                    _metric('Remaining', '${d(b.remainingCurrentCycle)}d'),
                    Container(width: 1, height: 26, color: AppColors.border),
                    _metric('Expiring', '${d(b.dueToExpire)}d'),
                    Container(width: 1, height: 26, color: AppColors.border),
                    _metric('Lapsed', '${d(b.alreadyLapsed)}d'),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _metric(String label, String value) => Column(
        children: [
          Text(value, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13)),
          const SizedBox(height: 2),
          Text(label, style: const TextStyle(color: AppColors.textMuted, fontSize: 10)),
        ],
      );

  Widget _requestRow(LeaveRequest r) {
    final (Color color, String label) = switch (r.status) {
      'APPROVED' => (AppColors.teal, 'Approved'),
      'REJECTED' => (AppColors.danger, 'Rejected'),
      'CANCELLED' => (AppColors.textMuted, 'Cancelled'),
      _ => (AppColors.amber, 'Pending Review'),
    };

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: color.withOpacity(0.15),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Icon(Icons.event_note, color: color, size: 18),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${r.type} · ${r.days.toStringAsFixed(r.days == r.days.roundToDouble() ? 0 : 1)} day(s)',
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Colors.white),
                ),
                const SizedBox(height: 2),
                Text('${r.from} → ${r.to}', style: const TextStyle(color: AppColors.textMuted, fontSize: 11)),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: color.withOpacity(0.15),
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: color.withOpacity(0.5)),
            ),
            child: Text(label, style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.bold)),
          ),
          if (r.isPending || r.isApproved)
            IconButton(
              icon: const Icon(Icons.close, size: 16),
              color: AppColors.textMuted,
              onPressed: () => _cancel(r),
              tooltip: 'Cancel',
            ),
        ],
      ),
    );
  }

  Widget _absenceRow(EmployeeAbsenceRecord a) {
    final bool isPending = a.status == 'PENDING_REVIEW';
    final bool isConfirmed = a.status == 'CONFIRMED';
    final Color color = isPending
        ? AppColors.amber
        : isConfirmed
            ? AppColors.danger
            : AppColors.teal;
    final String statusLabel = isPending
        ? 'Pending HR Review'
        : isConfirmed
            ? 'Confirmed Absence'
            : 'Excused / Dismissed';

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: color.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(
                  a.absenceType == 'SICK' ? Icons.sick_outlined : Icons.event_busy,
                  color: color,
                  size: 18,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${a.absenceType} · ${a.date}',
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Colors.white),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      a.reason?.isNotEmpty == true ? a.reason! : 'No explanation provided',
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
                    ),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: color.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: color.withOpacity(0.5)),
                ),
                child: Text(statusLabel, style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.bold)),
              ),
            ],
          ),
          if (a.documentTitle != null) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                const Icon(Icons.attach_file, size: 14, color: AppColors.primaryLight),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(
                    'Attached Evidence: ${a.documentTitle}',
                    style: const TextStyle(color: AppColors.primaryLight, fontSize: 11),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ],
          if (a.reviewNotes != null && a.reviewNotes!.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              'HR Note: "${a.reviewNotes}"',
              style: const TextStyle(color: Colors.white70, fontSize: 11, fontStyle: FontStyle.italic),
            ),
          ],
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Booking sheet
// ---------------------------------------------------------------------------

class _BookingSheet extends StatefulWidget {
  final ApiClient api;
  const _BookingSheet({required this.api});

  @override
  State<_BookingSheet> createState() => _BookingSheetState();
}

class _BookingSheetState extends State<_BookingSheet> {
  List<LeaveType> _types = const [];
  LeaveType? _type;
  DateTime? _from;
  DateTime? _to;
  final _reason = TextEditingController();

  LeavePreview? _preview;
  bool _loadingTypes = true;
  bool _submitting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.api.leaveTypes().then((t) {
      if (!mounted) return;
      setState(() {
        _types = t;
        _type = t.isNotEmpty ? t.first : null;
        _loadingTypes = false;
      });
    }).catchError((_) {
      if (mounted) setState(() => _loadingTypes = false);
    });
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  String _fmt(DateTime d) =>
      '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Future<void> _pick({required bool isStart}) async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: isStart ? (_from ?? now) : (_to ?? _from ?? now),
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 2),
    );
    if (picked == null) return;
    setState(() {
      if (isStart) {
        _from = picked;
        if (_to != null && _to!.isBefore(picked)) _to = picked;
      } else {
        _to = picked;
      }
    });
    _refreshPreview();
  }

  Future<void> _refreshPreview() async {
    if (_type == null || _from == null || _to == null) return;
    try {
      final p = await widget.api.previewLeave(
        leaveTypeId: _type!.id,
        startDate: _fmt(_from!),
        endDate: _fmt(_to!),
      );
      if (mounted) setState(() { _preview = p; _error = null; });
    } on ApiException catch (e) {
      if (mounted) setState(() { _preview = null; _error = e.message; });
    }
  }

  Future<void> _submit() async {
    if (_type == null || _from == null || _to == null) return;
    setState(() => _submitting = true);
    try {
      await widget.api.requestLeave(
        leaveTypeId: _type!.id,
        startDate: _fmt(_from!),
        endDate: _fmt(_to!),
        reason: _reason.text.trim().isEmpty ? null : _reason.text.trim(),
      );
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) setState(() { _error = e.message; _submitting = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 20, right: 20, top: 20,
        bottom: MediaQuery.of(context).viewInsets.bottom + 20,
      ),
      child: _loadingTypes
          ? const Padding(
              padding: EdgeInsets.all(40),
              child: Center(child: CircularProgressIndicator(color: AppColors.primary)),
            )
          : Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text('Apply for Leave', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.white)),
                    IconButton(
                      icon: const Icon(Icons.close, color: AppColors.textMuted),
                      onPressed: () => Navigator.pop(context),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                const Text('Leave Category', style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                DropdownButtonFormField<LeaveType>(
                  value: _type,
                  dropdownColor: AppColors.surfaceDark,
                  decoration: const InputDecoration(contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 10)),
                  items: _types
                      .map((t) => DropdownMenuItem(value: t, child: Text(t.name, style: const TextStyle(color: Colors.white, fontSize: 13))))
                      .toList(),
                  onChanged: (t) {
                    setState(() => _type = t);
                    _refreshPreview();
                  },
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(child: _dateField('From Date', _from, () => _pick(isStart: true))),
                    const SizedBox(width: 12),
                    Expanded(child: _dateField('To Date', _to, () => _pick(isStart: false))),
                  ],
                ),
                const SizedBox(height: 14),
                const Text('Reason / Explanation', style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                TextField(
                  controller: _reason,
                  style: const TextStyle(color: Colors.white, fontSize: 13),
                  decoration: InputDecoration(
                    hintText: _type?.requiresEvidence == true ? 'Reason (required)' : 'Reason (optional)',
                    hintStyle: const TextStyle(color: Colors.white30),
                  ),
                  maxLines: 2,
                ),
                if (_preview != null) ...[
                  const SizedBox(height: 14),
                  _previewCard(_preview!),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!, style: const TextStyle(color: AppColors.danger, fontSize: 12)),
                ],
                const SizedBox(height: 20),
                SizedBox(
                  height: 46,
                  child: FilledButton(
                    onPressed: (_submitting || _preview == null) ? null : _submit,
                    style: FilledButton.styleFrom(backgroundColor: AppColors.primary),
                    child: _submitting
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                        : const Text('Submit Application to HR', style: TextStyle(fontWeight: FontWeight.bold)),
                  ),
                ),
              ],
            ),
    );
  }

  Widget _dateField(String label, DateTime? value, VoidCallback onTap) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          InkWell(
            onTap: onTap,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                color: AppColors.bgDark,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.border),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(value == null ? 'Select Date' : _fmt(value), style: TextStyle(color: value == null ? AppColors.textMuted : Colors.white, fontSize: 13)),
                  const Icon(Icons.calendar_today, size: 14, color: AppColors.primaryLight),
                ],
              ),
            ),
          ),
        ],
      );

  Widget _previewCard(LeavePreview p) {
    final over = p.exceedsBalance;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: over ? AppColors.amber.withOpacity(0.15) : AppColors.teal.withOpacity(0.15),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: over ? AppColors.amber.withOpacity(0.4) : AppColors.teal.withOpacity(0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${p.requestedDays.toStringAsFixed(p.requestedDays == p.requestedDays.roundToDouble() ? 0 : 1)} working day(s) requested',
            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Colors.white),
          ),
          const SizedBox(height: 2),
          Text(
            'Projected Available Balance: ${p.projectedAvailable.toStringAsFixed(2)} days',
            style: TextStyle(fontSize: 12, color: over ? AppColors.amber : AppColors.teal),
          ),
          if (p.warning != null) ...[
            const SizedBox(height: 6),
            Text(p.warning!, style: const TextStyle(fontSize: 11, color: AppColors.amber)),
          ],
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Sickness & Emergency Absence Self-Reporting Sheet (Spec 2.2 & 10)
// ---------------------------------------------------------------------------

class _ReportAbsenceSheet extends StatefulWidget {
  final ApiClient api;
  const _ReportAbsenceSheet({required this.api});

  @override
  State<_ReportAbsenceSheet> createState() => _ReportAbsenceSheetState();
}

class _ReportAbsenceSheetState extends State<_ReportAbsenceSheet> {
  final _reason = TextEditingController();
  DateTime _date = DateTime.now();
  String _absenceType = 'SICK';
  bool _submitting = false;
  String? _error;
  List<EmployeeDocument> _documents = const [];
  String? _selectedDocumentId;
  bool _loadingDocs = true;

  @override
  void initState() {
    super.initState();
    _loadDocs();
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _loadDocs() async {
    try {
      final docs = await widget.api.myDocuments();
      if (mounted) setState(() { _documents = docs; _loadingDocs = false; });
    } catch (_) {
      if (mounted) setState(() => _loadingDocs = false);
    }
  }

  String _fmt(DateTime d) =>
      '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(now.year - 1),
      lastDate: now.add(const Duration(days: 7)),
    );
    if (picked != null && mounted) {
      setState(() => _date = picked);
    }
  }

  Future<void> _submit() async {
    if (_reason.text.trim().isEmpty) {
      setState(() => _error = 'Please provide a brief reason or symptoms description.');
      return;
    }

    setState(() { _submitting = true; _error = null; });
    try {
      await widget.api.selfReportAbsence(
        dateKey: _fmt(_date),
        absenceType: _absenceType,
        reason: _reason.text.trim(),
        evidenceDocumentId: _selectedDocumentId,
      );
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) setState(() { _error = e.message; _submitting = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 20, right: 20, top: 20,
        bottom: MediaQuery.of(context).viewInsets.bottom + 20,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'Report Sickness / Absence',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.white),
              ),
              IconButton(
                icon: const Icon(Icons.close, color: AppColors.textMuted),
                onPressed: () => Navigator.pop(context),
              ),
            ],
          ),
          const SizedBox(height: 6),
          const Text(
            'Submitting a self-report notifies HR immediately so your absence is recorded and not treated as an unexcused no-show.',
            style: TextStyle(color: AppColors.textMuted, fontSize: 11, height: 1.4),
          ),
          const SizedBox(height: 16),
          const Text('Absence Category', style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          DropdownButtonFormField<String>(
            value: _absenceType,
            dropdownColor: AppColors.surfaceDark,
            decoration: const InputDecoration(contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 10)),
            items: const [
              DropdownMenuItem(value: 'SICK', child: Text('🤒 Sickness / Flu', style: TextStyle(color: Colors.white, fontSize: 13))),
              DropdownMenuItem(value: 'MEDICAL', child: Text('🏥 Medical Appointment', style: TextStyle(color: Colors.white, fontSize: 13))),
              DropdownMenuItem(value: 'EMERGENCY', child: Text('🚨 Urgent Emergency', style: TextStyle(color: Colors.white, fontSize: 13))),
              DropdownMenuItem(value: 'OTHER', child: Text('📋 Other Unplanned Absence', style: TextStyle(color: Colors.white, fontSize: 13))),
            ],
            onChanged: (val) {
              if (val != null) setState(() => _absenceType = val);
            },
          ),
          const SizedBox(height: 14),
          const Text('Absence Date', style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          InkWell(
            onTap: _pickDate,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                color: AppColors.bgDark,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.border),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(_fmt(_date), style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w500)),
                  const Icon(Icons.calendar_today, size: 14, color: AppColors.primaryLight),
                ],
              ),
            ),
          ),
          const SizedBox(height: 14),
          const Text('Reason & Symptoms (Required)', style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          TextField(
            controller: _reason,
            style: const TextStyle(color: Colors.white, fontSize: 13),
            decoration: const InputDecoration(
              hintText: 'e.g. High fever and nausea, unable to come to the office today...',
              hintStyle: TextStyle(color: Colors.white30),
            ),
            maxLines: 2,
          ),
          if (!_loadingDocs && _documents.isNotEmpty) ...[
            const SizedBox(height: 14),
            const Text('Attach Evidence / Certificate (Optional)', style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            DropdownButtonFormField<String?>(
              value: _selectedDocumentId,
              dropdownColor: AppColors.surfaceDark,
              decoration: const InputDecoration(contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 10)),
              items: [
                const DropdownMenuItem(value: null, child: Text('None / Will provide later', style: TextStyle(color: AppColors.textMuted, fontSize: 13))),
                ..._documents.map(
                  (d) => DropdownMenuItem(value: d.id, child: Text(d.title, style: const TextStyle(color: Colors.white, fontSize: 13))),
                ),
              ],
              onChanged: (id) => setState(() => _selectedDocumentId = id),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: AppColors.danger, fontSize: 12)),
          ],
          const SizedBox(height: 20),
          SizedBox(
            height: 46,
            child: FilledButton(
              onPressed: _submitting ? null : _submit,
              style: FilledButton.styleFrom(backgroundColor: AppColors.amber),
              child: _submitting
                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(color: Colors.black, strokeWidth: 2))
                  : const Text('Submit Absence Report to HR', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.black)),
            ),
          ),
        ],
      ),
    );
  }
}
