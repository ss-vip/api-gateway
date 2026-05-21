// ─── 集中 Schema 管理 + 自動遷移 ─────────────────────────────────
//
// 設計原則:
// 1. 所有 table/column 定義集中在這裡
// 2. Worker startup 時自動偵測 DB 結構，補上遺漏欄位
// 3. 避免 SELECT/UPDATE 因欄位不存在而噴錯
// 4. 每個操作獨立 try-catch，單一失敗不中斷整體流程

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

// ─── Migration 定義 ─────────────────────────────────────────────
//
// 各 table 的「可能遺漏欄位」清單。
// 當 DB 為舊 schema 時，逐欄執行 ALTER TABLE ADD COLUMN。
// 若欄位已存在，PRAGMA 檢查會跳過。
//
// KEY  = table 名稱（也是 PRAGMA 的參數）
// COLS = [ "col_name type constraints", ... ]
//
// 注意：ALIER TABLE 僅能 ADD COLUMN，無法修改或刪除現有欄位。

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
    // 未來若 filters 新增欄位，在此加入即可
  },
  {
    name: "config",
    ddl: CONFIG_DDL,
    migrationCols: [],
    // 未來若 config 新增欄位，在此加入即可
  },
];

/**
 * 啟動時執行 schema 檢查與自動遷移。
 * - 建立 table（若不存在）
 * - 逐一檢查各 table 並補上遺漏欄位
 * - 確保 config row 存在
 *
 * 回傳 { added: number } 本次新增的欄位總數。
 */
export async function ensureSchema(env) {
  let totalAdded = 0;

  for (const table of TABLES) {
    // 1. 建立 table（IF NOT EXISTS，已存在則跳過）
    try {
      await env.DB.prepare(table.ddl).run();
    } catch (e) {
      console.error(`[schema] failed to create table ${table.name}:`, e.message);
      continue; // 無法建立 table → 跳過此 table 的所有 migration
    }

    // 2. 查詢現有欄位 — 若失敗則設為 null 表示未知
    let existing = null;
    try {
      const { results } = await env.DB.prepare(`PRAGMA table_info('${table.name}')`).all();
      existing = new Set((results || []).map(r => r.name).filter(Boolean));
    } catch (e) {
      console.error(`[schema] PRAGMA failed for ${table.name}, skip column migration:`, e.message);
      // existing 維持 null，不會誤跑 ALTER
    }

    // 3. 逐一補上遺漏欄位（僅當 PRAGMA 成功時）
    if (existing && table.migrationCols.length > 0) {
      for (const colDef of table.migrationCols) {
        const colName = colDef.split(" ")[0];
        if (!existing.has(colName)) {
          try {
            await env.DB.prepare(`ALTER TABLE ${table.name} ADD COLUMN ${colDef}`).run();
            totalAdded++;
            console.log(`[schema] migrated: ${table.name}.${colName}`);
          } catch (e) {
            // 可能因併發 race condition 或其他原因失敗，記錄但不中斷
            console.error(`[schema] failed to add ${table.name}.${colName}:`, e.message);
          }
        }
      }
    }
  }

  // 4. 確保 config row 存在
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO config (id, client_token, admin_password, recovery_period) VALUES (1, '', '', 300)"
    ).run();
  } catch (e) {
    console.error("[schema] failed to ensure config row:", e.message);
    // 不中斷 startup，config 可在首次使用時 lazy 初始化
  }

  if (totalAdded > 0) console.log(`[schema] migration complete: ${totalAdded} column(s) added`);
  return { added: totalAdded };
}
