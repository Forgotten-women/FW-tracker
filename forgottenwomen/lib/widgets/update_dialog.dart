import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../models/ota.dart';
import '../services/ota_service.dart';
import '../theme.dart';

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
        backgroundColor: Colors.transparent,
        builder: (ctx) => UpdateDialog(
          updateInfo: info,
          onDismiss: () => Navigator.of(ctx).pop(),
        ),
      );
    }
  }

  @override
  State<UpdateDialog> createState() => _UpdateDialogState();
}

class _UpdateDialogState extends State<UpdateDialog> {
  final _otaService = OtaService();
  bool _downloading = false;
  int _progress = 0;
  String? _statusText;
  String? _errorMessage;

  Future<void> _startUpdate() async {
    final url = widget.updateInfo.downloadUrl;
    if (url == null || url.isEmpty) {
      setState(() => _errorMessage = 'Download URL is not available.');
      return;
    }

    if (!kIsWeb && Platform.isIOS) {
      setState(() => _downloading = true);
      final launched = await _otaService.launchIosUpdate(url);
      if (!mounted) return;
      setState(() => _downloading = false);
      if (!launched) {
        setState(() => _errorMessage = 'Could not open iOS update link.');
      }
      return;
    }

    // Android direct download and install
    setState(() {
      _downloading = true;
      _progress = 0;
      _statusText = 'Preparing download…';
      _errorMessage = null;
    });

    try {
      _otaService.downloadAndInstallAndroid(url).listen(
        (OtaEvent event) {
          if (!mounted) return;
          switch (event.status) {
            case OtaStatus.downloading:
              final p = event.progress ?? 0;
              setState(() {
                _progress = p;
                _statusText = 'Downloading update… $p%';
              });
              break;
            case OtaStatus.installing:
              setState(() {
                _progress = 100;
                _statusText = 'Opening package installer…';
              });
              break;
            case OtaStatus.already_running_error:
              setState(() {
                _statusText = 'Download already in progress…';
              });
              break;
            case OtaStatus.permission_not_granted_error:
              setState(() {
                _downloading = false;
                _errorMessage = 'Permission to install unknown packages was denied. Please allow it in device settings.';
              });
              break;
            case OtaStatus.internal_error:
              setState(() {
                _downloading = false;
                _errorMessage = 'Download failed. Please try again.';
              });
              break;
          }
        },
        onError: (err) {
          if (mounted) {
            setState(() {
              _downloading = false;
              _errorMessage = 'Download failed: $err';
            });
          }
        },
      );
    } catch (e) {
      setState(() {
        _downloading = false;
        _errorMessage = 'Could not start update: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final info = widget.updateInfo;
    final isMandatory = info.mandatory;

    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: AppColors.surfaceDark,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: AppColors.border, width: 1.2),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.5),
            blurRadius: 30,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: isMandatory ? AppColors.danger.withOpacity(0.15) : AppColors.teal.withOpacity(0.15),
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  isMandatory ? Icons.warning_amber_rounded : Icons.system_update_rounded,
                  size: 28,
                  color: isMandatory ? AppColors.danger : AppColors.teal,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      isMandatory ? 'Required Update' : 'New Update Available',
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                        color: AppColors.textLight,
                        letterSpacing: -0.3,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      info.versionName != null ? 'Version ${info.versionName}' : 'New Version Ready',
                      style: const TextStyle(fontSize: 13, color: AppColors.textMuted),
                    ),
                  ],
                ),
              ),
              if (info.formattedFileSize.isNotEmpty)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: AppColors.surfaceLight,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Text(
                    info.formattedFileSize,
                    style: const TextStyle(
                      fontSize: 11,
                      fontFamily: 'monospace',
                      fontWeight: FontWeight.bold,
                      color: AppColors.textLight,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 18),
          if (info.releaseNotes != null && info.releaseNotes!.isNotEmpty) ...[
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColors.bgDark,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AppColors.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'WHAT\'S NEW',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                      color: AppColors.primaryLight,
                      letterSpacing: 0.5,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    info.releaseNotes!,
                    style: const TextStyle(
                      fontSize: 13,
                      color: AppColors.textLight,
                      height: 1.45,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 18),
          ],
          if (_errorMessage != null) ...[
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.danger.withOpacity(0.12),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.danger.withOpacity(0.3)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.error_outline, color: AppColors.danger, size: 20),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _errorMessage!,
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
            const SizedBox(height: 18),
          ],
          if (_downloading) ...[
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      _statusText ?? 'Downloading…',
                      style: const TextStyle(fontSize: 12, color: AppColors.textLight),
                    ),
                    Text(
                      '$_progress%',
                      style: const TextStyle(
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
                    value: _progress > 0 ? _progress / 100.0 : null,
                    minHeight: 8,
                    backgroundColor: AppColors.surfaceLight,
                    valueColor: const AlwaysStoppedAnimation<Color>(AppColors.teal),
                  ),
                ),
              ],
            ),
          ] else ...[
            Row(
              children: [
                if (!isMandatory) ...[
                  Expanded(
                    child: OutlinedButton(
                      onPressed: widget.onDismiss ?? () => Navigator.of(context).pop(),
                      style: OutlinedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                        side: const BorderSide(color: AppColors.border),
                      ),
                      child: const Text('Later', style: TextStyle(color: AppColors.textMuted)),
                    ),
                  ),
                  const SizedBox(width: 12),
                ],
                Expanded(
                  flex: isMandatory ? 1 : 2,
                  child: FilledButton.icon(
                    onPressed: _startUpdate,
                    style: FilledButton.styleFrom(
                      backgroundColor: isMandatory ? AppColors.danger : AppColors.teal,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    ),
                    icon: const Icon(Icons.download_rounded, size: 20),
                    label: Text(
                      isMandatory ? 'Update to Continue' : 'Update Now',
                      style: const TextStyle(fontWeight: FontWeight.bold),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
