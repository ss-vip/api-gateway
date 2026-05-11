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

### 渠道調用與路由機制 (Routing Logic)

1. 挑選已啟用且健康的渠道。
2. 挑選支援視覺與工具使用的渠道。
3. 挑選請求中的 model 名稱。
   - 精準匹配：與渠道設定的 model 完全一致（不分大小寫）將優先調用。
   - 相容路由：若無精確匹配的模型，會將請求分發至所有可用的渠道。
4. 權重隨機挑選 (Weighted Selection 1-100) 數值越高，被選中的機率越大。
5. 自動重試與備選 (Retry & Fallback)：
   - 次要模型 (Secondary Model)：在主要模型調用失敗（429/5xx/網路錯誤）時，會在同一渠道用次要模型重試發送。
   - 多渠道重試：若該渠道完全失敗，會排除該渠道重新挑選另一個渠道進行重試（單次請求最高重試 5 次）。

### 健康狀態判斷 (Health Status Logic)

正常 (Healthy) 無錯誤記錄，正常參與調用。
不穩 (Unstable) 連續錯誤次數介於 1~4 次，正常參與調用，但在介面顯示警告。
冷卻 (Recovery) 觸發 HTTP 429 速率限制或達到 RPD/RPM 上限，暫時從可用渠道移除，直到冷卻時間結束（預設 300s）。
異常 (Error) 連續錯誤次數達 5 次，進入封鎖狀態。
限額 (Exhausted) 偵測到 quota_exceeded 或 insufficient_credit 等關鍵字。 進入 7 天 的長期封鎖。

### 智慧自癒機制 (Self-Healing)

無人值守可用性：對於非限額類型的「異常」渠道，下次的請求會先判斷是否已超過了 30 分鐘，自動嘗試並恢復其可用性。
觀察期重試：自癒後的渠道會重新進入「觀察期」，若下一次調用成功，則自動清除所有錯誤紀錄，恢復為「正常」狀態；若再次失敗，則重新進入異常封鎖。

### 回應內容過濾 (Filter)
- 刪除模式：僅移除回應內容中匹配的關鍵字字串。
- 切除模式：偵測到匹配字串後，移除該字串及其後續的所有回應內容（適用於攔截 AI 生成的特定後綴）。
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
