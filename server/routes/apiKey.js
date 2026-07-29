const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireBusinessPlan } = require('../middleware/plangate');
const User = require('../models/User');

const router = express.Router();

/**
 * Generates a new API key for the current user, replacing any existing
 * one. Expires in 30 days (matching the Business plan's billing cycle).
 * The full key is only ever returned here, right after generation —
 * afterward, only a masked preview should be shown (matching how most
 * API products handle this, since the plaintext key can't be un-hashed
 * back out of the database even if we wanted to show it again later).
 */
router.post('/generate', requireAuth, requireBusinessPlan, async (req, res) => {
  const result = await User.generateApiKey(req.user.id);
  if (!result) {
    return res.status(500).json({ success: false, error: 'Could not generate an API key. Try again.' });
  }
  res.json({ success: true, apiKey: result.api_key, expiresAt: result.api_key_expires_at });
});

/**
 * Returns whether a (non-expired) key exists and a masked preview — not
 * the real key, which is only ever shown once, at generation time. An
 * expired key is reported as hasKey: false, even though the old value is
 * still sitting in the api_key column until the user generates a new
 * one — showing a masked preview of something that no longer actually
 * authenticates would be misleading.
 */
router.get('/', requireAuth, requireBusinessPlan, async (req, res) => {
  const user = await User.findById(req.user.id);
  const isExpired = user && user.api_key_expires_at && new Date(user.api_key_expires_at) <= new Date();

  if (!user || !user.api_key || isExpired) {
    return res.json({ success: true, hasKey: false });
  }
  const masked = `${user.api_key.slice(0, 11)}${'•'.repeat(8)}${user.api_key.slice(-4)}`;
  res.json({ success: true, hasKey: true, maskedKey: masked, expiresAt: user.api_key_expires_at });
});

router.delete('/', requireAuth, requireBusinessPlan, async (req, res) => {
  await User.revokeApiKey(req.user.id);
  res.json({ success: true });
});

module.exports = router;