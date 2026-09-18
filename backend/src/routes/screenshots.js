// Workstation Screenshot Administration & Storage Management Routes
//
// Allows HR to view employee screen capture galleries, manage storage footprint,
// delete captures individually or in bulk, configure capture intervals, and set retention rules.

const express = require('express');
const router = express.Router();
const { db, audit } = require('../db');
const { requireRole } = require('../middleware/auth');
const storage = require('../domain/storage');
const T = require('../util/time');

// ---------------------------------------------------------------------------
// Helper: Ensure screenshot tables and columns exist
// ---------------------------------------------------------------------------
async function ensureTables() {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS workstation_screenshots (
        id                  TEXT PRIMARY KEY,
        employee_id         TEXT NOT NULL,
        device_id           TEXT NOT NULL,
        date_key            TEXT NOT NULL,
        captured_at         BIGINT NOT NULL,
        storage_path        TEXT NOT NULL,
        file_size_bytes     BIGINT NOT NULL DEFAULT 0,
        mime_type           TEXT NOT NULL DEFAULT 'image/jpeg',
        active_app          TEXT,
        window_title        TEXT,
        capture_status      TEXT NOT NULL DEFAULT 'SUCCESS',
        created_at          BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ws_shots_emp_date ON workstation_screenshots (employee_id, date_key);
      CREATE INDEX IF NOT EXISTS idx_ws_shots_captured ON workstation_screenshots (captured_at);
    `);

    try {
      await db.exec(`
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS screenshot_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS screenshot_interval_minutes INTEGER NOT NULL DEFAULT 5;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS screenshot_mode TEXT NOT NULL DEFAULT 'ACTIVE_ONLY';
      `);
    } catch (_) {}
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// GET /api/admin/screenshots/storage-stats
// Storage usage metrics, quota gauge, and per-employee breakdown
// ---------------------------------------------------------------------------
router.get('/storage-stats', requireRole('HR_ADMIN', 'SYSTEM_ADMIN', 'AUDITOR'), async (req, res) => {
  await ensureTables();
  const nowMs = T.now();

  try {
    const totalRow = await db.prepare(`
      SELECT COUNT(*) as total_count, COALESCE(SUM(file_size_bytes), 0) as total_bytes
      FROM workstation_screenshots
    `).get();

    const employeeRows = await db.prepare(`
      SELECT 
        e.id as employee_id,
        e.name as employee_name,
        e.screenshot_enabled,
        e.screenshot_interval_minutes,
        e.screenshot_mode,
        COUNT(ws.id) as shot_count,
        COALESCE(SUM(ws.file_size_bytes), 0) as total_bytes,
        MAX(ws.captured_at) as latest_capture_at
      FROM employees e
      LEFT JOIN workstation_screenshots ws ON ws.employee_id = e.id
      WHERE e.active = 1
      GROUP BY e.id, e.name, e.screenshot_enabled, e.screenshot_interval_minutes, e.screenshot_mode
      ORDER BY total_bytes DESC, e.name ASC
    `).all();

    const settingRow = await db.prepare("SELECT value FROM org_settings WHERE key = 'screenshot_retention_days'").get();
    const retentionDays = parseInt(settingRow?.value || '30', 10) || 30;

    const quotaSettingRow = await db.prepare("SELECT value FROM org_settings WHERE key = 'screenshot_storage_quota_gb'").get();
    const quotaGb = parseFloat(quotaSettingRow?.value || '10') || 10;
    const quotaBytes = quotaGb * 1024 * 1024 * 1024;

    const totalBytes = Number(totalRow?.total_bytes || 0);
    const totalCount = Number(totalRow?.total_count || 0);
    const usedPercentage = quotaBytes > 0 ? Math.min(100, (totalBytes / quotaBytes) * 100) : 0;

    res.json({
      status: 'SUCCESS',
      totalBytes,
      totalCount,
      quotaGb,
      quotaBytes,
      usedPercentage: parseFloat(usedPercentage.toFixed(1)),
      retentionDays,
      employees: employeeRows.map(r => ({
        employeeId: r.employee_id,
        employeeName: r.employee_name,
        screenshotEnabled: r.screenshot_enabled === 1,
        intervalMinutes: parseInt(r.screenshot_interval_minutes, 10) || 5,
        mode: r.screenshot_mode || 'ACTIVE_ONLY',
        shotCount: Number(r.shot_count || 0),
        totalBytes: Number(r.total_bytes || 0),
        latestCaptureAt: r.latest_capture_at ? Number(r.latest_capture_at) : null,
      })),
    });
  } catch (err) {
    console.error('[screenshots/storage-stats] error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/screenshots/employee/:employeeId
// Returns screenshots for an employee filtered by date or date range
// ---------------------------------------------------------------------------
router.get('/employee/:employeeId', requireRole('HR_ADMIN', 'SYSTEM_ADMIN', 'AUDITOR'), async (req, res) => {
  await ensureTables();
  const { employeeId } = req.params;
  const { dateKey = T.dateKey(T.now()), limit = 300 } = req.query;

  try {
    const emp = await db.prepare('SELECT id, name, screenshot_enabled, screenshot_interval_minutes, screenshot_mode FROM employees WHERE id = ?').get(employeeId);
    if (!emp) {
      return res.status(404).json({ status: 'ERROR', message: 'Employee not found.' });
    }

    const rows = await db.prepare(`
      SELECT * FROM workstation_screenshots
      WHERE employee_id = ? AND date_key = ?
      ORDER BY captured_at ASC
      LIMIT ?
    `).all(employeeId, dateKey, parseInt(limit, 10) || 300);

    const availableDates = await db.prepare(`
      SELECT date_key, COUNT(*) as count, SUM(file_size_bytes) as total_bytes
      FROM workstation_screenshots
      WHERE employee_id = ?
      GROUP BY date_key
      ORDER BY date_key DESC
      LIMIT 60
    `).all(employeeId);

    const screenshots = await Promise.all(rows.map(async r => {
      let signedUrl = null;
      try {
        signedUrl = await storage.getScreenshotSignedUrl(r.storage_path, 3600);
      } catch (_) {}

      return {
        id: r.id,
        employeeId: r.employee_id,
        deviceId: r.device_id,
        dateKey: r.date_key,
        capturedAt: Number(r.captured_at),
        displayTime: T.displayTime(r.captured_at),
        storagePath: r.storage_path,
        fileSizeBytes: Number(r.file_size_bytes || 0),
        mimeType: r.mime_type || 'image/jpeg',
        activeApp: r.active_app || 'Active Workstation',
        windowTitle: r.window_title || '',
        captureStatus: r.capture_status || 'SUCCESS',
        imageUrl: signedUrl || `/api/admin/screenshots/image/${r.id}`,
      };
    }));

    res.json({
      status: 'SUCCESS',
      employee: {
        id: emp.id,
        name: emp.name,
        screenshotEnabled: emp.screenshot_enabled === 1,
        intervalMinutes: parseInt(emp.screenshot_interval_minutes, 10) || 5,
        mode: emp.screenshot_mode || 'ACTIVE_ONLY',
      },
      dateKey,
      count: screenshots.length,
      availableDates: availableDates.map(d => ({
        dateKey: d.date_key,
        count: Number(d.count),
        totalBytes: Number(d.total_bytes || 0),
      })),
      screenshots,
    });
  } catch (err) {
    console.error('[screenshots/employee] error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/screenshots/image/:id
// Direct authenticated streaming endpoint for a screenshot
// ---------------------------------------------------------------------------
router.get('/image/:id', requireRole('HR_ADMIN', 'SYSTEM_ADMIN', 'AUDITOR'), async (req, res) => {
  const { id } = req.params;
  try {
    const row = await db.prepare('SELECT storage_path, mime_type FROM workstation_screenshots WHERE id = ?').get(id);
    if (!row) {
      return res.status(404).send('Screenshot not found');
    }

    const buffer = await storage.getScreenshotBuffer(row.storage_path);
    res.setHeader('Content-Type', row.mime_type || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (err) {
    console.error('[screenshots/image] error:', err);
    res.status(404).send('Image could not be retrieved');
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/screenshots/employee/:employeeId/config
// Updates screenshot toggle, polling interval, and capture mode
// ---------------------------------------------------------------------------
router.patch('/employee/:employeeId/config', requireRole('HR_ADMIN', 'SYSTEM_ADMIN'), async (req, res) => {
  await ensureTables();
  const { employeeId } = req.params;
  const { enabled, intervalMinutes = 5, mode = 'ACTIVE_ONLY' } = req.body || {};

  const cleanEnabled = enabled ? 1 : 0;
  const cleanInterval = Math.max(1, Math.min(60, parseInt(intervalMinutes, 10) || 5));
  const cleanMode = mode === 'CONTINUOUS' ? 'CONTINUOUS' : 'ACTIVE_ONLY';

  try {
    const emp = await db.prepare('SELECT id, name, screenshot_enabled, screenshot_interval_minutes, screenshot_mode FROM employees WHERE id = ?').get(employeeId);
    if (!emp) {
      return res.status(404).json({ status: 'ERROR', message: 'Employee not found.' });
    }

    await db.prepare(`
      UPDATE employees
      SET screenshot_enabled = ?, screenshot_interval_minutes = ?, screenshot_mode = ?, updated_at = ?
      WHERE id = ?
    `).run(cleanEnabled, cleanInterval, cleanMode, T.now(), employeeId);

    await audit({
      actor: req.auth.user?.email || 'hr_admin',
      action: 'UPDATE_SCREENSHOT_CONFIG',
      targetType: 'EMPLOYEE',
      targetId: employeeId,
      before: {
        enabled: emp.screenshot_enabled === 1,
        intervalMinutes: emp.screenshot_interval_minutes,
        mode: emp.screenshot_mode,
      },
      after: {
        enabled: cleanEnabled === 1,
        intervalMinutes: cleanInterval,
        mode: cleanMode,
      },
      note: `Screenshot monitoring for ${emp.name} set to ${cleanEnabled ? 'ON' : 'OFF'} (${cleanInterval}m, ${cleanMode})`,
    });

    res.json({
      status: 'SUCCESS',
      message: 'Screenshot configuration updated.',
      config: {
        enabled: cleanEnabled === 1,
        intervalMinutes: cleanInterval,
        mode: cleanMode,
      },
    });
  } catch (err) {
    console.error('[screenshots/config] error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/screenshots
// Deletes specific screenshots by ID from database and Supabase S3
// ---------------------------------------------------------------------------
router.delete('/', requireRole('HR_ADMIN', 'SYSTEM_ADMIN'), async (req, res) => {
  await ensureTables();
  const { shotIds = [] } = req.body || {};

  if (!Array.isArray(shotIds) || shotIds.length === 0) {
    return res.status(400).json({ status: 'ERROR', message: 'shotIds array is required.' });
  }

  try {
    const placeholders = shotIds.map(() => '?').join(',');
    const rows = await db.prepare(`
      SELECT id, storage_path, file_size_bytes FROM workstation_screenshots
      WHERE id IN (${placeholders})
    `).all(...shotIds);

    const storageKeys = rows.map(r => r.storage_path);
    await storage.deleteScreenshots(storageKeys);

    await db.prepare(`
      DELETE FROM workstation_screenshots WHERE id IN (${placeholders})
    `).run(...shotIds);

    const deletedBytes = rows.reduce((acc, r) => acc + Number(r.file_size_bytes || 0), 0);

    await audit({
      actor: req.auth.user?.email || 'hr_admin',
      action: 'DELETE_SCREENSHOTS',
      targetType: 'SCREENSHOT',
      targetId: shotIds.join(','),
      note: `Deleted ${rows.length} screenshots (${Math.round(deletedBytes / 1024)} KB freed)`,
    });

    res.json({
      status: 'SUCCESS',
      deletedCount: rows.length,
      freedBytes: deletedBytes,
    });
  } catch (err) {
    console.error('[screenshots/delete] error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/screenshots/bulk-purge
// Purges screenshots older than X days or for a specific employee date
// ---------------------------------------------------------------------------
router.delete('/bulk-purge', requireRole('HR_ADMIN', 'SYSTEM_ADMIN'), async (req, res) => {
  await ensureTables();
  const { employeeId = null, dateKey = null, olderThanDays = null } = req.body || {};
  const nowMs = T.now();

  try {
    let whereClauses = [];
    let params = [];

    if (employeeId) {
      whereClauses.push('employee_id = ?');
      params.push(employeeId);
    }
    if (dateKey) {
      whereClauses.push('date_key = ?');
      params.push(dateKey);
    }
    if (olderThanDays && parseInt(olderThanDays, 10) > 0) {
      const cutoffMs = nowMs - (parseInt(olderThanDays, 10) * 24 * 60 * 60 * 1000);
      whereClauses.push('captured_at < ?');
      params.push(cutoffMs);
    }

    if (whereClauses.length === 0) {
      return res.status(400).json({ status: 'ERROR', message: 'Specify employeeId, dateKey, or olderThanDays for bulk purge.' });
    }

    const whereSql = whereClauses.join(' AND ');
    const rows = await db.prepare(`
      SELECT id, storage_path, file_size_bytes FROM workstation_screenshots
      WHERE ${whereSql}
    `).all(...params);

    if (rows.length > 0) {
      const storageKeys = rows.map(r => r.storage_path);
      await storage.deleteScreenshots(storageKeys);

      await db.prepare(`
        DELETE FROM workstation_screenshots WHERE ${whereSql}
      `).run(...params);
    }

    const deletedBytes = rows.reduce((acc, r) => acc + Number(r.file_size_bytes || 0), 0);

    await audit({
      actor: req.auth.user?.email || 'hr_admin',
      action: 'BULK_PURGE_SCREENSHOTS',
      targetType: 'SCREENSHOT',
      targetId: employeeId || 'ALL',
      note: `Bulk purged ${rows.length} screenshots (${Math.round(deletedBytes / 1024 / 1024)} MB freed)`,
    });

    res.json({
      status: 'SUCCESS',
      purgedCount: rows.length,
      freedBytes: deletedBytes,
    });
  } catch (err) {
    console.error('[screenshots/bulk-purge] error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/screenshots/auto-retention
// Sets the organization retention period (e.g. 14 / 30 / 60 days) and runs cleanup
// ---------------------------------------------------------------------------
router.post('/auto-retention', requireRole('HR_ADMIN', 'SYSTEM_ADMIN'), async (req, res) => {
  await ensureTables();
  const { retentionDays = 30, quotaGb = 10, runPurgeNow = false } = req.body || {};
  const cleanDays = Math.max(1, Math.min(365, parseInt(retentionDays, 10) || 30));
  const cleanQuota = Math.max(1, Math.min(1000, parseFloat(quotaGb) || 10));
  const nowMs = T.now();

  try {
    await db.prepare(`
      INSERT INTO org_settings (key, value, updated_at)
      VALUES ('screenshot_retention_days', ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `).run(String(cleanDays), nowMs);

    await db.prepare(`
      INSERT INTO org_settings (key, value, updated_at)
      VALUES ('screenshot_storage_quota_gb', ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `).run(String(cleanQuota), nowMs);

    let purgedCount = 0;
    let freedBytes = 0;

    if (runPurgeNow) {
      const cutoffMs = nowMs - (cleanDays * 24 * 60 * 60 * 1000);
      const oldRows = await db.prepare(`
        SELECT id, storage_path, file_size_bytes FROM workstation_screenshots
        WHERE captured_at < ?
      `).all(cutoffMs);

      if (oldRows.length > 0) {
        const storageKeys = oldRows.map(r => r.storage_path);
        await storage.deleteScreenshots(storageKeys);
        await db.prepare('DELETE FROM workstation_screenshots WHERE captured_at < ?').run(cutoffMs);
        purgedCount = oldRows.length;
        freedBytes = oldRows.reduce((acc, r) => acc + Number(r.file_size_bytes || 0), 0);
      }
    }

    res.json({
      status: 'SUCCESS',
      retentionDays: cleanDays,
      quotaGb: cleanQuota,
      purgedCount,
      freedBytes,
    });
  } catch (err) {
    console.error('[screenshots/auto-retention] error:', err);
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;
