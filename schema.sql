CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  base_url TEXT,
  api_key TEXT,
  provider TEXT DEFAULT 'openai', -- openai | anthropic
  model TEXT,
  model_name TEXT,
  weight INTEGER DEFAULT 1,
  rpm_limit INTEGER DEFAULT 0,
  rpd_limit INTEGER DEFAULT 0,
  tpm_limit INTEGER DEFAULT 0,
  tpd_limit INTEGER DEFAULT 0,
  rpm_count INTEGER DEFAULT 0,
  rpm_reset_at INTEGER DEFAULT 0,
  rpd_count INTEGER DEFAULT 0,
  rpd_reset_at INTEGER DEFAULT 0,
  is_enabled INTEGER DEFAULT 1,
  is_vision INTEGER DEFAULT 0,
  last_429 INTEGER DEFAULT 0,
  consecutive_errors INTEGER DEFAULT 0,
  last_error_at INTEGER DEFAULT 0,
  last_error_msg TEXT
);

CREATE TABLE IF NOT EXISTS filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  mode INTEGER DEFAULT 1, -- 1: truncate, 0: delete
  is_enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY,
  client_token TEXT,
  admin_password TEXT,
  cooldown_time INTEGER DEFAULT 300
);