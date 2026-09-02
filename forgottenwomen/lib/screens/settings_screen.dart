import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../services/device_probe.dart';
import '../services/offline_queue.dart';
import '../services/presence_service.dart';
import '../services/token_store.dart';
import '../widgets/update_dialog.dart';
import '../theme.dart';

class SettingsScreen extends StatefulWidget {
  final VoidCallback onSignedOut;
  const SettingsScreen({super.key, required this.onSignedOut});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _store = TokenStore();
  final _api = ApiClient();
  final _probe = DeviceProbe();
  final _queue = OfflineQueue();
  final _otaService = OtaService();
  final _serverController = TextEditingController();

  String _model = '';
  String _deviceId = '';
  String _appVersion = 'v1.0.0+1';
  NetworkFacts _network = const NetworkFacts();
  int _pending = 0;
  String? _reachable;
  bool _checkingUpdate = false;
  String? _updateStatus;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _serverController.dispose();
    _api.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final url = await _store.readServerUrl();
    final model = await _probe.model();
    final deviceId = await _store.readDeviceId();
    final network = await _probe.network();
    final pending = await _queue.length;
    final pkgInfo = await _otaService.getPackageInfo();

    if (!mounted) return;
    setState(() {
      _serverController.text = url;
      _model = model;
      _deviceId = deviceId ?? '--';
      _network = network;
      _pending = pending;
      _appVersion = 'v${pkgInfo.version} (${pkgInfo.buildNumber})';
    });
  }

  Future<void> _checkUpdatesManual() async {
    setState(() {
      _checkingUpdate = true;
      _updateStatus = null;
    });

    try {
      final info = await _otaService.checkForUpdate();
      if (!mounted) return;

      setState(() => _checkingUpdate = false);

      if (info != null && info.updateAvailable) {
        UpdateDialog.show(context, info);
      } else {
        setState(() => _updateStatus = 'You are on the latest version ($_appVersion).');
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Your app is up to date ($_appVersion)'),
            backgroundColor: AppColors.teal,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _checkingUpdate = false;
          _updateStatus = 'Could not check for updates.';
        });
      }
    }
  }

  Future<void> _testConnection() async {
    await _store.saveServerUrl(_serverController.text);
    final ok = await _api.health();
    if (!mounted) return;
    setState(() => _reachable = ok ? 'Server reachable' : 'Could not reach the server');
  }

  Future<void> _unpair() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Unpair this device?'),
        content: const Text(
          'This device will stop reporting attendance. Hours already recorded '
          'are kept. You will need a new pairing code from your administrator '
          'to start again.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade700),
            child: const Text('Unpair'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;
    await PresenceService.stop();
    await _store.clear();
    await _queue.clear();
    if (mounted) widget.onSignedOut();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const _Header('Server'),
          Card(
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
              side: BorderSide(color: Colors.grey.shade200),
            ),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  TextField(
                    controller: _serverController,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Server address',
                      prefixIcon: Icon(Icons.dns_outlined),
                    ),
                  ),
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton.icon(
                      onPressed: _testConnection,
                      icon: const Icon(Icons.network_check, size: 16),
                      label: const Text('Test connection'),
                    ),
                  ),
                  if (_reachable != null) ...[
                    const SizedBox(height: 8),
                    Text(_reachable!,
                        style: TextStyle(
                          fontSize: 12,
                          color: _reachable!.startsWith('Server')
                              ? AppColors.teal
                              : Colors.red.shade700,
                        )),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          const _Header('This device'),
          _InfoTile(label: 'Model', value: _model),
          _InfoTile(label: 'Device ID', value: _deviceId),
          _InfoTile(label: 'Wi-Fi network', value: _network.ssid ?? 'Not connected'),
          _InfoTile(
            label: 'Access point',
            value: _network.hasBssid ? _network.bssid! : 'Unavailable',
            // Without the BSSID the server can only fall back to checking the
            // source IP, so it is worth surfacing rather than failing quietly.
            hint: _network.hasBssid
                ? null
                : 'Location permission is needed to read this. Without it, '
                    'verification that you are at the office is weaker.',
          ),
          _InfoTile(label: 'Readings waiting to upload', value: '$_pending'),
          const SizedBox(height: 20),
          const _Header('App Version & Updates'),
          _InfoTile(label: 'Installed Version', value: _appVersion),
          const SizedBox(height: 6),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _checkingUpdate ? null : _checkUpdatesManual,
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.teal,
                side: const BorderSide(color: AppColors.teal, width: 1.2),
                padding: const EdgeInsets.symmetric(vertical: 12),
              ),
              icon: _checkingUpdate
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.teal),
                    )
                  : const Icon(Icons.system_update_alt_rounded, size: 16),
              label: Text(_checkingUpdate ? 'Checking for updates…' : 'Check for Updates'),
            ),
          ),
          if (_updateStatus != null) ...[
            const SizedBox(height: 6),
            Text(
              _updateStatus!,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
            ),
          ],
          const SizedBox(height: 20),
          const _Header('Your data'),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.surfaceDark,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.border),
            ),
            child: const Text(
              'Detailed presence readings are deleted after 90 days. Your daily '
              'hours are retained as part of the payroll record. To request a '
              'copy of your data, or its deletion, contact your administrator.',
              style: TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.45),
            ),
          ),
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _unpair,
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.danger,
                side: BorderSide(color: AppColors.danger.withOpacity(0.4)),
              ),
              icon: const Icon(Icons.link_off, size: 16),
              label: const Text('Unpair this device'),
            ),
          ),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  final String title;
  const _Header(this.title);

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(
          title,
          style: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.bold,
            color: AppColors.textLight,
          ),
        ),
      );
}

class _InfoTile extends StatelessWidget {
  final String label;
  final String value;
  final String? hint;

  const _InfoTile({required this.label, required this.value, this.hint});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                ),
              ),
              Flexible(
                child: Text(
                  value,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: AppColors.textLight,
                  ),
                ),
              ),
            ],
          ),
          if (hint != null) ...[
            const SizedBox(height: 6),
            Text(
              hint!,
              style: const TextStyle(fontSize: 11, color: AppColors.amber, height: 1.3),
            ),
          ],
        ],
      ),
    );
  }
}
