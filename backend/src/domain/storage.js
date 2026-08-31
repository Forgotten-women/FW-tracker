// Unified Cloud & Local Storage Provider. Spec sections 5 and 27.
//
// Supports Supabase / AWS S3 storage with private bucket permissions and
// provides a resilient local filesystem fallback when cloud credentials are
// not configured or running in offline test environments.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { DATA_DIR } = require('../db');

const LOCAL_STORE = path.join(DATA_DIR, 'documents');
if (!fs.existsSync(LOCAL_STORE)) {
  fs.mkdirSync(LOCAL_STORE, { recursive: true });
}

let supabaseClient = null;

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  if (!supabaseClient) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      supabaseClient = createClient(url, key, {
        auth: { persistSession: false },
      });
    } catch {
      supabaseClient = null;
    }
  }
  return supabaseClient;
}

function getBucket() {
  return process.env.SUPABASE_STORAGE_BUCKET || 'employee-documents';
}

/**
 * Saves a file to cloud storage (Supabase) if configured, or local private disk.
 * Returns the storage key / path and storage provider name.
 */
async function saveFile({ key, buffer, mimeType = 'application/octet-stream' }) {
  const client = getSupabase();

  if (client) {
    try {
      const { data, error } = await client.storage
        .from(getBucket())
        .upload(key, buffer, {
          contentType: mimeType,
          upsert: true,
        });

      if (!error && data) {
        return {
          storageKey: key,
          provider: 'supabase',
          path: data.path,
        };
      }
      console.warn('[storage] Supabase upload failed, falling back to local:', error?.message);
    } catch (err) {
      console.warn('[storage] Supabase error, falling back to local:', err?.message);
    }
  }

  // Local private storage fallback
  const localPath = path.join(LOCAL_STORE, key);
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(localPath, buffer);

  return {
    storageKey: key,
    provider: 'local',
    path: localPath,
  };
}

/**
 * Retrieves the raw file buffer from storage.
 */
async function getFileBuffer(key) {
  if (!key) throw new Error('No storage key provided.');

  // 1. Direct path check on local disk
  if (fs.existsSync(key)) {
    return fs.readFileSync(key);
  }

  // 2. Local store relative path check
  const localPath = path.join(LOCAL_STORE, key);
  if (fs.existsSync(localPath)) {
    return fs.readFileSync(localPath);
  }

  const basenamePath = path.join(LOCAL_STORE, path.basename(key));
  if (fs.existsSync(basenamePath)) {
    return fs.readFileSync(basenamePath);
  }

  // 3. Supabase Cloud Storage
  const client = getSupabase();
  if (client) {
    try {
      const { data, error } = await client.storage
        .from(getBucket())
        .download(key);

      if (!error && data) {
        const arrayBuffer = await data.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }
    } catch (err) {
      console.warn('[storage] Supabase download error, checking local store:', err?.message);
    }
  }

  throw new Error(`File not found in storage: ${key}`);
}

/**
 * Generates a signed, time-limited URL for secure access.
 */
async function getSignedUrl(key, expiresInSeconds = 60) {
  const client = getSupabase();

  if (client) {
    try {
      const { data, error } = await client.storage
        .from(getBucket())
        .createSignedUrl(key, expiresInSeconds);

      if (!error && data?.signedUrl) {
        return data.signedUrl;
      }
    } catch {
      // Fallback
    }
  }

  return null;
}

/**
 * Deletes a file from local storage and Supabase Cloud Storage.
 */
async function deleteFile(key) {
  if (!key) return;

  // 1. Delete local file
  const localPath = path.join(LOCAL_STORE, key);
  if (fs.existsSync(localPath)) {
    try { fs.unlinkSync(localPath); } catch (_) {}
  }
  const basenamePath = path.join(LOCAL_STORE, path.basename(key));
  if (fs.existsSync(basenamePath)) {
    try { fs.unlinkSync(basenamePath); } catch (_) {}
  }
  if (fs.existsSync(key)) {
    try { fs.unlinkSync(key); } catch (_) {}
  }

  // 2. Delete Supabase cloud file
  const client = getSupabase();
  if (client) {
    try {
      await client.storage.from(getBucket()).remove([key, path.basename(key)]);
    } catch (err) {
      console.warn('[storage] Supabase remove error:', err?.message);
    }
  }
}

module.exports = {
  saveFile,
  getFileBuffer,
  getSignedUrl,
  deleteFile,
  isCloudConfigured: () => Boolean(getSupabase()),
  LOCAL_STORE,
};
