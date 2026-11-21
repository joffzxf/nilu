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

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seed INTEGER NOT NULL,
  duration_ticks INTEGER NOT NULL,
  engine_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_challenges_user_created ON challenges(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  challenge_id TEXT UNIQUE NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  area REAL NOT NULL,
  max_slope REAL NOT NULL,
  successes INTEGER NOT NULL,
  misses INTEGER NOT NULL,
  max_combo INTEGER NOT NULL,
  duration_ticks INTEGER NOT NULL,
  engine_version TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  curve_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_user_score ON runs(user_id, score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_runs_score ON runs(score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
