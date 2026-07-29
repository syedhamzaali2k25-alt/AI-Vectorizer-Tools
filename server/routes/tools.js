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
const { removeBackgroundViaReplicate, upscaleViaReplicate, expandImageViaReplicate } = require('../services/replicateClient');
const { removeWatermarkAutomatic } = require('../services/dewatermarkClient');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Serves temporarily-staged uploads so external APIs (which need a public
// URL, not raw bytes) can fetch them. Deleted right after use.
router.get('/temp/:id', (req, res) => {
  const filePath = path.join(TEMP_DIR, req.params.id);
  if (!filePath.startsWith(TEMP_DIR)) return res.status(400).send('Invalid id');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found or already used');
  res.sendFile(filePath);
});

/**
 * Fire-and-forget wrapper for the background half of a job. The HTTP
 * response has already been sent by the time this runs, so nothing here
 * can talk back to that original request — every outcome (success or
 * failure) must be recorded via the job row itself, which is what the
 * frontend is polling. The outer .catch is only a safety net for a truly
 * unexpected bug slipping past the inner try/catch — it stops that from
 * crashing the whole process with an unhandled rejection.
 */
function runInBackground(asyncFn) {
  asyncFn().catch((err) => {
    console.error('[job] Unexpected error in background processing:', err);
  });
}

/**
 * Read-only balance check before creating a job — we don't want to spin
 * up a job (and call an external API) for someone who clearly can't pay
 * for it. This is a UX nicety, not the real enforcement: actual deduction
 * still happens atomically in User.deductCredits after success, which is
 * what actually prevents overspending if e.g. two jobs somehow race.
 */
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
        // Credits ran out between the earlier check and now (e.g. another
        // tab's job finished first) — the AI work still succeeded, so we
        // honor the result rather than throwing it away, but don't charge
        // for what the user can no longer afford.
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

  // No temp-hosting needed here — Dewatermark takes raw bytes directly —
  // but the raw buffer can't be handed to the background continuation
  // after res.json() the way a URL can, since req.file is tied to this
  // request's lifecycle. Copying the bytes into a plain Buffer first
  // keeps them alive independently of the request object.
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

  // Diffusion-based outpainting (FLUX Fill Pro) needs *some* text
  // description to know what to generate in the new area — an empty
  // prompt was found to produce a blank/neutral fill instead of actually
  // extending the scene. Default to a generic instruction when the user
  // doesn't type one, rather than sending an empty string.
  // Improved default: FLUX is very good at rendering text — good enough
  // that words like "photoshoot" or "fashion" in a prompt can make it
  // think it should generate a poster/caption instead of just extending
  // the photo (confirmed in testing — a user-written content-description
  // prompt produced literal title-card text over the new area). The
  // "no text" safety phrase is appended to EVERY prompt used — default or
  // user-typed — so this doesn't just protect the no-prompt case, it
  // protects any custom prompt too, without the user needing to know to
  // add it themselves.
  // Both real failures observed so far involved the model inventing new
  // PEOPLE in the generated area (a grid of unrelated faces, then a
  // second person's face) instead of just continuing the background —
  // explicitly telling it not to do that is a direct, targeted fix for
  // the specific failure pattern actually seen, not just a general hope.
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

// --- Step 10: still a placeholder ---
const PENDING_TOOLS = [
  { path: 'vectorize', name: 'Vectorizer', credits: 1 }
];

PENDING_TOOLS.forEach(({ path: toolPath, name, credits }) => {
  router.post(`/${toolPath}`, requireAuthOrApiKey, upload.single('image'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded (expected field name "image")' });
    }

    if (!(await hasEnoughCredits(req.user.id, credits))) {
      return res.status(402).json({ success: false, error: 'Not enough credits for this tool. Upgrade your plan or wait for your next billing cycle.' });
    }

    res.status(501).json({
      success: false,
      error: `${name} is not implemented yet — this route is a placeholder.`
    });
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
 *
 * No requireAuth here deliberately: by this point the real work (credits,
 * AI processing) is already done — this only re-serves an already-public,
 * temporary Replicate URL with a nicer filename attached. Restricting to
 * a small allow-list of hosts keeps this from being usable as a general
 * open proxy for arbitrary URLs.
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