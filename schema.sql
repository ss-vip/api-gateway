CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  name TEXT,
  base_url TEXT,
  api_key TEXT,
  provider TEXT DEFAULT 'openai',
  model TEXT,
  weight INTEGER DEFAULT 1,
  rpm_limit INTEGER DEFAULT 0,
  rpd_limit INTEGER DEFAULT 0,
  rpm_count INTEGER DEFAULT 0,
  rpm_reset_at INTEGER DEFAULT 0,
  rpd_count INTEGER DEFAULT 0,
  rpd_reset_at INTEGER DEFAULT 0,
  is_enabled INTEGER DEFAULT 1,
  is_vision INTEGER DEFAULT 0,
  last_429 INTEGER DEFAULT 0,
  consecutive_errors INTEGER DEFAULT 0,
  last_error_at INTEGER DEFAULT 0,
  last_error_msg TEXT,
  max_tokens INTEGER DEFAULT 0,
  support_tools INTEGER DEFAULT 1,
  response_time INTEGER DEFAULT 0,
  fallback_model TEXT
);

CREATE TABLE IF NOT EXISTS filters (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  mode INTEGER DEFAULT 1,
  is_enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY,
  client_token TEXT,
  admin_password TEXT,
  recovery_period INTEGER DEFAULT 300
);

CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels(is_enabled);
CREATE INDEX IF NOT EXISTS idx_channels_id ON channels(id);
CREATE INDEX IF NOT EXISTS idx_filters_enabled ON filters(is_enabled);