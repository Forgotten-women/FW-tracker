// Enrolment.
//
// The employee enters a single-use code issued by an administrator. The old
// flow instead let the phone invent its own employee id and send whatever name
// was typed, so anyone could register as anyone.

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
    final code = _codeController.text.trim().toUpperCase();
    if (code.isEmpty) {
      setState(() => _error = 'Enter the code your administrator gave you.');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      await _store.saveServerUrl(_serverController.text);

      // Requested before the first heartbeat, because without it the platform
      // returns a null SSID/BSSID and location verification silently weakens.
      final granted = await _probe.ensureLocationPermission();
      if (!granted && mounted) {
        setState(() => _error =
            'Location permission is required to confirm you are on the office network. '
            'Enable it in Settings and try again.');
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

      await _probe.ensureBackgroundLocationPermission();
      await PresenceService.start();

      if (mounted) widget.onEnrolled();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
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
                        'Ask your administrator for a pairing code. '
                        'It can only be used once.',
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
                          letterSpacing: 4,
                          fontWeight: FontWeight.bold,
                        ),
                        textAlign: TextAlign.center,
                        decoration: const InputDecoration(
                          labelText: 'Pairing code',
                          hintText: 'XXXX-XXXX',
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

/// Explicit, informed consent before any tracking begins.
///
/// This data is used for payroll, and the organisation is UK-based, so people
/// have to be told what is collected and for how long before it starts - not
/// discover it later.
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
            'While paired, this app reports the time you are connected to an '
            'office Wi-Fi network, so your working hours can be recorded for '
            'payroll.\n\n'
            'It records: the name of the network you are on, the access point '
            'identifier, and the time. It does NOT record your location when '
            'you are away from the office, your browsing, or anything else on '
            'your phone.\n\n'
            'Detailed records are kept for 90 days. Your daily hours are kept '
            'as long as your employer retains payroll records. You can ask to '
            'see your data or have this device unpaired at any time.',
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
