import 'package:flutter/material.dart';

import '../models/hr.dart';
import '../services/api_client.dart';
import '../theme.dart';

class ProfileScreen extends StatefulWidget {
  final ApiClient? apiClient;

  const ProfileScreen({super.key, this.apiClient});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late final ApiClient _api;
  EmployeeProfile? _profile;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _api = widget.apiClient ?? ApiClient();
    _loadProfile();
  }

  Future<void> _loadProfile() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final p = await _api.getProfile();
      if (mounted) {
        setState(() {
          _profile = p;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  String _formatCurrency(double amount, String currency) {
    final sym = currency == 'PKR' ? '₨ ' : (currency == 'GBP' ? '£' : '$currency ');
    final parts = amount.toStringAsFixed(2).split('.');
    final whole = parts[0];
    final dec = parts[1];
    final reg = RegExp(r'(\d{1,3})(?=(\d{3})+(?!\d))');
    final formattedWhole = whole.replaceAllMapped(reg, (Match m) => '${m[1]},');
    return '$sym$formattedWhole.$dec';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('My Profile'),
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded, size: 20),
            tooltip: 'Refresh',
            onPressed: _loadProfile,
          ),
        ],
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: AppColors.primaryLight),
            )
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.error_outline_rounded, color: AppColors.danger, size: 48),
                        const SizedBox(height: 12),
                        Text(
                          _error!,
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
                        ),
                        const SizedBox(height: 16),
                        OutlinedButton.icon(
                          onPressed: _loadProfile,
                          icon: const Icon(Icons.refresh_rounded, size: 16),
                          label: const Text('Retry'),
                        ),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  color: AppColors.primaryLight,
                  backgroundColor: AppColors.surfaceDark,
                  onRefresh: _loadProfile,
                  child: ListView(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 20),
                    children: [
                      _buildHeaderCard(_profile!),
                      const SizedBox(height: 16),
                      _buildSalaryCard(_profile!.salary),
                      const SizedBox(height: 16),
                      _buildEmploymentCard(_profile!),
                      const SizedBox(height: 16),
                      _buildPersonalDetailsCard(_profile!),
                      const SizedBox(height: 16),
                      _buildEmergencyContactsCard(_profile!.emergencyContacts),
                      const SizedBox(height: 16),
                      _buildKycStatusCard(_profile!),
                      const SizedBox(height: 32),
                    ],
                  ),
                ),
    );
  }

  Widget _buildHeaderCard(EmployeeProfile p) {
    final initials = p.name.trim().split(' ').map((e) => e.isNotEmpty ? e[0] : '').take(2).join().toUpperCase();

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.border),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.3),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        children: [
          Row(
            children: [
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: const LinearGradient(
                    colors: [AppColors.primary, AppColors.primaryLight],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: AppColors.primary.withOpacity(0.4),
                      blurRadius: 12,
                      offset: const Offset(0, 4),
                    ),
                  ],
                ),
                alignment: Alignment.center,
                child: Text(
                  initials.isEmpty ? '?' : initials,
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      p.name,
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                        color: AppColors.textLight,
                        letterSpacing: -0.3,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      p.jobTitle ?? p.role,
                      style: const TextStyle(
                        fontSize: 13,
                        color: AppColors.primaryLight,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          decoration: BoxDecoration(
                            color: p.active ? AppColors.teal.withOpacity(0.15) : AppColors.slateDark,
                            borderRadius: BorderRadius.circular(6),
                            border: Border.all(
                              color: p.active ? AppColors.teal.withOpacity(0.4) : AppColors.border,
                            ),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Container(
                                width: 6,
                                height: 6,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  color: p.active ? AppColors.teal : AppColors.textMuted,
                                ),
                              ),
                              const SizedBox(width: 5),
                              Text(
                                p.active ? 'ACTIVE' : 'INACTIVE',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.bold,
                                  color: p.active ? AppColors.teal : AppColors.textMuted,
                                ),
                              ),
                            ],
                          ),
                        ),
                        if (p.officeName != null) ...[
                          const SizedBox(width: 8),
                          Flexible(
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: AppColors.slateDark,
                                borderRadius: BorderRadius.circular(6),
                                border: Border.all(color: AppColors.border),
                              ),
                              child: Text(
                                p.officeName!,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 10, color: AppColors.textMuted),
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (p.employeeNumber != null || p.workEmail != null) ...[
            const SizedBox(height: 16),
            const Divider(color: AppColors.border, height: 1),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                if (p.employeeNumber != null)
                  _buildMiniMeta('EMPLOYEE ID', p.employeeNumber!),
                if (p.workEmail != null)
                  _buildMiniMeta('WORK EMAIL', p.workEmail!),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildMiniMeta(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: AppColors.textMuted),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.textLight),
        ),
      ],
    );
  }

  Widget _buildSalaryCard(SalaryInfo salary) {
    if (!salary.enabled) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.surfaceDark,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.slateDark,
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Icon(Icons.lock_outline_rounded, color: AppColors.textMuted, size: 20),
            ),
            const SizedBox(width: 14),
            const Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Salary Information',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppColors.textLight),
                  ),
                  SizedBox(height: 2),
                  Text(
                    'Salary details are restricted by company HR policy.',
                    style: TextStyle(fontSize: 11, color: AppColors.textMuted),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    if (salary.blocked) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.amber.withOpacity(0.08),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.amber.withOpacity(0.3)),
        ),
        child: Row(
          children: [
            const Icon(Icons.warning_amber_rounded, color: AppColors.amber, size: 24),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Salary Record Pending',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppColors.amber),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    salary.message ?? 'No active salary record on file. Contact HR.',
                    style: TextStyle(fontSize: 11, color: AppColors.amber.withOpacity(0.9)),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF1E1B4B), Color(0xFF0F172A)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.primary.withOpacity(0.4), width: 1.5),
        boxShadow: [
          BoxShadow(
            color: AppColors.primary.withOpacity(0.15),
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
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(6),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withOpacity(0.2),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: const Icon(Icons.account_balance_wallet_rounded, color: AppColors.primaryLight, size: 16),
                  ),
                  const SizedBox(width: 8),
                  const Text(
                    'OFFICIAL SALARY & RATES',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 0.8,
                      color: AppColors.primaryLight,
                    ),
                  ),
                ],
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: AppColors.primary.withOpacity(0.3),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.primaryLight.withOpacity(0.4)),
                ),
                child: Text(
                  salary.currency,
                  style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Text(
            _formatCurrency(salary.monthly, salary.currency),
            style: const TextStyle(
              fontSize: 28,
              fontWeight: FontWeight.bold,
              color: Colors.white,
              letterSpacing: -0.5,
            ),
          ),
          const Text(
            'Monthly Gross Salary',
            style: TextStyle(fontSize: 12, color: AppColors.textMuted),
          ),
          const SizedBox(height: 16),
          const Divider(color: Color(0xFF312E81), height: 1),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'DAILY RATE (1/260)',
                      style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: AppColors.textMuted),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      _formatCurrency(salary.daily, salary.currency),
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: AppColors.teal),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'ANNUAL BASE',
                      style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: AppColors.textMuted),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      _formatCurrency(salary.annual, salary.currency),
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Colors.white),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (salary.effectiveFrom != null) ...[
            const SizedBox(height: 10),
            Text(
              'Effective from: ${salary.effectiveFrom}',
              style: const TextStyle(fontSize: 10, color: AppColors.textMuted, fontStyle: FontStyle.italic),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildEmploymentCard(EmployeeProfile p) {
    return _buildSectionContainer(
      title: 'Employment & Schedule',
      icon: Icons.badge_outlined,
      children: [
        _buildDetailRow('Employment Type', p.employmentType ?? 'Full-time'),
        _buildDetailRow('Start Date', p.startDate ?? '—'),
        _buildDetailRow('Assigned Hours', '${p.startTime} – ${p.endTime}'),
        _buildDetailRow('Grace Window', '${p.graceMinutes} minutes (11:10:59 limit)'),
        _buildDetailRow('Daily Break', '${p.breakMinutes} minutes paid allowance'),
        _buildDetailRow('Working Days', p.workDays),
        if (p.holidayEntitlementDays != null)
          _buildDetailRow('Annual Leave Entitlement', '${p.holidayEntitlementDays!.toStringAsFixed(0)} days/year'),
        if (p.noticePeriodDays != null)
          _buildDetailRow('Notice Period', '${p.noticePeriodDays} days'),
      ],
    );
  }

  Widget _buildPersonalDetailsCard(EmployeeProfile p) {
    final pers = p;
    return _buildSectionContainer(
      title: 'Personal & Identification',
      icon: Icons.person_outline_rounded,
      children: [
        _buildDetailRow('National ID / CNIC', pers.nationalId ?? '—'),
        _buildDetailRow('Mobile Phone', pers.mobilePhone ?? '—'),
        _buildDetailRow('Personal Email', pers.personalEmail ?? '—'),
        _buildDetailRow('Date of Birth', pers.dateOfBirth ?? '—'),
        if (pers.addressLine1 != null)
          _buildDetailRow('Address', '${pers.addressLine1}${pers.city != null ? ', ${pers.city}' : ''}'),
      ],
    );
  }

  Widget _buildEmergencyContactsCard(List<EmergencyContact> contacts) {
    return _buildSectionContainer(
      title: 'Next of Kin & Emergency Contacts',
      icon: Icons.contact_phone_outlined,
      children: contacts.isEmpty
          ? [
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text(
                  'No emergency contacts on file.',
                  style: TextStyle(fontSize: 12, color: AppColors.textMuted, fontStyle: FontStyle.italic),
                ),
              ),
            ]
          : contacts.map((c) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.slateDark,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: c.isPrimary ? AppColors.teal.withOpacity(0.4) : AppColors.border),
                ),
                child: Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: c.isPrimary ? AppColors.teal.withOpacity(0.15) : AppColors.surfaceDark,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Icon(
                        Icons.person_rounded,
                        color: c.isPrimary ? AppColors.teal : AppColors.textMuted,
                        size: 18,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Text(
                                c.name,
                                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppColors.textLight),
                              ),
                              if (c.isPrimary) ...[
                                const SizedBox(width: 6),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                                  decoration: BoxDecoration(
                                    color: AppColors.teal.withOpacity(0.2),
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                  child: const Text(
                                    'PRIMARY',
                                    style: TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: AppColors.teal),
                                  ),
                                ),
                              ],
                            ],
                          ),
                          const SizedBox(height: 2),
                          Text(
                            '${c.relationship} · ${c.phone}',
                            style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            )).toList(),
    );
  }

  Widget _buildKycStatusCard(EmployeeProfile p) {
    return _buildSectionContainer(
      title: 'KYC & Document Vault',
      icon: Icons.verified_user_outlined,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${p.kycVerifiedCount} of ${p.kycTotalCount} Documents Verified',
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppColors.textLight),
                ),
                const SizedBox(height: 2),
                const Text(
                  'CNIC, Degree, Utility Bills & Contracts',
                  style: TextStyle(fontSize: 11, color: AppColors.textMuted),
                ),
              ],
            ),
            Icon(
              p.kycVerifiedCount > 0 && p.kycVerifiedCount >= p.kycTotalCount
                  ? Icons.check_circle_rounded
                  : Icons.pending_actions_rounded,
              color: p.kycVerifiedCount > 0 ? AppColors.teal : AppColors.amber,
              size: 24,
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildSectionContainer({
    required String title,
    required IconData icon,
    required List<Widget> children,
  }) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: AppColors.primaryLight),
              const SizedBox(width: 8),
              Text(
                title,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.bold,
                  color: AppColors.textLight,
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          const Divider(color: AppColors.border, height: 1),
          const SizedBox(height: 12),
          ...children,
        ],
      ),
    );
  }

  Widget _buildDetailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
          ),
          const SizedBox(width: 16),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.textLight),
            ),
          ),
        ],
      ),
    );
  }
}
