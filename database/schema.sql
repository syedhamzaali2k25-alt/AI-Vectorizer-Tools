-- Run this against your Supabase/Postgres database (SQL Editor, or psql).
-- Replaces the earlier flat schema with a properly normalized one:
--   users            — core account info only
--   plans            — lookup table (free/pro/business), not hardcoded in app code
--   credit_transactions — full ledger of every credit grant/use (audit trail,
--                          also what the future Dashboard's "history" will read from)
--   ai_usage         — one row per tool call (was called "jobs" before)
--   stripe_data      — kept separate from users, so users isn't cluttered with
--                       nullable Stripe-specific columns

CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,       -- 'free' | 'pro' | 'business'
  monthly_credits INTEGER NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO plans (name, monthly_credits, price_cents) VALUES
  ('free', 3, 0),
  ('pro', 500, 1900),
  ('business', 3000, 7900)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255),
  plan_id INTEGER NOT NULL REFERENCES plans(id) DEFAULT 1, -- 1 = 'free'
  credits INTEGER NOT NULL DEFAULT 3,    -- current balance; kept on users
                                           -- itself so deduction stays a
                                           -- single atomic UPDATE, not a
                                           -- SUM() over the ledger every time
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,                -- positive = granted, negative = spent
  reason VARCHAR(100) NOT NULL,           -- 'signup_bonus' | 'tool_usage' | 'plan_renewal' | 'stripe_purchase'
  balance_after INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  tool VARCHAR(50) NOT NULL,              -- 'bg-remove' | 'upscale' | 'watermark-remove' | 'expand' | ...
  status VARCHAR(50) NOT NULL DEFAULT 'completed',
  input_url TEXT,
  output_url TEXT,
  credits_used INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stripe_data (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  subscription_status VARCHAR(50),        -- 'active' | 'canceled' | 'past_due' | ...
  current_period_end TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_id ON ai_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_tx_user_id ON credit_transactions(user_id);