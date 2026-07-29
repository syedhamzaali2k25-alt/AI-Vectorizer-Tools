const crypto = require('crypto');

const LS_API_BASE = 'https://api.lemonsqueezy.com/v1';

/**
 * Creates a hosted checkout session for a specific plan (Pro or
 * Business) and returns the URL to redirect the user to. Lemon Squeezy
 * acts as the Merchant of Record — it handles the actual payment,
 * compliance, and payout to us, rather than us needing our own
 * Stripe-style direct merchant account (which isn't available in every
 * country).
 *
 * `userId` is passed through as custom checkout data so the webhook
 * handler can later identify which PixelForge account to upgrade once
 * the payment actually completes — Lemon Squeezy doesn't know anything
 * about our own user IDs otherwise.
 */
async function createCheckout({ variantId, userId, userEmail }, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  const storeId = process.env.LEMONSQUEEZY_STORE_ID;

  if (!apiKey || !storeId) {
    throw new Error('Missing LEMONSQUEEZY_API_KEY or LEMONSQUEEZY_STORE_ID — set them in .env once your store is ready.');
  }

  const res = await doFetch(`${LS_API_BASE}/checkouts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/vnd.api+json',
      Accept: 'application/vnd.api+json'
    },
    body: JSON.stringify({
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            email: userEmail,
            custom: { user_id: String(userId) }
          },
          // Without this, Lemon Squeezy sends the user to its own
          // generic post-purchase page after checkout — this brings
          // them back to our own dashboard instead, with a query param
          // the dashboard can use to show a "you're upgraded!" banner.
          product_options: {
            redirect_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:4000'}/dashboard?upgraded=true`
          }
        },
        relationships: {
          store: { data: { type: 'stores', id: String(storeId) } },
          variant: { data: { type: 'variants', id: String(variantId) } }
        }
      }
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Lemon Squeezy checkout creation failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const body = await res.json();
  return { checkoutUrl: body.data.attributes.url };
}

/**
 * Verifies a webhook actually came from Lemon Squeezy (not a spoofed
 * request from anyone who found the endpoint URL) — they sign the raw
 * request body with a shared secret using HMAC-SHA256, sent in the
 * X-Signature header. Must be checked against the RAW body bytes, not a
 * re-serialized JSON.parse(...) + JSON.stringify(...) round-trip, since
 * that could produce different bytes (key order, spacing) than what was
 * actually signed.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('Missing LEMONSQUEEZY_WEBHOOK_SECRET — set it in .env to match what you configure in the Lemon Squeezy dashboard.');
  }
  if (!signatureHeader) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  // Constant-time comparison — a plain === would leak timing information
  // about how many leading characters matched, which is exactly the kind
  // of side channel signature verification is supposed to avoid.
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

module.exports = { createCheckout, verifyWebhookSignature };