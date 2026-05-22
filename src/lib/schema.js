// 集中 Schema 管理 + 全自動遷移
// startup 時自動偵測 D1 結構：
//   - 缺 table → CREATE TABLE
//   - 缺 column → ALTER TABLE ADD COLUMN
//   - 型別不符 → log 警告（SQLite 不支援 ALTER COLUMN）
//   - 多餘 column → log 通知（非錯誤，可能是舊版遺留）
// 參考: DDL 定義在 git 中即為唯一真相來源

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
  response_time     INTEGER NOT NULL DEFAULT 0,
  fallback_model    TEXT    NOT NULL DEFAULT '',
  headers           TEXT,
  provider_options  TEXT,
  provider          TEXT    NOT NULL DEFAULT '',
  absolute_url      INTEGER NOT NULL DEFAULT 0,
  channel_type      TEXT    NOT NULL DEFAULT 'chat',
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

const CHANNEL_TYPES = new Set(["chat", "image_gen", "image_edit", "audio_tts", "audio_stt", "embeddings"]);

const TABLES = [
  {
    name: "channels",
    ddl: CHANNELS_DDL,
    migrationCols: [
      "support_tools INTEGER NOT NULL DEFAULT 1",
      "support_stream INTEGER NOT NULL DEFAULT 1",
      "response_time INTEGER NOT NULL DEFAULT 0",
      "fallback_model TEXT NOT NULL DEFAULT ''",
      "headers TEXT",
      "provider_options TEXT",
      "provider TEXT NOT NULL DEFAULT ''",
      "absolute_url INTEGER NOT NULL DEFAULT 0",
      "channel_type TEXT NOT NULL DEFAULT 'chat'",
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

/** 從 DDL 字串中解析出 { colName, colType } 的 Map */
function parseDDLColumns(ddl) {
  const cols = new Map();
  const lines = ddl.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("CREATE") || trimmed.startsWith(")") || trimmed.startsWith("(")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[0];
    if (["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT", "INDEX", ")"].includes(name.toUpperCase())) continue;
    const colType = parts[1].replace(/,+$/, "").toUpperCase();
    cols.set(name, colType);
  }
  return cols;
}

const EXPECTED_COLS = {
  channels: parseDDLColumns(CHANNELS_DDL),
  filters: parseDDLColumns(FILTERS_DDL),
  config: parseDDLColumns(CONFIG_DDL),
  request_logs: parseDDLColumns(REQUEST_LOGS_DDL),
};

/** startup 全自動 migration：建表 → 補欄位 → 建索引 → 型別警告 */
export async function ensureSchema(env) {
  let totalAdded = 0;
  let totalIndexes = 0;
  const warnings = [];

  for (const table of TABLES) {
    try {
      await env.DB.prepare(table.ddl).run();
    } catch (e) {
      console.error(`[schema] failed to create table ${table.name}:`, e.message);
      continue;
    }

    let columns = [];
    try {
      const { results } = await env.DB.prepare(`PRAGMA table_info('${table.name}')`).all();
      columns = (results || []).filter(r => r.name);
    } catch (e) {
      console.error(`[schema] PRAGMA failed for ${table.name}:`, e.message);
      continue;
    }

    const existingCols = new Set(columns.map(r => r.name));
    const existingTypes = new Map(columns.map(r => [r.name, (r.type || "").toUpperCase()]));
    const expected = EXPECTED_COLS[table.name];

    if (table.migrationCols.length > 0) {
      for (const colDef of table.migrationCols) {
        const colName = colDef.split(" ")[0];
        if (!existingCols.has(colName)) {
          try {
            await env.DB.prepare(`ALTER TABLE ${table.name} ADD COLUMN ${colDef}`).run();
            totalAdded++;
            console.log(`[schema] added: ${table.name}.${colName}`);
          } catch (e) {
            console.error(`[schema] failed to add ${table.name}.${colName}:`, e.message);
          }
        }
      }
    }

    if (expected) {
      for (const [name, expectedType] of expected) {
        const actualType = existingTypes.get(name);
        if (actualType && actualType !== expectedType) {
          warnings.push(
            `[schema] ${table.name}.${name}: type mismatch (expected ${expectedType}, actual ${actualType})`
          );
        }
      }
      for (const name of existingCols) {
        if (!expected.has(name) && !["id", "created_at", "updated_at"].includes(name)) {
          console.log(`[schema] ${table.name}.${name}: extra column (not in DDL, may be legacy)`);
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

  if (totalAdded > 0 || totalIndexes > 0) console.log(`[schema] auto-migration: ${totalAdded} col(s), ${totalIndexes} index(es)`);
  for (const w of warnings) console.warn(w);

  return { added: totalAdded, indexes: totalIndexes, warnings };
}

export { CHANNEL_TYPES };
