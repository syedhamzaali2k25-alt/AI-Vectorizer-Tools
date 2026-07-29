const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuthOrApiKey } = require('../middleware/auth');
const AiUsage = require('../models/AiUsage');

const router = express.Router();

// Polling every 2-3 seconds (as documented) from a single tab is well
// under this. Started at 3 requests per 5s per the original suggestion,
// but testing found that a completely normal case — someone with 2
// browser tabs open on the same job, each polling independently — could
// briefly exceed that and get falsely blocked. 10 per 5s comfortably
// covers several simultaneous tabs while still catching a genuinely
// runaway script or stuck loop, which fires far more rapidly than any
// real polling pattern would.
const jobStatusLimiter = rateLimit({
  windowMs: 5 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests — please poll at most every 2-3 seconds.' }
});

/**
 * Polled by the frontend every 2-3 seconds while a job is in flight, and
 * immediately on page load if a jobId was saved in localStorage from a
 * previous visit — this is what makes a refresh/tab-close/network drop
 * non-destructive: the job keeps running server-side regardless of
 * whether anyone is watching, and whoever asks later gets the real answer.
 *
 * Uses requireAuthOrApiKey (not just requireAuth) so external API callers
 * (Business plan) can check a job's status the same way the website
 * itself does — without this, a job created via API key could never
 * actually be checked for its result through this same key.
 */
router.get('/:id', jobStatusLimiter, requireAuthOrApiKey, async (req, res) => {
  const jobId = Number(req.params.id);
  if (!Number.isInteger(jobId)) {
    return res.status(400).json({ success: false, error: 'Invalid job id' });
  }

  const job = await AiUsage.findJobById(jobId, req.user.id);
  if (!job) {
    // Either it doesn't exist, or it belongs to someone else — same
    // response either way, so this can't be used to probe for valid ids.
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  if (job.status === 'completed') {
    return res.json({ success: true, status: 'completed', outputUrl: job.output_url });
  }
  if (job.status === 'failed') {
    return res.json({ success: true, status: 'failed', error: job.error_message || 'Processing failed.' });
  }
  return res.json({ success: true, status: 'processing' });
});

module.exports = router;