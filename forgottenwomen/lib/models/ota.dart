/// Where an update offer came from.
enum UpdateOrigin { backend, github }

class AppUpdateInfo {
  final bool updateAvailable;
  final bool mandatory;
  final int currentVersionCode;
  final int minSupportedVersionCode;
  final String? versionName;
  final int? versionCode;
  final String? platform;
  final String? downloadUrl;
  final String? sha256;
  final int? fileSize;
  final String? releaseNotes;
  final String? publishedAt;
  final String? iosTestflightUrl;
  final String? iosManifestUrl;

  /// The raw IPA, for a SideStore / AltStore install. Null on Android.
  final String? ipaUrl;

  final UpdateOrigin origin;

  const AppUpdateInfo({
    required this.updateAvailable,
    required this.mandatory,
    required this.currentVersionCode,
    required this.minSupportedVersionCode,
    this.versionName,
    this.versionCode,
    this.platform,
    this.downloadUrl,
    this.sha256,
    this.fileSize,
    this.releaseNotes,
    this.publishedAt,
    this.iosTestflightUrl,
    this.iosManifestUrl,
    this.ipaUrl,
    this.origin = UpdateOrigin.backend,
  });

  /// A successful check that found nothing newer.
  const AppUpdateInfo.upToDate(int localVersionCode)
      : updateAvailable = false,
        mandatory = false,
        currentVersionCode = localVersionCode,
        minSupportedVersionCode = 1,
        versionName = null,
        versionCode = null,
        platform = null,
        downloadUrl = null,
        sha256 = null,
        fileSize = null,
        releaseNotes = null,
        publishedAt = null,
        iosTestflightUrl = null,
        iosManifestUrl = null,
        ipaUrl = null,
        origin = UpdateOrigin.backend;

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
      sha256: latest?['sha256'] as String?,
      fileSize: latest?['fileSize'] as int?,
      releaseNotes: latest?['releaseNotes'] as String?,
      publishedAt: latest?['publishedAt'] as String?,
      iosTestflightUrl: ios?['testflightUrl'] as String?,
      iosManifestUrl: ios?['manifestUrl'] as String?,
      ipaUrl: latest?['ipaUrl'] as String?,
    );
  }

  String get formattedFileSize {
    if (fileSize == null || fileSize! <= 0) return '';
    final mb = fileSize! / (1024 * 1024);
    return '${mb.toStringAsFixed(1)} MB';
  }
}
