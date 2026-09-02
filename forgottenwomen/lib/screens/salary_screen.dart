import 'package:flutter/material.dart';

import '../models/hr.dart';
import '../services/api_client.dart';
import '../theme.dart';

class SalaryScreen extends StatefulWidget {
  const SalaryScreen({super.key});

  @override
  State<SalaryScreen> createState() => _SalaryScreenState();
}

class _SalaryScreenState extends State<SalaryScreen> {
  final _api = ApiClient();
  bool _loading = true;
  bool _refreshing = false;
  String? _error;
  EmployeePayrollStatement? _statement;

  @override
  void initState() {
    super.initState();
    _loadStatements();
  }

  @override
  void dispose() {
    _api.dispose();
    super.dispose();
  }

  Future<void> _loadStatements({bool isRefresh = false}) async {
    if (isRefresh) {
      setState(() => _refreshing = true);
    } else {
      setState(() {
        _loading = true;
        _error = null;
      });
    }

    try {
      final res = await _api.fetchMyPayrollStatements();
      if (mounted) {
        setState(() {
          _statement = res;
          _loading = false;
          _refreshing = false;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString().replaceAll('ApiException: ', '');
          _loading = false;
          _refreshing = false;
        });
      }
    }
  }

  String _formatCurrency(double amount, String currency) {
    final sym = currency == 'PKR' ? '₨ ' : (currency == 'GBP' ? '£' : (currency == 'USD' ? '\$' : '$currency '));
    final parts = amount.toStringAsFixed(2).split('.');
    final integerPart = parts[0].replaceAllMapped(
      RegExp(r'(\d{1,3})(?=(\d{3})+(?!\d))'),
      (Match m) => '${m[1]},',
    );
    return '$sym$integerPart.${parts[1]}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Salary & Statements', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17)),
            Text('Official Monthly Compensation', style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
          ],
        ),
        actions: [
          IconButton(
            icon: _refreshing
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : const Icon(Icons.refresh, color: Colors.white70),
            onPressed: _refreshing ? null : () => _loadStatements(isRefresh: true),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.primary))
          : RefreshIndicator(
              color: AppColors.teal,
              onRefresh: () => _loadStatements(isRefresh: true),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 40),
                children: [
                  if (_error != null) ...[
                    _buildErrorBanner(_error!),
                    const SizedBox(height: 16),
                  ],

                  if (_statement == null || !_statement!.enabled) ...[
                    _buildRestrictedCard(_statement?.message),
                  ] else ...[
                    // 1. Current Active Salary Hero Card
                    if (_statement!.currentSalary != null && !_statement!.currentSalary!.blocked)
                      _buildSalaryHeroCard(_statement!.currentSalary!),
                    const SizedBox(height: 24),

                    // 2. Section Header
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text(
                          'MONTHLY PAYROLL STATEMENTS',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 1.1,
                            color: AppColors.textMuted,
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(
                            color: AppColors.surfaceDark,
                            borderRadius: BorderRadius.circular(6),
                            border: Border.all(color: AppColors.border),
                          ),
                          child: Text(
                            '${_statement!.periods.length} Periods',
                            style: const TextStyle(fontSize: 11, color: AppColors.primaryLight, fontWeight: FontWeight.bold),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),

                    // 3. Statement Periods List
                    if (_statement!.periods.isEmpty)
                      _buildEmptyPeriodsCard()
                    else
                      ..._statement!.periods.map((p) => _buildPeriodStatementTile(p)),
                  ],
                ],
              ),
            ),
    );
  }

  Widget _buildErrorBanner(String msg) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.amber.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.amber.withValues(alpha: 0.4)),
      ),
      child: Row(
        children: [
          const Icon(Icons.warning_amber_rounded, color: AppColors.amber, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Text(msg, style: const TextStyle(color: AppColors.amber, fontSize: 12)),
          ),
        ],
      ),
    );
  }

  Widget _buildRestrictedCard(String? customMessage) {
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: AppColors.slateDark,
              shape: BoxShape.circle,
              border: Border.all(color: AppColors.border),
            ),
            child: const Icon(Icons.lock_outline_rounded, color: AppColors.textMuted, size: 36),
          ),
          const SizedBox(height: 16),
          const Text(
            'Compensation Restricted',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16),
          ),
          const SizedBox(height: 8),
          Text(
            customMessage ?? 'Salary figures and period statements are restricted by company HR policy.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4),
          ),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            decoration: BoxDecoration(
              color: AppColors.bgDark,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: AppColors.border),
            ),
            child: const Row(
              children: [
                Icon(Icons.info_outline, color: AppColors.primaryLight, size: 14),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'HR enables visibility during active pay review cycles',
                    style: TextStyle(color: AppColors.primaryLight, fontSize: 11, fontWeight: FontWeight.w500),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSalaryHeroCard(SalaryInfo salary) {
    final cur = salary.currency;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            AppColors.primary.withValues(alpha: 0.18),
            AppColors.surfaceDark,
          ],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.primary.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Expanded(
                child: Row(
                  children: [
                    Icon(Icons.account_balance_wallet_outlined, color: AppColors.primaryLight, size: 18),
                    SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'CURRENT BASE COMPENSATION',
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.bold,
                          letterSpacing: 1.1,
                          color: AppColors.primaryLight,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: AppColors.teal.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: AppColors.teal.withValues(alpha: 0.4)),
                ),
                child: Text(
                  cur,
                  style: const TextStyle(
                    color: AppColors.teal,
                    fontWeight: FontWeight.bold,
                    fontSize: 10,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Text(
            _formatCurrency(salary.monthly, cur),
            style: const TextStyle(
              fontSize: 30,
              fontWeight: FontWeight.bold,
              color: Colors.white,
              letterSpacing: -0.5,
            ),
          ),
          const SizedBox(height: 4),
          const Text('Gross Monthly Salary', style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.bgDark.withValues(alpha: 0.7),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.border),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _buildMetricCol('Daily Rate (1/260)', _formatCurrency(salary.daily, cur)),
                Container(width: 1, height: 26, color: AppColors.border),
                _buildMetricCol('Annualized', _formatCurrency(salary.annual, cur)),
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

  Widget _buildEmptyPeriodsCard() {
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: const Center(
        child: Column(
          children: [
            Icon(Icons.calendar_today_outlined, color: AppColors.textMuted, size: 32),
            SizedBox(height: 10),
            Text(
              'No Payroll Periods Available',
              style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 14),
            ),
            SizedBox(height: 4),
            Text(
              'When HR prepares and publishes monthly payroll cycles, your monthly pay statements will appear here.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColors.textMuted, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPeriodStatementTile(PayrollPeriodStatement p) {
    final isClosed = p.status == 'CLOSED';
    final hasAdjustments = p.adjustments.isNotEmpty || p.adjustmentsTotal != 0;
    final cur = p.currency;

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => _openPeriodDetailsSheet(p),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 1. Period Title & Status Badge
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Expanded(
                    child: Text(
                      p.name,
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.bold,
                        fontSize: 15,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: isClosed
                          ? AppColors.slateDark
                          : AppColors.teal.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(
                        color: isClosed
                            ? AppColors.border
                            : AppColors.teal.withValues(alpha: 0.4),
                      ),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          isClosed ? Icons.lock_outline : Icons.fiber_manual_record,
                          size: isClosed ? 11 : 9,
                          color: isClosed ? AppColors.textMuted : AppColors.teal,
                        ),
                        const SizedBox(width: 4),
                        Text(
                          isClosed ? 'CLOSED' : 'OPEN / ACTIVE',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                            color: isClosed ? AppColors.textMuted : AppColors.teal,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                '${p.startDate} → ${p.endDate}',
                style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
              ),
              const SizedBox(height: 12),

              // 2. Financial Breakdown Row
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.bgDark,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.border),
                ),
                child: Column(
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Expanded(
                          child: Text(
                            p.workingDaysCount > 0
                                ? 'Period Base (${p.workingDaysCount} working days)'
                                : 'Period Base Gross',
                            style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(_formatCurrency(p.basePayable, cur), style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600)),
                      ],
                    ),
                    if (hasAdjustments) ...[
                      const SizedBox(height: 6),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(
                            p.adjustmentsTotal >= 0 ? 'Approved Overtime & Additions' : 'Approved Deficit & Deductions',
                            style: TextStyle(
                              color: p.adjustmentsTotal >= 0 ? AppColors.teal : AppColors.amber,
                              fontSize: 12,
                            ),
                          ),
                          Text(
                            (p.adjustmentsTotal >= 0 ? '+' : '') + _formatCurrency(p.adjustmentsTotal, cur),
                            style: TextStyle(
                              color: p.adjustmentsTotal >= 0 ? AppColors.teal : AppColors.amber,
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ],
                      ),
                    ],
                    const Divider(height: 16, thickness: 1, color: AppColors.border),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text(
                          'Total Calculated Statement',
                          style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13),
                        ),
                        Text(
                          _formatCurrency(p.netPayable, cur),
                          style: const TextStyle(
                            color: AppColors.teal,
                            fontWeight: FontWeight.bold,
                            fontSize: 15,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),

              // 3. Footer tag with exchange rate and detail hint
              const SizedBox(height: 10),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'Conversion Rate: £1.00 = ₨${p.exchangeRate.toStringAsFixed(2)}',
                    style: const TextStyle(color: AppColors.textMuted, fontSize: 10),
                  ),
                  const Row(
                    children: [
                      Text(
                        'View breakdown',
                        style: TextStyle(color: AppColors.primaryLight, fontSize: 11, fontWeight: FontWeight.w600),
                      ),
                      SizedBox(width: 4),
                      Icon(Icons.chevron_right, color: AppColors.primaryLight, size: 14),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _openPeriodDetailsSheet(PayrollPeriodStatement p) {
    final cur = p.currency;
    showModalBottomSheet(
      context: context,
      backgroundColor: AppColors.surfaceDark,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.65,
        maxChildSize: 0.9,
        minChildSize: 0.4,
        expand: false,
        builder: (_, scrollController) => ListView(
          controller: scrollController,
          padding: const EdgeInsets.all(20),
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: AppColors.border,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(p.name, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 18)),
                      const SizedBox(height: 2),
                      Text('${p.startDate} to ${p.endDate}', style: const TextStyle(color: AppColors.textMuted, fontSize: 12)),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: p.status == 'CLOSED' ? AppColors.slateDark : AppColors.teal.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: p.status == 'CLOSED' ? AppColors.border : AppColors.teal.withValues(alpha: 0.4)),
                  ),
                  child: Text(
                    p.status,
                    style: TextStyle(
                      color: p.status == 'CLOSED' ? AppColors.textMuted : AppColors.teal,
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),

            // Summary Card
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: AppColors.bgDark,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.border),
              ),
              child: Column(
                children: [
                  _buildDetailRow('Contract Monthly Rate', _formatCurrency(p.monthlyGross, cur)),
                  const SizedBox(height: 8),
                  _buildDetailRow('Daily Rate (1/260)', _formatCurrency(p.dailyRate, cur)),
                  const SizedBox(height: 8),
                  _buildDetailRow('Working Days in Period', '${p.workingDaysCount} working days'),
                  const SizedBox(height: 8),
                  _buildDetailRow('Period Base Calculated', _formatCurrency(p.basePayable, cur), isBold: true),
                  const SizedBox(height: 8),
                  _buildDetailRow('Locked Exchange Rate', '£1.00 = ₨${p.exchangeRate.toStringAsFixed(2)}'),
                  const Divider(height: 20, thickness: 1, color: AppColors.border),
                  _buildDetailRow(
                    'Net Calculated Total',
                    _formatCurrency(p.netPayable, cur),
                    isBold: true,
                    valueColor: AppColors.teal,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),

            // Itemized Adjustments
            const Text(
              'APPROVED ADJUSTMENTS & OVERTIME',
              style: TextStyle(color: AppColors.textMuted, fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.1),
            ),
            const SizedBox(height: 10),
            if (p.adjustments.isEmpty)
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: AppColors.bgDark,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.border),
                ),
                child: const Text(
                  'No manual adjustments or overtime added for this period.',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 12),
                ),
              )
            else
              ...p.adjustments.map((a) => Container(
                    margin: const EdgeInsets.only(bottom: 8),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.bgDark,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AppColors.border),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                a.type.replaceAll('_', ' '),
                                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13),
                              ),
                              if (a.explanation.isNotEmpty)
                                Text(a.explanation, style: const TextStyle(color: AppColors.textMuted, fontSize: 11)),
                            ],
                          ),
                        ),
                        Text(
                          (a.amount >= 0 ? '+' : '') + _formatCurrency(a.amount, cur),
                          style: TextStyle(
                            color: a.amount >= 0 ? AppColors.teal : AppColors.amber,
                            fontWeight: FontWeight.bold,
                            fontSize: 13,
                          ),
                        ),
                      ],
                    ),
                  )),
          ],
        ),
      ),
    );
  }

  Widget _buildDetailRow(String label, String value, {bool isBold = false, Color? valueColor}) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Expanded(
          child: Text(
            label,
            style: TextStyle(
              color: isBold ? Colors.white : AppColors.textMuted,
              fontSize: 12,
              fontWeight: isBold ? FontWeight.bold : FontWeight.normal,
            ),
            overflow: TextOverflow.ellipsis,
          ),
        ),
        const SizedBox(width: 8),
        Text(
          value,
          textAlign: TextAlign.right,
          style: TextStyle(
            color: valueColor ?? (isBold ? Colors.white : Colors.white70),
            fontSize: isBold ? 14 : 12,
            fontWeight: isBold ? FontWeight.bold : FontWeight.w600,
          ),
        ),
      ],
    );
  }
}
