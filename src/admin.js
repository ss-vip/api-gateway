import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { html } from "hono/html";
import {
  getDbConfig,
  updateDbConfig,
  getChannels,
  getChannelById,
  getLogs,
  getLogById,
  clearLogs,
  getFilters,
  addFilter,
  updateFilter,
  deleteFilter,
} from "./db.js";

const LOGIN_UI = html` <div class="container py-5 mt-5">
  <div class="row justify-content-center pt-5">
    <div class="col-md-5 col-lg-4">
      <div class="card p-4 border-0 shadow-sm">
        <div class="card-body text-center">
          <div class="mb-4 text-primary">
            <i class="bi bi-shield-lock-fill h1"></i>
          </div>
          <h4 class="fw-bold mb-4">API Gateway</h4>
          <form action="/admin/login" method="POST">
            <div class="mb-4 text-start">
              <label class="form-label small fw-bold">PASSWORD</label>
              <input
                type="password"
                name="password"
                class="form-control"
                placeholder="請輸入密碼"
                required
                autofocus
              />
            </div>
            <button type="submit" class="btn btn-primary w-100 fw-bold py-2">
              LOGIN
            </button>
          </form>
        </div>
      </div>
    </div>
  </div>
</div>`;

const DASHBOARD_UI = html` <nav
    class="navbar navbar-expand-md navbar-light bg-body-tertiary sticky-top mb-4 py-2 border-bottom shadow-sm"
  >
    <div class="container">
      <a class="navbar-brand fw-bold d-flex align-items-center" href="#">
        <i class="bi bi-terminal-fill me-2 text-primary"></i>
        <span class="d-none d-sm-inline">Dashboard</span>
      </a>
      <button
        class="navbar-toggler border-0 shadow-none"
        type="button"
        data-bs-toggle="collapse"
        data-bs-target="#navContent"
      >
        <span class="navbar-toggler-icon"></span>
      </button>
      <div class="collapse navbar-collapse" id="navContent">
        <div
          class="ms-auto d-flex flex-wrap align-items-center gap-2 mt-3 mt-md-0"
        >
          <div class="btn-group btn-group-sm">
            <button
              onclick="exportConfig()"
              class="btn btn-outline-primary fw-bold"
            >
              匯出設定
            </button>
            <label
              class="btn btn-outline-info fw-bold mb-0"
              style="cursor:pointer"
            >
              匯入設定
              <input
                type="file"
                onchange="importConfig(event)"
                style="display:none"
              />
            </label>
            <button
              onclick="resetSystem()"
              class="btn btn-outline-danger fw-bold"
            >
              重置系統
            </button>
          </div>
          <div class="vr mx-2 d-none d-md-block"></div>
          <button
            onclick="toggleTheme()"
            id="theme-btn"
            class="btn btn-sm btn-outline-secondary border-0 px-2 fs-5"
          >
            🌓
          </button>
          <button
            onclick="location.href='/admin/logout'"
            class="btn btn-danger btn-sm fw-bold px-3"
          >
            登出
          </button>
        </div>
      </div>
    </div>
  </nav>

  <div class="container pb-5" id="main-content">
    <div class="row g-4 mb-4">
      <div class="col-md-4">
        <div class="card h-100 border-0 bg-body-tertiary">
          <div class="card-body px-4 py-3">
            <p class="text-muted small fw-bold text-uppercase mb-2">
              Client Bearer Token
            </p>
            <div class="input-group">
              <input
                type="text"
                id="client-token"
                class="form-control form-control-sm font-monospace"
                placeholder="sk-..."
              />
              <button
                id="btn-save-token"
                onclick="updateToken()"
                class="btn btn-primary btn-sm px-3 fw-bold"
              >
                儲存
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="col-md-2">
        <div class="card h-100 border-0 bg-body-tertiary">
          <div class="card-body px-4 py-3">
            <p class="text-muted small fw-bold text-uppercase mb-2">
              429 冷卻 (秒)
            </p>
            <div class="input-group">
              <input
                type="number"
                id="cooldown-time"
                class="form-control form-control-sm"
                placeholder="300"
                min="0"
              />
              <button
                id="btn-save-cooldown"
                onclick="updateCooldown()"
                class="btn btn-primary btn-sm px-2 fw-bold"
              >
                儲存
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="col-md-3 text-center">
        <div class="card h-100 border-0 bg-body-tertiary">
          <div class="card-body px-4 py-3">
            <p class="text-muted small fw-bold text-uppercase mb-1">渠道分佈</p>
            <div class="stat-val text-info" id="stat-channels-count">0 / 0</div>
            <div class="small opacity-50">啟用 / 總數</div>
          </div>
        </div>
      </div>
      <div class="col-md-3 text-center">
        <div class="card h-100 border-0 bg-body-tertiary">
          <div class="card-body px-4 py-3">
            <p class="text-muted small fw-bold text-uppercase mb-1">
              連線健康度
            </p>
            <div class="stat-val" id="stat-health-count">0 / 0</div>
            <div class="small opacity-50">啟用的: 異常 / 正常</div>
          </div>
        </div>
      </div>
    </div>



    <div class="card mb-5 border-0 bg-transparent">
      <div class="card-header bg-transparent py-3 px-0 border-0">
        <div class="d-flex justify-content-between align-items-center">
          <h6
            class="mb-0 fw-bold"
            style="cursor: pointer;"
            data-bs-toggle="collapse"
            data-bs-target="#collapseChannels"
            aria-expanded="true"
          >
            <i class="bi bi-hdd-stack-fill me-2 text-primary"></i>渠道對映清單
            <i class="bi bi-chevron-down ms-2 small opacity-50"></i>
          </h6>
          <div onclick="event.stopPropagation()">
            <button
              onclick="openChannelModal()"
              class="btn btn-primary btn-sm px-4 fw-bold"
            >
              新增渠道
            </button>
          </div>
        </div>
      </div>
      <div class="collapse show" id="collapseChannels">
        <div class="table-responsive">
        <table class="table table-hover align-middle mb-0 text-center small">
          <thead>
            <tr>
              <th>啟用狀態</th>
              <th>名稱</th>
              <th>目標模型</th>
              <th>權重 <i class="bi bi-info-circle" title="大值優先"></i></th>
              <th>RPM / RPD <i class="bi bi-info-circle" title="RPD 依太平洋時間(PT)重置"></i></th>
              <th>健康 <i class="bi bi-info-circle" title="點選重置異常計數"></i></th>
              <th>管理</th>
            </tr>
          </thead>
          <tbody id="list" class="border-top-0">
            <tr>
              <td colspan="7" class="py-5 text-muted">正在載入數據...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    </div>

    <div class="card mb-5 border-0 bg-transparent">
      <div class="card-header bg-transparent py-3 px-0 border-0">
        <div class="d-flex justify-content-between align-items-center">
          <h6
            class="mb-0 fw-bold"
            style="cursor: pointer;"
            data-bs-toggle="collapse"
            data-bs-target="#collapseFilters"
            aria-expanded="true"
          >
            <i class="bi bi-funnel-fill me-2 text-info"></i>回應內容過濾器
            <i class="bi bi-chevron-down ms-2 small opacity-50"></i>
          </h6>
          <div onclick="event.stopPropagation()">
            <button
              onclick="openFilterModal()"
              class="btn btn-outline-info btn-sm px-4 fw-bold"
            >
              新增過濾規則
            </button>
          </div>
        </div>
      </div>
      <div class="collapse show" id="collapseFilters">
        <div class="table-responsive">
        <table class="table table-hover align-middle mb-0 text-center small">
          <thead>
            <tr>
              <th width="100">啟用狀態</th>
              <th class="text-start ps-4">過濾關鍵字 / 廣告字串</th>
              <th width="100">模式</th>
              <th width="120">管理</th>
            </tr>
          </thead>
          <tbody id="filter-list" class="border-top-0">
            <tr>
              <td colspan="4" class="py-4 text-muted">目前無過濾規則</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    </div>

    <div class="card border-0 bg-transparent">
      <div class="card-header bg-transparent py-3 px-0 border-0">
        <div class="d-flex justify-content-between align-items-center">
          <h6
            class="mb-0 fw-bold text-muted"
            style="cursor: pointer;"
            data-bs-toggle="collapse"
            data-bs-target="#collapseLogs"
            aria-expanded="true"
          >
            <i class="bi bi-activity me-2"></i>請求記錄
            <i class="bi bi-chevron-down ms-2 small opacity-50"></i>
          </h6>
          <div class="btn-group" onclick="event.stopPropagation()">
            <button
              onclick="fetchLogs()"
              class="btn btn-sm btn-link text-decoration-none"
            >
              <i class="bi bi-arrow-clockwise"></i> 更新
            </button>
            <button
              onclick="clearLogs()"
              class="btn btn-sm btn-link text-danger text-decoration-none"
            >
              <i class="bi bi-trash"></i> 清空記錄
            </button>
          </div>
        </div>
      </div>
      <div class="collapse show" id="collapseLogs">
        <div class="table-responsive">
        <table
          class="table table-hover table-sm mb-0 align-middle text-center small"
        >
          <thead>
            <tr>
              <th class="ps-4">時間</th>
              <th>渠道</th>
              <th>回應</th>
              <th>耗時</th>
              <th>目標路徑</th>
              <th class="pe-4">詳情</th>
            </tr>
          </thead>
          <tbody id="log-list">
            <tr>
              <td colspan="6" class="py-4 text-muted">正在載入數據...</td>
            </tr>
          </tbody>
        </table>
      </div>
      </div>
    </div>
    </div>
  </div>

  <!-- Modals -->
  <div class="modal fade" id="logDetailModal" tabindex="-1">
    <div class="modal-dialog modal-lg modal-dialog-scrollable">
      <div class="modal-content">
        <div id="log-loading-overlay" class="loading-overlay d-none">
          <div class="spinner-border text-primary"></div>
        </div>
        <div class="modal-header border-0 bg-body-tertiary">
          <h6 class="modal-title fw-bold">記錄詳情</h6>
          <button
            type="button"
            class="btn-close"
            data-bs-dismiss="modal"
            aria-label="Close"
          ></button>
        </div>
        <div class="modal-body p-4">
          <div
            id="log-meta"
            class="row row-cols-2 g-3 p-3 bg-body-tertiary rounded mb-4"
          ></div>
          <div class="mb-4">
            <p
              class="small fw-bold border-start border-3 border-primary ps-2 mb-2"
            >
              Request Payload
            </p>
            <div id="log-req-body"></div>
          </div>
          <div>
            <p
              class="small fw-bold border-start border-3 border-success ps-2 mb-2"
            >
              Server Response
            </p>
            <div id="log-res-body"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="modal fade" id="channelModal" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content">
        <div id="channel-loading-overlay" class="loading-overlay d-none">
          <div class="spinner-border text-primary"></div>
        </div>
        <div class="modal-header border-0 px-4 pt-4">
          <h5 class="modal-title fw-bold">渠道設定</h5>
          <button
            type="button"
            class="btn-close"
            data-bs-dismiss="modal"
            aria-label="Close"
          ></button>
        </div>
        <div class="modal-body p-4">
          <input type="hidden" id="ch-id" />
          <div class="mb-3">
            <label class="form-label small fw-bold"
              >渠道名稱 <span class="text-danger">*</span></label
            >
            <input
              type="text"
              id="ch-name"
              class="form-control"
              placeholder="OpenAI-1"
              required
            />
          </div>
          <div class="mb-3">
            <label class="form-label small fw-bold">API Key (令牌)</label>
            <div class="input-group">
              <input
                type="password"
                id="ch-key"
                class="form-control"
                placeholder="sk-..."
              />
              <button
                class="btn btn-outline-secondary"
                type="button"
                onclick="togglePass('ch-key')"
              >
                <i class="bi bi-eye"></i>
              </button>
            </div>
          </div>
          <div class="mb-3">
            <label class="form-label small fw-bold">Base URL</label>
            <input
              type="text"
              id="ch-url"
              class="form-control"
              placeholder="https://api.openai.com"
            />
          </div>
          <div class="row g-3 mb-4">
            <div class="col-8">
              <label class="form-label small fw-bold">目標模型</label>
              <input
                type="text"
                id="ch-model"
                class="form-control"
                placeholder="gpt-4o"
              />
            </div>
            <div class="col-4">
              <label class="form-label small fw-bold">權重 (1~10000)</label>
              <input
                type="number"
                id="ch-weight"
                class="form-control"
                value="1"
                min="1"
                max="10000"
              />
            </div>
          </div>
          <div class="row g-3 mb-4">
            <div class="col-6">
              <label class="form-label small fw-bold">RPM (每分鐘限制)</label>
              <input
                type="number"
                id="ch-rpm"
                class="form-control"
                placeholder="0 = 無限制"
                min="0"
              />
            </div>
            <div class="col-6">
              <label class="form-label small fw-bold">RPD (每日限制)</label>
              <input
                type="number"
                id="ch-rpd"
                class="form-control"
                placeholder="0 = 無限制"
                min="0"
              />
              <div class="form-text" style="font-size: 10px;">依太平洋時間(PT)跨日重置</div>
            </div>
          </div>
          <div class="d-flex gap-3">
            <div
              class="flex-fill p-2 bg-body-tertiary rounded text-center border text-info"
            >
              <div class="small fw-bold mb-1">視覺支援</div>
              <div class="form-check form-switch d-inline-block">
                <input
                  class="form-check-input"
                  type="checkbox"
                  id="ch-vision"
                />
              </div>
            </div>
            <div
              class="flex-fill p-2 bg-body-tertiary rounded text-center border"
            >
              <div class="small fw-bold mb-1">啟用狀態</div>
              <div class="form-check form-switch d-inline-block">
                <input
                  class="form-check-input"
                  type="checkbox"
                  id="ch-enabled"
                  checked
                />
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer px-4 pb-4 border-0">
          <button
            id="btn-save-channel"
            onclick="saveChannel()"
            class="btn btn-primary w-100 fw-bold"
          >
            儲存設定
          </button>
        </div>
      </div>
    </div>
  </div>

  <div class="modal fade" id="filterModal" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content">
        <div class="modal-header border-0 px-4 pt-4">
          <h5 class="modal-title fw-bold">過濾規則設定</h5>
          <button
            type="button"
            class="btn-close"
            data-bs-dismiss="modal"
            aria-label="Close"
          ></button>
        </div>
        <div class="modal-body p-4">
          <input type="hidden" id="ft-id" />
          <div class="mb-3">
            <label class="form-label small fw-bold">過濾關鍵字</label>
            <textarea
              id="ft-text"
              class="form-control font-monospace"
              rows="4"
              placeholder="例如: Powered by XYZ.AI"
            ></textarea>
          </div>
          <div class="row g-2 mb-3">
            <div class="col-6">
              <div class="p-2 rounded text-center border">
                <div class="small fw-bold mb-1">模式</div>
                <select
                  id="ft-mode"
                  class="form-select form-select-sm border-0 text-center shadow-none fw-bold"
                >

                  <option value="1">切除其後 (Truncate)</option>
                  <option value="0">僅刪除 (Delete)</option>
                </select>
              </div>
            </div>

            <div class="col-6">
              <div
                class="p-2 bg-body-tertiary rounded text-center border h-100"
              >
                <div class="small fw-bold mb-1">啟用狀態</div>
                <div class="form-check form-switch d-inline-block">
                  <input
                    class="form-check-input"
                    type="checkbox"
                    id="ft-enabled"
                    checked
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer px-4 pb-4 border-0">
          <button
            id="btn-save-filter"
            onclick="saveFilter()"
            class="btn btn-info w-100 fw-bold"
          >
            儲存規則
          </button>
        </div>
      </div>
    </div>
  </div>

  <div class="toast-container" id="toast-container"></div>`;

const SCRIPT_UI = html`
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    let logModal, channelModal, filterModal;

    const setTheme = (theme) => {
      document.documentElement.setAttribute("data-bs-theme", theme);
      localStorage.setItem("theme", theme);
      const btn = document.getElementById("theme-btn");
      if (btn) btn.innerHTML = theme === "dark" ? "🌙" : "☀️";
      const nav = document.querySelector(".navbar");
      if (nav) {
        if (theme === "dark") {
          nav.classList.remove("navbar-light", "bg-body-tertiary");
          nav.classList.add("navbar-dark", "bg-dark");
        } else {
          nav.classList.remove("navbar-dark", "bg-dark");
          nav.classList.add("navbar-light", "bg-body-tertiary");
        }
      }
    };

    window.toggleTheme = () =>
      setTheme(
        document.documentElement.getAttribute("data-bs-theme") === "dark"
          ? "light"
          : "dark",
      );
    setTheme(
      localStorage.getItem("theme") ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"),
    );

    window.toast = (msg, type) => {
      const container = document.getElementById("toast-container");
      if (!container) return;
      const alert = document.createElement("div");
      alert.className =
        "alert " +
        (type === "error" ? "alert-danger" : "alert-success") +
        " fade show mb-3";
      alert.innerHTML = msg;
      container.appendChild(alert);
      setTimeout(() => {
        alert.classList.remove("show");
        setTimeout(() => alert.remove(), 500);
      }, 3500);
    };

    window.uiLoading = (id, isLoading) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = isLoading;
      const text = id.includes("token")
        ? "儲存"
        : id.includes("filter")
          ? "儲存規則"
          : id.includes("cooldown")
            ? "儲存"
            : "儲存設定";
      btn.innerHTML = isLoading
        ? '<span class="spinner-border spinner-border-sm me-1"></span>'
        : text;
    };

    let globalCooldown = 300;


    const apiFetch = async (url, options = {}) => {
      return await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
    };

    window.togglePass = (id) => {
      const el = document.getElementById(id);
      el.type = el.type === "password" ? "text" : "password";
    };
    window.formatTaipeiTime = (s) =>
      s
        ? new Date(
            s.replace(" ", "T") + (s.includes("Z") ? "" : "Z"),
          ).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })
        : "-";

    window.fetchConfig = async () => {
      const r = await fetch("/admin/api/config");
      if (r.ok) {
        const data = await r.json();
        document.getElementById("client-token").value = data.token || "";
        document.getElementById("cooldown-time").value = data.cooldown || "300";
        globalCooldown = parseInt(data.cooldown || "300");
        // Update list health display if list is already loaded
        if (typeof fetchList === "function") fetchList();
      }
    };

    window.updateCooldown = async () => {
      uiLoading("btn-save-cooldown", true);
      const val = document.getElementById("cooldown-time").value;
      try {
        const r = await apiFetch("/admin/api/config", {
          method: "POST",
          body: JSON.stringify({ cooldown: val }),
        });
        if (r.ok) {
          globalCooldown = parseInt(val);
          toast("冷卻時間已更新");
          fetchList();
        } else toast("更新失敗", "error");
      } catch (e) {
        toast("連線異常", "error");
      }
      uiLoading("btn-save-cooldown", false);
    };


    window.updateToken = async () => {
      uiLoading("btn-save-token", true);
      try {
        const r = await apiFetch("/admin/api/config", {
          method: "POST",
          body: JSON.stringify({
            token: document.getElementById("client-token").value,
          }),
        });
        toast(r.ok ? "令牌已更新" : "更新失敗", r.ok ? "success" : "error");
      } catch (e) {
        toast("連線異常", "error");
      }
      uiLoading("btn-save-token", false);
    };

    window.fetchList = async () => {
      const r = await fetch("/admin/api");
      if (!r.ok) return;
      const list = await r.json(),
        el = document.getElementById("list"),
        now = Date.now() / 1000;
      const enabledChannels = list.filter((c) => c.is_enabled);
      const healthyCount = enabledChannels.filter(
        (c) => now - (c.last_429 || 0) > globalCooldown,
      ).length;
      const unhealthyCount = enabledChannels.length - healthyCount;
      document.getElementById("stat-channels-count").textContent =
        enabledChannels.length + " / " + list.length;
      document.getElementById("stat-channels-count").className =
        "stat-val " + (enabledChannels.length === 0 ? "text-danger" : "text-info");

      document.getElementById("stat-health-count").textContent =
        unhealthyCount + " / " + healthyCount;
      document.getElementById("stat-health-count").className =
        "stat-val " + (unhealthyCount > 0 ? "text-danger" : "text-success");

      el.innerHTML =
        list
          .map((ch) => {
            const isCool = Date.now() / 1000 - (ch.last_429 || 0) < globalCooldown;
            return (
              '<tr><td><span class="badge ' +
              (ch.is_enabled ? "bg-success" : "bg-secondary") +
              '">' +
              (ch.is_enabled ? "啟用" : "停用") +
              "</span></td>" +
              '<td class="fw-bold">' +
              ch.name +
              "</td>" +
              '<td><code class="text-primary small">' +
              ch.model_name +
              "</code>" +
              (ch.is_vision
                ? '<span class="text-info ms-1"><i class="bi bi-eye-fill"></i></span>'
                : "") +
              "</td>" +
              "<td>" +
              ch.weight +
              "</td>" +
              '<td><span class="text-muted">' + (ch.rpm || '-') + ' / ' + (ch.rpd || '-') + '</span></td>' +
              '<td><span class="badge rounded-pill ' +
              (isCool ? "bg-warning text-dark" : (ch.consecutive_errors > 0 ? "bg-danger" : "bg-info")) +
              '" title="' + (ch.last_error_msg || '') + '" style="cursor:pointer" onclick="resetHealth(' + ch.id + ')">' +
              (isCool ? "冷卻" : (ch.consecutive_errors > 0 ? "異常 (" + ch.consecutive_errors + ")" : "正常")) +
              "</span></td>" +



              '<td><button onclick="openChannelModal(' +
              ch.id +
              ')" class="btn btn-outline-primary btn-sm px-2 py-0 me-1">編輯</button>' +
              '<button onclick="remove(' +
              ch.id +
              ')" class="btn btn-outline-danger btn-sm px-2 py-0">刪除</button></td></tr>'
            );
          })
          .join("") ||
        '<tr><td colspan="7" class="py-5 opacity-50">尚無數據</td></tr>';
    };


    window.fetchFilters = async () => {
      const r = await fetch("/admin/api/filters");
      if (!r.ok) return;
      const list = await r.json(),
        el = document.getElementById("filter-list");
      el.innerHTML =
        list
          .map(
            (f) =>
              '<tr><td><span class="badge ' +
              (f.is_enabled ? "bg-success" : "bg-secondary") +

              '">' +
              (f.is_enabled ? "啟用" : "停用") +
              "</span></td>" +
              '<td class="text-start ps-4 font-monospace small"><div class="text-truncate" style="max-width:400px">' +
              f.text +
              "</div></td>" +
              '<td><span class="badge bg-info small">' +
              (f.mode == 1 ? "切除" : "刪除") +
              "</span></td>" +

              '<td><button onclick="openFilterModal(' +
              f.id +
              ')" class="btn btn-outline-primary btn-sm px-2 py-0 me-1">編輯</button>' +

              '<button onclick="deleteFilterRule(' +
              f.id +
              ')" class="btn btn-outline-danger btn-sm px-2 py-0">刪除</button></td></tr>',
          )
          .join("") ||
        '<tr><td colspan="4" class="py-4 text-muted">目前無過濾規則</td></tr>';
    };

    window.fetchLogs = async () => {
      const r = await fetch("/admin/api/logs");
      if (r.ok) {
        const logs = await r.json(),
          el = document.getElementById("log-list");
        el.innerHTML = logs.length
          ? logs.map(
            (l) =>
              '<tr><td class="text-muted small">' +
              formatTaipeiTime(l.created_at) +
              "</td>" +
              '<td class="fw-bold text-truncate" style="max-width:120px">' +
              l.channel_name +
              "</td>" +
              '<td><span class="badge ' +
              (l.response_status == 200 ? "bg-success" : "bg-danger") +
              '">' +
              l.response_status +
              "</span></td>" +
              "<td>" +
              l.latency_ms +
              "ms</td>" +
              '<td class="text-break text-start small">' +
              (l.target_url || "-") +
              "</td>" +
              '<td class="pe-4"><button onclick="showLogDetail(' +
              l.id +
              ')" class="btn btn-outline-secondary btn-sm px-2 py-0">查看</button></td></tr>',
          ).join("")
          : '<tr><td colspan="6" class="py-4 text-muted">目前尚未產生任何請求記錄</td></tr>';
      }
    };

    window.showLogDetail = async (id) => {
      const overlay = document.getElementById("log-loading-overlay");
      if (overlay) overlay.classList.remove("d-none");
      if (logModal) logModal.show();
      try {
        const l = await (await fetch("/admin/api/logs/" + id)).json();
        document.querySelector("#logDetailModal .modal-title").innerHTML =
          '記錄詳情 <span class="badge bg-secondary ms-2">ID: ' +
          l.id +
          "</span>";
        const fmt = (s) => {
          try {
            return JSON.stringify(JSON.parse(s), null, 2);
          } catch (e) {
            return s;
          }
        };
        document.getElementById("log-meta").innerHTML = [
          { k: "時間", v: formatTaipeiTime(l.created_at) },
          { k: "渠道", v: l.channel_name },
          { k: "耗時", v: l.latency_ms + "ms" },
          {
            k: "狀態",
            v: l.response_status,
            b: l.response_status == 200 ? "success" : "danger",
          },
          { k: "模型", v: l.model || "-" },
          { k: "目標路徑", v: l.target_url || "-", f: true },
        ]
          .map(
            (m) =>
              '<div class="' +
              (m.f ? "col-12" : "col-6") +
              ' small mt-1"><div class="text-muted fw-bold" style="font-size:10px">' +
              m.k +
              "</div>" +
              '<div class="fw-bold text-break">' +
              (m.b
                ? '<span class="badge bg-' + m.b + '">' + m.v + "</span>"
                : m.v) +
              "</div></div>",
          )
          .join("");
        document.getElementById("log-req-body").innerHTML =
          "<pre>" + fmt(l.request_body || "{}") + "</pre>";
        document.getElementById("log-res-body").innerHTML =
          "<pre>" + (l.response_body || "No Data") + "</pre>";
      } catch (e) {
        toast("詳情獲取失敗", "error");
        logModal.hide();
      } finally {
        if (overlay) overlay.classList.add("d-none");
      }
    };

    window.openChannelModal = async (id) => {
      if (id) {
        document
          .getElementById("channel-loading-overlay")
          .classList.remove("d-none");
        channelModal.show();
        try {
          const ch = await (await fetch("/admin/api/channels/" + id)).json();
          document.getElementById("ch-id").value = ch.id;
          document.getElementById("ch-name").value = ch.name;
          document.getElementById("ch-key").value = ch.api_key;
          document.getElementById("ch-url").value = ch.base_url;
          document.getElementById("ch-model").value = ch.model_name;
          document.getElementById("ch-weight").value = ch.weight;
          document.getElementById("ch-rpm").value = ch.rpm || 0;
          document.getElementById("ch-rpd").value = ch.rpd || 0;
          document.getElementById("ch-enabled").checked = ch.is_enabled == 1;
          document.getElementById("ch-vision").checked = ch.is_vision == 1;
        } catch (e) {
          toast("載入失敗", "error");
          channelModal.hide();
        } finally {
          document
            .getElementById("channel-loading-overlay")
            .classList.add("d-none");
        }
      } else {
        document.getElementById("ch-id").value = "";
        ["ch-name", "ch-key", "ch-url", "ch-model"].forEach(
          (k) => (document.getElementById(k).value = ""),
        );
        document.getElementById("ch-weight").value = 1;
        document.getElementById("ch-rpm").value = 0;
        document.getElementById("ch-rpd").value = 0;
        document.getElementById("ch-enabled").checked = true;
        document.getElementById("ch-vision").checked = false;
        channelModal.show();
      }
    };

    window.saveChannel = async () => {
      const name = document.getElementById("ch-name").value,
        weight = parseInt(document.getElementById("ch-weight").value || 1);
      if (!name) return toast("名稱為必填", "error");
      uiLoading("btn-save-channel", true);
      try {
        const id = document.getElementById("ch-id").value;
        const body = {
          name,
          api_key: document.getElementById("ch-key").value,
          base_url: document.getElementById("ch-url").value,
          model_name: document.getElementById("ch-model").value,
          weight,
          rpm: parseInt(document.getElementById("ch-rpm").value || 0),
          rpd: parseInt(document.getElementById("ch-rpd").value || 0),
          is_enabled: document.getElementById("ch-enabled").checked,
          is_vision: document.getElementById("ch-vision").checked,
        };
        const r = await apiFetch(id ? "/admin/api/" + id : "/admin/api", {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(body),
        });
        if (r.ok) {
          toast("成功");
          channelModal.hide();
          fetchList();
        } else toast("失敗", "error");
      } catch (e) {
        toast("連線異常", "error");
      }
      uiLoading("btn-save-channel", false);
    };

    window.openFilterModal = async (id) => {
      document.getElementById("ft-id").value = id || "";
      if (id) {
        const r = await fetch("/admin/api/filters"),
          list = await r.json(),
          f = list.find((x) => x.id == id);
        if (f) {
          document.getElementById("ft-text").value = f.text;
          document.getElementById("ft-mode").value = f.mode || 1;
          document.getElementById("ft-enabled").checked = f.is_enabled == 1;
        }
      } else {
        document.getElementById("ft-text").value = "";
        document.getElementById("ft-mode").value = 1;
        document.getElementById("ft-enabled").checked = true;
      }
      filterModal.show();
    };

    window.saveFilter = async () => {
      const text = document.getElementById("ft-text").value;
      if (!text) return toast("關鍵字不可為空", "error");
      uiLoading("btn-save-filter", true);
      try {
        const id = document.getElementById("ft-id").value;
        const body = {
          text,
          mode: parseInt(document.getElementById("ft-mode").value),
          is_enabled: document.getElementById("ft-enabled").checked,
        };
        const r = await apiFetch(
          id ? "/admin/api/filters/" + id : "/admin/api/filters",
          { method: id ? "PUT" : "POST", body: JSON.stringify(body) },
        );
        if (r.ok) {
          toast("已儲存");
          filterModal.hide();
          fetchFilters();
        } else {
          const err = await r.json();
          toast("失敗: " + (err.error || "存取異常"), "error");
        }
      } catch (e) {
        toast("連線異常: " + e.message, "error");
      }
      uiLoading("btn-save-filter", false);
    };

    window.deleteFilterRule = async (id) =>
      confirm("確認刪除此規則？") &&
      (await apiFetch("/admin/api/filters/" + id, { method: "DELETE" }),
      fetchFilters(),
      toast("已刪除"));

    window.exportConfig = async () => {
      try {
        const [channels, config, filters] = await Promise.all([
          fetch("/admin/api").then((r) => r.json()),
          fetch("/admin/api/config").then((r) => r.json()),
          fetch("/admin/api/filters").then((r) => r.json()),
        ]);
        const blob = new Blob(
          [
            JSON.stringify(
              {
                channels,
                config,
                filters,
                exported_at: new Date().toISOString(),
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        );
        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const ts =
          now.getFullYear() +
          pad(now.getMonth() + 1) +
          pad(now.getDate()) +
          "-" +
          pad(now.getHours()) +
          pad(now.getMinutes()) +
          pad(now.getSeconds());
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "api-gateway-" + ts + ".json";
        a.click();
        toast("匯出成功");
      } catch (e) {
        toast("匯出失敗", "error");
      }
    };

    window.importConfig = async (e) => {
      const file = e.target.files[0];
      if (!file || !confirm("將覆蓋當前數據，是否繼續？")) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.config?.token)
            await apiFetch("/admin/api/config", {
              method: "POST",
              body: JSON.stringify({ token: data.config.token }),
            });

          const [curCh, curFt] = await Promise.all([
            fetch("/admin/api").then((r) => r.json()),
            fetch("/admin/api/filters").then((r) => r.json()),
          ]);

          // 1. Serialized deletion to avoid potential locks/conflicts
          for (const ch of curCh)
            await apiFetch("/admin/api/" + ch.id, { method: "DELETE" });
          for (const ft of curFt)
            await apiFetch("/admin/api/filters/" + ft.id, { method: "DELETE" });

          // 2. Parallel insertion of channels
          if (data.channels && data.channels.length > 0) {
            const chProms = data.channels.map((ch) =>
              apiFetch("/admin/api", {
                method: "POST",
                body: JSON.stringify({
                  name: (ch.name || ch.title || "").toString(),
                  api_key: ch.api_key || ch.key || "",
                  base_url: ch.base_url || ch.url || "",
                  model_name: ch.model_name || ch.model || "",
                  weight: parseInt(ch.weight) || 1,
                  is_enabled:
                    ch.is_enabled !== undefined
                      ? ch.is_enabled == 1 || ch.is_enabled === true
                      : true,
                  is_vision: ch.is_vision == 1 || ch.is_vision === true,
                  rpm: parseInt(ch.rpm) || 0,
                  rpd: parseInt(ch.rpd) || 0,
                }),
              }),
            );
            await Promise.all(chProms);
          }

          // 3. Parallel insertion of filters
          if (data.filters && data.filters.length > 0) {
            const ftProms = data.filters.map((ft) =>
              apiFetch("/admin/api/filters", {
                method: "POST",
                body: JSON.stringify({
                  text: ft.text,
                  mode: ft.mode !== undefined ? parseInt(ft.mode) : 1,
                  is_enabled:
                    ft.is_enabled !== undefined
                      ? ft.is_enabled == 1 || ft.is_enabled === true
                      : true,
                }),
              }),
            );
            await Promise.all(ftProms);
          }

          toast("匯入全數完成");
          setTimeout(() => location.reload(), 1000);
        } catch (e) {
          console.error("Import Failed:", e);
          toast("匯入失敗：" + e.message, "error");
        }
      };
      reader.readAsText(file);
    };

    window.remove = async (id) =>
      confirm("確認刪除渠道？") &&
      (await apiFetch("/admin/api/" + id, { method: "DELETE" }),
      fetchList(),
      toast("已刪除"));
    window.resetHealth = async (id) => {
      if (!confirm("確認重置此渠道的健康狀態？")) return;
      await apiFetch("/admin/api/channels/" + id + "/reset-health", { method: "POST" });
      fetchList();
      toast("已重置健康狀態");
    };
    window.clearLogs = async () =>
      confirm("確認清空記錄？") &&
      (await apiFetch("/admin/api/logs/clear", { method: "POST" }),
      (document.getElementById("log-list").innerHTML = ""),
      toast("已清空"));
    window.resetSystem = async () =>
      confirm("重置所有設定？") &&
      (await apiFetch("/admin/api/reset", { method: "POST" }),
      location.reload());

    document.addEventListener("DOMContentLoaded", () => {
      const m1 = document.getElementById("logDetailModal"),
        m2 = document.getElementById("channelModal"),
        m3 = document.getElementById("filterModal");

      // Use MutationObserver to detect aria-hidden changes and blur when needed
      const setupAriaFix = (modal) => {
        if (!modal) return;
        const observer = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            if (mutation.attributeName === "aria-hidden" && modal.getAttribute("aria-hidden") === "true") {
              // aria-hidden was just added, move focus away immediately
              document.body.focus();
              if (document.activeElement === document.body) return;
              // Force blur as fallback
              (document.activeElement || document.createElement("input")).blur();
            }
          });
        });
        observer.observe(modal, { attributes: true });
        return observer;
      };

      if (m1) logModal = new bootstrap.Modal(m1, { focus: false });
      if (m2) channelModal = new bootstrap.Modal(m2, { focus: false });
      if (m3) filterModal = new bootstrap.Modal(m3, { focus: false });

      // Also fix modal focus on show
      [m1, m2, m3].forEach(modal => {
        if (!modal) return;
        modal.addEventListener("show.bs.modal", () => {
          // Immediately blur any element before modal transitions
          window.setTimeout(() => {
            if (document.activeElement && modal.contains(document.activeElement)) {
              document.activeElement.blur();
            }
          }, 0);
        });
        modal.addEventListener("shown.bs.modal", () => {
          document.body.classList.add("modal-open");
          // Prevent modal itself from being focusable
          modal.tabIndex = -1;
          // Move focus to body instead of modal
          document.body.focus();
        });
        modal.addEventListener("hidden.bs.modal", () => {
          document.body.classList.remove("modal-open");
        });
      });

      // Set up observers for all modals
      setupAriaFix(m1);
      setupAriaFix(m2);
      setupAriaFix(m3);

      window.fetchConfig();
      if (m2) window.fetchList();
      if (m1) window.fetchLogs();
      if (m3) window.fetchFilters();
    });
  </script>
`;

const LAYOUT = (isAdmin) =>
  html` <!DOCTYPE html>
    <html lang="zh-TW" data-bs-theme="light">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>API Gateway</title>
        <link
          href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"
          rel="stylesheet"
        />
        <link
          href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"
          rel="stylesheet"
        />
        <style>
          body {
            font-family: "Inter", sans-serif;
            transition: background 0.3s;
          }
          .font-monospace {
            font-family: "Fira Code", "Cascadia Code", monospace !important;
            font-size: 0.85rem;
          }
          .loading-overlay {
            position: absolute;
            inset: 0;
            background: rgba(var(--bs-body-bg-rgb), 0.8);
            z-index: 1050;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: inherit;
          }
          .stat-val {
            font-size: 1.5rem;
            font-weight: 800;
            line-height: 1.2;
          }
          pre {
            background: var(--bs-body-tertiary-bg);
            padding: 1rem;
            border-radius: 8px;
            font-size: 0.8rem;
            max-height: 300px;
            overflow: auto;
            border: 1px solid var(--bs-border-color);
          }
          .toast-container {
            position: fixed;
            bottom: 2rem;
            right: 2rem;
            z-index: 2200;
            min-width: 280px;
            max-width: 450px;
          }
          .alert {
            font-size: 1.1rem;
            padding: 1.25rem 1.5rem;
            border-radius: 12px;
            border: none !important;
            box-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.3);
          }
          [data-bs-theme="dark"] .alert {
            box-shadow: 0 10px 40px -5px rgba(0, 0, 0, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
          }
          .table > :not(caption) > * > * {
            padding: 0.75rem 0.5rem;
          }
          .badge {
            font-weight: 600;
            letter-spacing: 0.3px;
          }
          .vr {
            opacity: 0.1;
          }
          .bi-chevron-down {
            display: inline-block;
            transition: transform 0.2s ease-in-out;
          }
          .collapsed .bi-chevron-down {
            transform: rotate(-90deg);
          }
        </style>
      </head>
      <body class="bg-body-secondary">
        ${isAdmin ? DASHBOARD_UI : LOGIN_UI} ${SCRIPT_UI}
      </body>
    </html>`;

export const adminRouter = (app) => {
  const adminAuth = async (c, next) => {
    const session = getCookie(c, "admin_session");
    if (!session || String(session) !== String(c.env.ADMIN_PASSWORD))
      return c.json({ error: "Unauthorized" }, 401);
    await next();
  };

  app.get("/admin", async (c) => {
    const isAdmin =
      getCookie(c, "admin_session") === String(c.env.ADMIN_PASSWORD);
    return c.html(LAYOUT(isAdmin));
  });

  app.get("/", async (c) => c.redirect("/admin"));

  app.post("/admin/login", async (c) => {
    const body = await c.req.parseBody();
    if (String(body.password) === String(c.env.ADMIN_PASSWORD)) {
      setCookie(c, "admin_session", String(c.env.ADMIN_PASSWORD), {
        path: "/",
        httpOnly: true,
        maxAge: 86400,
        secure: c.req.url.startsWith("https"),
        sameSite: "Lax",
      });
    }
    return c.redirect("/admin");
  });

  app.get("/admin/logout", (c) => {
    deleteCookie(c, "admin_session");
    return c.redirect("/admin");
  });

  app.get("/admin/api/config", adminAuth, async (c) => {
    const [token, cooldown] = await Promise.all([
      getDbConfig(c.env.DB, "client_bearer_token"),
      getDbConfig(c.env.DB, "cooldown_time"),
    ]);
    return c.json({ token, cooldown: cooldown || "300" });
  });

  app.post("/admin/api/config", adminAuth, async (c) => {
    const { token, cooldown } = await c.req.json();
    if (token !== undefined) {
      await updateDbConfig(c.env.DB, "client_bearer_token", token);
    }
    if (cooldown !== undefined) {
      await updateDbConfig(c.env.DB, "cooldown_time", String(cooldown));
    }
    return c.json({ ok: true });
  });


  app.get("/admin/api", adminAuth, async (c) =>
    c.json(await getChannels(c.env.DB)),
  );
  app.get("/admin/api/channels/:id", adminAuth, async (c) => {
    const ch = await getChannelById(c.env.DB, c.req.param("id"));
    return ch ? c.json(ch) : c.json({ error: "Not Found" }, 404);
  });

  app.post("/admin/api", adminAuth, async (c) => {
    try {
      const b = await c.req.json();
      const weight = Math.min(10000, Math.max(1, parseInt(b.weight || 1)));
      const rpm = Math.min(100000, Math.max(0, parseInt(b.rpm || 0)));
      const rpd = Math.min(10000000, Math.max(0, parseInt(b.rpd || 0)));
      await c.env.DB.prepare(
        "INSERT INTO channels (name, api_key, base_url, model_name, weight, is_enabled, is_vision, rpm, rpd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          b.name,
          b.api_key,
          b.base_url,
          b.model_name,
          weight,
          b.is_enabled ? 1 : 0,
          b.is_vision ? 1 : 0,
          rpm,
          rpd
        )
        .run();
      return c.json({ ok: true });
    } catch (e) {
      return c.json(
        { error: e.message.includes("UNIQUE") ? "名稱已存在" : e.message },
        500,
      );
    }
  });

  app.put("/admin/api/:id", adminAuth, async (c) => {
    try {
      const b = await c.req.json();
      const weight = Math.min(10000, Math.max(1, parseInt(b.weight || 1)));
      const rpm = Math.min(100000, Math.max(0, parseInt(b.rpm || 0)));
      const rpd = Math.min(10000000, Math.max(0, parseInt(b.rpd || 0)));
      await c.env.DB.prepare(
        "UPDATE channels SET name=?, api_key=?, base_url=?, model_name=?, weight=?, is_enabled=?, is_vision=?, rpm=?, rpd=? WHERE id=?",
      )
        .bind(
          b.name,
          b.api_key,
          b.base_url,
          b.model_name,
          weight,
          b.is_enabled ? 1 : 0,
          b.is_vision ? 1 : 0,
          rpm,
          rpd,
          c.req.param("id"),
        )
        .run();
      return c.json({ ok: true });
    } catch (e) {
      return c.json(
        { error: e.message.includes("UNIQUE") ? "名稱已存在" : e.message },
        500,
      );
    }
  });

  app.delete("/admin/api/:id", adminAuth, async (c) => {
    await c.env.DB.prepare("DELETE FROM channels WHERE id=?")
      .bind(c.req.param("id"))
      .run();
    return c.json({ ok: true });
  });

  app.post("/admin/api/channels/:id/reset-health", adminAuth, async (c) => {
    await resetChannelHealth(c.env.DB, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/admin/api/logs", adminAuth, async (c) =>
    c.json(await getLogs(c.env.DB)),
  );
  app.get("/admin/api/logs/:id", adminAuth, async (c) => {
    const log = await getLogById(c.env.DB, c.req.param("id"));
    return log ? c.json(log) : c.json({ error: "Not Found" }, 404);
  });

  app.post("/admin/api/logs/clear", adminAuth, async (c) => {
    await clearLogs(c.env.DB);
    return c.json({ ok: true });
  });

  app.get("/admin/api/filters", adminAuth, async (c) =>
    c.json(await getFilters(c.env.DB)),
  );
  app.post("/admin/api/filters", adminAuth, async (c) => {
    try {
      const { text, mode, is_enabled } = await c.req.json();
      await addFilter(c.env.DB, text, mode, is_enabled);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });
  app.put("/admin/api/filters/:id", adminAuth, async (c) => {
    try {
      const { text, mode, is_enabled } = await c.req.json();
      await updateFilter(c.env.DB, c.req.param("id"), text, mode, is_enabled);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });
  app.delete("/admin/api/filters/:id", adminAuth, async (c) => {
    await deleteFilter(c.env.DB, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/admin/api/reset", adminAuth, async (c) => {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM channels"),
      c.env.DB.prepare("DELETE FROM logs"),
      c.env.DB.prepare("DELETE FROM config"),
      c.env.DB.prepare("DELETE FROM filters"),
      c.env.DB.prepare(
        "INSERT INTO config (key, value) VALUES ('client_bearer_token', 'sk-test123456')"
      ),
      c.env.DB.prepare(
        "INSERT INTO config (key, value) VALUES ('cooldown_time', '300')"
      ),

    ]);
    return c.json({ ok: true });
  });
};
