-- cf-lite auth: users, linked OAuth accounts, D1-backed sessions (used by d1Store). Apply with: wrangler d1 migrations apply <db>
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT COLLATE NOCASE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  image TEXT,
  created_at INTEGER NOT NULL
);
-- Email is NOT unique on purpose: two IdPs may report the same address without proving ownership; linking is explicit (see d1Accounts).
CREATE INDEX IF NOT EXISTS users_email ON users(email);

CREATE TABLE IF NOT EXISTS accounts (
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_account_id)
);
CREATE INDEX IF NOT EXISTS accounts_user ON accounts(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,            -- SHA-256 of the cookie id, never the cookie itself
  user_id TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_exp ON sessions(expires_at);
