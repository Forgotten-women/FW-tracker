const { 
  saveScreenshot, 
  getScreenshotBuffer, 
  getScreenshotSignedUrl, 
  deleteScreenshot,
  deleteScreenshots 
} = require('../src/domain/storage');

async function runScreenshotStorageTests() {
  console.log('--- 1. Testing Screenshot Storage Domain Functions ---');
  const testKey = `screenshots/test-emp-999/${new Date().toISOString().slice(0, 10)}/test_${Date.now()}.jpg`;
  const dummyJpgBuffer = Buffer.from('FFD8FFE000104A46494600010101006000600000FFDB004300080606070605080707070909080A0C140D0C0B0B0C1912130F141D1A1F1E1D1A1C1C20242E2720222C231C1C2837292C30313434341F27393D38323C2E333432FFD9', 'hex');

  console.log(`[test] Saving test screenshot: ${testKey} (${dummyJpgBuffer.length} bytes)...`);
  const saveResult = await saveScreenshot({ key: testKey, buffer: dummyJpgBuffer, mimeType: 'image/jpeg' });
  console.log('[test] Save result:', saveResult);

  console.log('[test] Retrieving signed URL...');
  const signedUrl = await getScreenshotSignedUrl(testKey, 3600);
  console.log('[test] Signed URL generated successfully:', signedUrl ? 'YES' : 'NO');

  console.log('[test] Retrieving buffer...');
  const retrievedBuffer = await getScreenshotBuffer(testKey);
  console.log('[test] Retrieved buffer length:', retrievedBuffer ? retrievedBuffer.length : 'null');
  if (!retrievedBuffer || retrievedBuffer.length !== dummyJpgBuffer.length) {
    throw new Error('Retrieved buffer does not match expected length!');
  }

  console.log('[test] Deleting test screenshot...');
  await deleteScreenshot(testKey);
  console.log('[test] Deleted single screenshot successfully.');

  console.log('[test] Testing bulk deletion...');
  const key1 = `screenshots/test-emp-999/bulk_1.jpg`;
  const key2 = `screenshots/test-emp-999/bulk_2.jpg`;
  await saveScreenshot({ key: key1, buffer: dummyJpgBuffer });
  await saveScreenshot({ key: key2, buffer: dummyJpgBuffer });
  await deleteScreenshots([key1, key2]);
  console.log('[test] Bulk deletion executed successfully.');

  console.log('--- Screenshot Storage Tests Passed! ---');
}

runScreenshotStorageTests()
  .then(() => {
    console.log('[SUCCESS] All screenshot storage operations validated.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[FAILED] Screenshot storage tests failed:', err);
    process.exit(1);
  });
