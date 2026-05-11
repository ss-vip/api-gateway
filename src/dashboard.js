import { Hono } from "hono";
import { html } from "hono/html";
import { timingSafeEqual } from "hono/utils/buffer";

export default function (clearCache) {
  const app = new Hono();

  // 預設配置
  const DEFAULTS = { token: "sk-test123456", delay_period: 300 };

  // 獲取管理員密碼 (從資料庫)
  const getAdminPass = async (c) => {
    try {
      const cf = await c.env.DB.prepare(
        "SELECT admin_password FROM config WHERE id=1",
      ).first();
      return cf?.admin_password || null;
    } catch (e) {
      return null;
    }
  };

  // 檢查是否已設定密碼
  const hasAdminPass = async (c) => {
    const pass = await getAdminPass(c);
    return pass !== null && pass !== "";
  };

  // 密碼哈希函數 (salt + SHA-256)
  const hashPassword = async (password) => {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltHex = Array.from(salt)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const data = encoder.encode(password + saltHex);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return (
      saltHex +
      ":" +
      hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
    );
  };

  // 密碼驗證函數
  const verifyPassword = async (password, storedHash) => {
    if (!storedHash || storedHash.length < 32) return false;
    const parts = storedHash.split(":");
    if (parts.length !== 2) return false;
    const saltHex = parts[0];
    const storedHashHex = parts[1];
    const encoder = new TextEncoder();
    const data = encoder.encode(password + saltHex);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const inputHashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return timingSafeEqual(inputHashHex, storedHashHex, (s) => s);
  };

  app.use("/admin/api/*", async (c, next) => {
    // 公開端點不需要認證
    const path = c.req.path;
    if (
      path === "/admin/api/auth-status" ||
      path === "/admin/api/config" ||
      path === "/admin/api/verify-token"
    ) {
      return await next();
    }
    const storedHash = await getAdminPass(c);
    // 若尚未設定密碼，允許設定密碼的 API
    if (!storedHash) {
      if (path === "/admin/api/admin-pass") {
        return await next();
      }
      return c.json({ error: "請先設定密碼" }, 403);
    }
    const inputToken = c.req.header("X-Admin-Token");
    if (!inputToken) return c.json({ error: "Unauthorized" }, 401);
    // 驗證 token (可能是原始密碼或哈希值)
    const isValid =
      (await verifyPassword(inputToken, storedHash)) ||
      inputToken === storedHash;
    if (!isValid) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  app.get("/admin/api", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM channels ORDER BY id",
    ).all();
    return c.json(results || []);
  });

  app.post("/admin/api/batch-channels", async (c) => {
    const channels = await c.req.json();
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM channels"),
      ...channels.map((ch) =>
        c.env.DB.prepare(
          `INSERT INTO channels (name, base_url, api_key, provider, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, tpm_limit, tpd_limit, max_tokens, support_tools, fallback_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          ch.name,
          ch.base_url || "",
          ch.api_key || "",
          ch.provider || "openai",
          ch.model || "",
          ch.weight || 1,
          ch.is_enabled ? 1 : 0,
          ch.is_vision ? 1 : 0,
          ch.last_429 || 0,
          ch.consecutive_errors || 0,
          ch.last_error_msg || "",
          ch.last_error_at || 0,
          ch.rpm_limit || 0,
          ch.rpd_limit || 0,
          ch.tpm_limit || 0,
          ch.tpd_limit || 0,
          ch.max_tokens || 0,
          ch.support_tools !== false ? 1 : 0,
          ch.fallback_model || "",
        ),
      ),
    ]);
    clearCache();
    return c.json({ ok: true });
  });

  app.post("/admin/api/channels/:id/reset-health", async (c) => {
    const id = c.req.param("id");
    await c.env.DB.prepare(
      "UPDATE channels SET last_429=0,consecutive_errors=0,last_error_msg='',last_error_at=0 WHERE id=?",
    )
      .bind(id)
      .run();
    clearCache();
    return c.json({ ok: true });
  });

  app.post("/admin/api/channels/reset-all-health", async (c) => {
    await c.env.DB.prepare(
      "UPDATE channels SET last_429=0,consecutive_errors=0,last_error_msg='',last_error_at=0",
    ).run();
    clearCache();
    return c.json({ ok: true });
  });

  app.get("/admin/api/filters", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM filters ORDER BY id",
    ).all();
    return c.json(results || []);
  });

  app.post("/admin/api/filters", async (c) => {
    const filters = await c.req.json();
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM filters"),
      ...filters.map((f) =>
        c.env.DB.prepare(
          `INSERT INTO filters (text, mode, is_enabled) VALUES (?, ?, ?)`,
        ).bind(f.text, f.mode || 1, f.is_enabled ? 1 : 0),
      ),
    ]);
    clearCache();
    return c.json({ ok: true });
  });

  app.get("/admin/api/config", async (c) => {
    const cf = await c.env.DB.prepare(
      "SELECT * FROM config WHERE id=1",
    ).first();
    return c.json({
      token: cf?.client_token || DEFAULTS.token,
      recovery_period: cf?.recovery_period || DEFAULTS.delay_period,
    });
  });

  // 檢查是否需要設定密碼
  app.get("/admin/api/auth-status", async (c) => {
    const hasPass = await hasAdminPass(c);
    return c.json({ needsSetup: !hasPass });
  });

  // 驗證 token（用於保持登入狀態）
  app.post("/admin/api/verify-token", async (c) => {
    const { token } = await c.req.json();
    if (!token) return c.json({ valid: false }, 400);
    const storedHash = await getAdminPass(c);
    if (!storedHash) return c.json({ valid: false }, 403);
    const isValid = await verifyPassword(token, storedHash);
    return c.json({ valid: isValid });
  });

  app.post("/admin/api/config", async (c) => {
    const b = await c.req.json();
    const ex = await c.env.DB.prepare(
      "SELECT id FROM config WHERE id=1",
    ).first();
    if (ex) {
      await c.env.DB.prepare(
        `UPDATE config SET client_token=?,recovery_period=? WHERE id=1`,
      )
        .bind(
          b.token || DEFAULTS.token,
          parseInt(b.recovery_period) || DEFAULTS.delay_period,
        )
        .run();
    } else {
      // 初始化 config，密碼為空（用戶需設定）
      await c.env.DB.prepare(
        `INSERT INTO config (id,client_token,admin_password,recovery_period) VALUES (1,?,NULL,?)`,
      )
        .bind(
          b.token || DEFAULTS.token,
          parseInt(b.recovery_period) || DEFAULTS.delay_period,
        )
        .run();
    }
    clearCache();
    return c.json({ ok: true });
  });

  app.post("/admin/api/admin-pass", async (c) => {
    const { pass } = await c.req.json();
    if (!pass) return c.json({ error: "Password required" }, 400);
    if (pass.length < 6 || pass.length > 20)
      return c.json({ error: "Password must be 6-20 characters" }, 400);
    const hashedPass = await hashPassword(pass);
    const ex = await c.env.DB.prepare(
      "SELECT id FROM config WHERE id=1",
    ).first();
    if (ex) {
      await c.env.DB.prepare(`UPDATE config SET admin_password=? WHERE id=1`)
        .bind(hashedPass)
        .run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO config (id,admin_password) VALUES (1,?)`,
      )
        .bind(hashedPass)
        .run();
    }
    clearCache();
    return c.json({ ok: true });
  });

  app.post("/admin/api/import-all", async (c) => {
    const d = await c.req.json();
    const batch = [];
    if (d.channels) {
      batch.push(c.env.DB.prepare("DELETE FROM channels"));
      d.channels.forEach((ch) => {
        batch.push(
          c.env.DB.prepare(
            `INSERT INTO channels (name, base_url, api_key, provider, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, tpm_limit, tpd_limit, max_tokens, support_tools) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            ch.name,
            ch.base_url || "",
            ch.api_key || "",
            ch.provider || "openai",
            ch.model || "",
            ch.weight || 1,
            ch.is_enabled ? 1 : 0,
            ch.is_vision ? 1 : 0,
            ch.last_429 || 0,
            ch.consecutive_errors || 0,
            ch.last_error_msg || "",
            ch.last_error_at || 0,
            ch.rpm_limit || 0,
            ch.rpd_limit || 0,
            ch.tpm_limit || 0,
            ch.tpd_limit || 0,
            ch.max_tokens || 0,
            ch.support_tools !== false ? 1 : 0,
          ),
        );
      });
    }
    if (d.filters) {
      batch.push(c.env.DB.prepare("DELETE FROM filters"));
      d.filters.forEach((f) => {
        batch.push(
          c.env.DB.prepare(
            `INSERT INTO filters (text, mode, is_enabled) VALUES (?, ?, ?)`,
          ).bind(f.text, f.mode || 1, f.is_enabled ? 1 : 0),
        );
      });
    }
    if (d.config) {
      const currentPass = await getAdminPass(c);
      batch.push(
        c.env.DB.prepare(
          `INSERT OR REPLACE INTO config (id,client_token,admin_password,recovery_period) VALUES (1,?,?,?)`,
        ).bind(
          d.config.token || DEFAULTS.token,
          currentPass,
          parseInt(d.config.recovery_period) || DEFAULTS.delay_period,
        ),
      );
    }
    if (batch.length > 0) await c.env.DB.batch(batch);
    clearCache();
    return c.json({ ok: true });
  });

  app.post("/admin/login", async (c) => {
    const ip =
      c.req.header("CF-Connecting-IP") ||
      c.req.header("X-Forwarded-For") ||
      "unknown";
    const host = c.req.header("Host") || "localhost";
    const banKey = `login-ban:${ip}`,
      failKey = `login-fail:${ip}`;
    const BAN_DURATION = 900;
    const MAX_FAILURES = 10;

    const cache = caches.default;
    const banCacheKey = new Request(`https://${host}/_internal/${banKey}`);
    const banResponse = await cache.match(banCacheKey);
    if (banResponse)
      return c.json({ error: "嘗試過多，請 15 分鐘後再试" }, 429);

    const { password } = await c.req.json();
    if (!password) return c.json({ error: "密碼 required" }, 400);

    const storedHash = await getAdminPass(c);
    if (!storedHash) {
      return c.json({ error: "尚未設定密碼" }, 403);
    }

    const isMatch = await verifyPassword(password, storedHash);

    if (isMatch) {
      c.executionCtx.waitUntil(
        cache.delete(banCacheKey).catch(() => { }),
        cache
          .delete(new Request(`https://${host}/_internal/${failKey}`))
          .catch(() => { }),
      );
      return c.json({ ok: true });
    }

    const failCacheKey = new Request(`https://${host}/_internal/${failKey}`);
    const failResponse = await cache.match(failCacheKey);
    let failCount = 1;
    if (failResponse) {
      const failData = await failResponse.json().catch(() => ({ count: 1 }));
      failCount = (failData.count || 0) + 1;
    }

    if (failCount >= MAX_FAILURES) {
      c.executionCtx.waitUntil(
        cache
          .put(banCacheKey, new Response("banned", { status: 429 }))
          .catch(() => { }),
        cache.delete(failCacheKey).catch(() => { }),
      );
      return c.json({ error: "IP 已被封鎖 15 分鐘" }, 429);
    }

    c.executionCtx.waitUntil(
      cache
        .put(
          failCacheKey,
          new Response(JSON.stringify({ count: failCount }), {
            headers: { "Cache-Control": `max-age=${BAN_DURATION}` },
          }),
        )
        .catch(() => { }),
    );

    return c.json({ error: "密碼錯誤" }, 401);
  });

  app.post("/admin/api/reset", async (c) => {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM channels"),
      c.env.DB.prepare("DELETE FROM filters"),
      c.env.DB.prepare(
        "UPDATE config SET client_token=?, recovery_period=? WHERE id=1",
      ).bind(DEFAULTS.token, DEFAULTS.delay_period),
    ]);
    clearCache();
    return c.json({ ok: true });
  });

  app.post("/admin/api/proxy-models", async (c) => {
    const { url, key } = await c.req.json();
    if (!url) return c.json({ error: "URL is required" }, 400);
    try {
      let fetchUrl = url.trim().replace(/\/+$/, "");
      if (!fetchUrl.endsWith("/v1") && !fetchUrl.includes("/v1/")) {
        fetchUrl += "/v1/models";
      } else if (fetchUrl.endsWith("/chat/completions")) {
        fetchUrl = fetchUrl.replace("/chat/completions", "/models");
      } else {
        fetchUrl += "/models";
      }

      const res = await fetch(fetchUrl, {
        headers: { Authorization: key ? `Bearer ${key}` : "" },
      });
      if (!res.ok) return c.json({ error: "Failed to fetch: " + res.status });
      const data = await res.json();
      return c.json(data);
    } catch (e) {
      return c.json({ error: "Failed to fetch: " + e.message });
    }
  });

  const UI_SHELL = html`<!DOCTYPE html>
  <html lang="zh-TW" data-bs-theme="light">
  <head>
    <meta charset="UTF-8" /><title>API Gateway</title><meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgZmlsbD0iI0ZGQzEwNyIgdmlld0JveD0iMCAwIDE2IDE2Ij48cGF0aCBkPSJNMTEuMjUxLjA2OGEuNS41IDAgMCAxIC4yMjcuNThMOS42NzcgNi41SDEzYS41LjUgMCAwIDEgLjM2NC44NDNsLTggOC41YS41LjUgMCAwIDEtLjg0Mi0uNDlMNS45OSA5LjVIM2EuNS41IDAgMCAxLS4zNzItLjgzNGw4LTguNWEuNS41IDAgMCAxIC40MjMtLjE5OHoiLz48L3N2Zz4=">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" />
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet" />
    <link href="https://cdn.jsdelivr.net/npm/notyf@3.10.0/notyf.min.css" rel="stylesheet" />
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bs-body-font-family: 'Outfit', system-ui, -apple-system, sans-serif;
      }
      body {
        background: var(--bs-tertiary-bg);
        transition: background-color 0.2s, color 0.2s;
        min-height: 100vh;
        overflow: hidden; /* 初始鎖定捲軸，防止跳動 */
      }
      #login-view, #setup-view, #admin-view { display: none; }
      .navbar { backdrop-filter: blur(10px); background: rgba(var(--bs-body-bg-rgb), 0.8) !important; }
      .form-switch .form-check-input { cursor: pointer; margin-top: 0; }
      .form-check { min-height: auto; padding-top: 0; padding-bottom: 0; }
      .table td, .table th { vertical-align: middle; padding: 0.5rem; }
      .badge { font-weight: 600; letter-spacing: 0.5px; }
      .health-badge { cursor: help; }
      #loading-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 9999; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
      #loading-overlay.hide { display: none; }
      body.loading { overflow: hidden; }
      .notyf { z-index: 10000 !important; }
      .stat-card { border-start: 4px solid var(--bs-primary); }
      .table-responsive { border-radius: 0.75rem; overflow: hidden; }
        @media (max-width: 576px) {
          .navbar-brand { font-size: 1rem; }
          .btn-sm { padding: 0.25rem 0.5rem; font-size: 0.75rem; }
          .card-header span { font-size: 0.85rem; }
          .input-group-text { font-size: 0.7rem; }
        }
        .badge-openai { border: 1px solid #000 !important; background-color: #fff !important; color: #000 !important; font-size: 0.5rem; padding: 1px 3px; font-weight: 800; letter-spacing: 0.5px; vertical-align: middle; }
        .badge-anthropic { border: 1px solid #d97757 !important; background-color: #1a1a1a !important; color: #d97757 !important; font-size: 0.5rem; padding: 1px 3px; font-weight: 800; letter-spacing: 0.5px; vertical-align: middle; }
        .badge-deepseek { border: 1px solid #2d5db1 !important; background-color: #2d5db1 !important; color: #fff !important; font-size: 0.5rem; padding: 1px 3px; font-weight: 800; letter-spacing: 0.5px; vertical-align: middle; }
        [data-bs-theme="dark"] .badge-openai { border-color: #fff !important; background-color: #222 !important; color: #fff !important; }
        [data-bs-theme="dark"] .badge-anthropic { border-color: #d97757 !important; }
        [data-bs-theme="dark"] .badge-deepseek { border-color: #4a8dfd !important; background-color: #1e3a8a !important; }
      </style>
  </head>
  <body>
    <div id="loading-overlay"><div class="spinner-border text-light" role="status"></div></div>
    <div id="login-view" class="container py-5 mt-5">
      <div class="row justify-content-center pt-5"><div class="col-md-4"><div class="card p-4"><div class="card-body text-center">
        <h4 class="fw-bold mb-4">API Gateway</h4>
        <form id="loginForm"><div class="mb-4 text-start"><label class="form-label small fw-bold">ADMIN PASSWORD</label><input type="password" id="login-pass" class="form-control" minlength="6" maxLength="20" required /></div><button type="submit" class="btn btn-primary w-100 fw-bold py-2">LOGIN</button></form>
      </div></div></div></div>
    </div>

    <div id="setup-view" class="container py-5 mt-5">
      <div class="row justify-content-center pt-5"><div class="col-md-4"><div class="card p-4"><div class="card-body text-center">
        <h4 class="fw-bold mb-4">API Gateway</h4>
        <p class="text-muted small mb-3">請設定管理員密碼</p>
        <form id="setupForm"><div class="mb-4 text-start"><label class="form-label small fw-bold">NEW PASSWORD</label><input type="password" id="setup-pass" class="form-control" minlength="6" maxLength="20" required /></div><button type="submit" class="btn btn-success w-100 fw-bold py-2">SET PASSWORD</button></form>
      </div></div></div></div>
    </div>

    <div id="admin-view">
      <nav class="navbar navbar-expand border-bottom sticky-top mb-4 py-2"><div class="container">
        <a class="navbar-brand fw-bold text-primary" href="javascript:location.reload()">API Gateway</a>
        <div class="ms-auto d-flex gap-2 align-items-center">
          <div class="dropdown">
            <button class="btn btn-sm btn-outline-primary dropdown-toggle fw-bold" data-bs-toggle="dropdown">TOOLS</button>
            <ul class="dropdown-menu dropdown-menu-end shadow border-0">
              <li><button class="dropdown-item py-2 small" onclick="passModal.show()"><i class="bi bi-shield-lock me-2"></i>Change PW</button></li>
              <li><button class="dropdown-item py-2 small" onclick="exportJson()"><i class="bi bi-download me-2"></i>Export JSON</button></li>
              <li><label class="dropdown-item py-2 small mb-0 cursor-pointer" style="cursor:pointer"><i class="bi bi-upload me-2"></i>Import JSON<input type="file" onchange="importJson(event)" style="display:none" /></label></li>
              <li><hr class="dropdown-divider"></li>
              <li><button class="dropdown-item py-2 small text-danger" onclick="resetSystem()"><i class="bi bi-arrow-counterclockwise me-2"></i>System Reset</button></li>
            </ul>
          </div>
          <a href="https://github.com/ss-vip/api-gateway" target="_blank" class="btn btn-sm btn-outline-secondary border-0 px-2" title="GitHub Project"><i class="bi bi-github"></i></a>
          <button onclick="toggleTheme()" class="btn btn-sm btn-outline-secondary border-0 px-2"><i id="theme-icon" class="bi bi-sun"></i></button>
          <button onclick="logout()" class="btn btn-sm btn-outline-danger border-0 px-2" title="LOGOUT"><i class="bi bi-box-arrow-right"></i></button>
        </div>
      </div></nav>
      <div class="container pb-5">

        <div class="d-flex justify-content-between align-items-center mb-3 mt-2">
          <h5 class="fw-bold mb-0 text-uppercase text-secondary" style="font-size: 0.9rem; letter-spacing: 1px;">System Status</h5>
        </div>
        <div id="stat-content" class="mb-4"></div>

        <div class="card border-0 shadow-sm mb-4">
          <div class="card-header bg-transparent d-flex justify-content-between align-items-center py-3 border-0">
            <span class="text-muted small fw-bold text-uppercase">API Configuration</span>
            <button onclick="saveConfig()" class="btn btn-primary btn-sm px-3 fw-bold">SAVE</button>
          </div>
          <div class="card-body pt-0">
            <div class="row g-2">
              <div class="col-md-8"><div class="input-group input-group-sm"><span class="input-group-text fw-bold small">TOKEN</span><input type="text" id="cfg-token" class="form-control" /><button class="btn btn-outline-secondary" onclick="copyToken()"><i class="bi bi-copy"></i></button></div></div>
              <div class="col-md-4"><div class="input-group input-group-sm"><span class="input-group-text fw-bold small">Recovery Delay (s)</span><input type="number" id="cfg-recovery-period" class="form-control" /></div></div>
            </div>
          </div>
        </div>
        <div class="card mb-4 border-0 shadow-sm">
          <div class="card-header bg-transparent fw-bold d-flex justify-content-between align-items-center py-3 border-0">
            <div class="d-flex align-items-center gap-3 flex-grow-1">
              <span class="d-none d-md-inline">Channels</span>
              <div class="input-group input-group-sm" style="max-width: 250px;">
                <span class="input-group-text bg-transparent border-end-0"><i class="bi bi-search"></i></span>
                <input type="text" id="ch-search" class="form-control border-start-0 ps-0" placeholder="Search..." oninput="renderChannels()" />
              </div>
            </div>
            <div class="d-flex gap-2"><button onclick="openChannelModal()" class="btn btn-outline-primary btn-sm px-3 fw-bold">ADD</button><button onclick="resetAllHealth()" class="btn btn-outline-success btn-sm px-3 fw-bold">RESET ALL HEALTH</button><button onclick="saveAllChannels()" class="btn btn-primary btn-sm px-3 fw-bold">SAVE ALL</button></div>
          </div>
          <div class="table-responsive"><table class="table table-hover mb-0 text-center align-middle small text-nowrap">
            <thead class="table-light"><tr class="text-uppercase text-muted small" style="letter-spacing: 0.5px;">
              <th style="width: 60px" class="border-0 cursor-pointer" onclick="toggleSort('id')">ID <i id="sort-id" class="bi bi-arrow-down-up opacity-25"></i></th>
              <th style="width: 80px" class="border-0">ON/OFF</th>
              <th style="width: 80px" class="border-0 cursor-pointer" onclick="toggleSort('provider')">TYPE <i class="bi bi-info-circle" title="目標接收格式"></i> <i id="sort-provider" class="bi bi-arrow-down-up opacity-25"></i></th>
              <th class="border-0 cursor-pointer" onclick="toggleSort('name')">Name <i id="sort-name" class="bi bi-arrow-down-up opacity-25"></i></th>
              <th class="border-0 cursor-pointer" onclick="toggleSort('model')">Model <i class="bi bi-info-circle" title="優先調用相符的模型名、視覺、工具使用"></i> <i id="sort-model" class="bi bi-arrow-down-up opacity-25"></i></th>
              <th style="width: 100px" class="d-none d-sm-table-cell border-0 cursor-pointer" onclick="toggleSort('weight')">Weight <i class="bi bi-info-circle" title="大值優先"></i> <i id="sort-weight" class="bi bi-arrow-down-up opacity-25"></i></th>
              <th style="width: 120px" class="border-0 cursor-pointer" onclick="toggleSort('status')">Health <i class="bi bi-info-circle" title="多次錯誤的不健康渠道將被跳過調用，可以手動重置狀態"></i> <i id="sort-status" class="bi bi-arrow-down-up opacity-25"></i></th>
              <th style="width: 150px" class="text-center border-0">Actions</th>
            </tr></thead>
            <tbody id="channel-list"></tbody>
          </table></div>
        </div>
        <div class="card border-0 shadow-sm">
          <div class="card-header bg-transparent fw-bold d-flex justify-content-between align-items-center py-3 border-0">
            <span>Filters</span>
            <div class="d-flex gap-2"><button onclick="addFilter()" class="btn btn-outline-info btn-sm px-3 fw-bold">ADD</button><button onclick="saveAllFilters()" class="btn btn-info btn-sm px-3 fw-bold">SAVE ALL</button></div>
          </div>
          <div class="table-responsive"><table class="table table-hover mb-0 text-center small">
            <thead class="table-light"><tr>
              <th style="width: 80px" class="align-middle">ON/OFF</th>
              <th class="align-middle">Keyword <i class="bi bi-info-circle" title="要過濾的關鍵字"></i></th>
              <th style="width: 120px" class="d-none d-sm-table-cell align-middle">Mode <i class="bi bi-info-circle" title="Truncate: 切除關鍵字及其後內容；Delete: 僅刪除關鍵字"></i></th>
              <th style="width: 60px" class="align-middle">Actions</th>
            </tr></thead>
            <tbody id="filter-list"></tbody>
          </table></div>
        </div>
      </div>
    </div>
    <button id="go-top-btn" onclick="window.scrollTo({top:0,behavior:'smooth'})" class="btn btn-primary position-fixed bottom-0 end-0 m-3 rounded-circle p-2" style="width:40px;height:40px;z-index:1060;display:none;" title="Go Top" tabindex="-1"><i class="bi bi-arrow-up"></i></button>
      </div>
    </div>

    <div class="modal fade" id="passModal" tabindex="-1"><div class="modal-dialog modal-dialog-centered modal-sm"><div class="modal-content">
      <div class="modal-header border-0 pb-0"><h5 class="fw-bold">New Login Password</h5><button type="button" class="btn-close ms-auto" data-bs-dismiss="modal" aria-label="Close"></button></div>
      <div class="modal-body p-4"><input type="password" id="new-admin-pass" class="form-control" placeholder="New Password" minlength="6" maxLength="20" required /></div>
      <div class="modal-footer border-0 pt-0"><button onclick="updateAdminPass()" class="btn btn-warning w-100 fw-bold">UPDATE & LOGOUT</button></div>
    </div></div></div>

    <div class="modal fade" id="chModal" tabindex="-1"><div class="modal-dialog modal-dialog-centered"><div class="modal-content">
      <div class="modal-header border-0 pb-0">
        <div class="d-flex align-items-center gap-2">
          <h5 class="fw-bold small mb-0">Channel Editor</h5>
          <span id="ch-id-badge" class="badge bg-secondary" style="display:none"></span>
        </div>
        <button type="button" class="btn-close ms-auto" data-bs-dismiss="modal" aria-label="Close"></button>
      </div>
      <form id="ch-form" onsubmit="event.preventDefault(); applyChannel();">
      <div class="modal-body p-3 p-md-4">
        <input type="hidden" id="ch-idx" />
        <input type="hidden" id="ch-id" />
        <div class="row g-2 mb-2">
          <div class="col-8"><label class="form-label mini-label fw-bold">Name *</label><input type="text" id="ch-name" class="form-control form-control-sm" required /></div>
          <div class="col-4"><label class="form-label mini-label fw-bold">Type</label><select id="ch-provider" class="form-select form-select-sm"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></div>
        </div>
        <div class="mb-2"><label class="form-label mini-label fw-bold">API Key *</label><div class="input-group input-group-sm"><input type="password" id="ch-key" class="form-control form-control-sm" required /><button class="btn btn-outline-secondary" type="button" onclick="toggleKeyVis()" title="Toggle visibility">&#128065;</button></div></div>
        <div class="mb-2"><label class="form-label mini-label fw-bold">Base URL * <span class="text-muted fw-normal" style="font-size:0.6rem">建議結尾包含 /v1</span></label><input type="url" id="ch-url" class="form-control form-control-sm" placeholder="https://api.example.com/v1" oninput="checkFetchModelsBtn()" required /></div>
        <div class="mb-2">
          <label class="form-label mini-label fw-bold">Primary Model *</label>
          <div class="input-group input-group-sm">
            <input type="text" id="ch-model" class="form-control form-control-sm" required />
            <button class="btn btn-outline-primary fw-bold" type="button" id="btn-fetch-models-primary" onclick="fetchModels('primary')" disabled>FETCH</button>
          </div>
        </div>
        <div class="mb-2">
          <label class="form-label mini-label fw-bold">Secondary Model <span class="text-muted fw-normal" style="font-size:0.6rem">Fallback, Optional</span></label>
          <div class="input-group input-group-sm">
            <input type="text" id="ch-fallback-model" class="form-control form-control-sm" />
            <button class="btn btn-outline-secondary fw-bold" type="button" id="btn-fetch-models-fallback" onclick="fetchModels('fallback')" disabled>FETCH</button>
          </div>
        </div>
        <div class="row g-2 mb-2">
          <div class="col-6"><label class="form-label mini-label fw-bold">Weight (1-100)</label><input type="number" id="ch-weight" class="form-control form-control-sm" min="1" max="100" value="50" required /></div>
          <div class="col-6"><label class="form-label mini-label fw-bold">Max Tokens</label><input type="number" id="ch-tokens" class="form-control form-control-sm" min="0" value="0" /></div>
        </div>
        <div class="row g-1 mb-2">
          <div class="col-3"><label class="form-label mini-label fw-bold">RPM</label><input type="number" id="ch-rpm" class="form-control form-control-sm p-1" min="0" value="0" /></div>
          <div class="col-3"><label class="form-label mini-label fw-bold">RPD</label><input type="number" id="ch-rpd" class="form-control form-control-sm p-1" min="0" value="0" /></div>
          <div class="col-3"><label class="form-label mini-label fw-bold">TPM</label><input type="number" id="ch-tpm" class="form-control form-control-sm p-1" min="0" value="0" /></div>
          <div class="col-3"><label class="form-label mini-label fw-bold">TPD</label><input type="number" id="ch-tpd" class="form-control form-control-sm p-1" min="0" value="0" /></div>
        </div>
        <div class="row g-2 mt-3 pt-2 border-top">
          <div class="col-4 d-flex flex-column align-items-center">
            <label class="form-check-label small fw-bold mb-1" for="ch-vision">👁️ Vision</label>
            <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="ch-vision" checked></div>
          </div>
          <div class="col-4 d-flex flex-column align-items-center">
            <label class="form-check-label small fw-bold mb-1" for="ch-tools">🔧 Tools</label>
            <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="ch-tools" checked></div>
          </div>
          <div class="col-4 d-flex flex-column align-items-center">
            <label class="form-check-label small fw-bold mb-1" for="ch-enabled">✔️ Enabled</label>
            <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="ch-enabled" checked></div>
          </div>
        </div>
      </div>
      <div class="modal-footer border-0 pt-0"><button type="submit" class="btn btn-primary w-100 fw-bold">APPLY</button></div>
      </form>
    </div></div></div>

    <div class="modal fade" id="debugModal" tabindex="-1"><div class="modal-dialog modal-dialog-centered modal-lg"><div class="modal-content">
      <div class="modal-header border-0 pb-0">
        <h5 class="fw-bold small mb-0">Debug Info (Last Error)</h5>
        <button type="button" class="btn-close ms-auto" data-bs-dismiss="modal" aria-label="Close"></button>
      </div>
      <div class="modal-body p-3 p-md-4">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <span id="debug-time" class="text-muted fw-bold" style="font-size:0.8rem"></span>
        </div>
        <div class="mb-2"><label class="form-label mini-label">Error Message</label><input type="text" id="debug-msg" class="form-control form-control-sm text-danger" readonly /></div>
        <div class="mb-2" id="debug-url-wrapper"><label class="form-label mini-label">Target URL</label><input type="text" id="debug-url" class="form-control form-control-sm" readonly /></div>
        <div class="row g-2" id="debug-req-res-wrapper">
          <div class="col-12"><label class="form-label mini-label">Request Payload</label><textarea id="debug-req" class="form-control form-control-sm" rows="5" readonly style="font-size:0.7rem"></textarea></div>
          <div class="col-12"><label class="form-label mini-label">Response Data</label><textarea id="debug-res" class="form-control form-control-sm" rows="5" readonly style="font-size:0.7rem"></textarea></div>
        </div>
      </div>
    </div></div></div>

    <div class="modal fade" id="modelsModal" tabindex="-1"><div class="modal-dialog modal-dialog-centered"><div class="modal-content">
      <div class="modal-header border-0 pb-0"><h5 class="fw-bold small mb-0">Select a Model</h5><button type="button" class="btn-close ms-auto" data-bs-dismiss="modal" aria-label="Close"></button></div>
      <div class="modal-body p-3">
        <input type="text" id="model-search" class="form-control form-control-sm mb-2" placeholder="Search models..." oninput="renderModelList()" />
        <div class="list-group list-group-flush" id="models-list" style="max-height: 300px; overflow-y: auto;"></div>
      </div>
    </div></div></div>

    <style>.mini-label { font-size: 0.65rem; margin-bottom: 2px; text-transform: uppercase; color: var(--bs-secondary); }</style>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/notyf@3.10.0/notyf.min.js"></script>
    <script>
      const notyf = new Notyf({
        position: { x: 'right', y: 'bottom' },
        ripple: true,
        dismissible: true,
        duration: 2500
      });
      const toast = (msg, type = 'primary') => {
        if (type === 'danger') notyf.error(msg);
        else notyf.success(msg);
      };
      const confirm = (msg, onOk) => { if (window.confirm(msg)) onOk(); };
      let chModal, passModal, debugModal, modelsModal, channels = [], filters = [], delay_period = 300, refreshTimer = null, lastChannelsStr = '';
      let sortKey = null, sortOrder = 0; // 0: none, 1: asc, 2: desc
      let loadingTimer = null;
      const loading = (s) => {
        const el = document.getElementById('loading-overlay');
        if (s) {
          el.classList.remove('hide');
          document.body.classList.add('loading');
          clearTimeout(loadingTimer);
        } else {
          loadingTimer = setTimeout(() => {
            el.classList.add('hide');
            document.body.classList.remove('loading');
            document.body.style.overflow = ''; // 確保初始鎖定被解除
          }, 0);
        }
      };
      const api = async (u, m='GET', b=null, showLoader=true) => {
        if (showLoader) loading(true);
        const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': sessionStorage.getItem('adminToken') || '' }, body: b ? JSON.stringify(b) : null });
        if (showLoader) loading(false);
        if (r.status === 401) { showLogin(); return null; }
        if (!r.ok) { const err = await r.json(); toast(err.error || 'Request Failed', 'danger'); return null; }
        return r.json();
      };
      const showLogin = () => { document.getElementById('admin-view').style.display = 'none'; document.getElementById('setup-view').style.display = 'none'; document.getElementById('login-view').style.display = 'block'; loading(false); };
      const showSetup = () => { document.getElementById('admin-view').style.display = 'none'; document.getElementById('login-view').style.display = 'none'; document.getElementById('setup-view').style.display = 'block'; loading(false); };
      const showAdmin = () => { document.getElementById('login-view').style.display = 'none'; document.getElementById('setup-view').style.display = 'none'; document.getElementById('admin-view').style.display = 'block'; init(); loading(false); };
      const logout = () => { sessionStorage.removeItem('adminToken'); sessionStorage.removeItem('adminLoggedIn'); location.reload(); };
      const toggleTheme = () => { const t = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-bs-theme', t); document.getElementById('theme-icon').className = t === 'dark' ? 'bi bi-moon-fill' : 'bi bi-sun'; localStorage.setItem('theme', t); };
      const copyToken = () => { const t = document.getElementById('cfg-token'); t.select(); document.execCommand('copy'); toast('Token 已複製', 'success'); };
      const esc = (s) => String(s || "").replace(/[\\"\\n\\r\\t]/g, ' ').replace(/"/g, '&quot;');
      const initTooltips = () => { [...document.querySelectorAll('[data-bs-toggle="tooltip"]')].map(el => new bootstrap.Tooltip(el)); };
      document.getElementById('loginForm').onsubmit = async (e) => {
        e.preventDefault()
        const p = document.getElementById('login-pass').value
        if (!p) return toast('請輸入密碼', 'warning')
        loading(true)
        try {
          const r = await fetch('/admin/login', { method: 'POST', body: JSON.stringify({ password: p }) })
          const data = await r.json()
          loading(false)
          if (r.ok) {
            // 存儲密碼（用於 API 認證）+ 登入標記
            sessionStorage.setItem('adminToken', p)
            sessionStorage.setItem('adminLoggedIn', '1')
            showAdmin()
          } else {
            toast(data.error || '密碼錯誤', 'danger')
          }
        } catch(err) {
          loading(false)
          toast('網絡或資料庫異常，請確保已執行 D1 初始化', 'danger')
        }
      }

      document.getElementById('setupForm').onsubmit = async (e) => {
        e.preventDefault()
        const p = document.getElementById('setup-pass').value
        if (!p) return toast('請輸入密碼', 'warning')
        if (p.length < 6 || p.length > 20) return toast('密碼需 6-20 個字', 'warning')
        loading(true)
        try {
          // 先設定密碼
          const r = await fetch('/admin/api/admin-pass', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pass: p })
          })
          if (!r.ok) {
            loading(false)
            const err = await r.json()
            toast(err.error || '設定失敗', 'danger')
            return
          }
          // 設定成功後自動登入
          const loginRes = await fetch('/admin/login', { method: 'POST', body: JSON.stringify({ password: p }) })
          loading(false)
          if (loginRes.ok) {
            sessionStorage.setItem('adminToken', p)
            sessionStorage.setItem('adminLoggedIn', '1')
            showAdmin()
          } else {
            showLogin()
          }
        } catch(err) {
          loading(false)
          toast('網絡或資料庫異常', 'danger')
        }
      }

      const init = async () => {
        const cfg = await api('/admin/api/config', 'GET', null, false); if (!cfg) return;
        document.getElementById('cfg-token').value = cfg.token; document.getElementById('cfg-recovery-period').value = cfg.recovery_period; delay_period = cfg.recovery_period;
        const initData = await api('/admin/api', 'GET', null, false);
        if (initData) { channels = initData; lastChannelsStr = JSON.stringify(channels); }
        filters = await api('/admin/api/filters', 'GET', null, false);
        renderStats(); renderChannels(); renderFilters();
        if (!refreshTimer) refreshTimer = setInterval(async () => {
          const d = await api('/admin/api', 'GET', null, false);
          if (d) {
            const dStr = JSON.stringify(d);
            if (dStr !== lastChannelsStr) {
              lastChannelsStr = dStr;
              channels = d;
              renderStats();
              renderChannels();
            }
          }
        }, 30000);
      };

      const renderStats = () => {
        const now = Math.floor(Date.now() / 1000);
        const total = channels.length;
        const enabled = channels.filter(c => c.is_enabled).length;
        const cooling = channels.filter(c => c.is_enabled && (now - (c.last_429 || 0) < delay_period)).length;
        const error = channels.filter(c => c.is_enabled && c.consecutive_errors >= 5 && (now - (c.last_error_at || 0) <= 1800)).length;
        const unstable = channels.filter(c => c.is_enabled && c.consecutive_errors > 0 && c.consecutive_errors < 5).length;
        const healthy = enabled - cooling - error - unstable;
        const rpdChannels = channels.filter(c => c.is_enabled && c.rpd_limit > 0);
        const rpdTotal = rpdChannels.reduce((s, c) => s + c.rpd_limit, 0);
        const rpdUsed = rpdChannels.reduce((s, c) => s + ((now - (c.rpd_reset_at || 0)) < 86400 ? (c.rpd_count || 0) : 0), 0);
        const rpdPct = rpdTotal > 0 ? Math.round(rpdUsed / rpdTotal * 100) : -1;
        const rpdColor = rpdPct < 0 ? 'secondary' : rpdPct >= 90 ? 'danger' : rpdPct >= 70 ? 'warning' : 'success';
        const stats = [
          { label: 'Total', val: total, textClass: 'text-body-secondary' },
          { label: 'Active', val: healthy, textClass: 'text-success' },
          { label: 'Unstable', val: unstable, textClass: 'text-warning' },
          { label: 'Error', val: error, textClass: 'text-danger' },
          { label: 'Recovery', val: cooling, textClass: 'text-info' },
        ];

        let html = '<div class="row g-3 mb-3">';

        // Basic metrics
        html += stats.map(s =>
          '<div class="col-6 col-md-auto flex-grow-1">' +
            '<div class="card border-0 shadow-sm h-100">' +
              '<div class="card-body p-3">' +
                '<div class="small text-muted text-uppercase fw-bold mb-1">' + s.label + '</div>' +
                '<div class="h3 mb-0 fw-normal ' + s.textClass + '">' + s.val + '</div>' +
              '</div>' +
            '</div>' +
          '</div>'
        ).join('');

        // RPD metrics
        let rpdContent = '';
        if (rpdTotal > 0) {
          rpdContent =
            '<div class="d-flex justify-content-between align-items-end mb-2">' +
              '<span class="small text-muted text-uppercase fw-bold">Daily RPD Usage</span>' +
              '<span class="fw-bold text-' + rpdColor + '">' + rpdUsed + ' / ' + rpdTotal + ' <span class="small text-muted fw-normal">(' + rpdPct + '%)</span></span>' +
            '</div>' +
            '<div class="progress" style="height: 8px;">' +
              '<div class="progress-bar bg-' + rpdColor + '" style="width: ' + Math.min(100, Math.max(0, rpdPct)) + '%"></div>' +
            '</div>';
        } else {
          rpdContent = '<div class="text-muted small py-1"><i class="bi bi-info-circle me-1"></i> No RPD limits configured.</div>';
        }

        html +=
          '<div class="col-12">' +
            '<div class="card border-0 shadow-sm">' +
              '<div class="card-body p-3" title="所有已設定 RPD 的渠道加總統計">' +
                rpdContent +
              '</div>' +
            '</div>' +
          '</div>';

        html += '</div>';

        document.getElementById('stat-content').innerHTML = html;
      };

      const renderChannels = () => {
        const now = Math.floor(Date.now() / 1000);
        const query = document.getElementById('ch-search').value.toLowerCase();
        let display = [...channels];

        // Sorting logic
        if (sortKey && sortOrder > 0) {
          display.sort((a, b) => {
            let vA, vB;
            if (sortKey === 'status') {
              vA = a.consecutive_errors >= 5 ? 2 : (now - (a.last_429 || 0) < delay_period ? 1 : 0);
              vB = b.consecutive_errors >= 5 ? 2 : (now - (b.last_429 || 0) < delay_period ? 1 : 0);
            } else {
              vA = a[sortKey]; vB = b[sortKey];
            }
            if (typeof vA === 'string') vA = vA.toLowerCase();
            if (typeof vB === 'string') vB = vB.toLowerCase();
            if (vA < vB) return sortOrder === 1 ? -1 : 1;
            if (vA > vB) return sortOrder === 1 ? 1 : -1;
            return 0;
          });
        }

        const filtered = display.filter(c => c.name.toLowerCase().includes(query) || (c.model||'').toLowerCase().includes(query));

        // Update sort icons
        ['id','name','model','weight','status','provider'].forEach(k => {
          const icon = document.getElementById('sort-' + k);
          if (!icon) return;
          icon.className = 'bi bi-arrow-down-up opacity-25';
          if (k === sortKey) {
            if (sortOrder === 1) icon.className = 'bi bi-sort-down-alt text-primary opacity-100';
            else if (sortOrder === 2) icon.className = 'bi bi-sort-up text-primary opacity-100';
          }
        });

        document.getElementById('channel-list').innerHTML = filtered.map((c) => {
          const realIdx = channels.indexOf(c);
          let hoverMsg = c.last_error_msg || 'Unknown';
          try { hoverMsg = JSON.parse(hoverMsg).message || hoverMsg; } catch(e) {}
          let h = '<span class="badge bg-success health-badge">正常</span>';
          if (c.consecutive_errors >= 5) {
            if (now - (c.last_error_at || 0) > 1800) h = '<span class="badge bg-secondary health-badge" title="Observed (Retry soon)" onclick="showDebug(' + realIdx + ')">觀察</span>';
            else h = '<span class="badge bg-danger health-badge" title="點擊查看詳細錯誤" onclick="showDebug(' + realIdx + ')">異常</span>';
          }
          else if (now - (c.last_429 || 0) < delay_period) h = '<span class="badge bg-info health-badge" title="Recovery active" onclick="showDebug(' + realIdx + ')">冷卻</span>';
          else if (c.consecutive_errors > 0) h = '<span class="badge bg-warning text-dark health-badge" title="點擊查看詳細錯誤" onclick="showDebug(' + realIdx + ')">不穩</span>';
          else if (c.rpd_limit > 0 && (now - (c.rpd_reset_at || 0)) < 86400 && (c.rpd_count || 0) >= c.rpd_limit) h = '<span class="badge bg-dark health-badge" title="RPD exhausted: ' + c.rpd_count + '/' + c.rpd_limit + '">限額</span>';
          const providerBadge = c.provider === 'anthropic'
            ? '<span class="badge badge-anthropic">Anthropic</span>'
            : (c.model||'').toLowerCase().includes('deepseek')
              ? '<span class="badge badge-deepseek">DeepSeek</span>'
              : '<span class="badge badge-openai">OpenAI</span>';
          return '<tr>' +
            '<td class="text-muted small align-middle">' + (c.id || '-') + '</td>' +
            '<td class="align-middle"><div class="form-check form-switch d-inline-block justify-content-center"><input class="form-check-input" type="checkbox" ' + (c.is_enabled?'checked':'') + ' onchange="channels[' + realIdx + '].is_enabled=this.checked;renderStats()"></div></td>' +
            '<td class="align-middle">' + providerBadge + '</td>' +
            '<td class="fw-bold align-middle">' + c.name + '</td>' +
            '<td class="align-middle"><code class="small" style="cursor:pointer" onclick="copyModelName(&quot;' + esc(c.model||'') + '&quot;)" title="點擊複製">' + (c.model || '-') + '</code> ' + (c.is_vision?'👁️':'') + (c.support_tools !== 0?' 🔧':'') + '</td>' +
            '<td class="d-none d-sm-table-cell align-middle">' + c.weight + '</td>' +
            '<td class="align-middle">' + h + '</td>' +
            '<td class="align-middle">' +
              '<div class="d-none d-md-flex justify-content-center gap-1">' +
                '<button onclick="copyChannel(' + realIdx + ')" class="btn btn-sm btn-outline-secondary py-1 px-2" title="Copy Channel"><i class="bi bi-copy"></i></button>' +
                '<button onclick="editChannel(' + realIdx + ')" class="btn btn-sm btn-outline-primary py-1 px-2" title="Edit Channel"><i class="bi bi-pencil"></i></button>' +
                '<button onclick="resetHealth(' + c.id + ')" class="btn btn-sm btn-outline-success py-1 px-2" title="Reset Health"><i class="bi bi-arrow-repeat"></i></button>' +
                '<button onclick="delChannel(' + realIdx + ')" class="btn btn-sm btn-outline-danger py-1 px-2" title="Delete Channel"><i class="bi bi-trash"></i></button>' +
              '</div>' +
              '<div class="d-md-none dropdown">' +
                '<button class="btn btn-sm btn-light py-1 px-2" type="button" data-bs-toggle="dropdown"><i class="bi bi-three-dots-vertical"></i></button>' +
                '<ul class="dropdown-menu dropdown-menu-end shadow border-0">' +
                  '<li><button onclick="editChannel(' + realIdx + ')" class="dropdown-item small">Edit</button></li>' +
                  '<li><button onclick="resetHealth(' + c.id + ')" class="dropdown-item small">Reset Health</button></li>' +
                  '<li><button onclick="copyChannel(' + realIdx + ')" class="dropdown-item small">Copy</button></li>' +
                  '<li><button onclick="delChannel(' + realIdx + ')" class="dropdown-item small text-danger">Delete</button></li>' +
                '</ul>' +
              '</div>' +
            '</td>' +
          '</tr>';
        }).join('') || '<tr><td colspan="8" class="py-4 text-muted">No channels.</td></tr>';
        initTooltips();
      };

      const copyModelName = (name) => {
        if (!name) return;
        const tmp = document.createElement('textarea'); tmp.value = name; document.body.appendChild(tmp); tmp.select(); document.execCommand('copy'); document.body.removeChild(tmp);
        toast('Model ID 已複製: ' + name, 'success');
      };

      const resetHealth = async (id) => {
        if (!id) return toast('請先儲存渠道', 'warning');
        confirm('確定重置該渠道健康狀態？', async () => {
          await api('/admin/api/channels/' + id + '/reset-health', 'POST');
          init();
        });
      };

      const updateAdminPass = async () => {
        if (document.activeElement) document.activeElement.blur();
        const p = document.getElementById('new-admin-pass').value;
        if (!p) return toast('請輸入密碼', 'warning');
        confirm('更換密碼後將自動登出，確定？', async () => {
          await api('/admin/api/admin-pass', 'POST', { pass: p });
          logout();
        });
      };

      const renderFilters = () => {
        document.getElementById('filter-list').innerHTML = filters.map((f, i) => '<tr>' +
          '<td class="align-middle"><div class="form-check form-switch d-inline-block justify-content-center"><input class="form-check-input" type="checkbox" ' + (f.is_enabled?'checked':'') + ' onchange="filters[' + i + '].is_enabled=this.checked"></div></td>' +
          '<td class="align-middle"><input type="text" class="form-control form-control-sm" maxLength="30" placeholder="關鍵字（1-30 字）" value="' + esc(f.text) + '" oninput="filters[' + i + '].text=this.value" title="長度限 1-30 字"></td>' +
          '<td class="d-none d-sm-table-cell align-middle"><select class="form-select form-select-sm" onchange="filters[' + i + '].mode=parseInt(this.value)"><option value="1" ' + (f.mode==1?'selected':'') + '>Truncate</option><option value="0" ' + (f.mode==0?'selected':'') + '>Delete</option></select></td>' +
          '<td class="align-middle"><button onclick="filters.splice(' + i + ',1);renderFilters()" class="btn btn-sm btn-outline-danger py-1 px-2"><i class="bi bi-trash"></i></button></td>' +
        '</tr>').join('') || '<tr><td colspan="4" class="py-4 text-muted">No filters.</td></tr>';
        initTooltips();
      };

      const saveConfig = async () => { await api('/admin/api/config', 'POST', { token: document.getElementById('cfg-token').value, recovery_period: document.getElementById('cfg-recovery-period').value }); toast('設定已儲存', 'success'); };
      const saveAllChannels = async () => { await api('/admin/api/batch-channels', 'POST', channels); toast('渠道已儲存', 'success'); init(); };
      const saveAllFilters = async () => {
        const invalid = filters.filter(f => !f.text || f.text.trim().length === 0 || f.text.length > 30);
        if (invalid.length > 0) return toast('過濾關鍵字長度須介於 1–30 字，請修正後再儲存。', 'warning');
        await api('/admin/api/filters', 'POST', filters); toast('過濾器已儲存', 'success'); renderFilters();
      };
      const addFilter = () => { filters.push({ text: '', mode: 1, is_enabled: true }); renderFilters(); };
      const openChannelModal = () => { document.getElementById('ch-idx').value = ''; document.getElementById('ch-id').value = ''; const b = document.getElementById('ch-id-badge'); b.textContent = ''; b.style.display = 'none'; ['ch-name','ch-key','ch-url','ch-model','ch-fallback-model'].forEach(i=>document.getElementById(i).value=''); document.getElementById('ch-provider').value = 'openai'; document.getElementById('ch-weight').value=50; ['ch-rpm','ch-rpd','ch-tpm','ch-tpd','ch-tokens'].forEach(i=>document.getElementById(i).value=0); document.getElementById('ch-enabled').checked=true; document.getElementById('ch-vision').checked=false; document.getElementById('ch-tools').checked=true; checkFetchModelsBtn(); chModal.show(); };
      const editChannel = (idx) => {
        const c = channels[idx]; document.getElementById('ch-idx').value = idx; document.getElementById('ch-id').value = c.id || ''; const badge = document.getElementById('ch-id-badge'); if (c.id) { badge.textContent = '#' + c.id; badge.style.display = ''; } else { badge.textContent = ''; badge.style.display = 'none'; } document.getElementById('ch-name').value = c.name; document.getElementById('ch-provider').value = c.provider || 'openai'; document.getElementById('ch-key').value = c.api_key; document.getElementById('ch-url').value = c.base_url; document.getElementById('ch-model').value = c.model; document.getElementById('ch-fallback-model').value = c.fallback_model || ''; document.getElementById('ch-weight').value = c.weight; document.getElementById('ch-tokens').value = c.max_tokens || 0; document.getElementById('ch-rpm').value = c.rpm_limit || 0; document.getElementById('ch-rpd').value = c.rpd_limit || 0; document.getElementById('ch-tpm').value = c.tpm_limit || 0; document.getElementById('ch-tpd').value = c.tpd_limit || 0; document.getElementById('ch-vision').checked = c.is_vision == 1; document.getElementById('ch-tools').checked = c.support_tools !== 0; document.getElementById('ch-enabled').checked = c.is_enabled == 1;
        checkFetchModelsBtn();
        chModal.show();
      };

      const showDebug = (idx) => {
        const c = channels[idx];
        if (!c || !c.last_error_msg) return toast('無錯誤資訊', 'warning');
        document.getElementById('debug-time').textContent = new Date(c.last_error_at * 1000).toLocaleString();
        let parsed = null;
        try { parsed = JSON.parse(c.last_error_msg); } catch(e) {}
        if (parsed && typeof parsed === 'object') {
          document.getElementById('debug-msg').value = parsed.message || '';
          document.getElementById('debug-url').value = parsed.url || '';
          document.getElementById('debug-req').value = parsed.request || '';
          document.getElementById('debug-res').value = parsed.response || '';
          document.getElementById('debug-url-wrapper').style.display = 'block';
          document.getElementById('debug-req-res-wrapper').style.display = 'flex';
        } else {
          document.getElementById('debug-msg').value = c.last_error_msg;
          document.getElementById('debug-url-wrapper').style.display = 'none';
          document.getElementById('debug-req-res-wrapper').style.display = 'none';
        }
        debugModal.show();
      };

      const applyChannel = () => {
        if (document.activeElement) document.activeElement.blur();
        const idx = document.getElementById('ch-idx').value;
        const name = document.getElementById('ch-name').value.trim();
        if (!name) return toast('請輸入名稱', 'warning');
        const weightInput = document.getElementById('ch-weight');
        const weight = parseInt(weightInput.value);
        if (isNaN(weight) || weight < 1 || weight > 100) return toast('Weight 需介於 1-100', 'warning');
        const url = document.getElementById('ch-url').value.trim().replace(new RegExp('/+$'), '');
        if (!url) return toast('請輸入 Base URL', 'warning');
        const prev = idx !== '' ? channels[idx] : null;
        const b = { name, api_key: document.getElementById('ch-key').value, base_url: url, provider: document.getElementById('ch-provider').value, model: document.getElementById('ch-model').value, fallback_model: document.getElementById('ch-fallback-model').value, weight: weight, max_tokens: parseInt(document.getElementById('ch-tokens').value), rpm_limit: parseInt(document.getElementById('ch-rpm').value), rpd_limit: parseInt(document.getElementById('ch-rpd').value), tpm_limit: parseInt(document.getElementById('ch-tpm').value), tpd_limit: parseInt(document.getElementById('ch-tpd').value), is_vision: document.getElementById('ch-vision').checked, support_tools: document.getElementById('ch-tools').checked ? 1 : 0, is_enabled: document.getElementById('ch-enabled').checked, last_429: prev ? prev.last_429||0 : 0, consecutive_errors: prev ? prev.consecutive_errors||0 : 0, last_error_msg: prev ? prev.last_error_msg||'' : '', last_error_at: prev ? prev.last_error_at||0 : 0 };
        if (idx !== '') channels[idx] = b; else channels.push(b); chModal.hide(); renderChannels(); renderStats(); toast(idx !== '' ? '已修改，請 SAVE ALL 儲存' : '已新增，請 SAVE ALL 儲存', 'success');
      };
      const delChannel = (idx) => { confirm('確定刪除此渠道？', () => { channels.splice(idx, 1); renderChannels(); renderStats(); }); };
      const copyChannel = (idx) => { const src = channels[idx]; channels.push({ ...src, name: src.name + ' (copy)', id: undefined, last_429: 0, consecutive_errors: 0, last_error_msg: '', last_error_at: 0 }); renderChannels(); renderStats(); };
      const toggleKeyVis = () => { const i = document.getElementById('ch-key'); i.type = i.type === 'password' ? 'text' : 'password'; };

      let fetchedModels = [];
      let currentModelTarget = 'primary';
      const checkFetchModelsBtn = () => {
        const url = document.getElementById('ch-url').value.trim();
        const isDisabled = url.length === 0;
        document.getElementById('btn-fetch-models-primary').disabled = isDisabled;
        document.getElementById('btn-fetch-models-fallback').disabled = isDisabled;
      };
      const fetchModels = async (target = 'primary') => {
        currentModelTarget = target;
        const btnId = target === 'primary' ? 'btn-fetch-models-primary' : 'btn-fetch-models-fallback';
        const btn = document.getElementById(btnId);
        const originalContent = btn.innerHTML;

        const url = document.getElementById('ch-url').value.trim();
        const key = document.getElementById('ch-key').value.trim();
        if (!url) return;

        // 切換按鈕為 Loading 狀態 (不使用全局遮罩，避免畫面跳動)
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';

        try {
          // 第二層彈出視窗設計：呼叫 api 時 showLoader 設為 false
          const data = await api('/admin/api/proxy-models', 'POST', { url, key }, false);
          if (data && (data.data || Array.isArray(data))) {
            fetchedModels = data.data || (Array.isArray(data) ? data.map(m => typeof m === 'string' ? { id: m } : m) : []);
            document.getElementById('model-search').value = '';
            renderModelList();
            chModal.hide();
            modelsModal.show();
          }
        } catch (e) {
          toast('獲取模型失敗: ' + e.message, 'danger');
        } finally {
          // 恢復按鈕狀態
          btn.disabled = false;
          btn.innerHTML = originalContent;
        }
      };
      const renderModelList = () => {
        const q = document.getElementById('model-search').value.toLowerCase();
        const list = fetchedModels.filter(m => (m.id||m.name||'').toLowerCase().includes(q));
        document.getElementById('models-list').innerHTML = list.map(m => {
          let limitText = '';
          if (m.max_tokens) limitText += 'MaxTokens: ' + m.max_tokens + ' ';
          if (m.rpm) limitText += 'RPM: ' + m.rpm + ' ';
          const subText = limitText ? '<br><small class="text-muted">' + limitText + '</small>' : '';
          const mJson = JSON.stringify(m).replace(/"/g, '&quot;');
          return '<button class="list-group-item list-group-item-action py-2" onclick="selectModel(' + mJson + ')"><strong>' + esc(m.id||m.name) + '</strong>' + subText + '</button>';
        }).join('') || '<div class="p-3 text-center text-muted">No models found</div>';
      };
      const selectModel = (m) => {
        const id = (m.id || m.name || '').toLowerCase();
        if (currentModelTarget === 'primary') {
          document.getElementById('ch-model').value = m.id || m.name;
          if (m.max_tokens) document.getElementById('ch-tokens').value = m.max_tokens;
          if (m.rpm) document.getElementById('ch-rpm').value = m.rpm;
          if (m.rpd) document.getElementById('ch-rpd').value = m.rpd;
          if (m.tpm) document.getElementById('ch-tpm').value = m.tpm;
          if (m.tpd) document.getElementById('ch-tpd').value = m.tpd;

          // Auto-detect Vision/Tools support from model name
          if (id.includes('vision') || id.includes('claude-3') || id.includes('gpt-4o') || id.includes('gemini-1.5') || id.includes('gemini-exp') || id.includes('gpt-4-turbo') || id.includes('deepseek')) {
            document.getElementById('ch-vision').checked = true;
            document.getElementById('ch-tools').checked = true;
          } else {
            document.getElementById('ch-vision').checked = false;
            document.getElementById('ch-tools').checked = false;
          }
        } else {
          document.getElementById('ch-fallback-model').value = m.id || m.name;
        }
        modelsModal.hide();
        chModal.show();
      };

      const toggleSort = (key) => {
        if (sortKey === key) {
          sortOrder = (sortOrder + 1) % 3;
          if (sortOrder === 0) sortKey = null;
        } else {
          sortKey = key; sortOrder = 1;
        }
        renderChannels();
      };

      const resetAllHealth = async () => { confirm('重置所有渠道健康狀態？', async () => { await api('/admin/api/channels/reset-all-health', 'POST'); init(); }); };
      const exportJson = () => {
        const now = new Date(); const pad = (n) => String(n).padStart(2, '0');
        const ts = now.getFullYear() + pad(now.getMonth()+1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
        const data = { channels, filters, config: { token: document.getElementById('cfg-token').value, recovery_period: document.getElementById('cfg-recovery-period').value } };
        const b = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'api-gateway-' + ts + '.json'; a.click();
      };
      const importJson = (e) => { const r = new FileReader(); r.onload = async (ev) => { const d = JSON.parse(ev.target.result); if (await api('/admin/api/import-all', 'POST', d)) { toast('匯入成功', 'success'); init(); } }; r.readAsText(e.target.files[0]); };
      const resetSystem = async () => { confirm('重置系統將清除所有頻道、過濾器與設定（不含密碼），確定？', async () => { await api('/admin/api/reset', 'POST'); location.reload(); }); };
      const checkAuth = async () => {
        // 檢查是否需要設定密碼
        try {
          const authRes = await fetch('/admin/api/auth-status');
          const authData = await authRes.json();
          if (authData.needsSetup) {
            showSetup();
            return;
          }

          const storedToken = sessionStorage.getItem('adminToken');
          if (storedToken) {
            const r = await fetch('/admin/api/verify-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: storedToken })
            });
            const data = await r.json();
            if (data.valid) {
              sessionStorage.setItem('adminLoggedIn', '1');
              showAdmin();
            } else {
              sessionStorage.removeItem('adminToken');
              sessionStorage.removeItem('adminLoggedIn');
              showLogin();
            }
          } else {
            showLogin();
          }
        } catch (e) {
          showLogin();
        }
      };

      window.onload = () => {
        const t = localStorage.getItem('theme') || 'light'; document.documentElement.setAttribute('data-bs-theme', t); document.getElementById('theme-icon').className = t === 'dark' ? 'bi bi-moon-fill' : 'bi bi-sun';
        chModal = new bootstrap.Modal(document.getElementById('chModal'), { backdrop: 'static' });
        passModal = new bootstrap.Modal(document.getElementById('passModal'), { backdrop: 'static' });
        debugModal = new bootstrap.Modal(document.getElementById('debugModal'), { backdrop: 'static' });
        modelsModal = new bootstrap.Modal(document.getElementById('modelsModal'), { backdrop: 'static' });
        modelsModal._element.addEventListener('hidden.bs.modal', () => { chModal.show(); });
        const goTopBtn = document.getElementById('go-top-btn');
        const updateGoTop = () => { const hasModal = document.body.classList.contains('modal-open'); goTopBtn.style.display = (!hasModal && window.scrollY > 200) ? 'block' : 'none'; };
        window.addEventListener('scroll', updateGoTop);
        [chModal, passModal, debugModal, modelsModal].forEach(m => { m._element.addEventListener('shown.bs.modal', updateGoTop); m._element.addEventListener('hidden.bs.modal', updateGoTop); });

        // 執行驗證
        checkAuth();
      };

      // 快速路徑：如果 Session 已登入，立即顯示 Admin 介面，減少閃爍感
      if (sessionStorage.getItem('adminLoggedIn') === '1') {
        document.addEventListener('DOMContentLoaded', () => {
          document.getElementById('admin-view').style.display = 'block';
        });
      }
    </script>
  </body>
  </html>`;

  app.get("/admin", (c) => c.html(UI_SHELL));
  app.get("/", (c) => c.redirect("/admin"));

  return app;
}
