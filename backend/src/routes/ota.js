// OTA & App Releases API Routes
//
// Public endpoints for mobile apps to check for updates & stream iOS manifests,
// plus Admin endpoints for release publishing and version policy configuration.

const express = require('express');
const router = express.Router();
const OTA = require('../domain/ota');
const { requireAdmin } = require('../middleware/auth');

// ---------------------------------------------------------------------------
// Public / Device Endpoints
// ---------------------------------------------------------------------------

/**
 * Returns the latest release and update requirement for the requesting client.
 * e.g. GET /api/app/version/latest?platform=android&currentVersionCode=1
 */
router.get('/version/latest', async (req, res) => {
  try {
    const platform = req.query.platform || 'android';
    const currentVersionCode = req.query.currentVersionCode || 0;
    const result = await OTA.getLatestRelease({ platform, currentVersionCode });
    res.json({
      status: 'SUCCESS',
      ...result,
    });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

/**
 * Serves an iOS Wireless Enterprise Installation Manifest plist.
 */
router.get('/releases/ios/manifest.plist', (req, res) => {
  try {
    const { ipaUrl, bundleId, versionName, title } = req.query;
    if (!ipaUrl) {
      return res.status(400).send('ipaUrl query parameter is required');
    }
    const plist = OTA.generateIosManifest({
      ipaUrl,
      bundleId: bundleId || 'com.rethink.officetracker',
      versionName: versionName || '1.0.0',
      title: title || 'Office Tracker',
    });
    res.set('Content-Type', 'application/x-plist');
    res.send(plist);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/**
 * Client callback when a download is initiated to track download metrics.
 */
router.post('/releases/:id/download-event', async (req, res) => {
  try {
    await OTA.incrementDownload(req.params.id);
    res.json({ status: 'SUCCESS' });
  } catch (_) {
    res.json({ status: 'SUCCESS' });
  }
});

// ---------------------------------------------------------------------------
// Admin Endpoints
// ---------------------------------------------------------------------------

router.get('/admin/releases', requireAdmin, async (req, res) => {
  try {
    const releases = await OTA.listReleases();
    const minSupportedVersionCode = await OTA.getOrgSetting('min_supported_version_code', '1');
    const iosTestflightUrl = await OTA.getOrgSetting('ios_testflight_url', '');
    const iosEnterpriseManifestUrl = await OTA.getOrgSetting('ios_enterprise_manifest_url', '');
    const githubRepoOwner = await OTA.getOrgSetting('github_repo_owner', 'Abdullah-rethink');
    const githubRepoName = await OTA.getOrgSetting('github_repo_name', 'Office_tracker');

    res.json({
      status: 'SUCCESS',
      releases,
      config: {
        minSupportedVersionCode: parseInt(minSupportedVersionCode, 10) || 1,
        iosTestflightUrl,
        iosEnterpriseManifestUrl,
        githubRepoOwner,
        githubRepoName,
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/admin/releases', requireAdmin, async (req, res) => {
  try {
    const release = await OTA.recordRelease({
      ...req.body,
      actor: 'admin',
    });
    res.status(201).json({ status: 'SUCCESS', release });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.patch('/admin/releases/:id', requireAdmin, async (req, res) => {
  try {
    const updated = await OTA.updateRelease(req.params.id, {
      ...req.body,
      actor: 'admin',
    });
    res.json({ status: 'SUCCESS', release: updated });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.delete('/admin/releases/:id', requireAdmin, async (req, res) => {
  try {
    const result = await OTA.deleteRelease(req.params.id, 'admin');
    res.json({ status: 'SUCCESS', ...result });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/admin/releases/config', requireAdmin, async (req, res) => {
  try {
    const { minSupportedVersionCode, iosTestflightUrl, iosEnterpriseManifestUrl, githubRepoOwner, githubRepoName } = req.body || {};

    if (minSupportedVersionCode !== undefined) {
      await OTA.setOrgSetting('min_supported_version_code', String(minSupportedVersionCode), 'admin');
    }
    if (iosTestflightUrl !== undefined) {
      await OTA.setOrgSetting('ios_testflight_url', String(iosTestflightUrl).trim(), 'admin');
    }
    if (iosEnterpriseManifestUrl !== undefined) {
      await OTA.setOrgSetting('ios_enterprise_manifest_url', String(iosEnterpriseManifestUrl).trim(), 'admin');
    }
    if (githubRepoOwner !== undefined) {
      await OTA.setOrgSetting('github_repo_owner', String(githubRepoOwner).trim(), 'admin');
    }
    if (githubRepoName !== undefined) {
      await OTA.setOrgSetting('github_repo_name', String(githubRepoName).trim(), 'admin');
    }

    res.json({ status: 'SUCCESS', message: 'OTA configuration updated.' });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;
