# API Gateway

Cloudflare AI Gateway 代理 — 支援多 API Key 輪詢、故障轉移、Model 別名路由。

**架構**: Client -> 本機 Proxy (Node server) -> Cloudflare AI Gateway -> Upstream API

## 功能

- **多 Key 輪詢** — 每個 Provider 獨立 Round-Robin 選 Key
- **Key 故障轉移** — 429/5xx/網路錯誤 -> 指數退避降級 (30s×2ⁿ, max 5min)，成功後逐步恢復
- **Provider 降級** — Fallback Chain 依序嘗試備援 Provider
- **Model 別名路由** — 統一 model 名稱（如 `openai`）
- **SSE 串流** — 強制 stream 模式，透傳上游串流
- **CORS 全開** — 允許跨域請求
- **健康檢查** — `GET /health` 回報各 Provider Key 健康狀態

## 前置需求

- Node.js 18+
- Cloudflare 帳號 (AI Gateway)
- Node.js 的主機 (選用)

## 快速開始

```bash
# 設定
cp src/config.example.json src/config.json
# 編輯 src/config.json 填入 ACCOUNT_ID, GATEWAY_NAME, API Keys

npm start
```

### 環境變數 (可覆蓋 config.json)

```bash
export ACCOUNT_ID=your-account-id
export GATEWAY_NAME=your-gateway-name
export GEMINI_KEYS=key1,key2,key3
export MISTRAL_KEYS=key1,key2
export OPENAI_KEYS=key1
export PORT=3000
npm start
```

## 設定

`src/config.json` 完整欄位參考 `src/config.example.json`：

```json
{
  "account_id": "your-account-id",
  "gateway_name": "your-gateway-name",

  "client_token": "your-secret-token",

  "providers": {
    "google-ai-studio": ["key1", "key2"],
    "mistral": ["key1"]
  },

  "models": {
    "gemini-2.0-flash": "google-ai-studio",

    "openai": [
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

## 健康檢查

```bash
curl http://localhost:3000/health
# 支援自動清理 Cloudflare AI Gateway logs, 需要建立 Profile API Token 儲存於 config.json
```

## PM2 部署

```bash
npm install -g pm2
pm2 start src/index.js --name api-gateway \
  --max-memory-restart 200M \
  --exp-backoff-restart-delay 10000 \
  --kill-timeout 10000
pm2 save
pm2 startup
```
