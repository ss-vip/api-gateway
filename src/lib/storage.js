import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

function generateToken() {
  const bytes = randomBytes(15);
  return "sk-" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

const DEFAULT_CONFIG = {
  id: 1,
  client_token: generateToken(),
  admin_password: "",
  recovery_period: 300,
  created_at: 0,
  updated_at: 0,
};

const isNode = typeof process !== "undefined";

export class JsonDB {
  constructor(seed, filePath) {
    this._filePath = isNode ? (filePath || "./data/db.json") : null;
    this._saveTimer = null;
    this._dirty = false;
    this._load(seed);
  }

  _load(seed) {
    let loaded = null;

    if (this._filePath && existsSync(this._filePath)) {
      try {
        const content = readFileSync(this._filePath, "utf-8");
        loaded = JSON.parse(content);
      } catch (e) {
        console.error("[JsonDB] load failed:", e.message);
      }
    }

    const raw = loaded || (typeof seed === "string" ? this._tryParse(seed) : seed) || {};
    this.data = {
      channels: Array.isArray(raw.channels) ? raw.channels.map((c) => ({ ...c })) : [],
      filters: Array.isArray(raw.filters) ? raw.filters.map((f) => ({ ...f })) : [],
      config: raw.config && raw.config.id ? { ...DEFAULT_CONFIG, ...raw.config } : { ...DEFAULT_CONFIG },
    };
    this._nextId = {
      channel: Math.max(0, ...this.data.channels.map((c) => c.id || 0)) + 1,
      filter: Math.max(0, ...this.data.filters.map((f) => f.id || 0)) + 1,
    };
    this._dirty = false;
    this._startAutoSave();
  }

  _markDirty() {
    if (!this._filePath) return;
    this._dirty = true;
    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => this._flush(), 2000);
      if (this._saveTimer && typeof this._saveTimer.unref === "function") this._saveTimer.unref();
    }
  }

  _flush() {
    this._saveTimer = null;
    if (!this._dirty || !this._filePath) return;
    this._dirty = false;
    try {
      const dir = dirname(this._filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmpPath = this._filePath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), "utf-8");
      renameSync(tmpPath, this._filePath);
    } catch (e) {
      console.error("[JsonDB] save failed:", e.message);
    }
  }

  save() { this._dirty = true; this._flush(); }

  _startAutoSave() {
    if (!this._filePath) return;
    const timer = setInterval(() => { if (this._dirty) this._flush(); }, 60000);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  prepare(sql) {
    return new Statement(sql.trim(), this);
  }

  batch(statements) {
    const results = [];
    for (const stmt of statements) {
      results.push(this._execute(stmt));
    }
    return Promise.resolve(results);
  }

  toJSON() {
    return {
      channels: this.data.channels.map((c) => ({ ...c })),
      filters: this.data.filters.map((f) => ({ ...f })),
      config: { ...this.data.config },
    };
  }

  _tryParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  _execute(stmt) {
    const sql = stmt.sql;
    const params = stmt.args;
    const upper = sql.toUpperCase().trim();

    try {
      if (upper.includes("FROM CHANNELS") && !upper.includes("INSERT") && !upper.includes("DELETE")) {
        let rows = this.data.channels;

        if (upper.includes("WHERE ID IN")) {
          rows = rows.filter((r) => params.includes(r.id));
        }
        if (upper.includes("IS_ENABLED=1") || upper.includes("IS_ENABLED = 1")) {
          rows = rows.filter((r) => r.is_enabled === 1);
        }

        if (upper.includes("ORDER BY ID")) {
          rows = [...rows].sort((a, b) => (a.id || 0) - (b.id || 0));
        }

        return { results: rows };
      }

      if (upper.startsWith("DELETE FROM CHANNELS")) {
        this.data.channels = [];
        this._markDirty();
        return { success: true, meta: { changes: 1 } };
      }

      if (upper.startsWith("UPDATE CHANNELS")) {
        return this._updateChannels(sql, params);
      }

      if (upper.startsWith("INSERT INTO CHANNELS") || upper.includes("INTO CHANNELS")) {
        return this._insertChannels(sql, params);
      }

      if (upper.includes("FROM FILTERS") && !upper.includes("INSERT") && !upper.includes("DELETE")) {
        let rows = this.data.filters;
        if (upper.includes("IS_ENABLED=1")) {
          rows = rows.filter((r) => r.is_enabled === 1);
        }
        if (upper.includes("ORDER BY ID")) {
          rows = [...rows].sort((a, b) => (a.id || 0) - (b.id || 0));
        }
        return { results: rows };
      }

      if (upper.startsWith("DELETE FROM FILTERS")) {
        this.data.filters = [];
        this._markDirty();
        return { success: true, meta: { changes: 1 } };
      }

      if (upper.startsWith("INSERT INTO FILTERS") || upper.includes("INTO FILTERS")) {
        return this._insertFilters(sql, params);
      }

      if (upper.includes("FROM CONFIG")) {
        if (this.data.config && this.data.config.id) {
          return { results: [this.data.config], ...this.data.config };
        }
        return { results: [], ...DEFAULT_CONFIG };
      }

      if ((upper.startsWith("INSERT") || upper.includes("REPLACE")) && upper.includes("CONFIG")) {
        return this._upsertConfig(sql, params);
      }

      if (upper.startsWith("UPDATE CONFIG")) {
        return this._updateConfig(sql, params);
      }

      throw new Error("Unsupported SQL: " + sql.slice(0, 80));
    } catch (e) {
      if (e.message.startsWith("Unsupported SQL")) throw e;
      throw new Error("JsonDB exec error: " + e.message + " | SQL: " + sql.slice(0, 80));
    }
  }

  _updateChannels(sql, params) {
    const lower = sql.toLowerCase();
    const hasWhere = sql.toUpperCase().includes("WHERE ID=") || sql.toUpperCase().includes("WHERE ID =");
    const rows = hasWhere
      ? this.data.channels.filter((c) => {
          const idIdx = params.length - 1;
          const idParam = params[idIdx];
          return String(c.id) === String(idParam);
        })
      : this.data.channels;

    if (rows.length === 0) return { success: true, meta: { changes: 0 } };

    for (const row of rows) {
      if (lower.includes("rpm_count=")) {
        row.rpm_count = params[0];
        row.rpm_reset_at = params[1];
        row.rpd_count = params[2];
        row.rpd_reset_at = params[3];
      } else if (lower.includes("last_429=0")) {
        row.last_429 = 0;
        row.consecutive_errors = 0;
        row.last_error_msg = "";
        row.last_error_at = 0;
      } else if (lower.includes("consecutive_errors=")) {
        row.consecutive_errors = params[0];
        row.last_error_msg = params[1] || "";
        row.last_error_at = params[2] || 0;
        row.response_time = params[3] || 0;
        if (params.length >= 5) row.last_429 = params[4] || 0;
      }
      row.updated_at = Math.floor(Date.now() / 1000);
    }

    this._markDirty();
    return { success: true, meta: { changes: rows.length } };
  }

  _insertChannels(sql, params) {
    const id = params[0] !== null && params[0] !== undefined ? params[0] : this._nextId.channel++;
    let headers = null;
    if (params[18] !== undefined && params[18] !== null) {
      try { headers = typeof params[18] === "string" ? JSON.parse(params[18]) : params[18]; } catch { headers = {}; }
    }
    let providerOptions = null;
    if (params[19] !== undefined && params[19] !== null) {
      try { providerOptions = typeof params[19] === "string" ? JSON.parse(params[19]) : params[19]; } catch { providerOptions = {}; }
    }
    const providerOverride = params[20] !== undefined ? params[20] : "";
    const ch = {
      id,
      name: params[1] || "",
      base_url: params[2] || "",
      api_key: params[3] || "",
      model: params[4] || "",
      weight: params[5] || 1,
      is_enabled: params[6] !== undefined ? params[6] : 1,
      is_vision: params[7] || 0,
      last_429: params[8] || 0,
      consecutive_errors: params[9] || 0,
      last_error_msg: params[10] || "",
      last_error_at: params[11] || 0,
      rpm_limit: params[12] || 0,
      rpd_limit: params[13] || 0,
      max_tokens: params[14] || 0,
      support_tools: params[15] !== undefined ? params[15] : 1,
      response_time: params[16] || 0,
      fallback_model: params[17] || "",
      headers,
      provider_options: providerOptions,
      provider: providerOverride,
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    };
    const existing = this.data.channels.findIndex((c) => c.id === id);
    if (existing >= 0) {
      this.data.channels[existing] = ch;
    } else {
      this.data.channels.push(ch);
    }
    if (id >= this._nextId.channel) this._nextId.channel = id + 1;
    this._markDirty();
    return { success: true, meta: { last_row_id: id, changes: 1 } };
  }

  _insertFilters(sql, params) {
    const id = this._nextId.filter++;
    this.data.filters.push({
      id,
      text: params[0] || "",
      mode: params[1] !== undefined ? params[1] : 1,
      is_enabled: params[2] !== undefined ? params[2] : 1,
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    });
    this._markDirty();
    return { success: true, meta: { last_row_id: id, changes: 1 } };
  }

  _upsertConfig(sql, params) {
    const cfg = this.data.config;
    cfg.id = 1;
    cfg.updated_at = Math.floor(Date.now() / 1000);

    if (params.length >= 1 && params[0] !== undefined && params[0] !== null) {
      const sqlLower = sql.toLowerCase();
      if (sqlLower.includes("admin_password")) {
        if (params.length === 1) {
          cfg.admin_password = params[0];
        } else if (params.length === 3) {
          cfg.client_token = params[0];
          cfg.admin_password = params[1] || "";
          cfg.recovery_period = parseInt(params[2]) || 300;
        } else if (params.length === 4) {
          cfg.admin_password = params[0];
        }
      } else if (sqlLower.includes("client_token")) {
        cfg.client_token = params[0];
        if (params.length >= 2) cfg.recovery_period = parseInt(params[1]) || 300;
      }
    }
    this._markDirty();
    return { success: true, meta: { changes: 1 } };
  }

  _updateConfig(sql, params) {
    const lower = sql.toLowerCase();
    const cfg = this.data.config;
    cfg.updated_at = Math.floor(Date.now() / 1000);

    if (lower.includes("admin_password")) {
      cfg.admin_password = params[0] || "";
    } else if (lower.includes("client_token")) {
      cfg.client_token = params[0] || generateToken();
      cfg.recovery_period = parseInt(params[1]) || 300;
    }
    this._markDirty();
    return { success: true, meta: { changes: 1 } };
  }
}

class Statement {
  constructor(sql, db) {
    this.sql = sql;
    this.db = db;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  all() {
    const result = this.db._execute(this);
    return Promise.resolve(result.results ? result : { results: [] });
  }

  first() {
    const result = this.db._execute(this);
    if (result.results && Array.isArray(result.results)) {
      return Promise.resolve(result.results[0] || null);
    }
    if (result.id !== undefined) {
      return Promise.resolve(result);
    }
    return Promise.resolve(null);
  }

  run() {
    const result = this.db._execute(this);
    return Promise.resolve({
      success: true,
      meta: result.meta || { changes: 0 },
    });
  }
}
