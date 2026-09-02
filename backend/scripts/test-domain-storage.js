const { saveFile, getFileBuffer, deleteFile } = require('../src/domain/storage');

async function testStorageDomain() {
  console.log('[test-storage] Testing saveFile via domain...');
  const key = `test-emp-doc-${Date.now()}.txt`;
  const buffer = Buffer.from('Domain Storage Provider Test Content with Supabase S3', 'utf-8');

  const saveRes = await saveFile({ key, buffer, mimeType: 'text/plain' });
  console.log('[test-storage] saveFile result:', saveRes);

  console.log('[test-storage] Testing getFileBuffer...');
  const readBuf = await getFileBuffer(key);
  console.log('[test-storage] Read back:', readBuf.toString('utf-8'));

  console.log('[test-storage] Testing deleteFile...');
  await deleteFile(key);
  console.log('[test-storage] Deleted successfully! Domain storage is fully operational.');
}

testStorageDomain().catch(err => {
  console.error('[test-storage] Error:', err);
  process.exit(1);
});
