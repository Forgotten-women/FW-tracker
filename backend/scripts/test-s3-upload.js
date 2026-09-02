const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const { storageCredentials } = require('./_connection');

const creds = storageCredentials();

const s3 = new S3Client({
  forcePathStyle: true,
  region: creds.region,
  endpoint: creds.endpoint,
  credentials: {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
  },
});

async function main() {
  const bucket = creds.bucket;
  const testKey = `test-health-check-${Date.now()}.txt`;
  const content = 'Office Tracker S3 verification dummy test content';

  console.log(`[test] 1. Uploading test file "${testKey}" to bucket "${bucket}"...`);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: testKey,
    Body: Buffer.from(content, 'utf-8'),
    ContentType: 'text/plain',
  }));
  console.log('[test] -> Upload successful!');

  console.log(`[test] 2. Reading test file back from "${bucket}"...`);
  const getRes = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: testKey,
  }));
  const readData = await getRes.Body.transformToString();
  console.log(`[test] -> Read back: "${readData}"`);

  console.log(`[test] 3. Cleaning up / deleting test file "${testKey}"...`);
  await s3.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: testKey,
  }));
  console.log('[test] -> Cleanup successful! Bucket credentials are 100% WORKING.');
}

main().catch(err => {
  console.error('[test] ERROR testing S3 Supabase storage:', err);
  process.exit(1);
});
