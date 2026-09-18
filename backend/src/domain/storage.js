// Unified Cloud & Local Storage Provider. Spec sections 5 and 27.
//
// Supports Supabase S3 and REST API storage with private bucket permissions and
// provides a resilient local filesystem fallback when cloud credentials are
// not configured or running in offline test environments.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { DATA_DIR } = require('../db');

const LOCAL_STORE = path.join(DATA_DIR, 'documents');
if (!fs.existsSync(LOCAL_STORE)) {
  fs.mkdirSync(LOCAL_STORE, { recursive: true });
}

let s3Client = null;
let supabaseClient = null;

function getBucket() {
  return process.env.SUPABASE_STORAGE_BUCKET || 'employee-documents';
}

function getS3Client() {
  const accessKeyId = process.env.SUPABASE_S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.SUPABASE_S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
  const endpoint = process.env.SUPABASE_S3_ENDPOINT || process.env.SUPABASE_URL || '';

  if (accessKeyId && secretAccessKey && endpoint) {
    if (!s3Client) {
      s3Client = new S3Client({
        forcePathStyle: true,
        region: process.env.SUPABASE_REGION || 'ap-northeast-1',
        endpoint: endpoint.includes('/storage/v1/s3') ? endpoint : `${endpoint.replace(/\/+$/, '')}/storage/v1/s3`,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
    }
    return s3Client;
  }
  return null;
}

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

/**
 * Saves a file to cloud storage (Supabase S3 / REST) if configured, or local private disk.
 * Returns the storage key / path and storage provider name.
 */
async function saveFile({ key, buffer, mimeType = 'application/octet-stream' }) {
  // 1. Try S3 client
  const s3 = getS3Client();
  if (s3) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: getBucket(),
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }));
      return {
        storageKey: key,
        provider: 'supabase',
        path: key,
      };
    } catch (err) {
      console.warn('[storage] Supabase S3 upload failed, checking REST fallback:', err?.message);
    }
  }

  // 2. Try Supabase JS client
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
      console.warn('[storage] Supabase REST upload failed, falling back to local:', error?.message);
    } catch (err) {
      console.warn('[storage] Supabase error, falling back to local:', err?.message);
    }
  }

  // 3. Local private storage fallback
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

  // 1. Try S3 client
  const s3 = getS3Client();
  if (s3) {
    try {
      const res = await s3.send(new GetObjectCommand({
        Bucket: getBucket(),
        Key: key,
      }));
      const stream = res.Body;
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (err) {
      console.warn('[storage] Supabase S3 download failed, checking local:', err?.message);
    }
  }

  // 2. Direct path check on local disk
  if (fs.existsSync(key)) {
    return fs.readFileSync(key);
  }

  // 3. Local store relative path check
  const localPath = path.join(LOCAL_STORE, key);
  if (fs.existsSync(localPath)) {
    return fs.readFileSync(localPath);
  }

  const basenamePath = path.join(LOCAL_STORE, path.basename(key));
  if (fs.existsSync(basenamePath)) {
    return fs.readFileSync(basenamePath);
  }

  // 4. Supabase REST Cloud Storage
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

  // 1. Delete S3 cloud file
  const s3 = getS3Client();
  if (s3) {
    try {
      await s3.send(new DeleteObjectCommand({
        Bucket: getBucket(),
        Key: key,
      }));
    } catch (err) {
      console.warn('[storage] Supabase S3 delete error:', err?.message);
    }
  }

  // 2. Delete local file
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

  // 3. Delete Supabase REST cloud file
  const client = getSupabase();
  if (client) {
    try {
      await client.storage.from(getBucket()).remove([key, path.basename(key)]);
    } catch (err) {
      console.warn('[storage] Supabase remove error:', err?.message);
    }
  }
}

function getScreenshotsBucket() {
  return process.env.SUPABASE_SCREENSHOTS_BUCKET || 'workstation-screenshots';
}

const LOCAL_SCREENSHOTS_STORE = path.join(DATA_DIR, 'screenshots');
if (!fs.existsSync(LOCAL_SCREENSHOTS_STORE)) {
  try { fs.mkdirSync(LOCAL_SCREENSHOTS_STORE, { recursive: true }); } catch (_) {}
}

/**
 * Saves a screenshot to cloud storage (Supabase S3 / REST) or local private disk.
 */
async function saveScreenshot({ key, buffer, mimeType = 'image/jpeg' }) {
  const bucket = getScreenshotsBucket();

  // 1. Try S3 client
  const s3 = getS3Client();
  if (s3) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }));
      return { storageKey: key, provider: 'supabase', path: key, bucket };
    } catch (err) {
      // If bucket does not exist, try fallback bucket
      if (bucket !== getBucket()) {
        try {
          await s3.send(new PutObjectCommand({
            Bucket: getBucket(),
            Key: key,
            Body: buffer,
            ContentType: mimeType,
          }));
          return { storageKey: key, provider: 'supabase', path: key, bucket: getBucket() };
        } catch (_) {}
      }
      console.warn('[storage/screenshot] S3 upload warning:', err?.message);
    }
  }

  // 2. Try Supabase JS Client
  const client = getSupabase();
  if (client) {
    try {
      const { data, error } = await client.storage
        .from(bucket)
        .upload(key, buffer, {
          contentType: mimeType,
          upsert: true,
        });

      if (!error && data) {
        return { storageKey: key, provider: 'supabase', path: data.path, bucket };
      }

      // Try fallback bucket
      if (bucket !== getBucket()) {
        const { data: fbData, error: fbErr } = await client.storage
          .from(getBucket())
          .upload(key, buffer, {
            contentType: mimeType,
            upsert: true,
          });
        if (!fbErr && fbData) {
          return { storageKey: key, provider: 'supabase', path: fbData.path, bucket: getBucket() };
        }
      }
    } catch (err) {
      console.warn('[storage/screenshot] Supabase REST upload warning:', err?.message);
    }
  }

  // 3. Local disk fallback
  const localPath = path.join(LOCAL_SCREENSHOTS_STORE, key);
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(localPath, buffer);

  return { storageKey: key, provider: 'local', path: localPath, bucket: 'local' };
}

/**
 * Retrieves the raw screenshot buffer.
 */
async function getScreenshotBuffer(key) {
  if (!key) throw new Error('No storage key provided.');
  const bucket = getScreenshotsBucket();

  // 1. S3 Client
  const s3 = getS3Client();
  if (s3) {
    for (const b of [bucket, getBucket()]) {
      try {
        const res = await s3.send(new GetObjectCommand({
          Bucket: b,
          Key: key,
        }));
        const stream = res.Body;
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks);
      } catch (_) {}
    }
  }

  // 2. Direct local file check
  if (fs.existsSync(key)) return fs.readFileSync(key);
  const localPath = path.join(LOCAL_SCREENSHOTS_STORE, key);
  if (fs.existsSync(localPath)) return fs.readFileSync(localPath);

  // 3. Supabase JS Client
  const client = getSupabase();
  if (client) {
    for (const b of [bucket, getBucket()]) {
      try {
        const { data, error } = await client.storage.from(b).download(key);
        if (!error && data) {
          const arrayBuffer = await data.arrayBuffer();
          return Buffer.from(arrayBuffer);
        }
      } catch (_) {}
    }
  }

  throw new Error(`Screenshot not found in storage: ${key}`);
}

/**
 * Generates a signed URL for a screenshot.
 */
async function getScreenshotSignedUrl(key, expiresInSeconds = 3600) {
  const client = getSupabase();
  if (client) {
    const bucket = getScreenshotsBucket();
    for (const b of [bucket, getBucket()]) {
      try {
        const { data, error } = await client.storage
          .from(b)
          .createSignedUrl(key, expiresInSeconds);
        if (!error && data?.signedUrl) return data.signedUrl;
      } catch (_) {}
    }
  }
  return null;
}

/**
 * Deletes a single screenshot from S3 / Supabase / local disk.
 */
async function deleteScreenshot(key) {
  if (!key) return;
  const bucket = getScreenshotsBucket();

  const s3 = getS3Client();
  if (s3) {
    for (const b of [bucket, getBucket()]) {
      try {
        await s3.send(new DeleteObjectCommand({
          Bucket: b,
          Key: key,
        }));
      } catch (_) {}
    }
  }

  const localPath = path.join(LOCAL_SCREENSHOTS_STORE, key);
  if (fs.existsSync(localPath)) {
    try { fs.unlinkSync(localPath); } catch (_) {}
  }
  if (fs.existsSync(key)) {
    try { fs.unlinkSync(key); } catch (_) {}
  }

  const client = getSupabase();
  if (client) {
    for (const b of [bucket, getBucket()]) {
      try {
        await client.storage.from(b).remove([key]);
      } catch (_) {}
    }
  }
}

/**
 * Deletes multiple screenshots in bulk.
 */
async function deleteScreenshots(keys = []) {
  if (!Array.isArray(keys) || keys.length === 0) return;
  for (const k of keys) {
    await deleteScreenshot(k);
  }
}

module.exports = {
  saveFile,
  getFileBuffer,
  getSignedUrl,
  deleteFile,
  getScreenshotsBucket,
  saveScreenshot,
  getScreenshotBuffer,
  getScreenshotSignedUrl,
  deleteScreenshot,
  deleteScreenshots,
  isCloudConfigured: () => Boolean(getS3Client() || getSupabase()),
  LOCAL_STORE,
  LOCAL_SCREENSHOTS_STORE,
};

