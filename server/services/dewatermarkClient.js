/**
 * Dewatermark.AI — automatic watermark detection and removal.
 * Confirmed from their official API reference (assets.dewatermark.ai/api-document):
 *
 *   POST https://platform.dewatermark.ai/api/object_removal/v2/erase_watermark
 *   Header: X-API-KEY: <key>
 *   Body (multipart/form-data): original_preview_image (binary, JPEG,
 *     largest dimension ≤ 6000px), remove_text ("true"/"false"),
 *     predict_mode ("3.0" default)
 *
 * For the initial automatic pass, only `original_preview_image` is
 * required — no mask at all. (mask_base/mask_brush/session_id exist for
 * an optional manual-refinement follow-up call, which we don't use here
 * since the whole point of this integration is skipping manual masking.)
 *
 * Response: { edited_image: { image: <base64 JPEG>, ... }, session_id, event_id }
 */

const DEWATERMARK_URL = 'https://platform.dewatermark.ai/api/object_removal/v2/erase_watermark';

async function removeWatermarkAutomatic(imageBuffer, mimetype, apiKey, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;

  if (!apiKey) {
    throw new Error('Missing Dewatermark API key (set DEWATERMARK_API_KEY in your .env)');
  }

  const form = new FormData();
  form.append('original_preview_image', new Blob([imageBuffer], { type: mimetype || 'image/jpeg' }), 'image.jpg');
  form.append('remove_text', 'true'); // improves results specifically for text-style watermarks
  form.append('predict_mode', '3.0');

  const res = await doFetch(DEWATERMARK_URL, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey },
    body: form
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dewatermark request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const body = await res.json();

  if (!body.edited_image || !body.edited_image.image) {
    throw new Error(`Dewatermark succeeded but response was missing edited_image.image. Raw keys: ${Object.keys(body).join(', ')}`);
  }

  return { imageBase64: body.edited_image.image, sessionId: body.session_id };
}

module.exports = { removeWatermarkAutomatic };