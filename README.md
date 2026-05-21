# API Gateway

基於 **Hono** 構建的 AI API Gateway，部屬於 Cloudflare Workers。
支援 OpenAI 相容格式，具備智慧路由、故障冷卻、內容過濾與自動 Schema 遷移。

## 功能

- **智慧路由**：加權隨機選取 + 動態降級（模型精確匹配 ×10、延遲加權、錯誤次數遞減權重、RPM/RPD 使用率接近上限自動降權）
- **故障冷卻**：自動偵測 429/5xx 錯誤，支援指數退避（最長 1 小時），渠道錯誤 ≥5 次自動排除
- **自動恢復**：渠道成功回應後立即恢復權重，429 冷卻過期自動回歸，每 60 秒 cache 刷新重新同步 DB
- **自適應學習**：測試渠道時自動檢測 vision / tools / stream 支援度，dynamic toggle
- **回應過濾**：支援關鍵字刪除或截斷（串流 + 非串流）
- **管理後台**：`/admin` 網頁介面（渠道 CRUD、匯入匯出、健康狀態監控），`/health` 服務狀態
- **自動 Schema 遷移**：Worker startup 時自動偵測 D1 結構，補上遺漏欄位，部署不用再手動跑 migration

## 前置需求

- Node.js 18+
- Cloudflare 帳號
- 已建立 D1 資料庫（複製 `wrangler.toml.example` → `wrangler.toml` 並填入 D1 UUID）

## 快速開始

```bash
# 安裝依賴
npm install

# 複製設定檔
cp wrangler.toml.example wrangler.toml
# 編輯 wrangler.toml 填入 database_id

# 本地開發
npm run dev

# 部署上線（自動執行 DB migration）
npm run deploy
```

**部署後不需手動執行任何 DB migration**。Worker 啟動時會自動：
1. 建立 table（若不存在）
2. 檢查 channels / filters / config 的現有欄位
3. 補上遺漏欄位（ALTER TABLE ADD COLUMN）

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

## 渠道權重說明

每個渠道可設定靜態權重 `weight`（1–100，預設 50）。系統自動乘上以下動態因子決定實際選取機率：

| 因子 | 範圍 | 說明 |
|------|------|------|
| 模型匹配 | ×10 / ×5 / ×0.1 | 精確匹配 ×10、後備匹配 ×5、無匹配 ×0.1（僅備援） |
| 錯誤次數 | ×0.2–1.0 | 1次錯誤 ×0.8、2次 ×0.6、3次 ×0.4、≥4次 ×0.2 |
| RPM/RPD 使用率 | ×0.5 / ×1.0 | 使用率 >80% 時降為一半 |
| 回應延遲 | ×0.3–1.0 | 相對池平均的倍數，>2倍 ×0.3、>1.5倍 ×0.5、>1.2倍 ×0.75 |

所有因子在渠道恢復健康後自動回升，無需人工介入。

## 排程維護（建議）

建立排程任務定期呼叫 `/health`：

```
URL: https://your-worker.workers.dev/health
Schedule: Every 5 minutes
```

此端點會自動恢復冷卻到期的渠道、清理速率緩衝區、回報渠道統計。

## 架構備註

- 使用 Hono 框架、D1 資料庫、Workers Runtime
- 渠道狀態快取 60 秒（`loadCache`），減少 D1 讀取
- RPM/RPD 計數透過 `rateBuffer` 全域快取，由 `/health` 定期寫入 D1
- Schema 定義集中於 `src/lib/schema.js`，Worker startup 時自動 `PRAGMA table_info` + `ALTER TABLE` 補欄位
- 所有 SELECT 查詢使用 `SELECT *`，新增欄位不需修改查詢語句
