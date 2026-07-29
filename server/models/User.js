const db = require('../../config/db');
const crypto = require('crypto');

async function findByEmail(email) {
  const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0] || null;
}

async function findById(id) {
  const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

/**
 * Like findById, but also includes the plan's actual name/allowance —
 * users.plan_id alone is just a foreign key (1, 2, 3), not useful to show
 * directly in a dashboard.
 */
async function findByIdWithPlan(id) {
  const result = await db.query(
    `SELECT u.*, p.name AS plan_name, p.monthly_credits AS plan_monthly_credits
     FROM users u
     JOIN plans p ON p.id = u.plan_id
     WHERE u.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function findByGoogleId(googleId) {
  const result = await db.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
  return result.rows[0] || null;
}

async function findByApiKey(apiKey) {
  // Expired keys are treated as if they don't exist at all, rather than
  // returning the user and letting the caller separately check a date —
  // this way every route that authenticates via API key automatically
  // gets the expiration enforced without needing its own extra check.
  const result = await db.query(
    'SELECT * FROM users WHERE api_key = $1 AND api_key_expires_at > NOW()',
    [apiKey]
  );
  return result.rows[0] || null;
}

/**
 * Generates a new API key for a user, replacing any existing one — a
 * Business-plan-only feature (enforced by requireBusinessPlan at the
 * route level, not here) that lets external code call PixelForge's tool
 * endpoints directly with a long-lived key instead of a login session's
 * JWT. Format loosely follows the common "avt_live_<random>" convention
 * used by many API products, making it recognizable and greppable if it
 * ever leaks into a log or a public repo by mistake.
 *
 * Expires after 30 days (matching the Business plan's monthly billing
 * cycle) rather than lasting forever — reduces how much damage a leaked
 * key can do, and nudges toward periodic rotation as a side effect of
 * needing to regenerate anyway once it lapses.
 */
async function generateApiKey(userId) {
  const apiKey = `avt_live_${crypto.randomBytes(24).toString('hex')}`;
  const result = await db.query(
    `UPDATE users
     SET api_key = $2, api_key_expires_at = NOW() + INTERVAL '30 days'
     WHERE id = $1
     RETURNING api_key, api_key_expires_at`,
    [userId, apiKey]
  );
  return result.rows[0] || null;
}

async function revokeApiKey(userId) {
  await db.query('UPDATE users SET api_key = NULL WHERE id = $1', [userId]);
}

/**
 * Updates a user's plan_id — called from the billing webhook once Lemon
 * Squeezy confirms a subscription actually started, changed, or ended.
 * Also grants the new plan's full monthly credit allowance immediately
 * (there's no separate automatic monthly-renewal process elsewhere in
 * this codebase yet) — without this, someone upgrading from Free to
 * Business would have their plan_id changed but still be stuck with
 * whatever few credits they had left, with no path to actually getting
 * the 3000/month they just paid for.
 */
async function setPlan(userId, planId) {
  const planResult = await db.query('SELECT monthly_credits FROM plans WHERE id = $1', [planId]);
  const monthlyCredits = planResult.rows[0] ? planResult.rows[0].monthly_credits : null;
  if (monthlyCredits === null) {
    await db.query('UPDATE users SET plan_id = $2 WHERE id = $1', [userId, planId]);
    return;
  }

  const before = await db.query('SELECT credits FROM users WHERE id = $1', [userId]);
  const oldCredits = before.rows[0] ? before.rows[0].credits : 0;
  const delta = monthlyCredits - oldCredits;

  await db.query('UPDATE users SET plan_id = $2, credits = $3 WHERE id = $1', [userId, planId, monthlyCredits]);
  await logCreditTransaction(userId, delta, 'plan_change', monthlyCredits);
}

async function create({ email, passwordHash, fullName }) {
  // plan_id and credits both default per the schema (plan_id=1 'free',
  // credits=3 — free users get 3 conversions before needing to upgrade)
  // so they don't need to be listed explicitly here — but the
  // signup bonus still gets logged to the ledger for a full history.
  const result = await db.query(
    `INSERT INTO users (email, password_hash, full_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, full_name, credits, plan_id, created_at`,
    [email, passwordHash, fullName || null]
  );
  const user = result.rows[0];

  await logCreditTransaction(user.id, user.credits, 'signup_bonus', user.credits);

  return user;
}

/**
 * Creates a new account for someone signing up via Google — no password at
 * all (password_hash stays NULL; login.js's email/password form simply
 * isn't a valid path for this account unless they later set a password).
 */
async function createFromGoogle({ email, googleId, fullName }) {
  const result = await db.query(
    `INSERT INTO users (email, google_id, full_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, full_name, credits, plan_id, google_id, created_at`,
    [email, googleId, fullName || null]
  );
  const user = result.rows[0];

  await logCreditTransaction(user.id, user.credits, 'signup_bonus', user.credits);

  return user;
}

/**
 * Links a Google account to an existing email/password account — for
 * someone who signed up normally first, then later clicks "Continue with
 * Google" using the same email. After this, either sign-in method works.
 */
async function linkGoogleId(userId, googleId) {
  await db.query('UPDATE users SET google_id = $2 WHERE id = $1', [userId, googleId]);
}

async function deductCredits(userId, amount) {
  const result = await db.query(
    `UPDATE users SET credits = credits - $2
     WHERE id = $1 AND credits >= $2
     RETURNING credits`,
    [userId, amount]
  );
  const row = result.rows[0];
  if (!row) return null; // insufficient credits

  // Logged as a separate query after the atomic deduction above — not a
  // true multi-statement DB transaction (would need a checked-out client
  // rather than the plain pool.query() this project uses so far). For
  // credits (not real money), this is an acceptable simplification: worst
  // case is a missing ledger row if this second query fails, not a wrong
  // balance, since the balance itself was already correctly updated above.
  await logCreditTransaction(userId, -amount, 'tool_usage', row.credits);

  return row;
}

async function logCreditTransaction(userId, amount, reason, balanceAfter) {
  await db.query(
    `INSERT INTO credit_transactions (user_id, amount, reason, balance_after)
     VALUES ($1, $2, $3, $4)`,
    [userId, amount, reason, balanceAfter]
  );
}

async function getCreditHistory(userId, limit) {
  const result = await db.query(
    `SELECT amount, reason, balance_after, created_at
     FROM credit_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit || 50]
  );
  return result.rows;
}

module.exports = {
  findByEmail,
  findById,
  findByIdWithPlan,
  findByGoogleId,
  findByApiKey,
  generateApiKey,
  revokeApiKey,
  setPlan,
  create,
  createFromGoogle,
  linkGoogleId,
  deductCredits,
  logCreditTransaction,
  getCreditHistory
};