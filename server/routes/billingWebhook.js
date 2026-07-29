const express = require('express');
const User = require('../models/User');
const { verifyWebhookSignature } = require('../services/lemonSqueezyClient');

const router = express.Router();

const PLAN_ID = { free: 1, pro: 2, business: 3 };

/**
 * IMPORTANT: this route must be mounted in server.js BEFORE the global
 * app.use(express.json()) call, not alongside the other billing routes.
 * Signature verification needs the exact raw bytes Lemon Squeezy signed —
 * if the global JSON parser runs first, it consumes the request body,
 * and by the time this route's own express.raw() middleware runs there's
 * nothing left to capture (confirmed directly: req.body would already be
 * a parsed object, not a Buffer, breaking the signature check entirely).
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-signature'];
  const rawBody = req.body; // a Buffer, thanks to this route's own express.raw()

  let isValid;
  try {
    isValid = verifyWebhookSignature(rawBody.toString('utf8'), signature);
  } catch (err) {
    console.error('[billing] Webhook signature check errored:', err.message);
    return res.status(500).send('Signature verification misconfigured');
  }

  if (!isValid) {
    return res.status(401).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).send('Invalid JSON body');
  }

  const eventName = event.meta && event.meta.event_name;
  const customData = event.meta && event.meta.custom_data;
  const userId = customData && customData.user_id;
  const variantId = event.data && event.data.attributes && String(event.data.attributes.variant_id);

  if (!userId) {
    console.error('[billing] Webhook missing custom_data.user_id — cannot identify which account to update.', eventName);
    return res.status(200).send('Acknowledged (no user_id, nothing to update)');
  }

  try {
    if (eventName === 'subscription_created' || eventName === 'subscription_updated' || eventName === 'subscription_resumed') {
      const newPlanId = variantId === process.env.LEMONSQUEEZY_VARIANT_BUSINESS
        ? PLAN_ID.business
        : variantId === process.env.LEMONSQUEEZY_VARIANT_PRO
          ? PLAN_ID.pro
          : null;

      if (newPlanId) {
        await User.setPlan(userId, newPlanId);
        console.log(`[billing] User ${userId} upgraded to plan_id ${newPlanId} (${eventName})`);
      } else {
        console.error(`[billing] Webhook variant_id ${variantId} didn't match any configured plan for user ${userId}.`);
      }
    } else if (eventName === 'subscription_cancelled' || eventName === 'subscription_expired') {
      await User.setPlan(userId, PLAN_ID.free);
      console.log(`[billing] User ${userId} downgraded to Free (${eventName})`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('[billing] Error processing webhook:', err.message);
    res.status(500).send('Error processing webhook');
  }
});

module.exports = router;