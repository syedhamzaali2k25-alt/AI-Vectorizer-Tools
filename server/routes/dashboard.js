const express = require('express');
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');
const AiUsage = require('../models/AiUsage');

const router = express.Router();

/**
 * Returns the current user's account info, including their plan's actual
 * name and monthly credit allowance (not just the raw plan_id foreign
 * key) — used by the dashboard header (email, plan, credits remaining).
 */
router.get('/me', requireAuth, async (req, res) => {
  const user = await User.findByIdWithPlan(req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  res.json({
    success: true,
    user: {
      email: user.email,
      full_name: user.full_name,
      credits: user.credits,
      plan_name: user.plan_name,
      plan_monthly_credits: user.plan_monthly_credits
    }
  });
});

/**
 * Recent AI tool usage (Background Remover, Upscaler, etc.) — one row
 * per job, most recent first. Powers the "Recent tool usage" table.
 */
router.get('/usage-history', requireAuth, async (req, res) => {
  const history = await AiUsage.getHistory(req.user.id, 50);
  res.json({ success: true, history });
});

/**
 * Credit ledger — every credit gain (signup bonus, plan renewal) and
 * spend (tool usage), most recent first. Powers the "Credit history" table.
 */
router.get('/credit-history', requireAuth, async (req, res) => {
  const history = await User.getCreditHistory(req.user.id, 50);
  res.json({ success: true, history });
});

module.exports = router;