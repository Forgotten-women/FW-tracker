import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';

import '../models/hr.dart';
import '../services/api_client.dart';
import '../services/token_store.dart';
import '../theme.dart';

class ComplaintsScreen extends StatefulWidget {
  final ApiClient? api;
  const ComplaintsScreen({super.key, this.api});

  @override
  State<ComplaintsScreen> createState() => _ComplaintsScreenState();
}

class _ComplaintsScreenState extends State<ComplaintsScreen> with SingleTickerProviderStateMixin {
  late final ApiClient _api;
  late final TabController _tabController;
  final _tokenStore = TokenStore();

  String _employeeName = '';
  String? _employeeId;

  // Tab 1: Submit Form State
  final _formKey = GlobalKey<FormState>();
  final _subjectController = TextEditingController();
  final _descriptionController = TextEditingController();
  String _selectedCategory = 'Salary or payroll deductions';
  final String _selectedPriority = 'NORMAL';
  final List<PlatformFile> _selectedFiles = [];
  bool _submitting = false;

  final List<String> _defaultCategories = [
    'Salary or payroll deductions',
    'Incorrect attendance records',
    'Leave entitlement',
    'Working hours',
    'Workplace issues',
    'Behaviour or treatment in the office',
    'Problems involving another employee',
    'Problems involving a manager',
    'Harassment, bullying, or inappropriate behaviour',
    'Health and safety concerns',
    'Any other HR or workplace-related issue',
  ];
  List<String> _categories = [];

  // Tab 2: My Complaints State
  List<ComplaintItem> _myComplaints = [];
  bool _loadingList = true;
  String? _listError;

  @override
  void initState() {
    super.initState();
    _api = widget.api ?? ApiClient();
    _tabController = TabController(length: 2, vsync: this);
    _categories = List.from(_defaultCategories);
    _loadEmployeeData();
    _loadCategories();
    _loadMyComplaints();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _subjectController.dispose();
    _descriptionController.dispose();
    if (widget.api == null) {
      _api.dispose();
    }
    super.dispose();
  }

  Future<void> _loadEmployeeData() async {
    final name = await _tokenStore.readEmployeeName();
    final deviceId = await _tokenStore.readDeviceId();
    if (mounted) {
      setState(() {
        _employeeName = name;
        _employeeId = deviceId;
      });
    }
  }

  Future<void> _loadCategories() async {
    try {
      final cats = await _api.fetchComplaintCategories();
      if (cats.isNotEmpty && mounted) {
        setState(() {
          _categories = cats;
          if (!_categories.contains(_selectedCategory)) {
            _selectedCategory = _categories.first;
          }
        });
      }
    } catch (_) {}
  }

  Future<void> _loadMyComplaints() async {
    setState(() {
      _loadingList = true;
      _listError = null;
    });

    try {
      final list = await _api.myComplaints();
      if (mounted) {
        setState(() {
          _myComplaints = list;
          _loadingList = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() {
          _listError = err.toString();
          _loadingList = false;
        });
      }
    }
  }

  Future<void> _pickAttachments() async {
    try {
      final result = await FilePicker.platform.pickFiles(
        allowMultiple: true,
        type: FileType.any,
      );
      if (result != null && result.files.isNotEmpty && mounted) {
        setState(() {
          _selectedFiles.addAll(result.files);
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to pick file: $e'),
            backgroundColor: AppColors.danger,
          ),
        );
      }
    }
  }

  void _removeAttachment(int index) {
    setState(() {
      _selectedFiles.removeAt(index);
    });
  }

  Future<void> _submitConcern() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _submitting = true);

    try {
      final filePaths = _selectedFiles
          .where((f) => f.path != null)
          .map((f) => f.path!)
          .toList();

      final result = await _api.submitComplaint(
        category: _selectedCategory,
        subject: _subjectController.text.trim(),
        description: _descriptionController.text.trim(),
        priority: _selectedPriority,
        filePaths: filePaths,
      );

      if (mounted) {
        setState(() {
          _submitting = false;
          _subjectController.clear();
          _descriptionController.clear();
          _selectedFiles.clear();
        });

        _showConfirmationDialog(result);
        _loadMyComplaints();
      }
    } catch (err) {
      if (mounted) {
        setState(() => _submitting = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(err.toString()),
            backgroundColor: AppColors.danger,
          ),
        );
      }
    }
  }

  void _showConfirmationDialog(ComplaintSubmitResult result) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: AppColors.teal.withValues(alpha: 0.15),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.check_circle_rounded, color: AppColors.teal, size: 48),
            ),
            const SizedBox(height: 16),
            const Text(
              'Concern Submitted Confidentially',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.bold,
                color: Colors.white,
              ),
            ),
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              decoration: BoxDecoration(
                color: AppColors.bgDark,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.primary.withValues(alpha: 0.3)),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.tag_rounded, color: AppColors.primaryLight, size: 18),
                  const SizedBox(width: 6),
                  Text(
                    result.referenceNumber,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontWeight: FontWeight.bold,
                      fontSize: 15,
                      color: AppColors.primaryLight,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            Text(
              result.message,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.4),
            ),
            const SizedBox(height: 8),
            const Text(
              'Only authorised HR and Management can access your submission.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 11, color: AppColors.teal, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 24),
            SizedBox(
              width: double.infinity,
              height: 44,
              child: FilledButton(
                onPressed: () {
                  Navigator.pop(ctx);
                  _tabController.animateTo(1);
                },
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                child: const Text('View My Concerns', style: TextStyle(fontWeight: FontWeight.bold)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showComplaintDetailsSheet(ComplaintItem complaint) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.82,
        minChildSize: 0.5,
        maxChildSize: 0.95,
        builder: (_, scrollController) => Container(
          decoration: const BoxDecoration(
            color: AppColors.surfaceDark,
            borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
          ),
          padding: const EdgeInsets.all(20),
          child: ListView(
            controller: scrollController,
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

              // Reference and status badge
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    complaint.referenceNumber,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: AppColors.primaryLight,
                    ),
                  ),
                  _buildStatusChip(complaint.status),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                'Submitted on ${complaint.createdAtFormatted}',
                style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
              ),
              const SizedBox(height: 14),

              // Category tag
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: AppColors.bgDark,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.border),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.label_outline, size: 14, color: AppColors.textMuted),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        complaint.category,
                        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Colors.white),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),

              // Subject & Description
              Text(
                complaint.subject,
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.white),
              ),
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: AppColors.bgDark,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.border),
                ),
                child: Text(
                  complaint.description,
                  style: const TextStyle(fontSize: 13, color: AppColors.textLight, height: 1.4),
                ),
              ),
              const SizedBox(height: 16),

              // Attachments if any
              if (complaint.attachments.isNotEmpty) ...[
                const Text(
                  'ATTACHED DOCUMENTS / SCREENSHOTS',
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppColors.textMuted, letterSpacing: 1),
                ),
                const SizedBox(height: 8),
                ...complaint.attachments.map((att) => Container(
                      margin: const EdgeInsets.only(bottom: 8),
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(
                        color: AppColors.bgDark,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: AppColors.border),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.attach_file, color: AppColors.primaryLight, size: 18),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(att.fileName, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Colors.white)),
                                Text('${(att.fileSize / 1024).toStringAsFixed(1)} KB', style: const TextStyle(fontSize: 10, color: AppColors.textMuted)),
                              ],
                            ),
                          ),
                        ],
                      ),
                    )),
                const SizedBox(height: 16),
              ],

              // HR Response & Notes
              if (complaint.hrNotes != null && complaint.hrNotes!.isNotEmpty) ...[
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: AppColors.amber.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppColors.amber.withValues(alpha: 0.3)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Row(
                        children: [
                          Icon(Icons.comment_outlined, color: AppColors.amber, size: 16),
                          SizedBox(width: 6),
                          Text('HR / Management Response', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.amber)),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        complaint.hrNotes!,
                        style: const TextStyle(fontSize: 12, color: Colors.white, height: 1.4),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
              ],

              // Resolution Date & Summary
              if (complaint.resolvedAt != null) ...[
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: AppColors.teal.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppColors.teal.withValues(alpha: 0.3)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Row(
                            children: [
                              Icon(Icons.check_circle_outline, color: AppColors.teal, size: 16),
                              SizedBox(width: 6),
                              Text('Resolved', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.teal)),
                            ],
                          ),
                          Text(
                            complaint.resolvedAtFormatted ?? '',
                            style: const TextStyle(fontSize: 11, color: AppColors.teal),
                          ),
                        ],
                      ),
                      if (complaint.resolutionNotes != null && complaint.resolutionNotes!.isNotEmpty) ...[
                        const SizedBox(height: 6),
                        Text(
                          complaint.resolutionNotes!,
                          style: const TextStyle(fontSize: 12, color: Colors.white70, height: 1.4),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildStatusChip(String status) {
    Color bg = AppColors.primary.withValues(alpha: 0.15);
    Color text = AppColors.primaryLight;
    String label = status;

    switch (status) {
      case 'SUBMITTED':
        bg = Colors.purple.withValues(alpha: 0.15);
        text = Colors.purpleAccent;
        label = 'Submitted';
        break;
      case 'UNDER_REVIEW':
        bg = AppColors.amber.withValues(alpha: 0.15);
        text = AppColors.amber;
        label = 'Under Review';
        break;
      case 'IN_PROGRESS':
        bg = Colors.lightBlue.withValues(alpha: 0.15);
        text = Colors.lightBlueAccent;
        label = 'In Progress';
        break;
      case 'RESOLVED':
        bg = AppColors.teal.withValues(alpha: 0.15);
        text = AppColors.teal;
        label = 'Resolved';
        break;
      case 'CLOSED':
        bg = AppColors.border;
        text = AppColors.textMuted;
        label = 'Closed';
        break;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        label,
        style: TextStyle(color: text, fontSize: 11, fontWeight: FontWeight.bold),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('Employee Concerns & Complaints'),
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: AppColors.primary,
          labelColor: Colors.white,
          unselectedLabelColor: AppColors.textMuted,
          labelStyle: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
          tabs: const [
            Tab(text: 'Submit Concern'),
            Tab(text: 'My Concerns'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _buildSubmitTab(),
          _buildMyConcernsTab(),
        ],
      ),
    );
  }

  Widget _buildSubmitTab() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Confidential Privacy Banner
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColors.primary.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AppColors.primary.withValues(alpha: 0.25)),
              ),
              child: const Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.shield_outlined, color: AppColors.primaryLight, size: 22),
                  SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Strictly Confidential Submission',
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                        SizedBox(height: 4),
                        Text(
                          'Your concern will be securely received by authorized HR & Management. It is never visible or accessible to other employees.',
                          style: TextStyle(fontSize: 11, color: AppColors.textMuted, height: 1.35),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 18),

            // Employee Name & ID summary
            if (_employeeName.isNotEmpty) ...[
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
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
                        const Icon(Icons.person_outline, size: 16, color: AppColors.textMuted),
                        const SizedBox(width: 8),
                        Text(
                          _employeeName,
                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Colors.white),
                        ),
                      ],
                    ),
                    Text(
                      _employeeId != null && _employeeId!.isNotEmpty
                          ? 'ID: $_employeeId'
                          : 'Submitting as Self',
                      style: const TextStyle(fontSize: 11, color: AppColors.teal, fontWeight: FontWeight.w600),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 18),
            ],

            // Category Dropdown
            const Text(
              'Complaint Category',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.textLight),
            ),
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: BoxDecoration(
                color: AppColors.surfaceDark,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.border),
              ),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  value: _selectedCategory,
                  isExpanded: true,
                  dropdownColor: AppColors.surfaceDark,
                  style: const TextStyle(fontSize: 13, color: Colors.white),
                  items: _categories.map((cat) {
                    return DropdownMenuItem<String>(
                      value: cat,
                      child: Text(cat, overflow: TextOverflow.ellipsis),
                    );
                  }).toList(),
                  onChanged: (val) {
                    if (val != null) {
                      setState(() => _selectedCategory = val);
                    }
                  },
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Subject / Title
            const Text(
              'Subject / Title',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.textLight),
            ),
            const SizedBox(height: 6),
            TextFormField(
              controller: _subjectController,
              style: const TextStyle(color: Colors.white, fontSize: 13),
              decoration: InputDecoration(
                hintText: 'e.g. Issue regarding overtime calculation...',
                hintStyle: const TextStyle(color: Colors.white30, fontSize: 12),
                filled: true,
                fillColor: AppColors.surfaceDark,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: AppColors.border)),
                enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: AppColors.border)),
                focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: AppColors.primary)),
              ),
              validator: (val) {
                if (val == null || val.trim().isEmpty) return 'Please enter a subject.';
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Detailed Description
            const Text(
              'Detailed Description',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.textLight),
            ),
            const SizedBox(height: 6),
            TextFormField(
              controller: _descriptionController,
              maxLines: 5,
              style: const TextStyle(color: Colors.white, fontSize: 13),
              decoration: InputDecoration(
                hintText: 'Please describe the situation, dates, persons involved (if any), and desired resolution...',
                hintStyle: const TextStyle(color: Colors.white30, fontSize: 12),
                filled: true,
                fillColor: AppColors.surfaceDark,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: AppColors.border)),
                enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: AppColors.border)),
                focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: AppColors.primary)),
              ),
              validator: (val) {
                if (val == null || val.trim().isEmpty) return 'Please enter a detailed description.';
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Attachments Section
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'Supporting Documents / Screenshots',
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.textLight),
                ),
                TextButton.icon(
                  onPressed: _pickAttachments,
                  icon: const Icon(Icons.attach_file, size: 16, color: AppColors.primaryLight),
                  label: const Text('Add File', style: TextStyle(fontSize: 12, color: AppColors.primaryLight)),
                ),
              ],
            ),
            if (_selectedFiles.isNotEmpty) ...[
              const SizedBox(height: 6),
              ..._selectedFiles.asMap().entries.map((entry) {
                final idx = entry.key;
                final file = entry.value;
                return Container(
                  margin: const EdgeInsets.only(bottom: 6),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: AppColors.surfaceDark,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.insert_drive_file_outlined, color: AppColors.teal, size: 18),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          file.name,
                          style: const TextStyle(fontSize: 12, color: Colors.white),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.close, size: 16, color: AppColors.danger),
                        onPressed: () => _removeAttachment(idx),
                        constraints: const BoxConstraints(),
                        padding: EdgeInsets.zero,
                      ),
                    ],
                  ),
                );
              }),
            ],
            const SizedBox(height: 24),

            // Submit Button
            SizedBox(
              width: double.infinity,
              height: 48,
              child: FilledButton.icon(
                onPressed: _submitting ? null : _submitConcern,
                icon: _submitting
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Icon(Icons.send_rounded, size: 18),
                label: Text(
                  _submitting ? 'Submitting Confidentially...' : 'Submit Confidential Concern',
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                ),
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMyConcernsTab() {
    if (_loadingList) {
      return const Center(
        child: CircularProgressIndicator(color: AppColors.primary),
      );
    }

    if (_listError != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: AppColors.danger, size: 40),
              const SizedBox(height: 12),
              Text(
                _listError!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
              ),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: _loadMyComplaints,
                icon: const Icon(Icons.refresh, size: 16),
                label: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    if (_myComplaints.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.all(20),
                decoration: const BoxDecoration(
                  color: AppColors.surfaceDark,
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.folder_open_rounded, size: 40, color: AppColors.textMuted),
              ),
              const SizedBox(height: 16),
              const Text(
                'No Concerns Submitted',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Colors.white),
              ),
              const SizedBox(height: 8),
              const Text(
                'You have not submitted any complaints or concerns yet. Use the "Submit Concern" tab if you have any HR or workplace matter to raise confidentially.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.4),
              ),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadMyComplaints,
      color: AppColors.primary,
      child: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: _myComplaints.length,
        separatorBuilder: (_, _) => const SizedBox(height: 12),
        itemBuilder: (ctx, index) {
          final c = _myComplaints[index];
          return Card(
            color: AppColors.surfaceDark,
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
              side: const BorderSide(color: AppColors.border),
            ),
            child: InkWell(
              borderRadius: BorderRadius.circular(16),
              onTap: () => _showComplaintDetailsSheet(c),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          c.referenceNumber,
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 13,
                            fontWeight: FontWeight.bold,
                            color: AppColors.primaryLight,
                          ),
                        ),
                        _buildStatusChip(c.status),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      c.subject,
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: Colors.white),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      c.category,
                      style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          c.createdAtFormatted,
                          style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
                        ),
                        if (c.hrNotes != null && c.hrNotes!.isNotEmpty)
                          const Row(
                            children: [
                              Icon(Icons.mark_chat_read_outlined, size: 14, color: AppColors.amber),
                              SizedBox(width: 4),
                              Text('HR Responded', style: TextStyle(fontSize: 11, color: AppColors.amber, fontWeight: FontWeight.bold)),
                            ],
                          )
                        else if (c.attachments.isNotEmpty)
                          Row(
                            children: [
                              const Icon(Icons.attach_file, size: 14, color: AppColors.textMuted),
                              const SizedBox(width: 2),
                              Text('${c.attachments.length} file(s)', style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
                            ],
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
