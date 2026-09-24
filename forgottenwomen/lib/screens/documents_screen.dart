import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import '../models/hr.dart';
import '../services/api_client.dart';
import '../services/notification_service.dart';
import '../theme.dart';

class DocumentsScreen extends StatefulWidget {
  final ApiClient api;

  const DocumentsScreen({super.key, required this.api});

  @override
  State<DocumentsScreen> createState() => _DocumentsScreenState();
}

class _DocumentsScreenState extends State<DocumentsScreen> {
  Timer? _pollTimer;
  bool _loading = true;
  String? _error;
  KycChecklist? _checklist;
  List<EmployeeDocument> _documents = [];

  @override
  void initState() {
    super.initState();
    _loadData();
    _pollTimer = Timer.periodic(const Duration(seconds: 4), (_) => _loadSilently());
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _loadSilently() async {
    try {
      final checklist = await widget.api.myKycChecklist();
      final docs = await widget.api.myDocuments();
      if (mounted) {
        setState(() {
          _checklist = checklist;
          _documents = docs;
          _error = null;
        });
      }
      try {
        await NotificationService().checkAndDispatchUnseenNotifications();
      } catch (_) {}
    } catch (_) {}
  }

  Future<void> _loadData() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final checklist = await widget.api.myKycChecklist();
      final docs = await widget.api.myDocuments();
      if (mounted) {
        setState(() {
          _checklist = checklist;
          _documents = docs;
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

  void _openRequestUpdateSheet({String? initialTypeId, String? initialName}) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => _RequestDocumentUpdateSheet(
        api: widget.api,
        initialTypeId: initialTypeId,
        initialName: initialName,
        onSuccess: () {
          Navigator.pop(ctx);
          _loadData();
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Document update request submitted to HR!'),
              backgroundColor: AppColors.teal,
            ),
          );
        },
      ),
    );
  }

  Future<void> _deleteDoc(EmployeeDocument doc) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.sheet,
        title: Text('Delete Document?', style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.bold)),
        content: Text(
          'Are you sure you want to delete "${doc.title}"? This file will be permanently removed.',
          style: TextStyle(color: AppColors.textSecondary, fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel', style: TextStyle(color: AppColors.textSecondary)),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    try {
      await widget.api.deleteMyDocument(doc.id);
      _loadData();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Document deleted.'),
            backgroundColor: AppColors.teal,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to delete: $e'),
            backgroundColor: AppColors.danger,
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      backgroundColor: Colors.transparent,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: Text(
          'Documents & Staff KYC',
          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18, color: AppColors.textPrimary),
        ),
        actions: [
          IconButton(
            icon: Icon(Icons.refresh, color: AppColors.textSecondary),
            onPressed: _loading ? null : _loadData,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openRequestUpdateSheet(),
        backgroundColor: AppColors.primary,
        icon: const Icon(Icons.edit_note_outlined, color: AppColors.onAccent),
        label: const Text(
          'Request Doc Update',
          style: TextStyle(color: AppColors.onAccent, fontWeight: FontWeight.bold),
        ),
      ),
      body: _loading
          ? Center(child: CircularProgressIndicator(color: AppColors.primary))
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.error_outline, size: 48, color: AppColors.danger),
                        const SizedBox(height: 12),
                        Text(
                          _error!,
                          textAlign: TextAlign.center,
                          style: TextStyle(color: AppColors.textSecondary, fontSize: 14),
                        ),
                        const SizedBox(height: 16),
                        ElevatedButton(
                          onPressed: _loadData,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppColors.primary,
                          ),
                          child: const Text('Retry', style: TextStyle(color: AppColors.onAccent)),
                        ),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _loadData,
                  color: AppColors.primary,
                  child: Align(
                    alignment: Alignment.topCenter,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 720),
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 90),
                        children: [
                          if (_checklist != null) _buildProgressCard(_checklist!),
                          const SizedBox(height: 20),
                          Text(
                            'MANDATORY PERSONNEL KYC',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                              letterSpacing: 1.1,
                              color: AppColors.textSecondary,
                            ),
                          ),
                          const SizedBox(height: 10),
                          if (_checklist != null)
                            ..._checklist!.mandatoryChecklist.map((item) => _buildKycItemCard(item)),
                          const SizedBox(height: 24),
                          Text(
                            'MY DOCUMENT VAULT',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                              letterSpacing: 1.1,
                              color: AppColors.textSecondary,
                            ),
                          ),
                          const SizedBox(height: 10),
                          if (_documents.isEmpty)
                            Container(
                              padding: const EdgeInsets.all(24),
                              decoration: BoxDecoration(
                                color: AppColors.card,
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: AppColors.border),
                              ),
                              child: Center(
                                child: Text(
                                  'No documents uploaded yet.\nTap "Upload Document" to submit your CV, CNIC, or Utility Bill.',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(color: AppColors.textSecondary, fontSize: 13, height: 1.5),
                                ),
                              ),
                            )
                          else
                            ..._documents.map((doc) => _buildDocumentCard(doc)),
                        ],
                      ),
                    ),
                  ),
                ),
    );
  }

  Widget _buildProgressCard(KycChecklist kyc) {
    Color statusColor;
    String statusLabel;
    if (kyc.overallKycStatus == 'COMPLETE') {
      statusColor = AppColors.teal;
      statusLabel = 'KYC Complete';
    } else if (kyc.overallKycStatus == 'PENDING_REVIEW') {
      statusColor = AppColors.amber;
      statusLabel = 'Pending HR Review';
    } else {
      statusColor = AppColors.danger;
      statusLabel = 'Incomplete KYC';
    }

    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppColors.card,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: statusColor.withOpacity(0.4)),
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
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      kyc.employeeName,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppColors.textPrimary,
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      kyc.employeeRole,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: statusColor.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: statusColor.withOpacity(0.6)),
                ),
                child: Text(
                  statusLabel,
                  style: TextStyle(
                    color: statusColor,
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Staff Compliance Progress',
                style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
              ),
              Text(
                '${kyc.completionPercentage}%',
                style: TextStyle(
                  color: statusColor,
                  fontSize: 13,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              value: kyc.completionPercentage / 100,
              backgroundColor: AppColors.border,
              valueColor: AlwaysStoppedAnimation<Color>(statusColor),
              minHeight: 8,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: [
              _buildMiniMetric('${kyc.verifiedCount}', 'Verified', AppColors.teal),
              _buildMiniMetric('${kyc.pendingCount}', 'Pending', AppColors.amber),
              _buildMiniMetric('${kyc.missingCount}', 'Missing', AppColors.danger),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildMiniMetric(String value, String label, Color color) {
    return Column(
      children: [
        Text(value, style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 14)),
        Text(label, style: TextStyle(color: AppColors.textSecondary, fontSize: 10)),
      ],
    );
  }

  Widget _buildKycItemCard(KycItem item) {
    Color badgeColor;
    String badgeText;
    IconData icon;

    if (item.typeId == 'cv_resume') {
      icon = Icons.description;
    } else if (item.typeId == 'nic_card') {
      icon = Icons.badge;
    } else if (item.typeId == 'next_of_kin') {
      icon = Icons.people;
    } else if (item.typeId == 'utility_bill') {
      icon = Icons.receipt_long;
    } else {
      icon = Icons.assignment;
    }

    if (item.isVerified) {
      badgeColor = AppColors.teal;
      badgeText = 'VERIFIED';
    } else if (item.isPending) {
      badgeColor = AppColors.amber;
      badgeText = 'PENDING REVIEW';
    } else if (item.isRejected) {
      badgeColor = AppColors.danger;
      badgeText = 'REJECTED';
    } else {
      badgeColor = AppColors.neutral;
      badgeText = 'MISSING';
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.card,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: item.isRejected
              ? AppColors.danger.withOpacity(0.6)
              : AppColors.overlay(0.08),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: AppColors.primary.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(icon, color: AppColors.primaryLight, size: 20),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.name,
                      style: TextStyle(
                        color: AppColors.textPrimary,
                        fontWeight: FontWeight.bold,
                        fontSize: 14,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      item.description,
                      style: TextStyle(color: AppColors.textSecondary, fontSize: 11),
                    ),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: badgeColor.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: badgeColor.withOpacity(0.5)),
                ),
                child: Text(
                  badgeText,
                  style: TextStyle(
                    color: badgeColor,
                    fontSize: 9,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
          if (item.rejectionReason != null && item.rejectionReason!.isNotEmpty) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.danger.withOpacity(0.12),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppColors.danger.withOpacity(0.4)),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.warning_amber_rounded, color: AppColors.danger, size: 16),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'HR Feedback: ${item.rejectionReason}',
                      style: TextStyle(color: AppColors.danger, fontSize: 11, height: 1.3),
                    ),
                  ),
                ],
              ),
            ),
          ],
          if (!item.isVerified) ...[
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: () => _openRequestUpdateSheet(
                  initialTypeId: item.typeId,
                  initialName: item.name,
                ),
                icon: Icon(
                  Icons.edit_note,
                  size: 16,
                  color: AppColors.primaryLight,
                ),
                label: Text(
                  item.isRejected ? 'Request Correction' : 'Request ${item.name} Update',
                  style: TextStyle(color: AppColors.primaryLight, fontSize: 12, fontWeight: FontWeight.bold),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildDocumentCard(EmployeeDocument doc) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.card,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.overlay(0.08)),
      ),
      child: Row(
        children: [
          Icon(Icons.insert_drive_file, color: AppColors.textSecondary, size: 24),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  doc.title,
                  style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.bold, fontSize: 13),
                ),
                const SizedBox(height: 2),
                Text(
                  '${doc.type} · v${doc.version} · ${doc.uploadedAt}',
                  style: TextStyle(color: AppColors.textSecondary, fontSize: 11),
                ),
              ],
            ),
          ),
          if (doc.isVerified)
            Icon(Icons.check_circle, color: AppColors.teal, size: 18)
          else if (doc.isPending)
            Icon(Icons.hourglass_top, color: AppColors.amber, size: 18)
          else
            Icon(Icons.cancel, color: AppColors.danger, size: 18),
          const SizedBox(width: 6),
          IconButton(
            icon: Icon(Icons.delete_outline, color: AppColors.textTertiary, size: 18),
            onPressed: () => _deleteDoc(doc),
            tooltip: 'Delete Document',
          ),
        ],
      ),
    );
  }
}

class _RequestDocumentUpdateSheet extends StatefulWidget {
  final ApiClient api;
  final String? initialTypeId;
  final String? initialName;
  final VoidCallback onSuccess;

  const _RequestDocumentUpdateSheet({
    required this.api,
    this.initialTypeId,
    this.initialName,
    required this.onSuccess,
  });

  @override
  State<_RequestDocumentUpdateSheet> createState() => _RequestDocumentUpdateSheetState();
}

class _RequestDocumentUpdateSheetState extends State<_RequestDocumentUpdateSheet> {
  late String _selectedTypeId;
  late TextEditingController _reasonController;
  bool _submitting = false;
  String? _error;

  final List<Map<String, String>> _categories = [
    {'id': 'cv_resume', 'name': 'CV / Resume'},
    {'id': 'nic_card', 'name': 'National Identity Card (CNIC)'},
    {'id': 'next_of_kin', 'name': 'Next of Kin / Emergency Form'},
    {'id': 'utility_bill', 'name': 'Home Utility Bill (Electricity/Gas)'},
    {'id': 'employment_contract', 'name': 'Signed Employment Contract'},
    {'id': 'education_degree', 'name': 'Educational Degree / Certificate'},
    {'id': 'experience_letter', 'name': 'Experience / Relieving Letter'},
    {'id': 'police_verification', 'name': 'Police Clearance Certificate'},
    {'id': 'medical', 'name': 'Medical / Doctor Certificate'},
    {'id': 'other', 'name': 'Other HR Record'},
  ];

  @override
  void initState() {
    super.initState();
    _selectedTypeId = widget.initialTypeId ?? 'nic_card';
    _reasonController = TextEditingController(
      text: widget.initialName != null ? 'Please update/verify my ${widget.initialName}.' : '',
    );
  }

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  Future<void> _submitRequest() async {
    if (_reasonController.text.trim().isEmpty) {
      setState(() {
        _error = 'Please provide details or a reason for the document update request.';
      });
      return;
    }

    final categoryName = _categories.firstWhere((c) => c['id'] == _selectedTypeId)['name']!;

    setState(() {
      _submitting = true;
      _error = null;
    });

    try {
      await widget.api.requestDocumentUpdate(
        documentTypeId: _selectedTypeId,
        documentName: categoryName,
        reason: _reasonController.text.trim(),
      );

      widget.onSuccess();
    } catch (e) {
      setState(() {
        _error = e.toString();
        _submitting = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.fromLTRB(
        20,
        20,
        20,
        MediaQuery.of(context).viewInsets.bottom + 20,
      ),
      decoration: BoxDecoration(
        color: AppColors.card,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    Icon(Icons.edit_note, color: AppColors.primaryLight, size: 22),
                    SizedBox(width: 8),
                    Text(
                      'Request Document Update',
                      style: TextStyle(
                        color: AppColors.textPrimary,
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
                IconButton(
                  icon: Icon(Icons.close, color: AppColors.textSecondary),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.bg,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.border),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.shield_outlined, color: AppColors.teal, size: 18),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Official KYC and personnel documents are securely uploaded and verified by HR. Submitting this request alerts HR to update or replace your verified file.',
                      style: TextStyle(color: AppColors.textSecondary, fontSize: 11.5, height: 1.4),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Text(
              'Document Type',
              style: TextStyle(color: AppColors.textSecondary, fontSize: 12, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: BoxDecoration(
                color: AppColors.bg,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppColors.border),
              ),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  value: _selectedTypeId,
                  isExpanded: true,
                  dropdownColor: AppColors.sheet,
                  items: _categories.map((c) {
                    return DropdownMenuItem<String>(
                      value: c['id'],
                      child: Text(c['name']!, style: TextStyle(color: AppColors.textPrimary, fontSize: 13)),
                    );
                  }).toList(),
                  onChanged: (val) {
                    if (val != null) {
                      setState(() {
                        _selectedTypeId = val;
                      });
                    }
                  },
                ),
              ),
            ),
            const SizedBox(height: 14),
            Text(
              'Reason / Notes for HR',
              style: TextStyle(color: AppColors.textSecondary, fontSize: 12, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            TextField(
              controller: _reasonController,
              maxLines: 3,
              style: TextStyle(color: AppColors.textPrimary, fontSize: 13),
              decoration: InputDecoration(
                hintText: 'e.g. My CNIC was renewed. I have provided the hardcopy / scanned copy to the HR office.',
                hintStyle: TextStyle(color: AppColors.textTertiary),
                filled: true,
                fillColor: AppColors.bg,
                contentPadding: const EdgeInsets.all(12),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: BorderSide(color: AppColors.border),
                ),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: TextStyle(color: AppColors.danger, fontSize: 12)),
            ],
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              height: 44,
              child: ElevatedButton(
                onPressed: _submitting ? null : _submitRequest,
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                child: _submitting
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(color: AppColors.onAccent, strokeWidth: 2),
                      )
                    : const Text(
                        'Submit Request to HR',
                        style: TextStyle(color: AppColors.onAccent, fontWeight: FontWeight.bold),
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
