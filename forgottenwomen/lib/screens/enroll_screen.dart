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
      if (mounted) _serverController.text = url;
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Pair this device')),
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
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: Colors.grey.shade200),
                  ),
                  child: Column(
                    children: [
                      const Icon(Icons.badge_outlined, size: 44, color: AppColors.teal),
                      const SizedBox(height: 16),
                      const Text('Office Tracker',
                          style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                      const SizedBox(height: 6),
                      Text(
                        'Enter the pairing code shown on your admin dashboard.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
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
                        ),
                        textAlign: TextAlign.center,
                        decoration: const InputDecoration(
                          labelText: 'Pairing code',
                          hintText: 'e.g. WKYJ-UPNM',
                        ),
                      ),
                      const SizedBox(height: 16),
                      TextField(
                        controller: _serverController,
                        keyboardType: TextInputType.url,
                        autocorrect: false,
                        decoration: const InputDecoration(
                          labelText: 'Server address',
                          prefixIcon: Icon(Icons.dns_outlined),
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
                      color: Colors.red.shade50,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: Colors.red.shade200),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.error_outline, color: Colors.red, size: 20),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(_error!,
                              style: TextStyle(color: Colors.red.shade800, fontSize: 12)),
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
                    style: FilledButton.styleFrom(backgroundColor: AppColors.teal),
                    icon: _busy
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                                strokeWidth: 2, color: Colors.white),
                          )
                        : const Icon(Icons.link),
                    label: Text(_busy ? 'Pairing...' : 'Pair device'),
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
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.grey.shade300),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.privacy_tip_outlined, size: 18, color: Colors.grey.shade700),
              const SizedBox(width: 8),
              const Text('What this app records',
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'While paired, this app reports the time you are connected to the '
            'office Wi-Fi network, so your working hours can be recorded.\n\n'
            'It records: connected Wi-Fi network name, access point identifier, '
            'and timestamps. It does NOT record personal GPS location when away '
            'from the office or internet browsing activity.',
            style: TextStyle(fontSize: 12, color: Colors.grey.shade700, height: 1.45),
          ),
          const SizedBox(height: 4),
          CheckboxListTile(
            value: value,
            onChanged: onChanged,
            dense: true,
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            activeColor: AppColors.teal,
            title: const Text('I understand and agree',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
          ),
        ],
      ),
    );
  }
}