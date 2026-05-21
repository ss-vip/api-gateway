CREATE TABLE IF NOT EXISTS channels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL DEFAULT '',
  base_url      TEXT    NOT NULL DEFAULT '',
  api_key       TEXT    NOT NULL DEFAULT '',
  model         TEXT    NOT NULL DEFAULT '',
  weight        INTEGER NOT NULL DEFAULT 50,
  is_enabled    INTEGER NOT NULL DEFAULT 1,
  is_vision     INTEGER NOT NULL DEFAULT 0,
  last_429      INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_error_msg TEXT   NOT NULL DEFAULT '',
  last_error_at INTEGER NOT NULL DEFAULT 0,
  rpm_limit     INTEGER NOT NULL DEFAULT 0,
  rpd_limit     INTEGER NOT NULL DEFAULT 0,
  rpm_count     INTEGER NOT NULL DEFAULT 0,
  rpm_reset_at  INTEGER NOT NULL DEFAULT 0,
  rpd_count     INTEGER NOT NULL DEFAULT 0,
  rpd_reset_at  INTEGER NOT NULL DEFAULT 0,
  max_tokens    INTEGER NOT NULL DEFAULT 0,
  support_tools INTEGER NOT NULL DEFAULT 1,
  support_stream    INTEGER NOT NULL DEFAULT 1,
  support_image_gen INTEGER NOT NULL DEFAULT 0,
  support_audio_tts INTEGER NOT NULL DEFAULT 0,
  support_audio_stt INTEGER NOT NULL DEFAULT 0,
  support_image_edit INTEGER NOT NULL DEFAULT 0,
  response_time     INTEGER NOT NULL DEFAULT 0,
  fallback_model TEXT  NOT NULL DEFAULT '',
  headers       TEXT,
  provider_options TEXT,
  provider      TEXT  NOT NULL DEFAULT '',
  absolute_url  INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS filters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT    NOT NULL,
  mode        INTEGER NOT NULL DEFAULT 1,
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  client_token    TEXT    NOT NULL DEFAULT '',
  admin_password  TEXT    NOT NULL DEFAULT '',
  recovery_period INTEGER NOT NULL DEFAULT 300,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO config (id, client_token, admin_password, recovery_period)
VALUES (1, '', '', 300);

-- Migration for existing databases:
-- ALTER TABLE channels ADD COLUMN support_stream INTEGER NOT NULL DEFAULT 1;
-- ALTER TABLE channels ADD COLUMN support_image_gen INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE channels ADD COLUMN support_audio_tts INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE channels ADD COLUMN support_audio_stt INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE channels ADD COLUMN support_image_edit INTEGER NOT NULL DEFAULT 0;
