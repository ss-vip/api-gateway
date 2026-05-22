# API Gateway

支援 OpenAI 相容格式，具備智慧路由、故障冷卻、內容過濾功能。

## 功能

- **智慧路由**：加權隨機選取 + 動態降級（模型匹配、延遲加權、RPM/RPD 可用率與錯誤率增減權重）
- **故障冷卻**：自動偵測 4xx/5xx 錯誤，支援指數退避（最長 1 小時），渠道錯誤達 5 次將自動排除列隊
- **自動恢復**：渠道成功回應後逐步恢復（Sliding Window，每次成功遞減錯誤次數），429 冷卻過期自動回到列隊
- **自適應學習**：測試渠道時自動檢測 vision / tools / stream ，調用渠道時也會記憶是否支援使用
- **回應過濾**：支援關鍵字刪除或截斷（含關鍵字，截斷後續所有內容）
- **管理後台**：`/admin` 網頁介面（渠道 CRUD、匯入匯出 JSON 備份、健康狀態監控），`/health` 服務狀態

## 前置需求

- Node.js 18+
- Cloudflare 帳號
- 已建立 D1 資料庫（複製 `wrangler.toml.example` → `wrangler.toml` 並填入 D1 UUID）

## 快速開始

```bash
# 安裝依賴
npm install

# 複製設定檔 填入 database_id
cp wrangler.toml.example wrangler.toml

# 本地開發
npm run dev

# 部署上線
npm run deploy
```

## 管理後台

部署後開啟 `<your-worker-url>/admin` 進行初始密碼設定。

Client Token 將自動產生，可在 Dashboard 設定頁面查看或修改。

## API 使用

```bash
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

## 排程維護（建議）

建立排程任務定期呼叫 `/health`：

```
URL: https://your-worker.workers.dev/health
Schedule: Every 5 minutes
```

此端點會自動恢復冷卻到期的渠道、清理速率緩衝區、回報渠道統計。

## 架構備註

- 以佈署於 Cloudflare 免費層級使用為設計方向，使用 Hono 框架、D1 資料庫、Workers Runtime
- 渠道狀態快取 60 秒（`loadCache`），減少 D1 讀取
- RPM/RPD 計數透過 `rateBuffer` 全域快取，由 `/health` 定期寫入 D1
- Schema 定義集中於 `src/lib/schema.js`，Worker startup 時自動更新
- Gateway 內部查詢使用 `SELECT *` 以自動適應 Schema 新增欄位；Dashboard 使用明確欄位以確保系統監控穩定
