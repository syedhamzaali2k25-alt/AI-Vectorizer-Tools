/**
 * Job-based resumable AI processing.
 *
 * Previously: credits were deducted immediately, then we awaited the full
 * Replicate/Dewatermark call before responding — so a page refresh, tab
 * close, or network drop during that wait meant the user lost both the
 * credit AND the result, with no way to recover either.
 *
 * Now: each request creates a Job row (status='processing') and responds
 * with just the jobId immediately — the actual AI call keeps running in
 * the background regardless of whether the client is still listening.
 * Credits are deducted ONLY after the job actually succeeds. The frontend
 * polls GET /api/jobs/:id (see routes/jobs.js) to find out what happened,
 * and can resume that polling after a refresh since the jobId is saved in
 * localStorage — the job's real state lives in the database, not in any
 * particular page load.
 *
 * Known limitation, worth being upfront about: this runs the background
 * work as a plain in-process async function, not a real job queue
 * (Bull/Redis or similar). That's a reasonable tradeoff for this scale —
 * it needs no extra infrastructure — but it does mean a job left
 * mid-flight would never resolve if the server process itself restarts
 * partway through (the row would stay stuck at 'processing' forever). A
 * real queue with persistence/retries would be the next step up from here
 * if that becomes a real problem in practice.
 *
 * Auth note: every route below uses requireAuthOrApiKey instead of the
 * plain requireAuth — this accepts either the normal login JWT (the
 * website itself) or a Business-plan API key via the X-API-Key header
 * (external code calling these endpoints directly), setting req.user
 * identically either way so nothing else here needed to change.
 */
const express = require('express');
const { requireAuthOrApiKey } = require('../middleware/auth');
const { upload, uploadWithMask } = require('../middleware/upload');
const User = require('../models/User');
const AiUsage = require('../models/AiUsage');
const { stageFile, getPublicBaseUrl, cleanup, TEMP_DIR } = require('../services/tempHost');
const { removeBackgroundViaReplicate, upscaleViaReplicate, expandImageViaReplicate, vectorizeViaReplicate } = require('../services/replicateClient');
const { removeWatermarkAutomatic } = require('../services/dewatermarkClient');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Serves temporarily-staged uploads so external APIs (which need a public
// URL, not raw bytes) can fetch them. Deleted right after use.
router.get('/temp/:id', (req, res) => {
  // Some Replicate models (and possibly Replicate's own fetch step)
  // append a file extension to the URL they request, expecting it to
  // look like a normal image URL — even though the id itself (and the
  // actual staged file on disk) has no extension. Stripping any
  // trailing extension here means the lookup still finds the right
  // file regardless of whether one was appended.
  const rawId = req.params.id.replace(/\.[a-zA-Z0-9]+$/, '');
  const filePath = path.join(TEMP_DIR, rawId);
  if (!filePath.startsWith(TEMP_DIR)) return res.status(400).send('Invalid id');

  try {
    const data = fs.readFileSync(filePath);
    const requestedExt = path.extname(req.params.id).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[requestedExt] || 'application/octet-stream';
    res.type(mime).send(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).send('Not found or already used');
    }
    console.error('[temp route] Failed to read staged file:', filePath, err.message);
    return res.status(500).send('Could not read file');
  }
});

function runInBackground(asyncFn) {
  asyncFn().catch((err) => {
    console.error('[job] Unexpected error in background processing:', err);
  });
}

async function hasEnoughCredits(userId, required) {
  const user = await User.findById(userId);
  return !!user && user.credits >= required;
}

// --- Step 4: Background Remover — job-based ---
router.post('/bg-remove', requireAuthOrApiKey, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No image file uploaded (expected field name "image")' });
  }

  const apiToken = process.env.REPLICATE_API_TOKEN;
  if (!apiToken) {
    return res.status(500).json({ success: false, error: 'Server is missing REPLICATE_API_TOKEN — set it in .env' });
  }

  const CREDITS_REQUIRED = 1;
  if (!(await hasEnoughCredits(req.user.id, CREDITS_REQUIRED))) {
    return res.status(402).json({ success: false, error: 'Not enough credits. Upgrade your plan or wait for your next billing cycle.' });
  }

  const { id: tempId, filePath: tempPath } = stageFile(req.file.buffer, req.file.mimetype);
  const publicUrl = `${getPublicBaseUrl(req)}/api/tools/temp/${tempId}`;

  const job = await AiUsage.createJob(req.user.id, 'bg-remove', publicUrl);
  res.json({ success: true, jobId: job.id });

  runInBackground(async () => {
    try {
      const result = await removeBackgroundViaReplicate(publicUrl, apiToken);
      const updated = await User.deductCredits(req.user.id, CREDITS_REQUIRED);
      if (!updated) {
        await AiUsage.markJobCompleted(job.id, result.outputUrl, 0);
      } else {
        await AiUsage.markJobCompleted(job.id, result.outputUrl, CREDITS_REQUIRED);
      }
    } catch (err) {
      await AiUsage.markJobFailed(job.id, err.message);
    } finally {
      await cleanup(tempPath);
    }
  });
});

// --- Step 5: Image Upscaler — job-based ---
router.post('/upscale', requireAuthOrApiKey, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No image file uploaded (expected field name "image")' });
  }

  const apiToken = process.env.REPLICATE_API_TOKEN;
  if (!apiToken) {
    return res.status(500).json({ success: false, error: 'Server is missing REPLICATE_API_TOKEN — set it in .env' });
  }

  const scale = Number(req.body.scale) || 4;
  if (![2, 4].includes(scale)) {
    return res.status(400).json({ success: false, error: 'Scale must be 2 or 4' });
  }

  const CREDITS_REQUIRED = 1;
  if (!(await hasEnoughCredits(req.user.id, CREDITS_REQUIRED))) {
    return res.status(402).json({ success: false, error: 'Not enough credits. Upgrade your plan or wait for your next billing cycle.' });
  }

  const { id: tempId, filePath: tempPath } = stageFile(req.file.buffer, req.file.mimetype);
  const publicUrl = `${getPublicBaseUrl(req)}/api/tools/temp/${tempId}`;

  const job = await AiUsage.createJob(req.user.id, 'upscale', publicUrl);
  res.json({ success: true, jobId: job.id });

  runInBackground(async () => {
    try {
      const result = await upscaleViaReplicate(publicUrl, scale, apiToken);
      const updated = await User.deductCredits(req.user.id, CREDITS_REQUIRED);
      await AiUsage.markJobCompleted(job.id, result.outputUrl, updated ? CREDITS_REQUIRED : 0);
    } catch (err) {
      await AiUsage.markJobFailed(job.id, err.message);
    } finally {
      await cleanup(tempPath);
    }
  });
});

// --- Step 6: Watermark Remover (Dewatermark.AI, automatic) — job-based ---
router.post('/watermark-remove', requireAuthOrApiKey, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No image file uploaded (expected field name "image")' });
  }

  const apiKey = process.env.DEWATERMARK_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, error: 'Server is missing DEWATERMARK_API_KEY — set it in .env' });
  }

  const CREDITS_REQUIRED = 2;
  if (!(await hasEnoughCredits(req.user.id, CREDITS_REQUIRED))) {
    return res.status(402).json({ success: false, error: 'Not enough credits. Upgrade your plan or wait for your next billing cycle.' });
  }

  const imageBuffer = Buffer.from(req.file.buffer);
  const mimetype = req.file.mimetype;

  const job = await AiUsage.createJob(req.user.id, 'watermark-remove', null);
  res.json({ success: true, jobId: job.id });

  runInBackground(async () => {
    try {
      const result = await removeWatermarkAutomatic(imageBuffer, mimetype, apiKey);
      const outputUrl = `data:image/jpeg;base64,${result.imageBase64}`;
      const updated = await User.deductCredits(req.user.id, CREDITS_REQUIRED);
      await AiUsage.markJobCompleted(job.id, outputUrl, updated ? CREDITS_REQUIRED : 0);
    } catch (err) {
      await AiUsage.markJobFailed(job.id, err.message);
    }
  });
});

// --- Step 8: Image Expander (Replicate FLUX Fill Pro) — job-based ---
router.post('/expand', requireAuthOrApiKey, uploadWithMask, async (req, res) => {
  const imageFile = req.files?.image?.[0];
  const maskFile = req.files?.mask?.[0];

  if (!imageFile || !maskFile) {
    return res.status(400).json({ success: false, error: 'Both "image" (pre-padded) and "mask" files are required.' });
  }

  const apiToken = process.env.REPLICATE_API_TOKEN;
  if (!apiToken) {
    return res.status(500).json({ success: false, error: 'Server is missing REPLICATE_API_TOKEN — set it in .env' });
  }

  const SAFETY_SUFFIX = ', photorealistic, seamless, preserve the original subject exactly as-is with no alterations, do not modify, duplicate, or clone any person already in the image, absolutely no additional people, no cloned or repeated human figures, no new faces, no text, no logos, no watermarks, no captions, no duplicated objects, extend ONLY the empty background, road, sky, water, or scenery — never generate any new person or figure of any kind, matching perspective, lighting, shadows, colors and textures of the existing background';
  const DEFAULT_EXPAND_PROMPT = 'extend the background and environment naturally, matching the style, lighting, colors, and textures already visible in the photo';
  const userPrompt = req.body.prompt?.trim();
  const prompt = (userPrompt || DEFAULT_EXPAND_PROMPT) + SAFETY_SUFFIX;

  const CREDITS_REQUIRED = 2;
  if (!(await hasEnoughCredits(req.user.id, CREDITS_REQUIRED))) {
    return res.status(402).json({ success: false, error: 'Not enough credits. Upgrade your plan or wait for your next billing cycle.' });
  }

  const staged = stageFile(imageFile.buffer, imageFile.mimetype);
  const stagedMask = stageFile(maskFile.buffer, maskFile.mimetype);
  const base = getPublicBaseUrl(req);
  const imageUrl = `${base}/api/tools/temp/${staged.id}`;
  const maskUrl = `${base}/api/tools/temp/${stagedMask.id}`;

  const job = await AiUsage.createJob(req.user.id, 'expand', imageUrl);
  res.json({ success: true, jobId: job.id });

  runInBackground(async () => {
    try {
      const result = await expandImageViaReplicate(imageUrl, maskUrl, prompt, apiToken);
      const updated = await User.deductCredits(req.user.id, CREDITS_REQUIRED);
      await AiUsage.markJobCompleted(job.id, result.outputUrl, updated ? CREDITS_REQUIRED : 0);
    } catch (err) {
      await AiUsage.markJobFailed(job.id, err.message);
    } finally {
      await Promise.all([cleanup(staged.filePath), cleanup(stagedMask.filePath)]);
    }
  });
});

// --- Vectorizer (Replicate: recraft-ai/recraft-vectorize) ---
// Launch promo: free through the date below, then 1 credit per image.
const VECTORIZE_FREE_UNTIL = new Date('2026-10-30T00:00:00Z');
const VECTORIZE_CREDITS = 1;

router.post('/vectorize', requireAuthOrApiKey, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No image file uploaded (expected field name "image")' });
  }

  const apiToken = process.env.REPLICATE_API_TOKEN;
  if (!apiToken) {
    return res.status(500).json({ success: false, error: 'Server is missing REPLICATE_API_TOKEN — set it in .env' });
  }

  const isFreePeriod = Date.now() < VECTORIZE_FREE_UNTIL.getTime();
  const creditsRequired = isFreePeriod ? 0 : VECTORIZE_CREDITS;

  if (creditsRequired > 0 && !(await hasEnoughCredits(req.user.id, creditsRequired))) {
    return res.status(402).json({ success: false, error: 'Not enough credits. Upgrade your plan or wait for your next billing cycle.' });
  }

  const { id: tempId, filePath: tempPath } = stageFile(req.file.buffer, req.file.mimetype);
  const publicUrl = `${getPublicBaseUrl(req)}/api/tools/temp/${tempId}`;

  const job = await AiUsage.createJob(req.user.id, 'vectorize', publicUrl);
  res.json({ success: true, jobId: job.id });

  runInBackground(async () => {
    try {
      const result = await vectorizeViaReplicate(publicUrl, apiToken);
      if (creditsRequired > 0) {
        const updated = await User.deductCredits(req.user.id, creditsRequired);
        await AiUsage.markJobCompleted(job.id, result.outputUrl, updated ? creditsRequired : 0);
      } else {
        await AiUsage.markJobCompleted(job.id, result.outputUrl, 0);
      }
    } catch (err) {
      await AiUsage.markJobFailed(job.id, err.message);
    } finally {
      await cleanup(tempPath);
    }
  });
});

/**
 * Download proxy — the HTML `download` attribute on an <a> tag is silently
 * ignored by browsers for cross-origin URLs (like Replicate's
 * replicate.delivery output links), so clicking "Download" was just
 * opening/viewing the image instead of actually downloading it. This
 * route fetches the image server-side (no CORS restriction between
 * servers) and streams it back with a Content-Disposition header, which
 * reliably triggers a real download regardless of the original URL's origin.
 */
const ALLOWED_DOWNLOAD_HOSTS = ['replicate.delivery'];

router.get('/download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ success: false, error: 'Missing url parameter' });

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid url parameter' });
  }

  if (!ALLOWED_DOWNLOAD_HOSTS.includes(parsed.hostname)) {
    return res.status(403).json({ success: false, error: 'This host is not allowed for downloads.' });
  }

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      return res.status(502).json({ success: false, error: `Could not fetch the file (${upstream.status})` });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const safeFilename = (filename || 'download.png').replace(/[^a-zA-Z0-9_.-]/g, '_');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = router;