# ⚡ API Gateway

OpenAI 與 Anthropic 相容格式的 API 轉發服務，使用 Hono 框架構建，可佈署於 Cloudflare Workers 搭配 D1 儲存。支援多渠道路由、負載平衡、回應內容過濾。

---

## ✨ 功能特色

- **🌐 多渠道 URL 支援** 單組 API URL 與 KEY 搭配指定模型為一個渠道，可設定調用權重，是否視覺、工具支援及 limit 限制
- **⚡ 渠道自動調用** 優先調用與請求相符的模型或需要視覺、工具的渠道，沒有相符合的條件也會向下相容，試著調用其它渠道
- **❄️ 429 及故障冷卻機制** 自動重試且記錄長時間錯誤的渠道，可手動重置計數回到健康狀態
- **🛡️ 回應字串過濾與截斷** 刪除回應中的特定字串，或由關鍵字開始截斷及其後所有字串
- **📊 功能管理後台與匯出備份** 可匯出 JSON 格式的設定檔，方便備份與還原

---

## 🏗️ 專案架構

```text
api-gateway/
├── src/
│   ├── index.js            # 入口與核心程式
│   └── dashboard.js        # 管理後台介面
├── wrangler.toml           # Cloudflare Workers 配置
├── schema.sql              # 資料庫結構定義
└── package.json            # 專案依賴
```

---

## ⚙️ 環境設定

1. 請在 Cloudflare 控制台 (或執行 `npx wrangler d1 create <DATABASE_NAME>`) 建立 D1 資料庫。
2. 將 D1 資料庫名稱與 UUID 填入 `wrangler.toml` 檔案內。
3. `package.json` 檔案內的指令參數 `DB` 對應 `wrangler.toml` 檔案的 binding 名稱。

---

## 🚀 快速開始

### 1. 初始化與啟動 (local)

CLI 確保已安裝 Node.js，並登入 wrangler，會建立本地資料庫並啟動服務：

```bash
npm start
```

### 2. 部署至 Cloudflare

將程式碼與資料庫結構同步至雲端：

```bash
npm run deploy
```

### 資料庫重置 (local)

```bash
npm run reset-db
```

### 登入密碼重置 (local)

```bash
npm run reset-pw
```

### 資料庫重置 (Cloudflare)

```bash
npm run reset-remote-db
```

### 登入密碼重置 (Cloudflare)

```bash
npm run reset-remote-pw
```

---

## 🛠️ 管理後台

於 `/admin` 輸入密碼登入，錯誤多次將 BAN IP，初次使用需建立新密碼，登入後可變更。

### 渠道管理

- **模型列表**：可由 `/v1/models` 取得當前所有啟用渠道的模型列表，調用時會優先尋找與請求相符模型的渠道。
- **調用權重**：數字越大，該渠道被調用的機率越高，搭配 limit 彈性使用。
- **模型支援**：開啟後，帶有圖片或工具 function call 的請求將優先調用該渠道，若無適用的會向下相容調用一般渠道。
- **故障停用**：該渠道若有多次無法使用的紀錄，健康狀態會列為故障，且留有最後的異常請求紀錄，可以手動重置。

### 冷卻機制

- **頻率限制**：每個渠道可設定 RPM/RPD Limit 限制，達到上限將進入冷卻。
- **冷卻時間**：預設 5 分鐘，若渠道 API 發生 429 或不可用的狀況進入冷卻。
- **健康狀態**：長時間非健康的渠道仍會檢查是否恢復正常，自動回到健康狀態進入可用渠道列隊。

### 回應過濾

- **刪除模式**：僅移除回應內容所匹配的字串。
- **切除模式**：移除回應內容匹配的字串及其後續所有內容。

---

## 📝 API 使用範例

```bash
curl -X POST https://your-host/v1/chat/completions \
  -H "Authorization: Bearer client-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai",
    "messages": [{
      "role": "user",
      "content": "你好！"
    }],
    "stream": true
  }'
```
