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

  void _openUploadSheet({String? initialTypeId, String? initialName}) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => _UploadDocumentSheet(
        api: widget.api,
        initialTypeId: initialTypeId,
        initialName: initialName,
        onSuccess: () {
          Navigator.pop(ctx);
          _loadData();
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Document uploaded successfully! Submitted for HR verification.'),
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
        onPressed: () => _openUploadSheet(),
        backgroundColor: const Color(0xFF4F46E5),
        icon: const Icon(Icons.upload_file, color: Colors.white),
        label: const Text(
          'Upload Document',
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
                onPressed: () => _openUploadSheet(
                  initialTypeId: item.typeId,
                  initialName: item.name,
                ),
                icon: Icon(
                  item.isRejected ? Icons.replay : Icons.upload_file,
                  size: 16,
                  color: const Color(0xFF818CF8),
                ),
                label: Text(
                  item.isRejected ? 'Re-upload Document' : 'Upload ${item.name}',
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

class _UploadDocumentSheet extends StatefulWidget {
  final ApiClient api;
  final String? initialTypeId;
  final String? initialName;
  final VoidCallback onSuccess;

  const _UploadDocumentSheet({
    required this.api,
    this.initialTypeId,
    this.initialName,
    required this.onSuccess,
  });

  @override
  State<_UploadDocumentSheet> createState() => _UploadDocumentSheetState();
}

class _UploadDocumentSheetState extends State<_UploadDocumentSheet> {
  late String _selectedTypeId;
  late TextEditingController _titleController;
  late TextEditingController _expiryController;
  bool _uploading = false;
  String? _error;
  List<int>? _pickedFileBytes;
  String? _pickedFileName;

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
    _selectedTypeId = widget.initialTypeId ?? 'cv_resume';
    _titleController = TextEditingController(
      text: widget.initialName != null ? '${widget.initialName} - Submission' : '',
    );
    _expiryController = TextEditingController();
  }

  @override
  void dispose() {
    _titleController.dispose();
    _expiryController.dispose();
    super.dispose();
  }

  Future<void> _pickFile() async {
    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['pdf', 'png', 'jpg', 'jpeg', 'docx', 'doc'],
        withData: true,
      );
      if (result != null && result.files.isNotEmpty) {
        final f = result.files.first;
        List<int>? bytes = f.bytes;
        if (bytes == null && f.path != null) {
          bytes = await File(f.path!).readAsBytes();
        }
        if (bytes != null) {
          setState(() {
            _pickedFileBytes = bytes;
            _pickedFileName = f.name;
            if (_titleController.text.isEmpty) {
              _titleController.text = f.name;
            }
            _error = null;
          });
        }
      }
    } catch (e) {
      setState(() => _error = 'Could not select file: $e');
    }
  }

  Future<void> _submitUpload() async {
    if (_pickedFileBytes == null) {
      setState(() {
        _error = 'Please select a document file (PDF, PNG, JPG) from your device.';
      });
      return;
    }

    final title = _titleController.text.trim().isEmpty
        ? _categories.firstWhere((c) => c['id'] == _selectedTypeId)['name']!
        : _titleController.text.trim();

    setState(() {
      _uploading = true;
      _error = null;
    });

    try {
      await widget.api.uploadDocument(
        documentTypeId: _selectedTypeId,
        title: title,
        fileBytes: _pickedFileBytes!,
        filename: _pickedFileName ?? 'document.pdf',
        expiryDate: _expiryController.text.trim().isNotEmpty ? _expiryController.text.trim() : null,
      );

      widget.onSuccess();
    } catch (e) {
      setState(() {
        _error = e.toString();
        _uploading = false;
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
                const Text(
                  'Upload Personnel Document',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close, color: Colors.white54),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
            const SizedBox(height: 16),
            const Text(
              'Document Category',
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
                        if (_titleController.text.isEmpty) {
                          _titleController.text = _categories.firstWhere((c) => c['id'] == val)['name']!;
                        }
                      });
                    }
                  },
                ),
              ),
            ),
            const SizedBox(height: 14),
            const Text(
              'Document Title / Notes',
              style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            TextField(
              controller: _titleController,
              style: const TextStyle(color: Colors.white, fontSize: 13),
              decoration: InputDecoration(
                hintText: 'e.g. Electricity Bill - July 2026',
                hintStyle: const TextStyle(color: Colors.white30),
                filled: true,
                fillColor: const Color(0xFF0F172A),
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: Colors.white12),
                ),
              ),
            ),
            const SizedBox(height: 14),
            const Text(
              'Expiry Date (if applicable)',
              style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            TextField(
              controller: _expiryController,
              style: const TextStyle(color: Colors.white, fontSize: 13),
              decoration: InputDecoration(
                hintText: 'YYYY-MM-DD (e.g. 2028-12-31 for CNIC)',
                hintStyle: const TextStyle(color: Colors.white30),
                filled: true,
                fillColor: const Color(0xFF0F172A),
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: Colors.white12),
                ),
              ),
            ),
            const SizedBox(height: 14),
            const Text(
              'Select Document File',
              style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFF0F172A),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: _pickedFileBytes != null ? const Color(0xFF10B981) : Colors.white12,
                ),
              ),
              child: Row(
                children: [
                  Icon(
                    _pickedFileBytes != null ? Icons.check_circle : Icons.attach_file,
                    color: _pickedFileBytes != null ? const Color(0xFF10B981) : const Color(0xFF818CF8),
                    size: 20,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      _pickedFileName ?? 'No file selected (PDF, PNG, JPG)',
                      style: TextStyle(
                        color: _pickedFileBytes != null ? Colors.white : Colors.white54,
                        fontSize: 12,
                        fontWeight: _pickedFileBytes != null ? FontWeight.bold : FontWeight.normal,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 8),
                  ElevatedButton(
                    onPressed: _pickFile,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF4F46E5),
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
                    ),
                    child: Text(
                      _pickedFileBytes != null ? 'Change' : 'Browse File',
                      style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold),
                    ),
                  ),
                ],
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
                onPressed: _uploading ? null : _submitUpload,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF4F46E5),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                child: _uploading
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                      )
                    : const Text(
                        'Submit Document to Cloud Vault',
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
