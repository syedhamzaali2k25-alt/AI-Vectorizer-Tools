/**
 * Thin wrapper around Stability AI's v2beta Outpaint endpoint.
 *
 * Unlike Replicate, Stability's API:
 *  - Takes the raw image bytes directly via multipart/form-data (no need
 *    to host the image at a public URL first)
 *  - Responds synchronously with the actual image bytes (no polling)
 *
 * Endpoint: POST https://api.stability.ai/v2beta/stable-image/edit/outpaint
 * Docs confirmed at platform.stability.ai/docs/api-reference
 */

const STABILITY_BASE = 'https://api.stability.ai';

async function outpaintViaStability(imageBuffer, mimetype, directions, apiToken, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;

  if (!apiToken) {
    throw new Error('Missing Stability API token (set STABILITY_API_KEY in your .env)');
  }

  const { left = 0, right = 0, up = 0, down = 0, prompt } = directions;
  if (!left && !right && !up && !down) {
    throw new Error('At least one direction (left, right, up, down) must be greater than 0');
  }

  const form = new FormData();
  form.append('image', new Blob([imageBuffer], { type: mimetype }), 'image');
  if (left) form.append('left', String(left));
  if (right) form.append('right', String(right));
  if (up) form.append('up', String(up));
  if (down) form.append('down', String(down));
  if (prompt) form.append('prompt', prompt);
  form.append('output_format', 'png');

  const res = await doFetch(`${STABILITY_BASE}/v2beta/stable-image/edit/outpaint`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'image/*'
    },
    body: form
  });

  if (!res.ok) {
    // Stability returns JSON error bodies even though success responses are raw image bytes
    const text = await res.text().catch(() => '');
    throw new Error(`Stability request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimetype: 'image/png' };
}

module.exports = { outpaintViaStability };
