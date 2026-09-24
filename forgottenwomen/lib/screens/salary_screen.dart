import 'dart:async';

import 'package:flutter/material.dart';

import '../models/hr.dart';
import '../models/payroll.dart';
import '../services/api_client.dart';
import '../services/payslip_watcher.dart';
import '../theme.dart';
import '../widgets/glass/glass.dart';
import '../widgets/payroll/estimate_card.dart';
import '../widgets/payroll/payslip_widgets.dart';
import 'payslip_detail_screen.dart';

/// The Salary tab: this month's running estimate, then every published
/// payslip (and legacy CLOSED month), newest first. Everything comes from
/// GET /api/payroll/mine/statements; the server decides what is visible
/// (`enabled`) and says why when it isn't.
class SalaryScreen extends StatefulWidget {
  /// Defaults to a client of the screen's own (disposed with it).
  final ApiClient? api;

  const SalaryScreen({super.key, this.api});

  /// Forgets the in-memory statements, as a fresh launch would.
  @visibleForTesting
  static void clearCache() {
    _SalaryScreenState._cachedStatement = null;
    _SalaryScreenState._cachedAt = null;
  }

  @override
  State<SalaryScreen> createState() => _SalaryScreenState();
}

class _SalaryScreenState extends State<SalaryScreen> {
  late final ApiClient _api = widget.api ?? ApiClient();

  // The last statements loaded, kept for the life of the app so the tab
  // shows them at once and still has something to show offline. In memory
  // only, on purpose: pay figures are not written to SharedPreferences,
  // which is plaintext on disk.
  static EmployeePayrollStatement? _cachedStatement;
  static DateTime? _cachedAt;

  EmployeePayrollStatement? _statement;
  bool _loading = false;
  String? _error;
  bool _offline = false;

  // Right after a payslip is published the home summary can already report
  // it while the statements response (cached server-side for up to a
  // minute) does not yet. A few spaced retries close that gap.
  Timer? _staleTimer;
  int _staleRetries = 0;

  @override
  void initState() {
    super.initState();
    _statement = _cachedStatement;
    PayslipWatcher.latestPublishedAt.addListener(_onPayslipSeen);
    PayslipWatcher.refreshRequests.addListener(_onRefreshRequested);
    _loading = true;
    _load();
  }

  @override
  void dispose() {
    PayslipWatcher.latestPublishedAt.removeListener(_onPayslipSeen);
    PayslipWatcher.refreshRequests.removeListener(_onRefreshRequested);
    _staleTimer?.cancel();
    if (widget.api == null) _api.dispose();
    super.dispose();
  }

  void _onPayslipSeen() {
    final seen = PayslipWatcher.latestPublishedAt.value;
    final have = _statement?.latestPayslip?.publishedAt ?? 0;
    if (seen != null && seen > have) {
      _staleRetries = 0;
      _load();
    }
  }

  void _onRefreshRequested() {
    _staleRetries = 0;
    _load();
  }

  // One request at a time: a refresh asked for while one is running is
  // answered by that one.
  bool _requestInFlight = false;

  Future<void> _load() async {
    if (_requestInFlight || !mounted) return;
    _requestInFlight = true;
    if (!_loading) setState(() => _loading = true);
    try {
      final res = await _api.fetchMyPayrollStatements();
      _cachedStatement = res;
      _cachedAt = DateTime.now();
      if (!mounted) return;
      setState(() {
        _statement = res;
        _error = null;
        _offline = false;
      });
      _scheduleStaleRetry(res);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e is ApiException ? e.message : e.toString();
        // No HTTP response at all (timeout, no route): offline, not a
        // server refusal.
        _offline = e is ApiException && e.statusCode == null && e.code == null;
      });
    } finally {
      _requestInFlight = false;
      if (mounted) setState(() => _loading = false);
    }
  }

  void _scheduleStaleRetry(EmployeePayrollStatement res) {
    _staleTimer?.cancel();
    final seen = PayslipWatcher.latestPublishedAt.value;
    final have = res.latestPayslip?.publishedAt ?? 0;
    if (!res.enabled || seen == null || seen <= have) {
      _staleRetries = 0;
      return;
    }
    if (_staleRetries >= 3) return;
    _staleRetries++;
    _staleTimer = Timer(const Duration(seconds: 25), () {
      if (mounted) _load();
    });
  }

  void _openPayslip(PayrollPeriodStatement p) {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => PayslipDetailScreen(statement: p, api: _api)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = _statement;
    return Scaffold(
      backgroundColor: Colors.transparent,
      appBar: _appBar(),
      body: Column(
        children: [
          if (_loading)
            LinearProgressIndicator(
              minHeight: 2.5,
              backgroundColor: Colors.transparent,
              valueColor: AlwaysStoppedAnimation<Color>(AppColors.primaryLight),
            ),
          Expanded(
            child: RefreshIndicator(
              color: AppColors.primary,
              onRefresh: _load,
              child: Align(
                alignment: Alignment.topCenter,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 720),
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 30),
                    children: s == null
                        ? (_error == null ? _skeleton() : [_errorState()])
                        : _content(s),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  PreferredSizeWidget _appBar() {
    return AppBar(
      backgroundColor: Colors.transparent,
      toolbarHeight: 72,
      titleSpacing: 16,
      title: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Salary',
            style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800, letterSpacing: -0.4, color: AppColors.textPrimary),
          ),
          Text(
            'Payslips and this month so far',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500, color: AppColors.textSecondary),
          ),
        ],
      ),
      actions: [
        Padding(
          padding: const EdgeInsets.only(left: 6),
          child: Tooltip(
            message: 'Refresh',
            child: SizedBox(
              width: 44,
              height: 44,
              child: GlassCard(
                radius: 15,
                padding: EdgeInsets.zero,
                onTap: _loading ? null : _onRefreshRequested,
                child: Center(
                  child: _loading
                      ? SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.textPrimary),
                        )
                      : Icon(Icons.refresh_rounded, size: 19, color: AppColors.textPrimary),
                ),
              ),
            ),
          ),
        ),
        const SizedBox(width: 12),
      ],
    );
  }

  List<Widget> _content(EmployeePayrollStatement s) {
    final salary = s.currentSalary;
    return [
      if (_error != null) ...[
        _staleBanner(),
        const SizedBox(height: 12),
      ],
      if (!s.enabled)
        _restrictedCard(s.message)
      else ...[
        if (s.estimate != null) ...[
          EstimateCard(estimate: s.estimate!),
          const SizedBox(height: 22),
        ],
        SectionLabel(
          'Payslips',
          trailing: s.periods.isEmpty
              ? null
              : Text(
                  '${s.periods.length}',
                  style: monoStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.textTertiary),
                ),
        ),
        if (s.periods.isEmpty)
          _emptyPayslips()
        else
          for (final p in s.periods)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: PayslipTile(period: p, onTap: () => _openPayslip(p)),
            ),
        if (salary != null && !salary.blocked && salary.monthly > 0) ...[
          const SizedBox(height: 14),
          const SectionLabel('Current salary'),
          _currentSalaryCard(salary),
        ],
      ],
    ];
  }

  Widget _currentSalaryCard(SalaryInfo salary) {
    final cur = salary.currency;
    return GlassCard(
      radius: 22,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              GradientIconTile(
                icon: Icons.account_balance_wallet_rounded,
                colors: [AppColors.primary, AppColors.accentEnd],
                size: 38,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Gross monthly salary',
                      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
                    ),
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: Text(formatPayrollMoney(salary.monthly, cur), style: monoStyle(fontSize: 20, letterSpacing: -0.5)),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(child: PayrollInfoTile(label: 'Daily rate', value: formatPayrollMoney(salary.daily, cur))),
              const SizedBox(width: 8),
              Expanded(child: PayrollInfoTile(label: 'Annual', value: formatPayrollMoney(salary.annual, cur))),
              const SizedBox(width: 8),
              Expanded(
                child: PayrollInfoTile(
                  label: 'Effective from',
                  value: formatPayrollDate(salary.effectiveFrom) ?? '-',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _emptyPayslips() {
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(22),
      child: Column(
        children: [
          Icon(Icons.receipt_long_outlined, size: 32, color: AppColors.textTertiary),
          const SizedBox(height: 10),
          Text(
            'No payslips yet',
            style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
          ),
          const SizedBox(height: 4),
          Text(
            'When HR approves a monthly payroll run, your payslip appears here and you get a notification.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, height: 1.4, color: AppColors.textSecondary),
          ),
        ],
      ),
    );
  }

  Widget _restrictedCard(String? message) {
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(22),
      child: Column(
        children: [
          GradientIconTile(icon: Icons.lock_outline_rounded, colors: payslipToneColors(null), size: 48),
          const SizedBox(height: 14),
          Text(
            'Salary details are restricted',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
          ),
          const SizedBox(height: 6),
          // The server's policy message, verbatim.
          Text(
            (message == null || message.isEmpty)
                ? 'Salary and monthly statements are restricted by company HR policy.'
                : message,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, height: 1.4, color: AppColors.textSecondary),
          ),
        ],
      ),
    );
  }

  String _loadedAtText() {
    final at = _cachedAt;
    if (at == null) return 'earlier';
    final h = at.hour.toString().padLeft(2, '0');
    final m = at.minute.toString().padLeft(2, '0');
    return 'at $h:$m';
  }

  Widget _staleBanner() {
    final tone = AppColors.amber;
    final text = _offline
        ? "You're offline. Showing the payslips loaded ${_loadedAtText()}."
        : "Couldn't refresh ($_error). Showing the payslips loaded ${_loadedAtText()}.";
    return GlassCard(
      radius: 16,
      tint: tone.withValues(alpha: 0.12),
      borderColor: tone.withValues(alpha: 0.35),
      padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
      child: Row(
        children: [
          Icon(_offline ? Icons.wifi_off_rounded : Icons.info_outline_rounded, color: tone, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Text(text, style: TextStyle(color: tone, fontSize: 11.5, fontWeight: FontWeight.w600, height: 1.35)),
          ),
          TextButton(
            onPressed: _loading ? null : _onRefreshRequested,
            style: TextButton.styleFrom(foregroundColor: tone),
            child: const Text('Retry', style: TextStyle(fontWeight: FontWeight.w800)),
          ),
        ],
      ),
    );
  }

  Widget _errorState() {
    final tone = _offline ? AppColors.amber : AppColors.danger;
    return GlassCard(
      radius: 22,
      padding: const EdgeInsets.all(22),
      child: Column(
        children: [
          Icon(_offline ? Icons.wifi_off_rounded : Icons.cloud_off_rounded, size: 40, color: tone),
          const SizedBox(height: 12),
          Text(
            _offline ? "You're offline" : "Couldn't load your payslips",
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: AppColors.textPrimary),
          ),
          const SizedBox(height: 6),
          Text(
            _offline ? 'Connect to the internet, then try again.' : (_error ?? 'Something went wrong.'),
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12.5, height: 1.4, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _loading ? null : _onRefreshRequested,
            icon: const Icon(Icons.refresh_rounded, size: 18),
            label: const Text('Try again'),
          ),
        ],
      ),
    );
  }

  List<Widget> _skeleton() {
    Widget bar(double width, double height) => Container(
          width: width,
          height: height,
          decoration: BoxDecoration(
            color: AppColors.border,
            borderRadius: BorderRadius.circular(6),
          ),
        );
    return [
      GlassCard(
        strong: true,
        radius: 26,
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            bar(140, 14),
            const SizedBox(height: 14),
            bar(double.infinity, 34),
            const SizedBox(height: 16),
            bar(90, 10),
            const SizedBox(height: 8),
            bar(180, 28),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(child: bar(double.infinity, 44)),
                const SizedBox(width: 8),
                Expanded(child: bar(double.infinity, 44)),
                const SizedBox(width: 8),
                Expanded(child: bar(double.infinity, 44)),
              ],
            ),
          ],
        ),
      ),
      const SizedBox(height: 22),
      for (var i = 0; i < 3; i++)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: GlassCard(
            radius: 20,
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                bar(42, 42),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [bar(110, 13), const SizedBox(height: 6), bar(80, 10)],
                  ),
                ),
                bar(70, 16),
              ],
            ),
          ),
        ),
    ];
  }
}
