# API Gateway

Client → Proxy (Node) → [Cloudflare AI Gateway | 直接 Provider]。  
多 Key 輪詢、故障轉移、Model 別名路由、SSE 串流。

## 功能

- **多 Key 輪詢** — 每個 Provider 獨立 Round-Robin
- **Key 故障轉移** — 429/5xx/網路錯誤 → 退避降級，成功後逐步恢復
- **Provider 降級** — Fallback Chain 依序嘗試備援 Provider
- **Model 別名路由** — 依 context window 自動選擇最適合的別名
- **SSE 串流** — 透傳上游串流，自動改回 client 請求的 model 名稱
- **非 Chat 端點** — embeddings、images/generations、audio/speech、audio/transcriptions
- **請求頻率限制** — 可設定 RPM（rate_limit）與 TPM（tpm_limit）
- **管理後台** — `GET /console` 使用 client-token 登入
- **配置檔熱重啟** — 修改 config 檔 1 秒後自動重啟

## 快速開始

```bash
cp src/config.example.json src/config.json   # 填入 ACCOUNT_ID, GATEWAY_NAME, API keys
npm start
```

## API 使用

相容 OpenAI Chat Completions API：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -d '{"model":"openai","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

- `model` 可為 config 中定義的別名或真實模型名稱
- 陣列中的目標依序嘗試：第一個目標所有 Key 失敗 → 自動換下一個
- 非串流回應含 `X-Provider`、`X-Upstream-Model` headers

## Model 別名範例

```json
{
  "models": {
    "openai": [
      { "provider": "google-ai-studio", "model": "gemini-2.5-flash" },
      { "provider": "mistral",          "model": "mistral-small-latest" },
      { "provider": "cerebras",         "model": "gpt-oss-120b" }
    ]
  }
}
```

## 健康檢查

```bash
curl http://localhost:3000/health
# 帶 token 時可觸發 CF log 清理（需設定 log_retention_days）
```

## PM2 部署

```bash
npm install -g pm2
pm2 start index.js --name api-gateway --node-args="--max-old-space-size=192" --max-memory-restart 300M --exp-backoff-restart-delay 10000 --kill-timeout 10000
pm2 save && pm2 startup
```

## 設定

所有欄位說明請參閱 `src/config.example.json`。支援 `config.json` / `config.jsonc`（含 `//` 與 `/* */` 註解），值可由同名環境變數覆寫。
