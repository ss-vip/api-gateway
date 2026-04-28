CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    api_key TEXT,
    base_url TEXT,
    model_name TEXT,
    weight INTEGER DEFAULT 1,
    last_429 INTEGER DEFAULT 0,
    is_enabled INTEGER DEFAULT 1,
    is_vision INTEGER DEFAULT 0,
    rpm INTEGER DEFAULT 0,
    rpd INTEGER DEFAULT 0,
    rpm_count INTEGER DEFAULT 0,
    rpd_count INTEGER DEFAULT 0,
    last_rpm_reset INTEGER DEFAULT 0,
    last_rpd_reset INTEGER DEFAULT 0,
    consecutive_errors INTEGER DEFAULT 0,
    last_error_msg TEXT
);

CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_name TEXT,
    model TEXT,
    prompt TEXT,
    request_body TEXT,
    target_url TEXT,
    response_status INTEGER,
    response_body TEXT,
    error_msg TEXT,
    latency_ms INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS filters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT UNIQUE,
    mode INTEGER DEFAULT 0,
    is_enabled INTEGER DEFAULT 1
);

INSERT OR IGNORE INTO config (key, value) VALUES ('client_bearer_token', 'sk-test123456');
INSERT OR IGNORE INTO config (key, value) VALUES ('cooldown_time', '300');


CREATE TRIGGER IF NOT EXISTS clean_logs AFTER INSERT ON logs
BEGIN
    DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 50);
END;
