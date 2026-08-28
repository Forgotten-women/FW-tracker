// Employee warnings screen. Spec sections 9.2, 19.2 and 19.5.
//
// Shows the lateness standing in the organisation's own words, the green/amber/
// red band as a LABEL (spec 21: colour never the only signal), and formal
// warnings with an acknowledge action. Acknowledging records receipt, not
// agreement - the screen says so, because signing must not be mistaken for
// consent.

import 'package:flutter/material.dart';

import '../models/hr.dart';
import '../services/api_client.dart';
import '../theme.dart';

class WarningsScreen extends StatefulWidget {
  const WarningsScreen({super.key});

  @override
  State<WarningsScreen> createState() => _WarningsScreenState();
}

class _WarningsScreenState extends State<WarningsScreen> {
  final _api = ApiClient();
  WarningView? _view;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _api.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final v = await _api.myWarnings();
      if (!mounted) return;
      setState(() { _view = v; _error = null; _loading = false; });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() { _error = e.message; _loading = false; });
    }
  }

  Future<void> _acknowledge(FormalWarning w) async {
    final controller = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Acknowledge receipt'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'This records that you have received this warning. It does not '
              'mean you agree with it. You may add a comment.',
              style: TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              decoration: const InputDecoration(
                labelText: 'Comment (optional)',
                border: OutlineInputBorder(),
              ),
              maxLines: 2,
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not now')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: AppColors.teal),
            child: const Text('Acknowledge receipt'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await _api.acknowledgeWarning(w.id,
          comments: controller.text.trim().isEmpty ? null : controller.text.trim());
      _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Attendance & Warnings')),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.teal))
          : RefreshIndicator(
              color: AppColors.teal,
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_error != null)
                    Text(_error!, style: TextStyle(color: Colors.red.shade700))
                  else if (_view != null) ...[
                    _bandCard(_view!),
                    const SizedBox(height: 16),
                    _latenessCard(_view!.lateness),
                    const SizedBox(height: 20),
                    const Text('Formal warnings',
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 8),
                    if (_view!.warnings.isEmpty)
                      const Padding(
                        padding: EdgeInsets.all(24),
                        child: Center(
                          child: Text('No formal warnings on your record.',
                              style: TextStyle(color: Colors.grey)),
                        ),
                      )
                    else
                      ..._view!.warnings.map(_warningCard),
                  ],
                ],
              ),
            ),
    );
  }

  (Color, Color) _bandColours(String band) => switch (band) {
        'GREEN' => (Colors.green.shade600, Colors.green.shade50),
        'AMBER' => (Colors.orange.shade700, Colors.orange.shade50),
        'RED' => (Colors.red.shade700, Colors.red.shade50),
        _ => (Colors.blueGrey, Colors.blueGrey.shade50),
      };

  Widget _bandCard(WarningView v) {
    final (fg, bg) = _bandColours(v.band);
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: fg.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          Container(
            width: 12, height: 12,
            decoration: BoxDecoration(color: fg, shape: BoxShape.circle),
          ),
          const SizedBox(width: 12),
          // The label is always present; the dot only supplements it.
          Expanded(
            child: Text(v.bandLabel,
                style: TextStyle(color: fg, fontWeight: FontWeight.bold, fontSize: 15)),
          ),
        ],
      ),
    );
  }

  Widget _latenessCard(LatenessStatus s) {
    if (!s.resolved) {
      return _plainCard('Lateness cannot be shown until the monitoring period is set.');
    }
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Late occurrences this period',
                  style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
              Text('${s.count} / ${s.allowed}',
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 15,
                    color: s.thresholdReached ? Colors.red.shade700 : AppColors.slateDark,
                  )),
            ],
          ),
          const SizedBox(height: 8),
          // The organisation's own wording from spec 9.2.
          Text(s.message, style: TextStyle(fontSize: 12, color: Colors.grey.shade700, height: 1.4)),
        ],
      ),
    );
  }

  Widget _plainCard(String text) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Colors.grey.shade200),
        ),
        child: Text(text, style: const TextStyle(fontSize: 12, color: Colors.grey)),
      );

  Widget _warningCard(FormalWarning w) {
    final expired = w.status == 'EXPIRED';
    final withdrawn = w.status == 'WITHDRAWN';
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  w.levelLabel[0].toUpperCase() + w.levelLabel.substring(1),
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                ),
              ),
              if (expired || withdrawn)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: Colors.grey.shade100,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(withdrawn ? 'Withdrawn' : 'Expired',
                      style: TextStyle(fontSize: 10, color: Colors.grey.shade600)),
                ),
            ],
          ),
          const SizedBox(height: 4),
          Text('Issued ${w.issuedOn}',
              style: TextStyle(fontSize: 11, color: Colors.grey.shade500)),
          const SizedBox(height: 8),
          Text(w.explanation, style: const TextStyle(fontSize: 13, height: 1.4)),
          if (w.acknowledgementRequired) ...[
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton(
                onPressed: () => _acknowledge(w),
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.teal,
                  side: const BorderSide(color: AppColors.teal),
                ),
                child: const Text('Acknowledge receipt'),
              ),
            ),
          ] else if (w.acknowledgedAt != null) ...[
            const SizedBox(height: 8),
            Text('Receipt acknowledged ${w.acknowledgedAt}',
                style: TextStyle(fontSize: 11, color: Colors.green.shade700)),
          ],
        ],
      ),
    );
  }
}
