// Employee warnings screen. Spec sections 9.2, 19.2 and 19.5.

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
        backgroundColor: AppColors.surfaceDark,
        title: const Text('Acknowledge Receipt', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'This records that you have received this formal notice. It does not imply agreement. You may optionally add a comment for HR review.',
              style: TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.4),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: controller,
              style: const TextStyle(color: Colors.white, fontSize: 13),
              decoration: const InputDecoration(
                hintText: 'Optional statement / response...',
                hintStyle: TextStyle(color: Colors.white30),
              ),
              maxLines: 2,
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Not Now', style: TextStyle(color: AppColors.textMuted)),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: AppColors.primary),
            child: const Text('Acknowledge Receipt'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await _api.acknowledgeWarning(
        w.id,
        comments: controller.text.trim().isEmpty ? null : controller.text.trim(),
      );
      _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message), backgroundColor: AppColors.danger));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        backgroundColor: AppColors.surfaceDark,
        elevation: 0,
        title: const Text('Disciplinary & Standing', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17, color: Colors.white)),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: Colors.white70),
            onPressed: _loading ? null : _load,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppColors.primary))
          : RefreshIndicator(
              color: AppColors.primary,
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 30),
                children: [
                  if (_error != null)
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: AppColors.danger.withOpacity(0.15),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: AppColors.danger.withOpacity(0.4)),
                      ),
                      child: Text(_error!, style: const TextStyle(color: AppColors.danger, fontSize: 12)),
                    )
                  else if (_view != null) ...[
                    _bandCard(_view!),
                    const SizedBox(height: 16),
                    _latenessCard(_view!.lateness),
                    const SizedBox(height: 24),
                    const Text(
                      'FORMAL NOTICES & WARNINGS',
                      style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 1.1, color: AppColors.textMuted),
                    ),
                    const SizedBox(height: 10),
                    if (_view!.warnings.isEmpty)
                      Container(
                        padding: const EdgeInsets.all(24),
                        decoration: BoxDecoration(
                          color: AppColors.surfaceDark,
                          borderRadius: BorderRadius.circular(14),
                          border: Border.all(color: AppColors.border),
                        ),
                        child: const Center(
                          child: Text(
                            'No formal warnings or disciplinary records.\nYour attendance standing is clear.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: AppColors.textMuted, fontSize: 12, height: 1.5),
                          ),
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
        'GREEN' => (AppColors.teal, AppColors.teal.withOpacity(0.12)),
        'AMBER' => (AppColors.amber, AppColors.amber.withOpacity(0.12)),
        'RED' => (AppColors.danger, AppColors.danger.withOpacity(0.12)),
        _ => (AppColors.textMuted, AppColors.textMuted.withOpacity(0.12)),
      };

  Widget _bandCard(WarningView v) {
    final (fg, bg) = _bandColours(v.band);
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: fg.withOpacity(0.4)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.25),
            blurRadius: 14,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
            child: Icon(Icons.shield_outlined, color: fg, size: 22),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'ATTENDANCE STANDING',
                  style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 1.1, color: AppColors.textMuted),
                ),
                const SizedBox(height: 2),
                Text(
                  v.bandLabel,
                  style: TextStyle(color: fg, fontWeight: FontWeight.bold, fontSize: 15),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _latenessCard(LatenessStatus s) {
    if (!s.resolved) {
      return _plainCard('Lateness cannot be shown until the monitoring period is configured.');
    }
    return Container(
      padding: const EdgeInsets.all(18),
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
              const Expanded(
                child: Text(
                  'Lateness Occurrences',
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Colors.white),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: s.thresholdReached ? AppColors.danger.withOpacity(0.15) : AppColors.teal.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: s.thresholdReached ? AppColors.danger.withOpacity(0.5) : AppColors.teal.withOpacity(0.5)),
                ),
                child: Text(
                  '${s.count} / ${s.allowed} Allowed',
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 11,
                    color: s.thresholdReached ? AppColors.danger : AppColors.teal,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(s.message, style: const TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.4)),
        ],
      ),
    );
  }

  Widget _plainCard(String text) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.surfaceDark,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.border),
        ),
        child: Text(text, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
      );

  Widget _warningCard(FormalWarning w) {
    final expired = w.status == 'EXPIRED';
    final withdrawn = w.status == 'WITHDRAWN';
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                w.levelLabel[0].toUpperCase() + w.levelLabel.substring(1),
                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Colors.white),
              ),
              if (expired || withdrawn)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: AppColors.bgDark,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Text(
                    withdrawn ? 'Withdrawn' : 'Expired',
                    style: const TextStyle(fontSize: 10, color: AppColors.textMuted),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 4),
          Text('Issued On: ${w.issuedOn}', style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
          const SizedBox(height: 10),
          Text(w.explanation, style: const TextStyle(fontSize: 13, height: 1.4, color: Colors.white70)),
          if (w.acknowledgementRequired) ...[
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              height: 42,
              child: FilledButton(
                onPressed: () => _acknowledge(w),
                style: FilledButton.styleFrom(backgroundColor: AppColors.primary),
                child: const Text('Acknowledge Receipt', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
              ),
            ),
          ] else if (w.acknowledgedAt != null) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                const Icon(Icons.check_circle, color: AppColors.teal, size: 14),
                const SizedBox(width: 6),
                Text('Receipt acknowledged on ${w.acknowledgedAt}', style: const TextStyle(fontSize: 11, color: AppColors.teal)),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
