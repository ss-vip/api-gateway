// 集中 Schema 管理 + 自動遷移
// startup 時自動偵測 D1 結構，補上遺漏欄位

const CHANNELS_DDL = `CREATE TABLE IF NOT EXISTS channels (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL DEFAULT '',
  base_url          TEXT    NOT NULL DEFAULT '',
  api_key           TEXT    NOT NULL DEFAULT '',
  model             TEXT    NOT NULL DEFAULT '',
  weight            INTEGER NOT NULL DEFAULT 50,
  is_enabled        INTEGER NOT NULL DEFAULT 1,
  is_vision         INTEGER NOT NULL DEFAULT 0,
  last_429          INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_error_msg    TEXT    NOT NULL DEFAULT '',
  last_error_at     INTEGER NOT NULL DEFAULT 0,
  rpm_limit         INTEGER NOT NULL DEFAULT 0,
  rpd_limit         INTEGER NOT NULL DEFAULT 0,
  rpm_count         INTEGER NOT NULL DEFAULT 0,
  rpm_reset_at      INTEGER NOT NULL DEFAULT 0,
  rpd_count         INTEGER NOT NULL DEFAULT 0,
  rpd_reset_at      INTEGER NOT NULL DEFAULT 0,
  max_tokens        INTEGER NOT NULL DEFAULT 0,
  support_tools     INTEGER NOT NULL DEFAULT 1,
  support_stream    INTEGER NOT NULL DEFAULT 1,
  support_image_gen  INTEGER NOT NULL DEFAULT 0,
  support_audio_tts  INTEGER NOT NULL DEFAULT 0,
  support_audio_stt  INTEGER NOT NULL DEFAULT 0,
  support_image_edit INTEGER NOT NULL DEFAULT 0,
  response_time     INTEGER NOT NULL DEFAULT 0,
  fallback_model    TEXT    NOT NULL DEFAULT '',
  headers           TEXT,
  provider_options  TEXT,
  provider          TEXT    NOT NULL DEFAULT '',
  absolute_url      INTEGER NOT NULL DEFAULT 0,
  cooldown_until    INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
)`;

const FILTERS_DDL = `CREATE TABLE IF NOT EXISTS filters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT    NOT NULL,
  mode        INTEGER NOT NULL DEFAULT 1,
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
)`;

const CONFIG_DDL = `CREATE TABLE IF NOT EXISTS config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  client_token    TEXT    NOT NULL DEFAULT '',
  admin_password  TEXT    NOT NULL DEFAULT '',
  recovery_period INTEGER NOT NULL DEFAULT 300,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
)`;

const REQUEST_LOGS_DDL = `CREATE TABLE IF NOT EXISTS request_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER NOT NULL DEFAULT 0,
  model       TEXT    NOT NULL DEFAULT '',
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status      INTEGER NOT NULL DEFAULT 0,
  error_msg   TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
)`;

// 注意：ALTER TABLE 僅能 ADD COLUMN，無法修改或刪除現有欄位。

const TABLES = [
  {
    name: "channels",
    ddl: CHANNELS_DDL,
    migrationCols: [
      "support_tools INTEGER NOT NULL DEFAULT 1",
      "support_stream INTEGER NOT NULL DEFAULT 1",
      "support_image_gen INTEGER NOT NULL DEFAULT 0",
      "support_audio_tts INTEGER NOT NULL DEFAULT 0",
      "support_audio_stt INTEGER NOT NULL DEFAULT 0",
      "support_image_edit INTEGER NOT NULL DEFAULT 0",
      "response_time INTEGER NOT NULL DEFAULT 0",
      "fallback_model TEXT NOT NULL DEFAULT ''",
      "headers TEXT",
      "provider_options TEXT",
      "provider TEXT NOT NULL DEFAULT ''",
      "absolute_url INTEGER NOT NULL DEFAULT 0",
      "cooldown_until INTEGER NOT NULL DEFAULT 0",
    ],
  },
  {
    name: "filters",
    ddl: FILTERS_DDL,
    migrationCols: [],
  },
  {
    name: "config",
    ddl: CONFIG_DDL,
    migrationCols: [],
  },
  {
    name: "request_logs",
    ddl: REQUEST_LOGS_DDL,
    migrationCols: [],
  },
];

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at)",
];

/** startup 自動建表 + 補欄位 + 建 index，回傳 { added, indexes } */
export async function ensureSchema(env) {
  let totalAdded = 0;
  let totalIndexes = 0;

  for (const table of TABLES) {
    try {
      await env.DB.prepare(table.ddl).run();
    } catch (e) {
      console.error(`[schema] failed to create table ${table.name}:`, e.message);
      continue;
    }

    let existing = null;
    try {
      const { results } = await env.DB.prepare(`PRAGMA table_info('${table.name}')`).all();
      existing = new Set((results || []).map(r => r.name).filter(Boolean));
    } catch (e) {
      console.error(`[schema] PRAGMA failed for ${table.name}:`, e.message);
    }

    if (existing && table.migrationCols.length > 0) {
      for (const colDef of table.migrationCols) {
        const colName = colDef.split(" ")[0];
        if (!existing.has(colName)) {
          try {
            await env.DB.prepare(`ALTER TABLE ${table.name} ADD COLUMN ${colDef}`).run();
            totalAdded++;
            console.log(`[schema] migrated: ${table.name}.${colName}`);
          } catch (e) {
            console.error(`[schema] failed to add ${table.name}.${colName}:`, e.message);
          }
        }
      }
    }
  }

  for (const idxSql of INDEXES) {
    try {
      await env.DB.prepare(idxSql).run();
      totalIndexes++;
    } catch (e) {
      console.error(`[schema] failed to create index:`, e.message);
    }
  }

  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO config (id, client_token, admin_password, recovery_period) VALUES (1, '', '', 300)"
    ).run();
  } catch (e) {
    console.error("[schema] failed to ensure config row:", e.message);
  }

  if (totalAdded > 0 || totalIndexes > 0) console.log(`[schema] migration complete: ${totalAdded} col(s), ${totalIndexes} index(es)`);
  return { added: totalAdded, indexes: totalIndexes };
}
