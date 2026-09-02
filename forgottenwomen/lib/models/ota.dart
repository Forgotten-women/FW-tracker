class AppUpdateInfo {
  final bool updateAvailable;
  final bool mandatory;
  final int currentVersionCode;
  final int minSupportedVersionCode;
  final String? versionName;
  final int? versionCode;
  final String? platform;
  final String? downloadUrl;
  final int? fileSize;
  final String? releaseNotes;
  final String? publishedAt;
  final String? iosTestflightUrl;
  final String? iosManifestUrl;

  const AppUpdateInfo({
    required this.updateAvailable,
    required this.mandatory,
    required this.currentVersionCode,
    required this.minSupportedVersionCode,
    this.versionName,
    this.versionCode,
    this.platform,
    this.downloadUrl,
    this.fileSize,
    this.releaseNotes,
    this.publishedAt,
    this.iosTestflightUrl,
    this.iosManifestUrl,
  });

  factory AppUpdateInfo.fromJson(Map<String, dynamic> json, int localVersionCode) {
    final latest = json['latestRelease'] as Map<String, dynamic>?;
    final ios = json['ios'] as Map<String, dynamic>?;

    return AppUpdateInfo(
      updateAvailable: json['updateAvailable'] as bool? ?? false,
      mandatory: json['mandatory'] as bool? ?? false,
      currentVersionCode: json['currentVersionCode'] as int? ?? localVersionCode,
      minSupportedVersionCode: json['minSupportedVersionCode'] as int? ?? 1,
      versionName: latest?['versionName'] as String?,
      versionCode: latest?['versionCode'] as int?,
      platform: latest?['platform'] as String?,
      downloadUrl: latest?['downloadUrl'] as String?,
      fileSize: latest?['fileSize'] as int?,
      releaseNotes: latest?['releaseNotes'] as String?,
      publishedAt: latest?['publishedAt'] as String?,
      iosTestflightUrl: ios?['testflightUrl'] as String?,
      iosManifestUrl: ios?['manifestUrl'] as String?,
    );
  }

  String get formattedFileSize {
    if (fileSize == null || fileSize! <= 0) return '';
    final mb = fileSize! / (1024 * 1024);
    return '${mb.toStringAsFixed(1)} MB';
  }
}
