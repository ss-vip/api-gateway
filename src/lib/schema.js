import { generateToken } from "./db.js";

let schemaReady = false;

const CHANNELS_DDL = `CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL DEFAULT '',
  base_url    TEXT    NOT NULL DEFAULT '',
  api_key     TEXT    NOT NULL DEFAULT '',
  model       TEXT    NOT NULL DEFAULT '',
  weight      INTEGER NOT NULL DEFAULT 50,
  is_enabled  INTEGER NOT NULL DEFAULT 1
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
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
)`;

const ALL_DDLS = [CHANNELS_DDL, FILTERS_DDL, CONFIG_DDL];
const ALL_TABLES = ["channels", "filters", "config"];

export async function ensureSchema(env) {
  if (schemaReady) return;
  let ok = 0;

  for (let i = 0; i < ALL_DDLS.length; i++) {
    try {
      await env.DB.prepare(ALL_DDLS[i]).run();
      ok++;
    } catch (e) {
      console.error(`[schema] failed to create table ${ALL_TABLES[i]}:`, e.message);
    }
  }

  // 確保 config row 存在並產生 client_token
  try {
    const cf = await env.DB.prepare("SELECT client_token FROM config WHERE id=1").first();
    if (!cf) {
      const token = generateToken();
      await env.DB.prepare(
        "INSERT INTO config (id, client_token, admin_password) VALUES (1, ?, '')"
      ).bind(token).run();
    } else if (!cf.client_token) {
      const token = generateToken();
      await env.DB.prepare("UPDATE config SET client_token=? WHERE id=1").bind(token).run();
    }
  } catch (e) {
    console.error("[schema] failed to ensure config row:", e.message);
  }

  if (ok > 0) console.log(`[schema] ${ok}/${ALL_DDLS.length} tables ready`);
  schemaReady = true;
}
