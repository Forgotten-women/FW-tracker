import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import '../models/hr.dart';
import '../services/api_client.dart';
import '../services/notification_service.dart';

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
            const SnackBar(
              content: Text('Document update request submitted to HR!'),
              backgroundColor: Color(0xFF10B981),
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
        backgroundColor: const Color(0xFF1E293B),
        title: const Text('Delete Document?', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        content: Text(
          'Are you sure you want to delete "${doc.title}"? This file will be permanently removed.',
          style: const TextStyle(color: Colors.white70, fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel', style: TextStyle(color: Colors.white54)),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFFF43F5E)),
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
          const SnackBar(
            content: Text('Document deleted.'),
            backgroundColor: Color(0xFF10B981),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to delete: $e'),
            backgroundColor: const Color(0xFFF43F5E),
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      backgroundColor: const Color(0xFF0F172A),
      appBar: AppBar(
        backgroundColor: const Color(0xFF1E293B),
        elevation: 0,
        title: const Text(
          'Documents & Staff KYC',
          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18, color: Colors.white),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: Colors.white70),
            onPressed: _loading ? null : _loadData,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openRequestUpdateSheet(),
        backgroundColor: const Color(0xFF4F46E5),
        icon: const Icon(Icons.edit_note_outlined, color: Colors.white),
        label: const Text(
          'Request Doc Update',
          style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Color(0xFF4F46E5)))
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.error_outline, size: 48, color: Color(0xFFF43F5E)),
                        const SizedBox(height: 12),
                        Text(
                          _error!,
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: Colors.white70, fontSize: 14),
                        ),
                        const SizedBox(height: 16),
                        ElevatedButton(
                          onPressed: _loadData,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF4F46E5),
                          ),
                          child: const Text('Retry', style: TextStyle(color: Colors.white)),
                        ),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _loadData,
                  color: const Color(0xFF4F46E5),
                  child: Align(
                    alignment: Alignment.topCenter,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 720),
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 90),
                        children: [
                          if (_checklist != null) _buildProgressCard(_checklist!),
                          const SizedBox(height: 20),
                          const Text(
                            'MANDATORY PERSONNEL KYC',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                              letterSpacing: 1.1,
                              color: Colors.white54,
                            ),
                          ),
                          const SizedBox(height: 10),
                          if (_checklist != null)
                            ..._checklist!.mandatoryChecklist.map((item) => _buildKycItemCard(item)),
                          const SizedBox(height: 24),
                          const Text(
                            'MY DOCUMENT VAULT',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                              letterSpacing: 1.1,
                              color: Colors.white54,
                            ),
                          ),
                          const SizedBox(height: 10),
                          if (_documents.isEmpty)
                            Container(
                              padding: const EdgeInsets.all(24),
                              decoration: BoxDecoration(
                                color: const Color(0xFF1E293B),
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: Colors.white10),
                              ),
                              child: const Center(
                                child: Text(
                                  'No documents uploaded yet.\nTap "Upload Document" to submit your CV, CNIC, or Utility Bill.',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(color: Colors.white54, fontSize: 13, height: 1.5),
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
      statusColor = const Color(0xFF10B981);
      statusLabel = 'KYC Complete';
    } else if (kyc.overallKycStatus == 'PENDING_REVIEW') {
      statusColor = const Color(0xFFF59E0B);
      statusLabel = 'Pending HR Review';
    } else {
      statusColor = const Color(0xFFF43F5E);
      statusLabel = 'Incomplete KYC';
    }

    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: const Color(0xFF1E293B),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: statusColor.withOpacity(0.4)),
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
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    kyc.employeeName,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    kyc.employeeRole,
                    style: const TextStyle(color: Colors.white54, fontSize: 12),
                  ),
                ],
              ),
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
              const Text(
                'Staff Compliance Progress',
                style: TextStyle(color: Colors.white70, fontSize: 12),
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
              backgroundColor: Colors.white10,
              valueColor: AlwaysStoppedAnimation<Color>(statusColor),
              minHeight: 8,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: [
              _buildMiniMetric('${kyc.verifiedCount}', 'Verified', const Color(0xFF10B981)),
              _buildMiniMetric('${kyc.pendingCount}', 'Pending', const Color(0xFFF59E0B)),
              _buildMiniMetric('${kyc.missingCount}', 'Missing', const Color(0xFFF43F5E)),
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
        Text(label, style: const TextStyle(color: Colors.white54, fontSize: 10)),
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
      badgeColor = const Color(0xFF10B981);
      badgeText = 'VERIFIED';
    } else if (item.isPending) {
      badgeColor = const Color(0xFFF59E0B);
      badgeText = 'PENDING REVIEW';
    } else if (item.isRejected) {
      badgeColor = const Color(0xFFF43F5E);
      badgeText = 'REJECTED';
    } else {
      badgeColor = const Color(0xFF64748B);
      badgeText = 'MISSING';
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF1E293B),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: item.isRejected
              ? const Color(0xFFF43F5E).withOpacity(0.6)
              : Colors.white.withOpacity(0.08),
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
                  color: const Color(0xFF4F46E5).withOpacity(0.15),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(icon, color: const Color(0xFF818CF8), size: 20),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.name,
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.bold,
                        fontSize: 14,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      item.description,
                      style: const TextStyle(color: Colors.white54, fontSize: 11),
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
                color: const Color(0xFF881337).withOpacity(0.4),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFFF43F5E).withOpacity(0.4)),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.warning_amber_rounded, color: Color(0xFFF43F5E), size: 16),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'HR Feedback: ${item.rejectionReason}',
                      style: const TextStyle(color: Color(0xFFFECDD3), fontSize: 11, height: 1.3),
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
                icon: const Icon(
                  Icons.edit_note,
                  size: 16,
                  color: Color(0xFF818CF8),
                ),
                label: Text(
                  item.isRejected ? 'Request Correction' : 'Request ${item.name} Update',
                  style: const TextStyle(color: Color(0xFF818CF8), fontSize: 12, fontWeight: FontWeight.bold),
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
        color: const Color(0xFF1E293B),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white.withOpacity(0.08)),
      ),
      child: Row(
        children: [
          const Icon(Icons.insert_drive_file, color: Colors.white70, size: 24),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  doc.title,
                  style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13),
                ),
                const SizedBox(height: 2),
                Text(
                  '${doc.type} · v${doc.version} · ${doc.uploadedAt}',
                  style: const TextStyle(color: Colors.white54, fontSize: 11),
                ),
              ],
            ),
          ),
          if (doc.isVerified)
            const Icon(Icons.check_circle, color: Color(0xFF10B981), size: 18)
          else if (doc.isPending)
            const Icon(Icons.hourglass_top, color: Color(0xFFF59E0B), size: 18)
          else
            const Icon(Icons.cancel, color: Color(0xFFF43F5E), size: 18),
          const SizedBox(width: 6),
          IconButton(
            icon: const Icon(Icons.delete_outline, color: Colors.white38, size: 18),
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
      decoration: const BoxDecoration(
        color: Color(0xFF1E293B),
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
                const Row(
                  children: [
                    Icon(Icons.edit_note, color: Color(0xFF818CF8), size: 22),
                    SizedBox(width: 8),
                    Text(
                      'Request Document Update',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
                IconButton(
                  icon: const Icon(Icons.close, color: Colors.white54),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFF0F172A),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.white10),
              ),
              child: const Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.shield_outlined, color: Color(0xFF10B981), size: 18),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Official KYC and personnel documents are securely uploaded and verified by HR. Submitting this request alerts HR to update or replace your verified file.',
                      style: TextStyle(color: Colors.white70, fontSize: 11.5, height: 1.4),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'Document Type',
              style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: BoxDecoration(
                color: const Color(0xFF0F172A),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.white12),
              ),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  value: _selectedTypeId,
                  isExpanded: true,
                  dropdownColor: const Color(0xFF0F172A),
                  items: _categories.map((c) {
                    return DropdownMenuItem<String>(
                      value: c['id'],
                      child: Text(c['name']!, style: const TextStyle(color: Colors.white, fontSize: 13)),
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
            const Text(
              'Reason / Notes for HR',
              style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            TextField(
              controller: _reasonController,
              maxLines: 3,
              style: const TextStyle(color: Colors.white, fontSize: 13),
              decoration: InputDecoration(
                hintText: 'e.g. My CNIC was renewed. I have provided the hardcopy / scanned copy to the HR office.',
                hintStyle: const TextStyle(color: Colors.white30),
                filled: true,
                fillColor: const Color(0xFF0F172A),
                contentPadding: const EdgeInsets.all(12),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: Colors.white12),
                ),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Color(0xFFF43F5E), fontSize: 12)),
            ],
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              height: 44,
              child: ElevatedButton(
                onPressed: _submitting ? null : _submitRequest,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF4F46E5),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                child: _submitting
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                      )
                    : const Text(
                        'Submit Request to HR',
                        style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
