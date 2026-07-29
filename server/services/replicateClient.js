/**
 * Wrapper around Replicate's API. Two calling patterns used across our
 * tools: an "official" model (no version hash needed) and a "community"
 * model (needs dynamic version resolution) or a hardcoded version hash
 * for models known to be stable enough not to need re-resolving each call.
 */

const REPLICATE_API_BASE = 'https://api.replicate.com/v1';

/**
 * Retries a Replicate call specifically on 429 (rate limited) responses,
 * with a short exponential backoff — bulk uploads can fire several
 * requests close together, and Replicate's rate limit is easy to hit
 * that way even though each individual request is perfectly valid on
 * its own. A normal error (400, 500, etc.) still fails immediately;
 * only 429 specifically gets retried.
 */
async function withRateLimitRetry(fn, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const is429 = err.status === 429 || (err.message && err.message.includes('(429)'));
      if (!is429 || attempt === maxRetries) throw err;
      // Replicate tells us exactly how long to wait in its own response
      // (confirmed via real testing: accounts under $5 in billing credit
      // get throttled to 6 requests/minute, burst of 1, with a
      // retry_after in seconds) — trust that over our own guessed
      // exponential backoff whenever it's present.
      const waitMs = typeof err.retryAfterSeconds === 'number'
        ? (err.retryAfterSeconds * 1000) + 250 // small buffer past the exact reset point
        : 1000 * Math.pow(2, attempt); // fallback: 1s, 2s, 4s
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}

async function runReplicateModel(owner, model, input, apiToken, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;

  const createRes = await doFetch(`${REPLICATE_API_BASE}/models/${owner}/${model}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      Prefer: 'wait'
    },
    body: JSON.stringify({ input })
  });

  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '');
    const error = new Error(`Replicate request failed (${createRes.status}): ${text.slice(0, 300)}`);
    error.status = createRes.status;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.retry_after === 'number') error.retryAfterSeconds = parsed.retry_after;
    } catch (e) {
      // body wasn't JSON, or didn't include retry_after — fine, the
      // caller falls back to its own default backoff in that case
    }
    throw error;
  }

  const prediction = await createRes.json();

  if (prediction.status === 'failed') {
    throw new Error(prediction.error || 'Replicate prediction failed');
  }

  const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  return { outputUrl: output, raw: prediction };
}

const REAL_ESRGAN_VERSION = '42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b';

async function runReplicateVersionedModel(version, input, apiToken, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;

  const createRes = await doFetch(`${REPLICATE_API_BASE}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      Prefer: 'wait'
    },
    body: JSON.stringify({ version, input })
  });

  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '');
    const error = new Error(`Replicate request failed (${createRes.status}): ${text.slice(0, 300)}`);
    error.status = createRes.status;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.retry_after === 'number') error.retryAfterSeconds = parsed.retry_after;
    } catch (e) {
      // not JSON, or no retry_after — caller falls back to default backoff
    }
    throw error;
  }

  const prediction = await createRes.json();
  if (prediction.status === 'failed') {
    throw new Error(prediction.error || 'Replicate prediction failed');
  }

  const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  return { outputUrl: output, raw: prediction };
}

async function removeBackgroundViaReplicate(imageUrl, apiToken, opts) {
  return withRateLimitRetry(() => runReplicateModel('bria', 'remove-background', { image: imageUrl }, apiToken, opts));
}

async function upscaleViaReplicate(imageUrl, scale, apiToken, opts) {
  return withRateLimitRetry(() => runReplicateVersionedModel(
    REAL_ESRGAN_VERSION,
    { image: imageUrl, scale: scale || 4, face_enhance: true },
    apiToken,
    opts
  ));
}

async function expandImageViaReplicate(paddedImageUrl, maskUrl, prompt, apiToken, opts) {
  return withRateLimitRetry(() => runReplicateModel(
    'black-forest-labs',
    'flux-fill-pro',
    { image: paddedImageUrl, mask: maskUrl, prompt: prompt || '' },
    apiToken,
    opts
  ));
}

module.exports = {
  runReplicateModel,
  runReplicateVersionedModel,
  removeBackgroundViaReplicate,
  upscaleViaReplicate,
  expandImageViaReplicate
};