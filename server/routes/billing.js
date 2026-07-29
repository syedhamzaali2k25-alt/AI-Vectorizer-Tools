const express = require('express');
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');
const { createCheckout } = require('../services/lemonSqueezyClient');

const router = express.Router();

function getVariantIdForPlan(planName) {
  if (planName === 'pro') return process.env.LEMONSQUEEZY_VARIANT_PRO;
  if (planName === 'business') return process.env.LEMONSQUEEZY_VARIANT_BUSINESS;
  return null;
}

/**
 * Starts a checkout for the given plan and returns the hosted Lemon
 * Squeezy checkout URL for the frontend to redirect to — the actual
 * payment form, card entry, etc. all happen on Lemon Squeezy's own
 * pages, not ours.
 *
 * Note: the webhook that actually handles subscription events lives in
 * routes/billingWebhook.js instead of here — it needs to be mounted
 * before the global express.json() middleware in server.js (see that
 * file for why), so it can't share this router.
 */
router.post('/checkout', requireAuth, async (req, res) => {
  const planName = req.body.plan;
  const variantId = getVariantIdForPlan(planName);

  if (!variantId) {
    return res.status(400).json({
      success: false,
      error: `Unknown or unconfigured plan "${planName}". Valid plans: pro, business.`
    });
  }

  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  try {
    const { checkoutUrl } = await createCheckout({
      variantId,
      userId: user.id,
      userEmail: user.email
    });
    res.json({ success: true, checkoutUrl });
  } catch (err) {
    console.error('[billing] Checkout creation failed:', err.message);
    res.status(502).json({ success: false, error: 'Could not start checkout. Try again in a moment.' });
  }
});

module.exports = router;