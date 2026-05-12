-- ============================================================
-- API Gateway Database Schema
-- 支援 Circuit Breaker, Rate Limiting, Content Filtering
-- ============================================================

-- Channels: upstream API 渠道設定與健康狀態
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'openai',
  model TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 1,
  rpm_limit INTEGER NOT NULL DEFAULT 0,
  rpd_limit INTEGER NOT NULL DEFAULT 0,
  rpm_count INTEGER NOT NULL DEFAULT 0,
  rpm_reset_at INTEGER NOT NULL DEFAULT 0,
  rpd_count INTEGER NOT NULL DEFAULT 0,
  rpd_reset_at INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  is_vision INTEGER NOT NULL DEFAULT 0,
  last_429 INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_error_at INTEGER NOT NULL DEFAULT 0,
  last_error_msg TEXT NOT NULL DEFAULT '',
  max_tokens INTEGER NOT NULL DEFAULT 0,
  support_tools INTEGER NOT NULL DEFAULT 1,
  response_time INTEGER NOT NULL DEFAULT 0,
  fallback_model TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Filters: 串流/非串流內容過濾規則
CREATE TABLE IF NOT EXISTS filters (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  mode INTEGER NOT NULL DEFAULT 1,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Config: 系統全域設定（單列模式）
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY,
  client_token TEXT NOT NULL DEFAULT '',
  admin_password TEXT NOT NULL DEFAULT '',
  recovery_period INTEGER NOT NULL DEFAULT 300,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ============================================================
-- Indexes (查詢效能優化)
-- ============================================================

-- 渠道啟用 + 模型 (selectChannel 常用過濾條件)
CREATE INDEX IF NOT EXISTS idx_channels_enabled_model ON channels(is_enabled, model);
-- 渠道啟用 + 視覺 (hasImage 過濾)
CREATE INDEX IF NOT EXISTS idx_channels_enabled_vision ON channels(is_enabled, is_vision);
-- 渠道 ID 快速查詢
CREATE INDEX IF NOT EXISTS idx_channels_id ON channels(id);
-- 過濾器啟用狀態
CREATE INDEX IF NOT EXISTS idx_filters_enabled ON filters(is_enabled);
