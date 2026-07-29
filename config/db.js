/**
 * PostgreSQL connection pool.
 * Fill in DATABASE_URL in your .env once you've provisioned a Postgres
 * instance (e.g. Render, Railway, Supabase, or Neon all offer free tiers).
 */
const { Pool } = require('pg');

// SSL is required by virtually every hosted cloud Postgres (Supabase, Neon,
// Render, Railway, etc.) regardless of dev/prod — gating this on NODE_ENV
// was a real bug: with NODE_ENV=development (our own .env.example default),
// SSL was being disabled even when connecting to a cloud database that
// requires it, causing every query to fail with a generic connection error.
// Only skip SSL for an actual local Postgres install (localhost/127.0.0.1).
const connectionString = process.env.DATABASE_URL || '';
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error:', err);
});

module.exports = pool;