const db = require('../../config/db');

async function createJob(userId, tool, inputUrl) {
  const result = await db.query(
    `INSERT INTO ai_usage (user_id, tool, status, input_url, credits_used)
     VALUES ($1, $2, 'processing', $3, 0)
     RETURNING *`,
    [userId, tool, inputUrl]
  );
  return result.rows[0];
}

async function markJobCompleted(jobId, outputUrl, creditsUsed) {
  const result = await db.query(
    `UPDATE ai_usage
     SET status = 'completed', output_url = $2, credits_used = $3,
         updated_at = NOW(), completed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [jobId, outputUrl, creditsUsed]
  );
  return result.rows[0];
}

async function markJobFailed(jobId, errorMessage) {
  const result = await db.query(
    `UPDATE ai_usage
     SET status = 'failed', error_message = $2, updated_at = NOW(), completed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [jobId, errorMessage]
  );
  return result.rows[0];
}

async function findJobById(jobId, userId) {
  const result = await db.query(
    'SELECT * FROM ai_usage WHERE id = $1 AND user_id = $2',
    [jobId, userId]
  );
  return result.rows[0] || null;
}

async function getHistory(userId, limit) {
  const result = await db.query(
    `SELECT id, tool, status, input_url, output_url, credits_used, error_message, created_at, completed_at
     FROM ai_usage
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit || 50]
  );
  return result.rows;
}

async function findStaleProcessingJobs(timeoutMinutes) {
  const result = await db.query(
    `SELECT id FROM ai_usage
     WHERE status = 'processing'
       AND created_at < NOW() - INTERVAL '1 minute' * $1`,
    [timeoutMinutes]
  );
  return result.rows;
}

module.exports = { createJob, markJobCompleted, markJobFailed, findJobById, findStaleProcessingJobs, getHistory };