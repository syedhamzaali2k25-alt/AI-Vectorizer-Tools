/**
 * Standalone test — bypasses the whole Express app, auth, and database.
 * Just tests: does our Replicate integration actually work with a real token?
 *
 * Run from the server/ folder:
 *   node test-bg-remove.js
 */
require('dotenv').config();
const { removeBackgroundViaReplicate } = require('./services/replicateClient');

// A public test image (safe to use — Wikimedia Commons, freely licensed)
const TEST_IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/640px-Cat03.jpg';

async function main() {
  console.log('Testing Replicate Background Remover...');
  console.log('Input image:', TEST_IMAGE_URL);
  console.log('Token loaded:', !!process.env.REPLICATE_API_TOKEN);
  console.log('Calling Replicate — this may take 5-15 seconds...\n');

  try {
    const result = await removeBackgroundViaReplicate(TEST_IMAGE_URL, process.env.REPLICATE_API_TOKEN);
    console.log('✅ SUCCESS!');
    console.log('Output image URL:', result.outputUrl);
    console.log('\nOpen that URL in your browser to see the background-removed result.');
  } catch (err) {
    console.log('❌ FAILED');
    console.log('Error:', err.message);
  }
}

main();
