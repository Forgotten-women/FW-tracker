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
  List<BankHoliday> _bankHolidays = const [];
  int _selectedTab = 0; // 0: Overview, 1: Monthly Statement, 2: Public Holidays
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
      final leaveFuture = _api.myLeave();
      final absFuture = _api.myAbsences().catchError((_) => <EmployeeAbsenceRecord>[]);
      final reportFuture = _api.fetchMonthlyLeaveReport(month: _selectedMonthKey).catchError((_) => null);
      final holidaysFuture = _api.fetchBankHolidays().catchError((_) => <BankHoliday>[]);

      final leaveData = await leaveFuture;
      final absList = await absFuture;
      final report = await reportFuture;
      final holidays = await holidaysFuture;

      if (!mounted) return;

      setState(() {
        _balance = leaveData['balance'] as LeaveBalance;
        _requests = (leaveData['requests'] as List).cast<LeaveRequest>();
        _absences = absList;
        if (report != null) {
          _monthlyReport = report;
          _selectedMonthKey ??= report.monthKey;
        }
        _bankHolidays = holidays;
        _error = null;
      });

      try {
        await NotificationService().checkAndDispatchUnseenNotifications();
      } catch (_) {}
    } catch (_) {}
  }

  Future<void> _load() async {
    try {
      final leaveFuture = _api.myLeave();
      final absFuture = _api.myAbsences().catchError((_) => <EmployeeAbsenceRecord>[]);
      final reportFuture = _api.fetchMonthlyLeaveReport(month: _selectedMonthKey).catchError((_) => null);
      final holidaysFuture = _api.fetchBankHolidays().catchError((_) => <BankHoliday>[]);

      final leaveData = await leaveFuture;
      final absList = await absFuture;
      final report = await reportFuture;
      final holidays = await holidaysFuture;

      if (!mounted) return;

      setState(() {
        _balance = leaveData['balance'] as LeaveBalance;
        _requests = (leaveData['requests'] as List).cast<LeaveRequest>();
        _absences = absList;
        if (report != null) {
          _monthlyReport = report;
          _selectedMonthKey ??= report.monthKey;
        }
        _bankHolidays = holidays;
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
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'Could not load leave data: $e';
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
      backgroundColor: AppColors.sheet,
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
      backgroundColor: AppColors.sheet,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => _ReportAbsenceSheet(api: _api),
    );
    if (reported == true) _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: Text('Leave & Time Off', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17, color: AppColors.textPrimary)),
        actions: [
          IconButton(
            icon: Icon(Icons.refresh, color: AppColors.textSecondary),
            onPressed: _loading ? null : _load,
          ),
        ],
      ),
      floatingActionButton: (_selectedTab == 0 && _balance != null && !_balance!.blocked)
          ? FloatingActionButton.extended(
              onPressed: _openBooking,
              backgroundColor: AppColors.primary,
              icon: const Icon(Icons.add, color: AppColors.onAccent),
              label: const Text('Apply for Leave', style: TextStyle(color: AppColors.onAccent, fontWeight: FontWeight.bold)),
            )
          : null,
      body: Column(
        children: [
          _tabSelector(),
          Expanded(
            child: _loading
                ? Center(child: CircularProgressIndicator(color: AppColors.primary))
                : RefreshIndicator(
                    color: AppColors.primary,
                    onRefresh: _load,
                    child: _selectedTab == 0
                        ? _overviewTab()
                        : (_selectedTab == 1 ? _monthlyStatementTab() : _bankHolidaysTab()),
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
                        Icon(Icons.dashboard_outlined, size: 14, color: _selectedTab == 0 ? AppColors.onAccent : AppColors.textMuted),
                        const SizedBox(width: 4),
                        Text(
                          'Overview',
                          style: TextStyle(
                            color: _selectedTab == 0 ? AppColors.onAccent : AppColors.textMuted,
                            fontWeight: _selectedTab == 0 ? FontWeight.bold : FontWeight.normal,
                            fontSize: 12,
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
                        Icon(Icons.calendar_month_outlined, size: 14, color: _selectedTab == 1 ? AppColors.onAccent : AppColors.textMuted),
                        const SizedBox(width: 4),
                        Text(
                          'Statement',
                          style: TextStyle(
                            color: _selectedTab == 1 ? AppColors.onAccent : AppColors.textMuted,
                            fontWeight: _selectedTab == 1 ? FontWeight.bold : FontWeight.normal,
                            fontSize: 12,
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
                onTap: () => setState(() => _selectedTab = 2),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  decoration: BoxDecoration(
                    color: _selectedTab == 2 ? AppColors.primary : Colors.transparent,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Center(
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.beach_access_outlined, size: 14, color: _selectedTab == 2 ? AppColors.onAccent : AppColors.textMuted),
                        const SizedBox(width: 4),
                        Text(
                          'Holidays (${_bankHolidays.length})',
                          style: TextStyle(
                            color: _selectedTab == 2 ? AppColors.onAccent : AppColors.textMuted,
                            fontWeight: _selectedTab == 2 ? FontWeight.bold : FontWeight.normal,
                            fontSize: 12,
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
              Text(
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
                  child: Center(
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
              Text(
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
                  child: Center(
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
      return Center(child: CircularProgressIndicator(color: AppColors.primary));
    }

    final r = _monthlyReport;
    if (r == null || r.blocked) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.info_outline, size: 48, color: AppColors.amber),
              const SizedBox(height: 12),
              Text(
                r?.blockedMessage ?? 'Monthly leave statement is not available yet.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4),
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
              Row(
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
                SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.primary)),
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
                dropdownColor: AppColors.sheet,
                icon: Icon(Icons.arrow_drop_down, color: AppColors.primaryLight),
                items: r.availableMonths.map((m) {
                  return DropdownMenuItem<String>(
                    value: m.monthKey,
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          m.label,
                          style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w600, fontSize: 13),
                        ),
                        if (m.isCurrent)
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: AppColors.teal.withOpacity(0.2),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
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
              style: TextStyle(color: AppColors.textMuted, fontSize: 11),
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
            color: AppColors.shadow,
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
                child: Icon(Icons.lightbulb_outline, size: 20, color: AppColors.primaryLight),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  r.summaryExplanation,
                  style: TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    height: 1.4,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Divider(color: AppColors.border, height: 1),
          const SizedBox(height: 8),
          Text(
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
        Text(
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
                color: AppColors.textPrimary,
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
                color: AppColors.textPrimary,
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
                  style: TextStyle(color: AppColors.textMuted, fontSize: 11, fontWeight: FontWeight.w500),
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
            style: TextStyle(color: AppColors.textMuted, fontSize: 10),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
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
          Text(
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
          Divider(color: AppColors.border, height: 20),
          _usageRow(
            icon: Icons.money_off_csred_outlined,
            iconColor: AppColors.amber,
            title: 'Unpaid Leave Taken',
            monthValue: '${d(r.monthUnpaidLeaveTaken)}d this month',
            cycleValue: '${d(r.cycleUnpaidLeaveTaken)}d cycle total',
          ),
          if (r.approvedCarryForwardDays > 0) ...[
            Divider(color: AppColors.border, height: 20),
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
              Text(title, style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w600, fontSize: 13)),
              const SizedBox(height: 2),
              Text(cycleValue, style: TextStyle(color: AppColors.textMuted, fontSize: 11)),
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
              Expanded(
                child: Text(
                  'REQUESTED LEAVE SUFFICIENCY',
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.0, color: AppColors.textMuted),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 8),
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
                      isOk ? 'Sufficient' : 'Advance Needed',
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
            style: TextStyle(color: AppColors.textPrimary, fontSize: 12.5, height: 1.4),
          ),
          if (suff.pendingRequests.isNotEmpty) ...[
            const SizedBox(height: 12),
            Divider(color: AppColors.border, height: 1),
            const SizedBox(height: 10),
            Text(
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
                    Expanded(
                      child: Text(
                        '${p.startDate} → ${p.endDate} (${p.typeName})',
                        style: TextStyle(color: AppColors.textSecondary, fontSize: 11),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '${d(p.days)} days',
                      style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.bold, fontSize: 11),
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
              Expanded(
                child: Text(
                  'LEAVE ADJUSTMENTS IN THIS MONTH',
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.0, color: AppColors.textMuted),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (r.totalMonthAdjustments != 0) ...[
                const SizedBox(width: 8),
                Text(
                  r.totalMonthAdjustments > 0 ? '+${d(r.totalMonthAdjustments)}d' : '${d(r.totalMonthAdjustments)}d',
                  style: TextStyle(
                    color: r.totalMonthAdjustments > 0 ? AppColors.teal : AppColors.danger,
                    fontWeight: FontWeight.bold,
                    fontSize: 11,
                  ),
                ),
              ],
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
              child: Row(
                children: [
                  Icon(Icons.tune_outlined, size: 16, color: AppColors.textMuted),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'No adjustments were recorded in this month.',
                      style: TextStyle(color: AppColors.textMuted, fontSize: 11.5),
                    ),
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
                            style: TextStyle(color: AppColors.textPrimary, fontSize: 12, fontWeight: FontWeight.w500),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Date: ${a.date}${a.createdBy != null ? ' • by ${a.createdBy}' : ''}',
                            style: TextStyle(color: AppColors.textMuted, fontSize: 10),
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
              icon: Icon(Icons.sick_outlined, size: 16, color: AppColors.amber),
              label: Text(
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
        child: Text(msg, style: TextStyle(color: AppColors.danger, fontSize: 12)),
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
            Icon(Icons.info_outline, color: AppColors.amber),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                b.blockedMessage ?? 'Your leave balance is not available yet.',
                style: TextStyle(fontSize: 12, color: AppColors.amber, height: 1.4),
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
            color: AppColors.shadow,
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
              Expanded(
                child: Text(
                  'AVAILABLE LEAVE',
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.0, color: AppColors.textMuted),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (renewal != null) ...[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withOpacity(0.2),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppColors.primary.withOpacity(0.4)),
                  ),
                  child: Text(
                    'Renews: $renewal',
                    style: TextStyle(color: AppColors.primaryLight, fontSize: 10, fontWeight: FontWeight.bold),
                  ),
                ),
              ],
            ],
          ),
          if (cycleStart != null && cycleEnd != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'Work Anniversary Cycle: $cycleStart → $cycleEnd',
                style: TextStyle(color: AppColors.textMuted, fontSize: 10),
              ),
            ),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                d(b.available),
                style: TextStyle(
                  color: AppColors.textPrimary,
                  fontSize: 32,
                  fontWeight: FontWeight.bold,
                  letterSpacing: -0.5,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                'days available',
                style: TextStyle(color: AppColors.teal, fontWeight: FontWeight.bold, fontSize: 14),
              ),
            ],
          ),
          if (b.isNegative)
            Padding(
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
                  Icon(Icons.warning_amber_rounded, size: 16, color: AppColors.amber),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${d(b.dueToExpire)} days due to expire at cycle end. Management can approve up to 5 days to carry forward.',
                      style: TextStyle(color: AppColors.amber, fontSize: 11, height: 1.3),
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
                Divider(color: AppColors.border, height: 1),
                const SizedBox(height: 10),
                Row(
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

  Widget _metric(String label, String value) => Expanded(
        child: Column(
          children: [
            Text(
              value,
              style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.bold, fontSize: 12.5),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 2),
            Text(
              label,
              style: TextStyle(color: AppColors.textMuted, fontSize: 9.5),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
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
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: AppColors.textPrimary),
                ),
                const SizedBox(height: 2),
                Text('${r.from} → ${r.to}', style: TextStyle(color: AppColors.textMuted, fontSize: 11)),
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
                      style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: AppColors.textPrimary),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      a.reason?.isNotEmpty == true ? a.reason! : 'No explanation provided',
                      style: TextStyle(color: AppColors.textMuted, fontSize: 11),
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
                Icon(Icons.attach_file, size: 14, color: AppColors.primaryLight),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(
                    'Attached Evidence: ${a.documentTitle}',
                    style: TextStyle(color: AppColors.primaryLight, fontSize: 11),
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
              style: TextStyle(color: AppColors.textSecondary, fontSize: 11, fontStyle: FontStyle.italic),
            ),
          ],
        ],
      ),
    );
  }

  Widget _bankHolidaysTab() {
    final year = DateTime.now().year;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        // Organisation Policy Card
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              colors: [
                AppColors.primary.withOpacity(0.25),
                AppColors.surfaceDark,
              ],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.primary.withOpacity(0.4)),
            boxShadow: [
              BoxShadow(
                color: AppColors.shadow,
                blurRadius: 10,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withOpacity(0.25),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(Icons.beach_access, size: 20, color: AppColors.primaryLight),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Annual Bank Holidays Policy',
                          style: TextStyle(
                            color: AppColors.textPrimary,
                            fontSize: 15,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '5 Designated Organisation Public Holidays ($year)',
                          style: TextStyle(
                            color: AppColors.primaryLight,
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: Colors.amber.withOpacity(0.15),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: Colors.amber.withOpacity(0.4)),
                    ),
                    child: const Text(
                      'HR Set',
                      style: TextStyle(
                        color: Colors.amberAccent,
                        fontSize: 10,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Text(
                'Our organisation designates exactly 5 approved public holidays each year. These dates are approved in advance and have special entitlement rules:',
                style: TextStyle(color: AppColors.textSecondary, fontSize: 12, height: 1.4),
              ),
              const SizedBox(height: 10),
              _policyBullet(Icons.check_circle_outline, 'Paid Day Off: 7.5h credited to your monthly required working hours target.'),
              const SizedBox(height: 5),
              _policyBullet(Icons.shield_outlined, 'No Leave Deduction: Never reduces or deducts from your 20-day annual leave balance.'),
              const SizedBox(height: 5),
              _policyBullet(Icons.alarm_off_outlined, 'No Absence Trigger: Automatically excluded from morning absence monitoring.'),
              const SizedBox(height: 5),
              _policyBullet(Icons.lock_outline, 'HR Configured: Exact approved dates & titles are managed strictly by HR each year.'),
            ],
          ),
        ),

        const SizedBox(height: 18),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              'DESIGNATED HOLIDAYS (${_bankHolidays.length})',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.bold,
                letterSpacing: 1.1,
                color: AppColors.textMuted,
              ),
            ),
            Text(
              'Visible in Advance',
              style: TextStyle(fontSize: 11, color: AppColors.textMuted),
            ),
          ],
        ),
        const SizedBox(height: 10),

        if (_bankHolidays.isEmpty)
          Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              color: AppColors.surfaceDark,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.border),
            ),
            child: Center(
              child: Text(
                'No bank holidays found for this year.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 13),
              ),
            ),
          )
        else
          ..._bankHolidays.asMap().entries.map((entry) {
            final idx = entry.key;
            final h = entry.value;
            return _bankHolidayCard(idx + 1, h);
          }),
      ],
    );
  }

  Widget _policyBullet(IconData icon, String text) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 14, color: AppColors.primaryLight),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: TextStyle(color: AppColors.textSecondary, fontSize: 11.5, height: 1.3),
          ),
        ),
      ],
    );
  }

  Widget _bankHolidayCard(int index, BankHoliday h) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.primary.withOpacity(0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: AppColors.primary.withOpacity(0.2),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  '#$index',
                  style: TextStyle(
                    color: AppColors.primaryLight,
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  h.name,
                  style: TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: AppColors.teal.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: AppColors.teal.withOpacity(0.3)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.check, size: 11, color: AppColors.teal),
                    SizedBox(width: 3),
                    Text(
                      'Paid Off',
                      style: TextStyle(
                        color: AppColors.teal,
                        fontSize: 10.5,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Icon(Icons.calendar_today_outlined, size: 13, color: AppColors.textMuted),
              const SizedBox(width: 6),
              Text(
                h.date,
                style: TextStyle(
                  color: AppColors.textPrimary,
                  fontFamily: 'monospace',
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '·  ${h.weekday}',
                style: TextStyle(color: AppColors.textMuted, fontSize: 12),
              ),
            ],
          ),
          if (h.notes != null && h.notes!.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              h.notes!,
              style: TextStyle(color: AppColors.textSecondary, fontSize: 11),
            ),
          ],
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: AppColors.overlay(0.04),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Row(
              children: [
                Icon(Icons.star_outline, size: 12, color: AppColors.primaryLight),
                SizedBox(width: 5),
                Text(
                  '0 Annual Leave Deducted · 7.5h Monthly Target Credit',
                  style: TextStyle(color: AppColors.textSecondary, fontSize: 10.5),
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
          ? Padding(
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
                    Text('Apply for Leave', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.textPrimary)),
                    IconButton(
                      icon: Icon(Icons.close, color: AppColors.textMuted),
                      onPressed: () => Navigator.pop(context),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                Text('Leave Category', style: TextStyle(color: AppColors.textSecondary, fontSize: 12, fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                DropdownButtonFormField<LeaveType>(
                  value: _type,
                  dropdownColor: AppColors.sheet,
                  decoration: const InputDecoration(contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 10)),
                  items: _types
                      .map((t) => DropdownMenuItem(value: t, child: Text(t.name, style: TextStyle(color: AppColors.textPrimary, fontSize: 13))))
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
                Text('Reason / Explanation', style: TextStyle(color: AppColors.textSecondary, fontSize: 12, fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                TextField(
                  controller: _reason,
                  style: TextStyle(color: AppColors.textPrimary, fontSize: 13),
                  decoration: InputDecoration(
                    hintText: _type?.requiresEvidence == true ? 'Reason (required)' : 'Reason (optional)',
                    hintStyle: TextStyle(color: AppColors.textTertiary),
                  ),
                  maxLines: 2,
                ),
                if (_preview != null) ...[
                  const SizedBox(height: 14),
                  _previewCard(_preview!),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!, style: TextStyle(color: AppColors.danger, fontSize: 12)),
                ],
                const SizedBox(height: 20),
                SizedBox(
                  height: 46,
                  child: FilledButton(
                    onPressed: (_submitting || _preview == null) ? null : _submit,
                    style: FilledButton.styleFrom(backgroundColor: AppColors.primary),
                    child: _submitting
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(color: AppColors.onAccent, strokeWidth: 2))
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
          Text(label, style: TextStyle(color: AppColors.textSecondary, fontSize: 12, fontWeight: FontWeight.w600)),
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
                  Text(value == null ? 'Select Date' : _fmt(value), style: TextStyle(color: value == null ? AppColors.textMuted : AppColors.textPrimary, fontSize: 13)),
                  Icon(Icons.calendar_today, size: 14, color: AppColors.primaryLight),
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
            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: AppColors.textPrimary),
          ),
          const SizedBox(height: 2),
          Text(
            'Projected Available Balance: ${p.projectedAvailable.toStringAsFixed(2)} days',
            style: TextStyle(fontSize: 12, color: over ? AppColors.amber : AppColors.teal),
          ),
          if (p.warning != null) ...[
            const SizedBox(height: 6),
            Text(p.warning!, style: TextStyle(fontSize: 11, color: AppColors.amber)),
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
              Text(
                'Report Sickness / Absence',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.textPrimary),
              ),
              IconButton(
                icon: Icon(Icons.close, color: AppColors.textMuted),
                onPressed: () => Navigator.pop(context),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'Submitting a self-report notifies HR immediately so your absence is recorded and not treated as an unexcused no-show.',
            style: TextStyle(color: AppColors.textMuted, fontSize: 11, height: 1.4),
          ),
          const SizedBox(height: 16),
          Text('Absence Category', style: TextStyle(color: AppColors.textSecondary, fontSize: 12, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          DropdownButtonFormField<String>(
            value: _absenceType,
            dropdownColor: AppColors.sheet,
            decoration: const InputDecoration(contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 10)),
            items: [
              DropdownMenuItem(value: 'SICK', child: Text('🤒 Sickness / Flu', style: TextStyle(color: AppColors.textPrimary, fontSize: 13))),
              DropdownMenuItem(value: 'MEDICAL', child: Text('🏥 Medical Appointment', style: TextStyle(color: AppColors.textPrimary, fontSize: 13))),
              DropdownMenuItem(value: 'EMERGENCY', child: Text('🚨 Urgent Emergency', style: TextStyle(color: AppColors.textPrimary, fontSize: 13))),
              DropdownMenuItem(value: 'OTHER', child: Text('📋 Other Unplanned Absence', style: TextStyle(color: AppColors.textPrimary, fontSize: 13))),
            ],
            onChanged: (val) {
              if (val != null) setState(() => _absenceType = val);
            },
          ),
          const SizedBox(height: 14),
          Text('Absence Date', style: TextStyle(color: AppColors.textSecondary, fontSize: 12, fontWeight: FontWeight.w600)),
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
                  Text(_fmt(_date), style: TextStyle(color: AppColors.textPrimary, fontSize: 13, fontWeight: FontWeight.w500)),
                  Icon(Icons.calendar_today, size: 14, color: AppColors.primaryLight),
                ],
              ),
            ),
          ),
          const SizedBox(height: 14),
          Text('Reason & Symptoms (Required)', style: TextStyle(color: AppColors.textSecondary, fontSize: 12, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          TextField(
            controller: _reason,
            style: TextStyle(color: AppColors.textPrimary, fontSize: 13),
            decoration: InputDecoration(
              hintText: 'e.g. High fever and nausea, unable to come to the office today...',
              hintStyle: TextStyle(color: AppColors.textTertiary),
            ),
            maxLines: 2,
          ),
          if (!_loadingDocs && _documents.isNotEmpty) ...[
            const SizedBox(height: 14),
            Text('Attach Evidence / Certificate (Optional)', style: TextStyle(color: AppColors.textSecondary, fontSize: 12, fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            DropdownButtonFormField<String?>(
              value: _selectedDocumentId,
              dropdownColor: AppColors.sheet,
              decoration: const InputDecoration(contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 10)),
              items: [
                DropdownMenuItem(value: null, child: Text('None / Will provide later', style: TextStyle(color: AppColors.textMuted, fontSize: 13))),
                ..._documents.map(
                  (d) => DropdownMenuItem(value: d.id, child: Text(d.title, style: TextStyle(color: AppColors.textPrimary, fontSize: 13))),
                ),
              ],
              onChanged: (id) => setState(() => _selectedDocumentId = id),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: TextStyle(color: AppColors.danger, fontSize: 12)),
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
