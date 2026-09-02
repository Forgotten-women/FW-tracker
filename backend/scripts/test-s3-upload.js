const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  forcePathStyle: true,
  region: 'ap-northeast-1', // or auto
  endpoint: 'https://xywqabfcqbrheaqfbyib.storage.supabase.co/storage/v1/s3',
  credentials: {
    accessKeyId: '7f90c89fb4678a0ebc391d976bd87eef',
    secretAccessKey: 'c02400243c3d5639bcecf1000ba159e3275948edefaf5a97e988253b8e7ccb48',
  },
});

async function main() {
  const bucket = 'employee-documents';
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
