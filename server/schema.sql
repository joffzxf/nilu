PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE NOT NULL,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_states (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  return_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

/* 一个用户的一生。结束时只标记 ended；一生只有一次，不能复活。 */
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'alive',
  birth_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  last_settled_at INTEGER NOT NULL,
  age_seconds REAL NOT NULL DEFAULT 0,
  day REAL NOT NULL DEFAULT 0,
  slope REAL NOT NULL DEFAULT 0,
  height REAL NOT NULL DEFAULT 0,
  area REAL NOT NULL DEFAULT 0,
  efforts INTEGER NOT NULL DEFAULT 0,
  seed INTEGER NOT NULL,
  engine_version TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

/* 一个登录用户同一时间只能有一个还活着的一生 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_one_alive
  ON accounts(user_id) WHERE status = 'alive';
CREATE INDEX IF NOT EXISTS idx_accounts_user_created
  ON accounts(user_id, created_at DESC);

/* 预留：今后的玩法都可以写成一条事件，不改主表 */
CREATE TABLE IF NOT EXISTS account_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  at_age REAL NOT NULL,
  at_ms INTEGER NOT NULL,
  slope_after REAL,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_account_age
  ON account_events(account_id, at_age);

/* 一次“努力”的待办：答案在服务器，客户端只负责敲 */
CREATE TABLE IF NOT EXISTS efforts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  keys_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_efforts_account_created
  ON efforts(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_efforts_user_created
  ON efforts(user_id, created_at DESC);
