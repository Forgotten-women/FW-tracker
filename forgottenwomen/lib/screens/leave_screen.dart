// Employee leave screen. Spec sections 14, 15 and 19.4.
//
// Shows the five balance figures spec 19.4 asks for, the list of requests, and
// a booking flow that previews the cost and shortfall BEFORE submitting - spec
// 15 is explicit that those figures appear up front, so nobody discovers a
// shortfall after the fact.

import 'package:flutter/material.dart';

import '../models/hr.dart';
import '../services/api_client.dart';
import '../theme.dart';

class LeaveScreen extends StatefulWidget {
  const LeaveScreen({super.key});

  @override
  State<LeaveScreen> createState() => _LeaveScreenState();
}

class _LeaveScreenState extends State<LeaveScreen> {
  final _api = ApiClient();

  LeaveBalance? _balance;
  List<LeaveRequest> _requests = const [];
  bool _loading = true;
  String? _error;

  @override
  void dispose() {
    _api.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final data = await _api.myLeave();
      if (!mounted) return;
      setState(() {
        _balance = data['balance'] as LeaveBalance;
        _requests = (data['requests'] as List).cast<LeaveRequest>();
        _error = null;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  Future<void> _openBooking() async {
    final booked = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => _BookingSheet(api: _api),
    );
    if (booked == true) _load();
  }

  Future<void> _cancel(LeaveRequest r) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cancel this request?'),
        content: Text('${r.type}: ${r.from} to ${r.to}'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade700),
            child: const Text('Cancel request'),
          ),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await _api.cancelLeave(r.id);
      _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Leave')),
      floatingActionButton: (_balance != null && !_balance!.blocked)
          ? FloatingActionButton.extended(
              onPressed: _openBooking,
              backgroundColor: AppColors.teal,
              icon: const Icon(Icons.add),
              label: const Text('Book leave'),
            )
          : null,
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.teal))
          : RefreshIndicator(
              color: AppColors.teal,
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_error != null) _errorBanner(_error!),
                  if (_balance != null) _balanceCard(_balance!),
                  const SizedBox(height: 20),
                  const Text('Your requests',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 8),
                  if (_requests.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(
                        child: Text('No leave requests yet.',
                            style: TextStyle(color: Colors.grey)),
                      ),
                    )
                  else
                    ..._requests.map(_requestRow),
                ],
              ),
            ),
    );
  }

  Widget _errorBanner(String msg) => Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.red.shade50,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: Colors.red.shade200),
        ),
        child: Text(msg, style: TextStyle(color: Colors.red.shade800, fontSize: 12)),
      );

  Widget _balanceCard(LeaveBalance b) {
    // Under an anniversary-based year, an employee with no start date has no
    // computable balance. Say so plainly rather than showing zeroes.
    if (b.blocked) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.amber.shade50,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Colors.amber.shade200),
        ),
        child: Row(
          children: [
            Icon(Icons.info_outline, color: Colors.amber.shade800),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                b.blockedMessage ?? 'Your leave balance is not available yet.',
                style: TextStyle(fontSize: 12, color: Colors.amber.shade900),
              ),
            ),
          ],
        ),
      );
    }

    String d(double v) => v.toStringAsFixed(2);
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [AppColors.teal, AppColors.tealDark],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${d(b.available)} days available',
              style: const TextStyle(
                  color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold)),
          if (b.isNegative)
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Text('This is a negative balance, approved in advance.',
                  style: TextStyle(color: Colors.amberAccent, fontSize: 11)),
            ),
          const SizedBox(height: 16),
          const Divider(color: Colors.white24),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: [
              _metric('Entitlement', d(b.annualEntitlement)),
              _metric('Accrued', d(b.accrued)),
              _metric('Taken', d(b.taken)),
              _metric('Booked', d(b.booked)),
            ],
          ),
          if (b.yearFrom != null) ...[
            const SizedBox(height: 12),
            Text('Holiday year ${b.yearFrom} to ${b.yearTo}',
                style: TextStyle(color: Colors.white.withValues(alpha: 0.75), fontSize: 11)),
          ],
        ],
      ),
    );
  }

  Widget _metric(String label, String value) => Column(
        children: [
          Text(value,
              style: const TextStyle(
                  color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16)),
          Text(label,
              style: TextStyle(color: Colors.white.withValues(alpha: 0.75), fontSize: 11)),
        ],
      );

  Widget _requestRow(LeaveRequest r) {
    final (color, label) = switch (r.status) {
      'APPROVED' => (Colors.green, 'Approved'),
      'REJECTED' => (Colors.red, 'Rejected'),
      'CANCELLED' => (Colors.grey, 'Cancelled'),
      _ => (Colors.orange, 'Pending'),
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${r.type} · ${r.days.toStringAsFixed(r.days == r.days.roundToDouble() ? 0 : 2)} day(s)',
                    style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                Text('${r.from} to ${r.to}',
                    style: TextStyle(color: Colors.grey.shade600, fontSize: 11)),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(label,
                style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600)),
          ),
          if (r.isPending || r.isApproved)
            IconButton(
              icon: const Icon(Icons.close, size: 18),
              color: Colors.grey,
              onPressed: () => _cancel(r),
              tooltip: 'Cancel',
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

  // Previews the cost as soon as there is enough to compute it - spec 15 wants
  // the figures visible before the request is sent.
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
              child: Center(child: CircularProgressIndicator(color: AppColors.teal)),
            )
          : Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Book leave',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                const SizedBox(height: 16),
                DropdownButtonFormField<LeaveType>(
                  initialValue: _type,
                  decoration: const InputDecoration(labelText: 'Type', border: OutlineInputBorder()),
                  items: _types
                      .map((t) => DropdownMenuItem(value: t, child: Text(t.name)))
                      .toList(),
                  onChanged: (t) {
                    setState(() => _type = t);
                    _refreshPreview();
                  },
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(child: _dateField('From', _from, () => _pick(isStart: true))),
                    const SizedBox(width: 12),
                    Expanded(child: _dateField('To', _to, () => _pick(isStart: false))),
                  ],
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _reason,
                  decoration: InputDecoration(
                    labelText: _type?.requiresEvidence == true
                        ? 'Reason (required for this type)'
                        : 'Reason (optional)',
                    border: const OutlineInputBorder(),
                  ),
                  maxLines: 2,
                ),
                if (_preview != null) ...[
                  const SizedBox(height: 16),
                  _previewCard(_preview!),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!, style: TextStyle(color: Colors.red.shade700, fontSize: 12)),
                ],
                const SizedBox(height: 16),
                SizedBox(
                  height: 48,
                  child: FilledButton(
                    onPressed: (_submitting || _preview == null) ? null : _submit,
                    style: FilledButton.styleFrom(backgroundColor: AppColors.teal),
                    child: Text(_submitting ? 'Submitting…' : 'Submit request'),
                  ),
                ),
              ],
            ),
    );
  }

  Widget _dateField(String label, DateTime? value, VoidCallback onTap) => InkWell(
        onTap: onTap,
        child: InputDecorator(
          decoration: InputDecoration(labelText: label, border: const OutlineInputBorder()),
          child: Text(value == null ? 'Select' : _fmt(value),
              style: TextStyle(color: value == null ? Colors.grey : Colors.black87)),
        ),
      );

  Widget _previewCard(LeavePreview p) {
    final over = p.exceedsBalance;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: over ? Colors.amber.shade50 : Colors.teal.shade50,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: over ? Colors.amber.shade300 : Colors.teal.shade100),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${p.requestedDays.toStringAsFixed(p.requestedDays == p.requestedDays.roundToDouble() ? 0 : 2)} working day(s)',
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
          Text('Balance after approval: ${p.projectedAvailable.toStringAsFixed(2)} days',
              style: const TextStyle(fontSize: 12)),
          if (p.warning != null) ...[
            const SizedBox(height: 6),
            Text(p.warning!,
                style: TextStyle(fontSize: 11, color: Colors.amber.shade900)),
          ],
        ],
      ),
    );
  }
}
