import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../models/ota.dart';
import '../services/ota_service.dart';
import '../services/update_sources.dart';
import '../theme.dart';

/// The update offer. On Android it downloads, verifies and opens the system
/// installer; on iOS it hands the update to SideStore or AltStore.
class UpdateDialog extends StatefulWidget {
  final AppUpdateInfo updateInfo;
  final VoidCallback? onDismiss;

  const UpdateDialog({
    super.key,
    required this.updateInfo,
    this.onDismiss,
  });

  static Future<void> show(BuildContext context, AppUpdateInfo info) {
    if (info.mandatory) {
      return showDialog(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => PopScope(
          canPop: false,
          child: Dialog(
            backgroundColor: Colors.transparent,
            insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
            child: UpdateDialog(updateInfo: info),
          ),
        ),
      );
    } else {
      return showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        backgroundColor: Colors.transparent,
        builder: (ctx) => Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          child: UpdateDialog(
            updateInfo: info,
            onDismiss: () => Navigator.of(ctx).pop(),
          ),
        ),
      );
    }
  }

  @override
  State<UpdateDialog> createState() => _UpdateDialogState();
}

enum _Phase {
  idle,
  checkingPermission,
  /// "Install unknown apps" is off; waiting for the person to turn it on.
  needsPermission,
  downloading,
  /// The system installer is showing its own "Update" prompt.
  waitingForInstaller,
}

class _UpdateDialogState extends State<UpdateDialog> with WidgetsBindingObserver {
  final _ota = OtaService();
  final bool _isIos = OtaService.currentPlatform == UpdatePlatform.ios;

  // Android
  _Phase _phase = _Phase.idle;
  int? _progress;
  String? _statusText;
  String? _errorMessage;
  bool _showInstallHelp = false;
  bool _reachedInstaller = false;
  String? _versionBeforeInstall;
  StreamSubscription<OtaEvent>? _sub;

  // iOS
  IosStores? _stores;
  String _sourceUrl = defaultIosSourceUrl;
  String? _iosNotice;

  AppUpdateInfo get _info => widget.updateInfo;
  String get _versionLabel => _info.versionName != null ? 'version ${_info.versionName}' : 'the new version';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (_isIos) _loadIos();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _sub?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    if (_isIos) {
      // SideStore may have been installed meanwhile.
      _loadIos();
      return;
    }
    if (_phase == _Phase.needsPermission) {
      _resumeAfterSettings();
    } else if (_phase == _Phase.waitingForInstaller) {
      _checkInstallOutcome();
    }
  }

  // -------------------------------------------------------------------------
  // Android
  // -------------------------------------------------------------------------

  Future<void> _startAndroid() async {
    final url = _info.downloadUrl;
    if (url == null || url.isEmpty) {
      setState(() => _errorMessage = 'This update has no download link. Please try again later.');
      return;
    }

    setState(() {
      _phase = _Phase.checkingPermission;
      _errorMessage = null;
      _showInstallHelp = false;
    });

    final allowed = await _ota.ensureInstallPermission();
    if (!mounted) return;
    if (!allowed) {
      setState(() => _phase = _Phase.needsPermission);
      return;
    }

    try {
      _versionBeforeInstall = (await PackageInfo.fromPlatform()).version;
    } catch (_) {
      _versionBeforeInstall = null;
    }
    if (!mounted) return;

    setState(() {
      _phase = _Phase.downloading;
      _progress = 0;
      _statusText = 'Starting download';
      _reachedInstaller = false;
    });

    await _sub?.cancel();
    _sub = _ota
        .downloadAndInstallAndroid(url, expectedSha256: _info.sha256)
        .listen(_onEvent, onError: (Object err) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.idle;
        _errorMessage = 'The download failed. Check your connection and try again.';
      });
    });
  }

  void _onEvent(OtaEvent event) {
    if (!mounted) return;
    setState(() {
      switch (event.status) {
        case OtaStatus.downloading:
          _progress = event.progress;
          _statusText = 'Downloading update';
          break;
        case OtaStatus.verifying:
          _progress = 100;
          _statusText = 'Checking the download';
          break;
        case OtaStatus.installing:
          _reachedInstaller = true;
          _statusText = 'Opening the installer';
          break;
        case OtaStatus.installerOpened:
          _phase = _Phase.waitingForInstaller;
          _statusText = 'Tap Update when Android asks.';
          break;
        case OtaStatus.already_running_error:
          _statusText = 'A download is already running';
          break;
        case OtaStatus.permission_not_granted_error:
          _phase = _Phase.needsPermission;
          break;
        case OtaStatus.checksum_mismatch_error:
          _phase = _Phase.idle;
          _errorMessage = 'The download did not match its published checksum, so it was '
              'deleted and not installed. Please try again later.';
          break;
        case OtaStatus.internal_error:
          _phase = _Phase.idle;
          if (_reachedInstaller) {
            _errorMessage = 'The installer could not be opened.';
            _showInstallHelp = true;
          } else {
            _errorMessage = 'The download failed. Check your connection and try again.';
          }
          break;
      }
    });
  }

  Future<void> _resumeAfterSettings() async {
    if (await _ota.hasInstallPermission() && mounted && _phase == _Phase.needsPermission) {
      _startAndroid();
    }
  }

  /// Back from the installer. A successful update restarts the app, so if
  /// this screen is still here with the same version, it did not install.
  Future<void> _checkInstallOutcome() async {
    String? now;
    try {
      now = (await PackageInfo.fromPlatform()).version;
    } catch (_) {
      now = null;
    }
    if (!mounted || _phase != _Phase.waitingForInstaller) return;
    if (now != null && now != _versionBeforeInstall) return;
    setState(() {
      _phase = _Phase.idle;
      _showInstallHelp = true;
    });
  }

  // -------------------------------------------------------------------------
  // iOS
  // -------------------------------------------------------------------------

  Future<void> _loadIos() async {
    final stores = await _ota.detectIosStores();
    final source = await _ota.iosSourceUrl();
    if (!mounted) return;
    setState(() {
      _stores = stores;
      _sourceUrl = source;
    });
  }

  String? get _ipaUrl {
    final ipa = _info.ipaUrl;
    return ipa != null && ipa.isNotEmpty ? ipa : null;
  }

  Future<void> _openStore(Uri uri, String appName, {required bool install}) async {
    final ok = await _ota.openExternal(uri);
    if (!mounted) return;
    setState(() {
      _iosNotice = !ok
          ? 'Could not open $appName.'
          : install
              ? '$appName is installing $_versionLabel. Wait for it to finish, then open FWSync again.'
              : 'Source added to $appName. New versions now show up there by themselves.';
    });
  }

  Future<void> _copySource() async {
    await Clipboard.setData(ClipboardData(text: _sourceUrl));
    if (!mounted) return;
    setState(() => _iosNotice = 'Source link copied.');
  }

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final isMandatory = _info.mandatory;
    final maxHeight = MediaQuery.of(context).size.height * 0.85;

    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: Container(
        decoration: BoxDecoration(
          color: AppColors.sheet,
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: AppColors.glassBorder, width: 1.2),
          boxShadow: [
            BoxShadow(color: AppColors.shadow, blurRadius: 30, offset: const Offset(0, 10)),
          ],
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(22),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _header(isMandatory),
              const SizedBox(height: 16),
              if (_info.releaseNotes != null && _info.releaseNotes!.trim().isNotEmpty) ...[
                _panel(
                  title: "WHAT'S NEW",
                  child: Text(
                    _info.releaseNotes!.trim(),
                    style: TextStyle(fontSize: 13, color: AppColors.textPrimary, height: 1.45),
                  ),
                ),
                const SizedBox(height: 14),
              ],
              if (_errorMessage != null) ...[
                _message(_errorMessage!, tone: AppColors.danger, icon: Icons.error_outline),
                const SizedBox(height: 14),
              ],
              ...(_isIos ? _iosBody(isMandatory) : _androidBody(isMandatory)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header(bool isMandatory) {
    final tone = isMandatory ? AppColors.danger : AppColors.teal;
    return Row(
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: tone.withValues(alpha: 0.15), shape: BoxShape.circle),
          child: Icon(
            isMandatory ? Icons.warning_amber_rounded : Icons.system_update_rounded,
            size: 28,
            color: tone,
          ),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                isMandatory ? 'Required Update' : 'New Update Available',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: AppColors.textPrimary,
                  letterSpacing: -0.3,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                _info.versionName != null ? 'Version ${_info.versionName}' : 'New version ready',
                style: TextStyle(fontSize: 13, color: AppColors.textSecondary),
              ),
            ],
          ),
        ),
        if (_info.formattedFileSize.isNotEmpty)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: AppColors.cardRaised,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: AppColors.glassBorder),
            ),
            child: Text(
              _info.formattedFileSize,
              style: TextStyle(
                fontSize: 11,
                fontFamily: 'monospace',
                fontWeight: FontWeight.bold,
                color: AppColors.textPrimary,
              ),
            ),
          ),
      ],
    );
  }

  List<Widget> _androidBody(bool isMandatory) {
    final busy = _phase == _Phase.checkingPermission ||
        _phase == _Phase.downloading ||
        _phase == _Phase.waitingForInstaller;

    return [
      if (_phase == _Phase.needsPermission) ...[
        _message(
          'Android needs your permission before FWSync can install updates. '
          'In the settings screen, turn on "Allow from this source" (under Install '
          'unknown apps), then come back here.',
          tone: AppColors.amber,
          icon: Icons.lock_open_rounded,
        ),
        const SizedBox(height: 12),
        _primaryButton(
          label: 'Open settings',
          icon: Icons.settings_rounded,
          onPressed: () => _ota.openSettings(),
          tone: AppColors.amber,
        ),
        const SizedBox(height: 10),
        _secondaryButton(label: 'Try again', onPressed: _startAndroid),
        if (!isMandatory) ...[
          const SizedBox(height: 4),
          _textButton('Later', widget.onDismiss ?? () => Navigator.of(context).pop()),
        ],
      ] else if (busy) ...[
        _progressBlock(),
        if (_phase == _Phase.waitingForInstaller) ...[
          const SizedBox(height: 12),
          _hint('Android shows its own confirmation for every update. Tap Update when Android asks.'),
        ],
      ] else ...[
        if (_showInstallHelp) ...[
          _message(
            "If Android says 'App not installed', uninstall this version once and install "
            'the new one; this is a one-time change.',
            tone: AppColors.amber,
            icon: Icons.info_outline_rounded,
          ),
          const SizedBox(height: 12),
        ] else ...[
          _hint('The update downloads here and is checked before it is installed. '
              'Tap Update when Android asks.'),
          const SizedBox(height: 14),
        ],
        _buttonsRow(
          isMandatory: isMandatory,
          primaryLabel: _showInstallHelp
              ? 'Try again'
              : isMandatory
                  ? 'Update to Continue'
                  : 'Update Now',
          onPrimary: _startAndroid,
        ),
        if (_showInstallHelp && (_info.downloadUrl ?? '').isNotEmpty) ...[
          const SizedBox(height: 4),
          _textButton(
            'Download the new version in the browser',
            () => _ota.openExternal(Uri.parse(_info.downloadUrl!)),
          ),
        ],
      ],
    ];
  }

  List<Widget> _iosBody(bool isMandatory) {
    final stores = _stores;
    final ipa = _ipaUrl;
    final out = <Widget>[
      _panel(
        title: 'HOW UPDATING WORKS ON IPHONE',
        child: Text(
          'FWSync is installed through SideStore or AltStore, which sign it '
          'with a free Apple ID. An iPhone app cannot replace itself, so that app '
          'downloads $_versionLabel and installs it over this one.\n\n'
          'With a free Apple ID the app must be refreshed every 7 days or it stops '
          'opening. SideStore can refresh it on the phone; AltStore needs AltServer '
          'running on your computer.',
          style: TextStyle(fontSize: 12.5, color: AppColors.textSecondary, height: 1.45),
        ),
      ),
      const SizedBox(height: 14),
    ];

    if (_iosNotice != null) {
      out
        ..add(_message(_iosNotice!, tone: AppColors.teal, icon: Icons.check_circle_outline_rounded))
        ..add(const SizedBox(height: 12));
    }

    if (stores == null) {
      out.add(Center(
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.teal),
          ),
        ),
      ));
    } else if (!stores.any) {
      out.addAll([
        _panel(
          title: 'SIDESTORE IS NOT INSTALLED',
          child: Text(
            '1. Install SideStore from sidestore.io (or AltStore from altstore.io) '
            'by following its setup guide.\n'
            '2. In SideStore, open Sources, tap +, and add:\n$_sourceUrl\n'
            '3. Install FWSync from that source. New versions then show up '
            'there by themselves.',
            style: TextStyle(fontSize: 12.5, color: AppColors.textPrimary, height: 1.5),
          ),
        ),
        const SizedBox(height: 12),
        _primaryButton(
          label: 'Open sidestore.io',
          icon: Icons.open_in_new_rounded,
          onPressed: () => _ota.openExternal(Uri.parse('https://sidestore.io')),
        ),
        const SizedBox(height: 10),
        _secondaryButton(label: 'Copy source link', onPressed: _copySource),
      ]);
    } else {
      if (ipa == null) {
        out.add(_message('This update has no iPhone download yet. Please try again later.',
            tone: AppColors.amber, icon: Icons.info_outline_rounded));
      } else {
        if (stores.sideStore) {
          out.add(_primaryButton(
            label: 'Update with SideStore',
            icon: Icons.download_rounded,
            onPressed: () => _openStore(sideStoreInstallUri(ipa), 'SideStore', install: true),
          ));
        }
        if (stores.altStore) {
          if (stores.sideStore) out.add(const SizedBox(height: 10));
          void open() => _openStore(altStoreInstallUri(ipa), 'AltStore', install: true);
          out.add(stores.sideStore
              ? _secondaryButton(label: 'Update with AltStore', onPressed: open)
              : _primaryButton(label: 'Update with AltStore', icon: Icons.download_rounded, onPressed: open));
        }
      }
      out
        ..add(const SizedBox(height: 14))
        ..add(_hint('One-time: add the update source, and SideStore or AltStore will '
            'offer new versions by itself.'));
      if (stores.sideStore) {
        out.add(_textButton('Add update source to SideStore',
            () => _openStore(sideStoreSourceUri(_sourceUrl), 'SideStore', install: false)));
      }
      if (stores.altStore) {
        out.add(_textButton('Add update source to AltStore',
            () => _openStore(altStoreSourceUri(_sourceUrl), 'AltStore', install: false)));
      }
    }

    if (!isMandatory) {
      out
        ..add(const SizedBox(height: 4))
        ..add(_textButton('Later', widget.onDismiss ?? () => Navigator.of(context).pop()));
    }
    return out;
  }

  // Building blocks -----------------------------------------------------------

  Widget _progressBlock() {
    final p = _progress;
    final showPct = _phase == _Phase.downloading && p != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: Text(
                _statusText ?? 'Downloading update',
                style: TextStyle(fontSize: 12.5, color: AppColors.textPrimary),
              ),
            ),
            if (showPct)
              Text(
                '$p%',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  fontFamily: 'monospace',
                  color: AppColors.teal,
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: LinearProgressIndicator(
            value: _phase == _Phase.downloading && p != null && p > 0 ? p / 100.0 : null,
            minHeight: 8,
            backgroundColor: AppColors.border,
            valueColor: AlwaysStoppedAnimation<Color>(AppColors.teal),
          ),
        ),
      ],
    );
  }

  Widget _panel({required String title, required Widget child}) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.cardRaised,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.glassBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.bold,
              color: AppColors.primaryLight,
              letterSpacing: 0.5,
            ),
          ),
          const SizedBox(height: 6),
          child,
        ],
      ),
    );
  }

  Widget _message(String text, {required Color tone, required IconData icon}) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: tone.withValues(alpha: 0.3)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: tone, size: 20),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: TextStyle(color: AppColors.textPrimary, fontSize: 12.5, height: 1.4),
            ),
          ),
        ],
      ),
    );
  }

  Widget _hint(String text) => Text(
        text,
        style: TextStyle(fontSize: 12, color: AppColors.textSecondary, height: 1.4),
      );

  Widget _buttonsRow({
    required bool isMandatory,
    required String primaryLabel,
    required VoidCallback onPrimary,
  }) {
    return Row(
      children: [
        if (!isMandatory) ...[
          Expanded(
            child: OutlinedButton(
              onPressed: widget.onDismiss ?? () => Navigator.of(context).pop(),
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                side: BorderSide(color: AppColors.glassBorder),
              ),
              child: Text('Later', style: TextStyle(color: AppColors.textSecondary)),
            ),
          ),
          const SizedBox(width: 12),
        ],
        Expanded(
          flex: isMandatory ? 1 : 2,
          child: _primaryButton(
            label: primaryLabel,
            icon: Icons.download_rounded,
            onPressed: onPrimary,
            tone: isMandatory ? AppColors.danger : AppColors.teal,
          ),
        ),
      ],
    );
  }

  Widget _primaryButton({
    required String label,
    required IconData icon,
    required VoidCallback onPressed,
    Color? tone,
  }) {
    return FilledButton.icon(
      onPressed: onPressed,
      style: FilledButton.styleFrom(
        backgroundColor: tone ?? AppColors.teal,
        foregroundColor: AppColors.onAccent,
        padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 12),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
      icon: Icon(icon, size: 20),
      label: Text(label, style: const TextStyle(fontWeight: FontWeight.bold)),
    );
  }

  Widget _secondaryButton({required String label, required VoidCallback onPressed}) {
    return OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColors.teal,
        padding: const EdgeInsets.symmetric(vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        side: BorderSide(color: AppColors.teal, width: 1.2),
      ),
      child: Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
    );
  }

  Widget _textButton(String label, VoidCallback onPressed) {
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(foregroundColor: AppColors.primaryLight),
      child: Text(label, textAlign: TextAlign.center),
    );
  }
}
