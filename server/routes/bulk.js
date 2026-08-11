const express = require('express');
const asyncLib = require('async');
const archiver = require('archiver');
const { requireAuthOrApiKey } = require('../middleware/auth');
const { requirePaidPlan } = require('../middleware/plangate');
const { uploadBulk, MAX_BATCH_FILES } = require('../middleware/upload');
const User = require('../models/User');
const AiUsage = require('../models/AiUsage');
const { stageFile, cleanup } = require('../services/tempHost');
const { removeBackgroundViaReplicate, upscaleViaReplicate } = require('../services/replicateClient');
const { removeWatermarkAutomatic } = require('../services/dewatermarkClient');

const router = express.Router();

// Matches the per-tool credit costs already established for single-image
// processing — Expander isn't included since bulk mode doesn't support it
// (each image would need its own custom expansion direction/mask, which
// doesn't fit a simple "upload many, get many results" flow).
const TOOL_CREDIT_COST = {
  'bg-remove': 1,
  'upscale': 1,
  'watermark-remove': 2
};

function runInBackground(asyncFn) {
  asyncFn().catch((err) => {
    console.error('[bulk-job] Unexpected error in background processing:', err);
  });
}

function getPublicBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

/**
 * Uploads up to MAX_BATCH_FILES images and creates one independent job
 * per image, returning all job IDs immediately — mirrors the same
 * "create job, return right away, process in the background" pattern
 * used by the single-image tool routes, just looped over N files.
 * Gated to Pro/Business plans via requirePaidPlan.
 */
router.post('/bulk-upload', requireAuthOrApiKey, requirePaidPlan, uploadBulk, async (req, res) => {
  const tool = req.body.tool;
  const files = req.files;

  if (!TOOL_CREDIT_COST[tool]) {
    return res.status(400).json({
      success: false,
      error: `Bulk processing supports: ${Object.keys(TOOL_CREDIT_COST).join(', ')}`
    });
  }
  if (!files || files.length === 0) {
    return res.status(400).json({ success: false, error: 'No images uploaded' });
  }

  const costPerFile = TOOL_CREDIT_COST[tool];
  const totalCost = costPerFile * files.length;

  // Upfront check against the whole batch — a UX nicety so someone
  // doesn't wait through a whole batch just to have every item fail at
  // the end. Real enforcement is still per-job at completion time below
  // (User.deductCredits is atomic), which is what actually prevents
  // overspending if credits run out mid-batch.
  const user = await User.findById(req.user.id);
  if (!user || user.credits < totalCost) {
    return res.status(402).json({
      success: false,
      error: `This batch needs ${totalCost} credits (${costPerFile} × ${files.length} image${files.length > 1 ? 's' : ''}), but you only have ${user ? user.credits : 0}.`
    });
  }

  const jobs = [];
  for (const file of files) {
    const job = await AiUsage.createJob(req.user.id, tool, null);
    jobs.push({ jobId: job.id, filename: file.originalname });
  }

  const apiToken = process.env.REPLICATE_API_TOKEN;
  const dewatermarkKey = process.env.DEWATERMARK_API_KEY;

  // Confirmed in real testing: firing all N jobs simultaneously (plain
  // forEach, no limit) hit Replicate's rate limit (429) once a batch had
  // more than a couple of images — even though each individual request
  // was perfectly valid on its own. Processing with limited concurrency
  // (a few at a time, not all at once) avoids tripping that limit in the
  // first place, on top of the retry-with-backoff already added for any
  // 429s that still slip through.
  // Started at 3, but real testing showed even 2 concurrent Replicate
  // requests hit a 429 on this account — some Replicate accounts (often
  // free/trial tier) allow only a single request at a time. Set to 1
  // (fully sequential — one image finishes before the next starts) to
  // guarantee no concurrent requests are ever made, at the cost of a
  // slower batch overall. If a higher tier account handles more
  // concurrency fine, this can be raised again later.
  const BULK_CONCURRENCY = 1;

  runInBackground(async () => {
    const filesWithJobIds = files.map((file, index) => ({ file, jobId: jobs[index].jobId }));

    await asyncLib.mapLimit(filesWithJobIds, BULK_CONCURRENCY, async ({ file, jobId }, callback) => {
      let staged = null;
      try {
        let outputUrl;

        if (tool === 'watermark-remove') {
          const result = await removeWatermarkAutomatic(file.buffer, file.mimetype, dewatermarkKey);
          outputUrl = `data:image/jpeg;base64,${result.imageBase64}`;
        } else {
          staged = stageFile(file.buffer, file.mimetype);
          const base = getPublicBaseUrl(req);
          const imageUrl = `${base}/api/tools/temp/${staged.id}`;

          const result = tool === 'bg-remove'
            ? await removeBackgroundViaReplicate(imageUrl, apiToken)
            : await upscaleViaReplicate(imageUrl, 4, apiToken);
          outputUrl = result.outputUrl;
        }

        const updated = await User.deductCredits(req.user.id, costPerFile);
        if (!updated) {
          await AiUsage.markJobFailed(jobId, 'Not enough credits remaining to complete this item.');
          if (callback) callback(null);
          return;
        }

        await AiUsage.markJobCompleted(jobId, outputUrl, costPerFile);
      } catch (err) {
        await AiUsage.markJobFailed(jobId, err.message);
      } finally {
        if (staged) await cleanup(staged.filePath);
      }
      if (callback) callback(null);
    });
  });

  res.json({ success: true, jobs, maxBatchFiles: MAX_BATCH_FILES });
});

/**
 * Polls multiple jobs in one request — a batch of N images would
 * otherwise mean N separate polling requests every 2.5s, which adds up
 * fast and is pure waste when they can all be checked in one query.
 */
// Named "jobs-batch" (not "jobs/batch") deliberately — the existing
// single-job status route is GET /api/jobs/:id, mounted separately and
// earlier in server.js. Since Express matches routes in registration
// order, a request to /api/jobs/batch was being caught by that :id
// route first (treating "batch" as a literal job id, since :id matches
// any path segment) rather than ever reaching this handler. A distinct
// path segment sidesteps the ambiguity entirely regardless of mount order.
router.get('/jobs-batch', requireAuthOrApiKey, async (req, res) => {
  const ids = (req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return res.status(400).json({ success: false, error: 'No job ids provided' });
  }

  const results = await Promise.all(
    ids.map(async (id) => {
      const job = await AiUsage.findJobById(id, req.user.id);
      if (!job) return { id, status: 'not_found' };
      return { id, status: job.status, outputUrl: job.output_url, error: job.error_message };
    })
  );

  res.json({ success: true, jobs: results });
});

// Same allow-list approach as the existing single-file download proxy —
// only replicate.delivery URLs and data: URLs (Dewatermark's base64
// output) are accepted, so this can't be used as an open proxy for
// arbitrary URLs.
const ALLOWED_DOWNLOAD_HOSTS = ['replicate.delivery'];

/**
 * Bundles multiple completed results into a single ZIP — without this,
 * someone processing 10 images would have to click "download" 10 times.
 * POST with a JSON body rather than GET with comma-separated query params
 * — a data: URL (Dewatermark's output format) legitimately contains a
 * comma as part of its own syntax (`data:image/jpeg;base64,...`), which
 * broke a comma-delimited query string approach; each URL as its own JSON
 * array element avoids that ambiguity entirely regardless of content.
 */
router.post('/download-zip', requireAuthOrApiKey, express.json(), async (req, res) => {
  const urls = Array.isArray(req.body.urls) ? req.body.urls : [];
  if (urls.length === 0) {
    return res.status(400).json({ success: false, error: 'No urls provided' });
  }
  if (urls.length > MAX_BATCH_FILES) {
    return res.status(400).json({ success: false, error: `Too many files — max ${MAX_BATCH_FILES} per batch.` });
  }

  for (const url of urls) {
    if (typeof url !== 'string' || url.startsWith('data:')) continue; // data: URLs are always safe, no host to check
    try {
      const parsed = new URL(url);
      if (!ALLOWED_DOWNLOAD_HOSTS.includes(parsed.hostname)) {
        return res.status(403).json({ success: false, error: `Host not allowed: ${parsed.hostname}` });
      }
    } catch {
      return res.status(400).json({ success: false, error: `Invalid url: ${url}` });
    }
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="pixelforge-batch.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('[download-zip] archive error:', err);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      if (url.startsWith('data:')) {
        const match = url.match(/^data:(.+);base64,(.+)$/);
        if (match) {
          archive.append(Buffer.from(match[2], 'base64'), { name: `image-${i + 1}.jpg` });
        }
      } else {
        const upstream = await fetch(url);
        if (upstream.ok) {
          archive.append(Buffer.from(await upstream.arrayBuffer()), { name: `image-${i + 1}.png` });
        }
      }
    } catch (err) {
      // Skip this one file rather than failing the entire ZIP over one bad URL
    }
  }

  await archive.finalize();
});

module.exports = router;