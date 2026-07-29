/**
 * Several external AI APIs (Replicate, Apify, etc.) require a publicly
 * reachable image URL as input — they can't accept raw uploaded bytes
 * directly. This stages an upload at a short-lived URL on our own server
 * so those APIs can fetch it, then the caller deletes it once done.
 *
 * NOTE: this only works once this server is actually publicly deployed.
 * On localhost, external services cannot reach these URLs at all.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEMP_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

function stageFile(buffer, mimetype) {
  const ext = (mimetype.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const id = `${crypto.randomUUID()}.${ext}`;
  const filePath = path.join(TEMP_DIR, id);
  fs.writeFileSync(filePath, buffer);
  return { id, filePath };
}

function getPublicBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function cleanup(filePath) {
  return fs.promises.unlink(filePath).catch(() => {}); // best-effort, ignore errors
}

module.exports = { stageFile, getPublicBaseUrl, cleanup, TEMP_DIR };
