// Enrolment Screen

import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../services/device_probe.dart';
import '../services/presence_service.dart';
import '../services/token_store.dart';
import '../theme.dart';

class EnrollScreen extends StatefulWidget {
  final VoidCallback onEnrolled;
  const EnrollScreen({super.key, required this.onEnrolled});

  @override
  State<EnrollScreen> createState() => _EnrollScreenState();
}

class _EnrollScreenState extends State<EnrollScreen> {
  final _codeController = TextEditingController();
  final _serverController = TextEditingController();
  final _store = TokenStore();
  final _api = ApiClient();
  final _probe = DeviceProbe();

  bool _busy = false;
  String? _error;
  bool _consentGiven = false;

  @override
  void initState() {
    super.initState();
    _store.readServerUrl().then((url) {
      if (mounted) setState(() => _serverController.text = url);
    });
  }

  @override
  void dispose() {
    _codeController.dispose();
    _serverController.dispose();
    _api.dispose();
    super.dispose();
  }

  Future<void> _enroll() async {
    final rawText = _codeController.text.trim();
    final clean = rawText.replaceAll(RegExp(r'[^A-Za-z0-9]'), '').toUpperCase();
    if (clean.isEmpty) {
      setState(() => _error = 'Enter the code shown on the dashboard.');
      return;
    }

    final code = clean.length == 8 ? '${clean.substring(0, 4)}-${clean.substring(4)}' : clean;

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final serverUrl = _serverController.text.trim();
      if (serverUrl.isNotEmpty) {
        await _store.saveServerUrl(serverUrl);
      }

      final hasLocation = await _probe.ensureLocationPermission();
      if (!hasLocation) {
        setState(() => _error =
            'Location permission is required to detect office Wi-Fi networks.');
        setState(() => _busy = false);
        return;
      }

      final result = await _api.enroll(
        code: code,
        platform: _probe.platform,
        model: await _probe.model(),
      );

      final employee = result['employee'] as Map<String, dynamic>;
      await _store.saveEnrollment(
        token: result['token'] as String,
        deviceId: result['deviceId'] as String,
        employeeId: employee['id'] as String,
        employeeName: employee['name'] as String,
        employeeRole: employee['role'] as String? ?? '',
      );

      try {
        await _probe.ensureBackgroundLocationPermission();
      } catch (_) {}

      try {
        await PresenceService.start();
      } catch (_) {}

      if (mounted) widget.onEnrolled();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not pair: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _showServerDialog() async {
    final tempController = TextEditingController(
      text: _serverController.text.isNotEmpty
          ? _serverController.text
          : TokenStore.defaultServerUrl,
    );
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.surfaceDark,
        title: const Text(
          'Backend Server URL',
          style: TextStyle(color: AppColors.textLight, fontSize: 18, fontWeight: FontWeight.bold),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Specify the office attendance backend address.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 13),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: tempController,
              autocorrect: false,
              style: const TextStyle(color: AppColors.textLight, fontSize: 14),
              decoration: InputDecoration(
                labelText: 'Server URL',
                labelStyle: const TextStyle(color: AppColors.textMuted),
                hintText: TokenStore.defaultServerUrl,
                filled: true,
                fillColor: AppColors.bgDark,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
              ),
            ),
            const SizedBox(height: 12),
            TextButton.icon(
              onPressed: () {
                tempController.text = TokenStore.defaultServerUrl;
              },
              icon: const Icon(Icons.restore, size: 16, color: AppColors.teal),
              label: const Text(
                'Reset to Production Cloud',
                style: TextStyle(color: AppColors.teal, fontSize: 12),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel', style: TextStyle(color: AppColors.textMuted)),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.teal),
            onPressed: () async {
              final newUrl = tempController.text.trim();
              if (newUrl.isNotEmpty) {
                _serverController.text = newUrl;
                await _store.saveServerUrl(newUrl);
                if (mounted) setState(() {});
              }
              if (ctx.mounted) Navigator.of(ctx).pop();
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'Pair this device',
          style: TextStyle(fontWeight: FontWeight.bold, color: AppColors.textLight),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings_outlined, color: AppColors.textMuted),
            tooltip: 'Server settings',
            onPressed: _showServerDialog,
          ),
        ],
      ),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  padding: const EdgeInsets.all(24),
                  decoration: BoxDecoration(
                    color: AppColors.surfaceDark,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Column(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: AppColors.teal.withOpacity(0.12),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.badge_outlined, size: 36, color: AppColors.teal),
                      ),
                      const SizedBox(height: 16),
                      const Text(
                        'Office Tracker',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.bold,
                          color: AppColors.textLight,
                        ),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Enter the pairing code shown on your admin dashboard.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: AppColors.textMuted, fontSize: 13),
                      ),
                      const SizedBox(height: 24),
                      TextField(
                        controller: _codeController,
                        textCapitalization: TextCapitalization.characters,
                        autocorrect: false,
                        style: const TextStyle(
                          fontSize: 22,
                          letterSpacing: 3,
                          fontWeight: FontWeight.bold,
                          color: AppColors.textLight,
                        ),
                        textAlign: TextAlign.center,
                        decoration: InputDecoration(
                          labelText: 'Pairing code',
                          labelStyle: const TextStyle(color: AppColors.textMuted),
                          hintText: 'e.g. WKYJ-UPNM',
                          hintStyle: TextStyle(color: AppColors.textMuted.withOpacity(0.4)),
                          filled: true,
                          fillColor: AppColors.bgDark,
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                            borderSide: const BorderSide(color: AppColors.border),
                          ),
                          enabledBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                            borderSide: const BorderSide(color: AppColors.border),
                          ),
                          focusedBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(12),
                            borderSide: const BorderSide(color: AppColors.primary, width: 1.5),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                _ConsentNotice(
                  value: _consentGiven,
                  onChanged: (v) => setState(() => _consentGiven = v ?? false),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.danger.withOpacity(0.12),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AppColors.danger.withOpacity(0.3)),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.error_outline, color: AppColors.danger, size: 20),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _error!,
                            style: const TextStyle(
                              color: Color(0xFFFCA5A5),
                              fontSize: 12,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: 20),
                SizedBox(
                  height: 50,
                  child: FilledButton.icon(
                    onPressed: (_busy || !_consentGiven) ? null : _enroll,
                    style: FilledButton.styleFrom(
                      backgroundColor: AppColors.teal,
                      disabledBackgroundColor: AppColors.surfaceLight,
                      disabledForegroundColor: AppColors.textMuted.withOpacity(0.5),
                    ),
                    icon: _busy
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(Icons.link),
                    label: Text(_busy ? 'Pairing...' : 'Pair device'),
                  ),
                ),
                const SizedBox(height: 16),
                Center(
                  child: InkWell(
                    onTap: _showServerDialog,
                    borderRadius: BorderRadius.circular(8),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 10),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.cloud_outlined, size: 14, color: AppColors.textMuted),
                          const SizedBox(width: 6),
                          Flexible(
                            child: Text(
                              _serverController.text.isNotEmpty
                                  ? _serverController.text
                                  : TokenStore.defaultServerUrl,
                              style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 6),
                          const Icon(Icons.edit_outlined, size: 12, color: AppColors.teal),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ConsentNotice extends StatelessWidget {
  final bool value;
  final ValueChanged<bool?> onChanged;

  const _ConsentNotice({required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.privacy_tip_outlined, size: 18, color: AppColors.teal),
              SizedBox(width: 8),
              Text(
                'What this app records',
                style: TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 13,
                  color: AppColors.textLight,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          const Text(
            'While paired, this app reports the time you are connected to the '
            'office Wi-Fi network, so your working hours can be recorded.\n\n'
            'It records: connected Wi-Fi network name, access point identifier, '
            'and timestamps. It does NOT record personal GPS location when away '
            'from the office or internet browsing activity.',
            style: TextStyle(
              fontSize: 12,
              color: AppColors.textMuted,
              height: 1.45,
            ),
          ),
          const SizedBox(height: 4),
          Material(
            color: Colors.transparent,
            child: CheckboxListTile(
              value: value,
              onChanged: onChanged,
              contentPadding: EdgeInsets.zero,
              dense: true,
              activeColor: AppColors.teal,
              title: const Text(
                'I understand and agree to pair this device',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  color: AppColors.textLight,
                ),
              ),
              controlAffinity: ListTileControlAffinity.leading,
            ),
          ),
        ],
      ),
    );
  }
}