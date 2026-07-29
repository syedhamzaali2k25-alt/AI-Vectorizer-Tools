const jwt = require('jsonwebtoken');
const User = require('../models/User');

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, email: payload.email };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

/**
 * Accepts EITHER a Business-plan API key (via X-API-Key header) OR the
 * normal login JWT (via Authorization: Bearer) — lets external code call
 * tool endpoints directly with a long-lived key, while the website itself
 * keeps working exactly as before with its session JWT. Both paths set
 * req.user in the same shape, so every downstream route (credit checks,
 * job creation, etc.) works identically regardless of which was used.
 */
async function requireAuthOrApiKey(req, res, next) {
  const apiKeyHeader = req.headers['x-api-key'];

  if (apiKeyHeader) {
    const user = await User.findByApiKey(apiKeyHeader);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }
    req.user = { id: user.id, email: user.email };
    return next();
  }

  return requireAuth(req, res, next);
}

module.exports = { requireAuth, requireAuthOrApiKey };