# API Gateway

Cloudflare AI Gateway 代理 — 支援多 API Key 輪詢、故障轉移、Model 別名路由。

**架構**: Client -> 本機 Proxy (Node server) -> Cloudflare AI Gateway -> Upstream API

## 功能

- **多 Key 輪詢** — 每個 Provider 獨立 Round-Robin 選 Key
- **Key 故障轉移** — 429/5xx/網路錯誤 -> 指數退避降級 (30s×2ⁿ, max 5min)，成功後逐步恢復
- **Provider 降級** — Fallback Chain 依序嘗試備援 Provider
- **Model 別名路由** — 統一 model 名稱（如 `openai`）或相符的模型名稱優先調用
- **SSE 串流** — 透傳上游串流，自動改回 client 請求的 model 名稱
- **健康檢查** — `GET /health` （帶 client token）查各渠道健康狀態，觸發 free keys 更新與 cloudflare log 清理
- **Free Keys 備援** — 當 CF AI Gateway 所有 key 都失敗時，自動嘗試 free keys
- **非 Chat 端點** — 支援 embeddings、images/generations、audio/speech、audio/transcriptions
- **配置熱重載** — 修改 `config.json` 自動重啟（1秒 debounce）

## 前置需求

- Node.js 18+
- Cloudflare 帳號 (啟用 AI Gateway 服務)
- Node.js 主機 (選用)

## 快速開始

```bash
# 複製設定檔並修改 src/config.json 填入 ACCOUNT_ID, GATEWAY_NAME, API Keys
cp src/config.example.json src/config.json

npm start
```

### 環境變數 (可覆蓋 config.json)

```bash
export PORT=3000
export ACCOUNT_ID=your-account-id
export GATEWAY_NAME=your-gateway-name
export GEMINI_KEYS=key1,key2
npm start
```

## 設定

`src/config.json` 完整欄位參考 `src/config.example.json`。

| 欄位 | 說明 |
|------|------|
| `account_id` | Cloudflare Account ID |
| `gateway_name` | Cloudflare AI Gateway 名稱 |
| `client_token` | （選用）Client 端 Bearer Token，設定後所有 POST 需帶此 Token |
| `timeout` | 上游請求超時（ms，預設 600000） |
| `key_cooldown` | Key 錯誤冷卻時間（ms，預設 30000），指數退避 ×2ⁿ |
| `max_key_backoff` | Key 最長退避時間（ms，預設 300000） |
| `error_log.enabled` | （選用）非200錯誤紀錄檔開關（預設 true） |
| `error_log.path` | （選用）紀錄檔路徑（預設 ./error.log） |
| `error_log.retention_days` | （選用）紀錄保留天數（預設 7） |
| `free_keys.enabled` | 是否啟用公開免費 Key 備援 |
| `free_keys.url` | 免費 Key 來源 URL（GitHub README） |
| `free_keys.base_url` | 免費 Key 的 API 端點 |
| `free_keys.interval_ms` | 輪詢間隔（ms，預設 300000） |
| `log_retention_days` | （選用）CF AI Gateway 日誌保留天數，>0 時 `/health` 會自動清理 |
| `cf_api_token` | （選用）CF API Token，需有 AI Gateway Edit 權限 |
| `providers` | Provider 名稱到 Key 陣列的對應 |
| `models` | Model 別名路由表，可指向字串（單一 provider）或陣列（fallback chain） |

- 以下設定範例，client 發送請求使用 model 名稱 `openai` 將會隨機調用 provider `google-ai-studio`、`mistral` 的對應模型與 keys 做轉發

```json
{
  "providers": {
    "google-ai-studio": ["key1", "key2"],
    "mistral": ["key1"]
  },

  "models": {
    "gemini-2.0-flash": "google-ai-studio",

    "openai": [
      { "provider": "google-ai-studio", "model": "gemini-2.5-flash" },
      { "provider": "google-ai-studio", "model": "gemini-2.0-flash" },
      { "provider": "mistral",   "model": "mistral-large-latest" }
    ]
  }
}
```

## API 使用

相容 OpenAI Chat Completions API：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer client_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

- `model` 可以是真實 model（如 `gemini-2.0-flash`）或 `models` 中定義的虛擬名稱
- `models` 陣列中的目標**依序嘗試**：第一個目標所有 Key 失敗 → 自動換下一個目標（可同 Provider 不同 Model）
- 回應 header `X-Provider` 標示實際使用的 Provider, `X-Upstream-Model` 標示實際上游 model
- 別名路由的 SSE 回應中 model 欄位自動改回 client 請求的名稱

## 健康檢查 (推薦排程)

```bash
curl http://localhost:3000/health
# 未帶 Token 時僅回傳 {status, uptime}
# 帶 Token 時回傳各 Provider 的 key 健康狀態，並觸發：
#   1. 自動清理 Cloudflare AI Gateway logs（需 cf_api_token、log_retention_days）
#   2. 重新爬取免費 key（需 free_keys.enabled）
```

## PM2 部署 (選用)

```bash
npm install -g pm2
pm2 start src/index.js --name api-gateway \
  --max-memory-restart 200M \
  --exp-backoff-restart-delay 10000 \
  --kill-timeout 10000
pm2 save
pm2 startup
```

## 補充

- Client 請求若非使用 chat 端點（TTS/STT/圖像生成）僅 OpenAI providers 可用。
- 在 Cloudflare AI Gateway 中，有支援 cartesia、elevenlabs、deepgram、fal-ai、ideogram 服務使用，但由於上游 API 不同，目前在此專案不適用。
