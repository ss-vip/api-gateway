# 🚀 API Gateway

OpenAI 相容格式的 API 分流服務，可佈署於 **Cloudflare Workers**，使用 hono 框架構建。支援多渠道路由、負載平衡、回應內容過濾。

---

## ✨ 功能特色

- **🌐 多渠道 URL 支援** 單組 API 與 KEY 及模型為一個渠道，可設定 limit 限制
- **❄️ 429 及故障冷卻機制** 自動重試且記錄長時間錯誤的渠道，可手動重置計數
- **🛡️ 回應字串過濾與截斷** 刪除回應中的特定字串
- **🛠️ JSON 格式自動修復** 修復 API 請求與回應中 JSON 的錯誤格式
- **📊 功能管理後台與匯出備份** 可匯出 JSON 格式的設定檔，方便備份與還原

---

## 🏗️ 專案架構

```text
api-gateway/
├── src/
│   ├── index.js      # 應用入口與路由總控
│   ├── proxy.js      # 代理與分流核心邏輯
│   ├── db.js         # D1 資料庫操作封裝
│   └── admin.js      # 管理後台介面與 API
├── wrangler.toml     # Cloudflare Workers 配置
├── schema.sql        # 資料庫結構定義
└── package.json      # 專案依賴
```

---

## ⚙️ 環境變數

在 `.dev.vars` (開發環境) 或 Cloudflare Secrets (正式環境) 中設定：

`ADMIN_PASSWORD=管理後台登入密碼`

---

## 🚀 快速開始

### 1. 安裝環境

確保已安裝 Node.js 並執行：

```bash
npm install
```

### 2. 本地開發

啟動本地開發伺服器：

```bash
npm run dev
```

### 3. 部署至 Cloudflare

```bash
npm run deploy
```

### 資料庫重置

使用 Wrangler 重置 D1 資料庫 (本地測試)：

```bash
npm run reset-db
```

---

## 🛠️ 管理後台

於路徑 `/admin` 輸入密碼登入。

### 渠道管理

- **調用權重**：數字越大，該渠道被調用的機率越高。
- **視覺支援**：開啟後，帶有圖片的請求將優先調用該渠道。
- **故障停用**：該渠道若有多次無法使用的紀錄，會列為故障，可以手動重置計算紀錄。

### 冷卻機制

- **頻率限制**：每個渠道可設定 RPM/RPD Limit 限制，達到上限將進入冷卻。
- **冷卻時間**：預設 5 分鐘，若渠道 API 發生 429 或不可用的狀況進入冷卻。

### 回應過濾

- **刪除模式**：僅移除回應內容所匹配的字串。
- **切除模式**：移除回應內容匹配的字串及其後續所有內容。

---

## 📝 API 使用範例

```bash
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-client-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": true
  }'
```
