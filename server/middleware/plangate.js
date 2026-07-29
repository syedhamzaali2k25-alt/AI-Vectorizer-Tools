/**
 * Plan-gating middleware — blocks access to paid-only features (like the
 * planned bulk/multi-file upload) for users on the free plan. Built as a
 * general-purpose gate, not hardcoded to any one feature, so it can be
 * reused for whatever else ends up being Pro/Business-only later.
 *
 * Must run AFTER requireAuth (needs req.user.id already set).
 */

const User = require('../models/User');

/**
 * Blocks free-plan users entirely. Use this for anything that should be
 * available to any paying customer (Pro or Business).
 */
async function requirePaidPlan(req, res, next) {
  const user = await User.findByIdWithPlan(req.user.id);

  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  if (user.plan_name === 'free') {
    return res.status(403).json({
      success: false,
      error: 'This feature is available on Pro and Business plans. Upgrade to unlock it.',
      requiresPlan: 'pro'
    });
  }

  req.userPlan = user; // downstream routes can reuse this instead of re-querying
  next();
}

/**
 * More specific gate for anything reserved for the top tier only
 * (Business) — e.g. if bulk upload's higher batch limits end up being
 * Business-exclusive while a smaller batch size stays available to Pro.
 */
async function requireBusinessPlan(req, res, next) {
  const user = await User.findByIdWithPlan(req.user.id);

  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  if (user.plan_name !== 'business') {
    return res.status(403).json({
      success: false,
      error: 'This feature is available on the Business plan. Upgrade to unlock it.',
      requiresPlan: 'business'
    });
  }

  req.userPlan = user;
  next();
}

module.exports = { requirePaidPlan, requireBusinessPlan };