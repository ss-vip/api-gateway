import { Hono } from 'hono'
import { html } from 'hono/html'

export default function(clearCache) {
  const app = new Hono()

  const DEFAULTS = { token: 'sk-test123456', pass: 'adm123456', cooldown: 300 }

  const getAdminPass = async (c) => {
    try {
      const cf = await c.env.DB.prepare("SELECT admin_password FROM config WHERE id=1").first()
      return cf?.admin_password || c.env.ADMIN_PASSWORD || DEFAULTS.pass
    } catch (e) {
      return c.env.ADMIN_PASSWORD || DEFAULTS.pass
    }
  }

  app.use('/admin/api/*', async (c, next) => {
    const pass = await getAdminPass(c)
    if (!pass) return await next()
    if (c.req.header("X-Admin-Token") !== pass) return c.json({ error: "Unauthorized" }, 401)
    await next()
  })

  app.get('/admin/api', async c => {
    const { results } = await c.env.DB.prepare("SELECT * FROM channels ORDER BY id").all()
    return c.json(results || [])
  })

  app.post('/admin/api/batch-channels', async c => {
    const channels = await c.req.json()
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM channels"),
      ...channels.map(ch => c.env.DB.prepare(`INSERT INTO channels (name, base_url, api_key, provider, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, tpm_limit, tpd_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(ch.name, ch.base_url || "", ch.api_key || "", ch.provider || "openai", ch.model || "", ch.weight || 1, ch.is_enabled ? 1 : 0, ch.is_vision ? 1 : 0, ch.last_429 || 0, ch.consecutive_errors || 0, ch.last_error_msg || "", ch.last_error_at || 0, ch.rpm_limit || 0, ch.rpd_limit || 0, ch.tpm_limit || 0, ch.tpd_limit || 0))
    ])
    clearCache()
    return c.json({ ok: true })
  })

  app.post('/admin/api/channels/:id/reset-health', async c => {
    const id = c.req.param('id')
    await c.env.DB.prepare("UPDATE channels SET last_429=0,consecutive_errors=0,last_error_msg='',last_error_at=0 WHERE id=?").bind(id).run()
    clearCache()
    return c.json({ ok: true })
  })

  app.post('/admin/api/channels/reset-all-health', async c => {
    await c.env.DB.prepare("UPDATE channels SET last_429=0,consecutive_errors=0,last_error_msg='',last_error_at=0").run()
    clearCache()
    return c.json({ ok: true })
  })

  app.get('/admin/api/filters', async c => {
    const { results } = await c.env.DB.prepare("SELECT * FROM filters ORDER BY id").all()
    return c.json(results || [])
  })

  app.post('/admin/api/filters', async c => {
    const filters = await c.req.json()
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM filters"),
      ...filters.map(f => c.env.DB.prepare(`INSERT INTO filters (text, mode, is_enabled) VALUES (?, ?, ?)`).bind(f.text, f.mode || 1, f.is_enabled ? 1 : 0))
    ])
    clearCache()
    return c.json({ ok: true })
  })

  app.get('/admin/api/config', async c => {
    const cf = await c.env.DB.prepare("SELECT * FROM config WHERE id=1").first()
    return c.json({ token: cf?.client_token || DEFAULTS.token, cooldown: cf?.cooldown_time || DEFAULTS.cooldown })
  })

  app.post('/admin/api/config', async c => {
    const b = await c.req.json()
    const ex = await c.env.DB.prepare("SELECT id FROM config WHERE id=1").first()
    const currentPass = await getAdminPass(c)
    if (ex) {
      await c.env.DB.prepare(`UPDATE config SET client_token=?,cooldown_time=? WHERE id=1`).bind(b.token || DEFAULTS.token, parseInt(b.cooldown) || DEFAULTS.cooldown).run()
    } else {
      await c.env.DB.prepare(`INSERT INTO config (id,client_token,admin_password,cooldown_time) VALUES (1,?,?,?)`).bind(b.token || DEFAULTS.token, currentPass, parseInt(b.cooldown) || DEFAULTS.cooldown).run()
    }
    clearCache()
    return c.json({ ok: true })
  })

  app.post('/admin/api/admin-pass', async c => {
    const { pass } = await c.req.json()
    if (!pass) return c.json({ error: 'Password required' }, 400)
    const ex = await c.env.DB.prepare("SELECT id FROM config WHERE id=1").first()
    if (ex) {
      await c.env.DB.prepare(`UPDATE config SET admin_password=? WHERE id=1`).bind(pass).run()
    } else {
      await c.env.DB.prepare(`INSERT INTO config (id,admin_password) VALUES (1,?)`).bind(pass).run()
    }
    clearCache()
    return c.json({ ok: true })
  })

  app.post('/admin/api/import-all', async c => {
    const d = await c.req.json()
    const batch = []
    if (d.channels) {
      batch.push(c.env.DB.prepare("DELETE FROM channels"))
      d.channels.forEach(ch => {
        batch.push(c.env.DB.prepare(`INSERT INTO channels (name, base_url, api_key, provider, model, weight, is_enabled, is_vision, last_429, consecutive_errors, last_error_msg, last_error_at, rpm_limit, rpd_limit, tpm_limit, tpd_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(ch.name, ch.base_url || "", ch.api_key || "", ch.provider || "openai", ch.model || "", ch.weight || 1, ch.is_enabled ? 1 : 0, ch.is_vision ? 1 : 0, ch.last_429 || 0, ch.consecutive_errors || 0, ch.last_error_msg || "", ch.last_error_at || 0, ch.rpm_limit || 0, ch.rpd_limit || 0, ch.tpm_limit || 0, ch.tpd_limit || 0))
      })
    }
    if (d.filters) {
      batch.push(c.env.DB.prepare("DELETE FROM filters"))
      d.filters.forEach(f => {
        batch.push(c.env.DB.prepare(`INSERT INTO filters (text, mode, is_enabled) VALUES (?, ?, ?)`).bind(f.text, f.mode || 1, f.is_enabled ? 1 : 0))
      })
    }
    if (d.config) {
      const currentPass = await getAdminPass(c)
      batch.push(c.env.DB.prepare(`INSERT OR REPLACE INTO config (id,client_token,admin_password,cooldown_time) VALUES (1,?,?,?)`).bind(d.config.token || DEFAULTS.token, currentPass, parseInt(d.config.cooldown) || DEFAULTS.cooldown))
    }
    if (batch.length > 0) await c.env.DB.batch(batch)
    clearCache()
    return c.json({ ok: true })
  })

  app.post('/admin/login', async c => {
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
    const banKey = `ban:${ip}`, failKey = `fail:${ip}`
    try {
      const banned = await c.env.KV.get(banKey)
      if (banned) return c.json({ error: '登入嘗試過多，IP 已暫時封鎖，請 1 小時後再試' }, 429)
    } catch (e) {}
    const { password } = await c.req.json()
    const pass = await getAdminPass(c)
    if (password === pass) {
      try { await c.env.KV.delete(failKey) } catch (e) {}
      return c.json({ ok: true })
    }
    try {
      const failData = await c.env.KV.get(failKey, 'json') || { count: 0 }
      failData.count++
      if (failData.count >= 5) {
        await c.env.KV.put(banKey, '1', { expirationTtl: 3600 })
        await c.env.KV.delete(failKey)
        return c.json({ error: 'IP 已被封鎖 1 小時（連續失敗 5 次）' }, 429)
      }
      await c.env.KV.put(failKey, JSON.stringify(failData), { expirationTtl: 900 })
    } catch (e) {}
    return c.json({ error: '密碼錯誤' }, 401)
  })

  app.post('/admin/api/reset', async c => {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM channels"),
      c.env.DB.prepare("DELETE FROM filters"),
      c.env.DB.prepare("INSERT OR REPLACE INTO config (id, client_token, admin_password, cooldown_time) VALUES (1, ?, ?, ?)").bind(DEFAULTS.token, DEFAULTS.pass, DEFAULTS.cooldown)
    ])
    clearCache()
    return c.json({ ok: true })
  })

  const UI_SHELL = html`<!DOCTYPE html>
  <html lang="zh-TW" data-bs-theme="light">
  <head>
    <meta charset="UTF-8" /><title>API Gateway</title><meta name="viewport" content="width=device-width, initial-scale=1" />
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" />
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet" />
    <style>
      body { background: var(--bs-tertiary-bg); font-family: system-ui, -apple-system, sans-serif; transition: 0.3s; }
      .card { border: none; box-shadow: 0 0.125rem 0.25rem rgba(0,0,0,0.075); border-radius: 12px; }
      #login-view, #admin-view { display: none; }
      .navbar { backdrop-filter: blur(10px); background: rgba(var(--bs-body-bg-rgb), 0.8) !important; }
      .form-switch .form-check-input { cursor: pointer; }
      .badge { font-weight: 600; letter-spacing: 0.5px; padding: 0.4em 0.8em; }
      .font-monospace { font-family: "Fira Code", monospace !important; }
      .health-badge { cursor: help; }
      #loading-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 9999; display: none; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
      .spinner-border { width: 3rem; height: 3rem; color: white; }
      .stat-card { border-left: 4px solid var(--bs-primary); }
      .table-responsive { border-radius: 12px; overflow: hidden; }
      @media (max-width: 576px) {
        .navbar-brand { font-size: 1rem; }
        .btn-sm { padding: 0.25rem 0.5rem; font-size: 0.75rem; }
        .card-header span { font-size: 0.85rem; }
        .input-group-text { font-size: 0.7rem; }
      }
    </style>
  </head>
  <body>
    <div id="loading-overlay"><div class="spinner-border text-light" role="status"></div></div>
    <div id="login-view" class="container py-5 mt-5">
      <div class="row justify-content-center pt-5"><div class="col-md-4"><div class="card p-4"><div class="card-body text-center">
        <h4 class="fw-bold mb-4">API Gateway</h4>
        <form id="loginForm"><div class="mb-4 text-start"><label class="form-label small fw-bold">ADMIN PASSWORD</label><input type="password" id="login-pass" class="form-control" /></div><button type="submit" class="btn btn-primary w-100 fw-bold py-2">LOGIN</button></form>
      </div></div></div></div>
    </div>

    <div id="admin-view">
      <nav class="navbar navbar-expand border-bottom sticky-top mb-4 py-2"><div class="container">
        <a class="navbar-brand fw-bold text-primary" href="#">Gateway</a>
        <div class="ms-auto d-flex gap-2 align-items-center">
          <button onclick="toggleTheme()" class="btn btn-sm btn-outline-secondary border-0 px-2"><i id="theme-icon" class="bi bi-sun"></i></button>
          <div class="dropdown">
            <button class="btn btn-sm btn-outline-primary dropdown-toggle fw-bold" data-bs-toggle="dropdown">TOOLS</button>
            <ul class="dropdown-menu dropdown-menu-end shadow border-0">
              <li><button class="dropdown-item py-2 small" onclick="passModal.show()"><i class="bi bi-shield-lock me-2"></i>Update Pass</button></li>
              <li><button class="dropdown-item py-2 small" onclick="exportJson()"><i class="bi bi-download me-2"></i>Export JSON</button></li>
              <li><label class="dropdown-item py-2 small mb-0 cursor-pointer" style="cursor:pointer"><i class="bi bi-upload me-2"></i>Import JSON<input type="file" onchange="importJson(event)" style="display:none" /></label></li>
              <li><hr class="dropdown-divider"></li>
              <li><button class="dropdown-item py-2 small text-danger" onclick="resetSystem()"><i class="bi bi-arrow-counterclockwise me-2"></i>System Reset</button></li>
            </ul>
          </div>
          <button onclick="logout()" class="btn btn-danger btn-sm fw-bold px-3">LOGOUT</button>
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
              <div class="col-md-8"><div class="input-group input-group-sm"><span class="input-group-text fw-bold small">TOKEN</span><input type="text" id="cfg-token" class="form-control font-monospace" /><button class="btn btn-outline-secondary" onclick="copyToken()"><i class="bi bi-copy"></i></button></div></div>
              <div class="col-md-4"><div class="input-group input-group-sm"><span class="input-group-text fw-bold small">429 Cooldown (s)</span><input type="number" id="cfg-cooldown" class="form-control" /></div></div>
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
            <div class="d-flex gap-2"><button onclick="openChannelModal()" class="btn btn-outline-primary btn-sm px-3 fw-bold">ADD</button><button onclick="resetAllHealth()" class="btn btn-outline-success btn-sm px-3 fw-bold">RESET ALL</button><button onclick="saveAllChannels()" class="btn btn-primary btn-sm px-3 fw-bold">SAVE ALL</button></div>
          </div>
          <div class="table-responsive"><table class="table table-hover mb-0 text-center align-middle small">
            <thead class="table-light"><tr>
              <th>ON/OFF</th>
              <th class="d-none d-sm-table-cell">ID</th>
              <th>Name</th>
              <th>Model <i class="bi bi-info-circle" data-bs-toggle="tooltip" title="圖像請求將優先調用視覺模型"></i></th>
              <th class="d-none d-sm-table-cell">Weight <i class="bi bi-info-circle" data-bs-toggle="tooltip" title="權重越高分配機率越大"></i></th>
              <th>Health <i class="bi bi-info-circle" data-bs-toggle="tooltip" title="健康狀態，連續失敗5次將熔斷"></i></th>
              <th>Actions</th>
            </tr></thead>
            <tbody id="channel-list"></tbody>
          </table></div>
        </div>
        <div class="card border-0 shadow-sm">
          <div class="card-header bg-transparent fw-bold d-flex justify-content-between align-items-center py-3 border-0">
            <span>Filters</span>
            <div class="d-flex gap-2"><button onclick="addFilter()" class="btn btn-outline-info btn-sm px-3 fw-bold">ADD</button><button onclick="saveAllFilters()" class="btn btn-info btn-sm px-3 fw-bold">SAVE ALL</button></div>
          </div>
          <div class="table-responsive"><table class="table table-hover mb-0 text-center align-middle small">
            <thead class="table-light"><tr>
              <th>ON/OFF</th>
              <th>Keyword <i class="bi bi-info-circle" data-bs-toggle="tooltip" title="命中關鍵字後的過濾動作。建議使用廣告句的特徵前綴，長度限 1–30 字元"></i></th>
              <th class="d-none d-sm-table-cell" style="width: 120px;">Mode</th>
              <th>Actions</th>
            </tr></thead>
            <tbody id="filter-list"></tbody>
          </table></div>
        </div>
      </div>
    </div>

    <div class="modal fade" id="passModal" tabindex="-1"><div class="modal-dialog modal-dialog-centered modal-sm"><div class="modal-content">
      <div class="modal-header border-0 pb-0"><h5 class="fw-bold">Update Admin Pass</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close" onclick="this.blur()"></button></div>
      <div class="modal-body p-4"><input type="password" id="new-admin-pass" class="form-control" placeholder="New Password" /></div>
      <div class="modal-footer border-0 pt-0"><button onclick="updateAdminPass()" class="btn btn-warning w-100 fw-bold">UPDATE & LOGOUT</button></div>
    </div></div></div>

    <div class="modal fade" id="chModal" tabindex="-1"><div class="modal-dialog modal-dialog-centered"><div class="modal-content">
      <div class="modal-header border-0 pb-0">
        <div class="d-flex align-items-center gap-2">
          <h5 class="fw-bold small mb-0">Channel Editor</h5>
          <span id="ch-id-badge" class="badge bg-secondary" style="display:none"></span>
        </div>
        <button type="button" class="btn-close ms-auto" data-bs-dismiss="modal" aria-label="Close" onclick="this.blur()"></button>
      </div>
      <div class="modal-body p-3 p-md-4">
        <input type="hidden" id="ch-idx" />
        <input type="hidden" id="ch-id" />
        <div class="mb-2"><label class="form-label mini-label fw-bold">Name *</label><input type="text" id="ch-name" class="form-control form-control-sm" /></div>
        <div class="mb-2"><label class="form-label mini-label fw-bold">API Key</label><div class="input-group input-group-sm"><input type="password" id="ch-key" class="form-control form-control-sm" /><button class="btn btn-outline-secondary" type="button" onclick="toggleKeyVis()" title="Toggle visibility">&#128065;</button></div></div>
        <div class="mb-2"><label class="form-label mini-label fw-bold">Base URL <span class="text-muted fw-normal" style="font-size:0.6rem">建議結尾包含 /v1</span></label><input type="text" id="ch-url" class="form-control form-control-sm" placeholder="https://api.example.com/v1" /></div>
        <div class="row g-2 mb-2"><div class="col-6"><label class="form-label mini-label fw-bold">Model</label><input type="text" id="ch-model" class="form-control form-control-sm" /></div><div class="col-6"><label class="form-label mini-label fw-bold">Weight</label><input type="number" id="ch-weight" class="form-control form-control-sm" value="1" /></div></div>
        <div class="row g-1 mb-2">
          <div class="col-3"><label class="form-label mini-label fw-bold">RPM</label><input type="number" id="ch-rpm" class="form-control form-control-sm p-1" value="0" /></div>
          <div class="col-3"><label class="form-label mini-label fw-bold">RPD</label><input type="number" id="ch-rpd" class="form-control form-control-sm p-1" value="0" /></div>
          <div class="col-3"><label class="form-label mini-label fw-bold">TPM</label><input type="number" id="ch-tpm" class="form-control form-control-sm p-1" value="0" /></div>
          <div class="col-3"><label class="form-label mini-label fw-bold">TPD</label><input type="number" id="ch-tpd" class="form-control form-control-sm p-1" value="0" /></div>
        </div>
        <div class="row g-2 mt-3 pt-2 border-top">
          <div class="col-6 d-flex flex-column align-items-center">
            <label class="form-check-label small fw-bold mb-1" for="ch-vision">Vision</label>
            <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="ch-vision"></div>
          </div>
          <div class="col-6 d-flex flex-column align-items-center">
            <label class="form-check-label small fw-bold mb-1" for="ch-enabled">Enabled</label>
            <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="ch-enabled" checked></div>
          </div>
        </div>
      </div>
      <div class="modal-footer border-0 pt-0"><button onclick="applyChannel()" class="btn btn-primary w-100 fw-bold">APPLY</button></div>
    </div></div></div>

    <style>.mini-label { font-size: 0.65rem; margin-bottom: 2px; text-transform: uppercase; color: var(--bs-secondary); }</style>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
    <script>
      let chModal, passModal, channels = [], filters = [], cooldown = 300, refreshTimer = null, lastChannelsStr = '';
      const loading = (s) => document.getElementById('loading-overlay').style.display = s ? 'flex' : 'none';
      const api = async (u, m='GET', b=null, showLoader=true) => {
        if (showLoader) loading(true);
        const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': sessionStorage.getItem('adminToken') || '' }, body: b ? JSON.stringify(b) : null });
        if (showLoader) loading(false);
        if (r.status === 401) { showLogin(); return null; }
        if (!r.ok) { const err = await r.json(); alert(err.error || 'Request Failed'); return null; }
        return r.json();
      };
      const showLogin = () => { document.getElementById('admin-view').style.display = 'none'; document.getElementById('login-view').style.display = 'block'; };
      const showAdmin = () => { document.getElementById('login-view').style.display = 'none'; document.getElementById('admin-view').style.display = 'block'; init(); };
      const logout = () => { sessionStorage.removeItem('adminToken'); location.reload(); };
      const toggleTheme = () => { const t = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-bs-theme', t); document.getElementById('theme-icon').className = t === 'dark' ? 'bi bi-moon-fill' : 'bi bi-sun'; localStorage.setItem('theme', t); };
      const copyToken = () => { const t = document.getElementById('cfg-token'); t.select(); document.execCommand('copy'); alert('Token Copied'); };
      const esc = (s) => String(s || "").replace(/[\\"\\n\\r\\t]/g, ' ').replace(/"/g, '&quot;');
      const initTooltips = () => { [...document.querySelectorAll('[data-bs-toggle="tooltip"]')].map(el => new bootstrap.Tooltip(el)); };

      document.getElementById('loginForm').onsubmit = async (e) => { e.preventDefault(); const p = document.getElementById('login-pass').value; loading(true); try { const r = await fetch('/admin/login', { method: 'POST', body: JSON.stringify({ password: p }) }); loading(false); if (r.ok) { sessionStorage.setItem('adminToken', p); showAdmin(); } else { const err = await r.json(); alert(err.error || '密碼錯誤'); } } catch(err) { loading(false); alert('網絡或資料庫異常，請確保已執行 D1 初始化'); } };

      const init = async () => {
        const cfg = await api('/admin/api/config'); if (!cfg) return;
        document.getElementById('cfg-token').value = cfg.token; document.getElementById('cfg-cooldown').value = cfg.cooldown; cooldown = cfg.cooldown;
        const initData = await api('/admin/api');
        if (initData) { channels = initData; lastChannelsStr = JSON.stringify(channels); }
        filters = await api('/admin/api/filters');
        renderStats(); renderChannels(); renderFilters(); initTooltips();
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
        const cooling = channels.filter(c => c.is_enabled && (now - (c.last_429 || 0) < cooldown)).length;
        const error = channels.filter(c => c.is_enabled && c.consecutive_errors >= 5).length;
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
          { label: 'Cooling', val: cooling, textClass: 'text-info' },
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
              '<div class="card-body p-3">' +
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
        const filtered = channels.filter(c => c.name.toLowerCase().includes(query) || (c.model||'').toLowerCase().includes(query));
        document.getElementById('channel-list').innerHTML = filtered.map((c) => {
          const realIdx = channels.indexOf(c);
          let h = '<span class="badge bg-success health-badge">正常</span>';
          if (c.consecutive_errors >= 5) {
            if (now - (c.last_error_at || 0) > 604800) h = '<span class="badge bg-secondary health-badge" title="Observed (Retry soon)">觀察</span>';
            else h = '<span class="badge bg-danger health-badge" title="' + esc(c.last_error_msg || 'Multiple errors') + '">異常</span>';
          }
          else if (now - (c.last_429 || 0) < cooldown) h = '<span class="badge bg-info health-badge" title="Cooldown active">冷卻</span>';
          else if (c.consecutive_errors > 0) h = '<span class="badge bg-warning text-dark health-badge" title="' + esc(c.last_error_msg || 'Minor errors') + '">不穩</span>';
          else if (c.rpd_limit > 0 && (now - (c.rpd_reset_at || 0)) < 86400 && (c.rpd_count || 0) >= c.rpd_limit) h = '<span class="badge bg-dark health-badge" title="RPD exhausted: ' + c.rpd_count + '/' + c.rpd_limit + '">限額</span>';
          return '<tr>' +
            '<td><div class="form-check form-switch d-inline-block"><input class="form-check-input" type="checkbox" ' + (c.is_enabled?'checked':'') + ' onchange="channels[' + realIdx + '].is_enabled=this.checked;renderStats()"></div></td>' +
            '<td class="d-none d-sm-table-cell text-muted small">' + (c.id || '-') + '</td>' +
            '<td class="fw-bold">' + c.name + '</td>' +
            '<td><code class="small">' + (c.model || '-') + '</code> ' + (c.is_vision?'👁️':'') + '</td>' +
            '<td class="d-none d-sm-table-cell">' + c.weight + '</td>' +
            '<td>' + h + '</td>' +
            '<td>' +
              '<div class="d-none d-md-flex justify-content-center gap-1">' +
                '<button onclick="editChannel(' + realIdx + ')" class="btn btn-sm btn-outline-primary py-0 px-2">Edit</button>' +
                '<button onclick="resetHealth(' + c.id + ')" class="btn btn-sm btn-outline-success py-0 px-2">Reset</button>' +
                '<button onclick="copyChannel(' + realIdx + ')" class="btn btn-sm btn-outline-secondary py-0 px-2">Copy</button>' +
                '<button onclick="delChannel(' + realIdx + ')" class="btn btn-sm btn-outline-danger py-0 px-2">Del</button>' +
              '</div>' +
              '<div class="d-md-none dropdown">' +
                '<button class="btn btn-sm btn-light py-0 px-2" type="button" data-bs-toggle="dropdown"><i class="bi bi-three-dots-vertical"></i></button>' +
                '<ul class="dropdown-menu dropdown-menu-end shadow border-0">' +
                  '<li><button onclick="editChannel(' + realIdx + ')" class="dropdown-item small">Edit</button></li>' +
                  '<li><button onclick="resetHealth(' + c.id + ')" class="dropdown-item small">Reset Health</button></li>' +
                  '<li><button onclick="copyChannel(' + realIdx + ')" class="dropdown-item small">Copy</button></li>' +
                  '<li><button onclick="delChannel(' + realIdx + ')" class="dropdown-item small text-danger">Delete</button></li>' +
                '</ul>' +
              '</div>' +
            '</td>' +
          '</tr>';
        }).join('') || '<tr><td colspan="7" class="py-4 text-muted">No channels.</td></tr>';
        initTooltips();
      };

      const resetHealth = async (id) => {
        if (!id) return alert('Please save channels first');
        if (!confirm('確定重置該渠道健康狀態？')) return;
        await api('/admin/api/channels/' + id + '/reset-health', 'POST');
        init();
      };

      const updateAdminPass = async () => {
        if (document.activeElement) document.activeElement.blur();
        const p = document.getElementById('new-admin-pass').value;
        if (!p) return alert('Password required');
        if (!confirm('更換密碼後將自動登出，確定？')) return;
        await api('/admin/api/admin-pass', 'POST', { pass: p });
        logout();
      };

      const renderFilters = () => {
        document.getElementById('filter-list').innerHTML = filters.map((f, i) => '<tr>' +
          '<td><div class="form-check form-switch d-inline-block"><input class="form-check-input" type="checkbox" ' + (f.is_enabled?'checked':'') + ' onchange="filters[' + i + '].is_enabled=this.checked"></div></td>' +
          '<td><input type="text" class="form-control form-control-sm font-monospace" maxlength="30" placeholder="廣告特徵前綴（建議 1-30 字）" value="' + esc(f.text) + '" oninput="filters[' + i + '].text=this.value" data-bs-toggle="tooltip" title="長度限 1-30 字元，取廣告句特徵前綴即可"></td>' +
          '<td class="d-none d-sm-table-cell"><select class="form-select form-select-sm" onchange="filters[' + i + '].mode=parseInt(this.value)"><option value="1" ' + (f.mode==1?'selected':'') + '>Truncate</option><option value="0" ' + (f.mode==0?'selected':'') + '>Delete</option></select></td>' +
          '<td><button onclick="filters.splice(' + i + ',1);renderFilters()" class="btn btn-sm btn-outline-danger py-0 px-2"><i class="bi bi-trash"></i></button></td>' +
        '</tr>').join('') || '<tr><td colspan="4" class="py-4 text-muted">No filters.</td></tr>';
        initTooltips();
      };

      const saveConfig = async () => { await api('/admin/api/config', 'POST', { token: document.getElementById('cfg-token').value, cooldown: document.getElementById('cfg-cooldown').value }); alert('Saved'); };
      const saveAllChannels = async () => { await api('/admin/api/batch-channels', 'POST', channels); alert('Channels Saved'); init(); };
      const saveAllFilters = async () => {
        const invalid = filters.filter(f => f.text && (f.text.length === 0 || f.text.length > 30));
        if (invalid.length > 0) return alert('過濾關鍵字長度須介於 1–30 字元，請修正後再儲存。');
        await api('/admin/api/filters', 'POST', filters); alert('Filters Saved'); renderFilters();
      };
      const addFilter = () => { filters.push({ text: '', mode: 1, is_enabled: true }); renderFilters(); };
      const openChannelModal = () => { document.getElementById('ch-idx').value = ''; document.getElementById('ch-id').value = ''; const b = document.getElementById('ch-id-badge'); b.textContent = ''; b.style.display = 'none'; ['ch-name','ch-key','ch-url','ch-model'].forEach(i=>document.getElementById(i).value=''); document.getElementById('ch-weight').value=1; ['ch-rpm','ch-rpd','ch-tpm','ch-tpd'].forEach(i=>document.getElementById(i).value=0); document.getElementById('ch-enabled').checked=true; document.getElementById('ch-vision').checked=false; chModal.show(); };
      const editChannel = (idx) => {
        const c = channels[idx]; document.getElementById('ch-idx').value = idx; document.getElementById('ch-id').value = c.id || ''; const badge = document.getElementById('ch-id-badge'); if (c.id) { badge.textContent = '#' + c.id; badge.style.display = ''; } else { badge.textContent = ''; badge.style.display = 'none'; } document.getElementById('ch-name').value = c.name; document.getElementById('ch-key').value = c.api_key; document.getElementById('ch-url').value = c.base_url; document.getElementById('ch-model').value = c.model; document.getElementById('ch-weight').value = c.weight; document.getElementById('ch-rpm').value = c.rpm_limit || 0; document.getElementById('ch-rpd').value = c.rpd_limit || 0; document.getElementById('ch-tpm').value = c.tpm_limit || 0; document.getElementById('ch-tpd').value = c.tpd_limit || 0; document.getElementById('ch-vision').checked = c.is_vision == 1; document.getElementById('ch-enabled').checked = c.is_enabled == 1; chModal.show();
      };
      const applyChannel = () => {
        if (document.activeElement) document.activeElement.blur();
        const idx = document.getElementById('ch-idx').value;
        const name = document.getElementById('ch-name').value.trim();
        if (!name) return alert('Name is required');
        const url = document.getElementById('ch-url').value.trim().replace(/\\/+$/, '');
        const prev = idx !== '' ? channels[idx] : null;
        const b = { name, api_key: document.getElementById('ch-key').value, base_url: url, provider: 'openai', model: document.getElementById('ch-model').value, weight: parseInt(document.getElementById('ch-weight').value), rpm_limit: parseInt(document.getElementById('ch-rpm').value), rpd_limit: parseInt(document.getElementById('ch-rpd').value), tpm_limit: parseInt(document.getElementById('ch-tpm').value), tpd_limit: parseInt(document.getElementById('ch-tpd').value), is_vision: document.getElementById('ch-vision').checked, is_enabled: document.getElementById('ch-enabled').checked, last_429: prev ? prev.last_429||0 : 0, consecutive_errors: prev ? prev.consecutive_errors||0 : 0, last_error_msg: prev ? prev.last_error_msg||'' : '', last_error_at: prev ? prev.last_error_at||0 : 0 };
        if (idx !== '') channels[idx] = b; else channels.push(b); chModal.hide(); renderChannels(); renderStats();
      };
      const delChannel = (idx) => { if (confirm('Delete?')) { channels.splice(idx, 1); renderChannels(); renderStats(); } };
      const copyChannel = (idx) => { const src = channels[idx]; channels.push({ ...src, name: src.name + ' (copy)', id: undefined, last_429: 0, consecutive_errors: 0, last_error_msg: '', last_error_at: 0 }); renderChannels(); renderStats(); };
      const toggleKeyVis = () => { const i = document.getElementById('ch-key'); i.type = i.type === 'password' ? 'text' : 'password'; };
      const resetAllHealth = async () => { if (!confirm('重置所有渠道健康狀態？')) return; await api('/admin/api/channels/reset-all-health', 'POST'); init(); };
      const exportJson = () => {
        const now = new Date(); const pad = (n) => String(n).padStart(2, '0');
        const ts = now.getFullYear() + pad(now.getMonth()+1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
        const data = { channels, filters, config: { token: document.getElementById('cfg-token').value, cooldown: document.getElementById('cfg-cooldown').value } };
        const b = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'api-gateway-' + ts + '.json'; a.click();
      };
      const importJson = (e) => { const r = new FileReader(); r.onload = async (ev) => { const d = JSON.parse(ev.target.result); if (await api('/admin/api/import-all', 'POST', d)) { alert('Imported Successfully'); init(); } }; r.readAsText(e.target.files[0]); };
      const resetSystem = async () => { if (confirm('Reset All?')) { await api('/admin/api/reset', 'POST'); location.reload(); } };
      window.onload = async () => {
        const t = localStorage.getItem('theme') || 'light'; document.documentElement.setAttribute('data-bs-theme', t); document.getElementById('theme-icon').className = t === 'dark' ? 'bi bi-moon-fill' : 'bi bi-sun';
        chModal = new bootstrap.Modal(document.getElementById('chModal'));
        passModal = new bootstrap.Modal(document.getElementById('passModal'));
        const r = await fetch('/admin/login', { method: 'POST', body: JSON.stringify({ password: sessionStorage.getItem('adminToken') || '' }) });
        if (r.ok) showAdmin(); else showLogin();
      };
    </script>
  </body>
  </html>`

  app.get('/admin', c => c.html(UI_SHELL))
  app.get('/', c => c.redirect('/admin'))

  return app
}