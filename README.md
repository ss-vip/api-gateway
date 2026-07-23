# API Gateway

Client → Proxy (Node) → 上游 Provider。
多 Key 輪詢、故障轉移、Model 別名路由、SSE 串流。

## 功能

- **多 Key 輪詢** — 每個 Provider 獨立 Round-Robin
- **Key 故障轉移** — 429/5xx/網路錯誤 → 退避降級，成功後逐步恢復
- **Provider 降級** — Fallback Chain 依序嘗試備援 Provider
- **Model 別名路由** — 依 context window 自動選擇最適合的別名
- **SSE 串流** — 透傳上游串流，自動改回 client 請求的 model 名稱
- **非 Chat 端點** — embeddings、images/generations、audio/speech、audio/transcriptions
- **請求頻率限制** — 可設定 RPM（rate_limit）與 TPM（tpm_limit）
- **管理後台** — `GET /console` 使用 client-token 登入，可檢視/編輯 config、Log
- **運行儀表板** — `/console` 的 Status 顯示各 provider 健康度，並彙總成功/失敗次數、平均延遲、錯誤率
- **配置檔熱重啟** — 修改 config 檔 1 秒後自動重啟

> `log.json` 預設保留 7 天（檔名可由 `log.path` 指定），清理機制由 `/health` 每小時清理，並在每寫入 50 筆時觸發，避免資料無限增長。

## 快速開始

```bash
cp src/config.example.json src/config.json   # 填入 Client Token 與 API keys
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
      { "provider": "mistral",          "model": "mistral-small-latest" },
      { "provider": "cerebras",         "model": "gpt-oss-120b" }
    ]
  }
}
```

## 健康檢查

```bash
curl http://localhost:3000/health
```

## PM2 部署

```bash
npm install -g pm2
pm2 start index.js --name api-gateway --node-args="--max-old-space-size=192" --max-memory-restart 300M --exp-backoff-restart-delay 10000 --kill-timeout 10000
pm2 save && pm2 startup
```

## 設定

所有欄位說明請參閱 `src/config.example.json`。支援 `config.json` / `config.jsonc`（含 `//` 與 `/* */` 註解），值可由同名環境變數覆寫。

## 支援的 Provider

相容 OpenAI Chat Completions API：

openai、mistral、cerebras、deepseek、xai、groq、together、openrouter、cohere、perplexity、huggingface、pollinations、literouter、llm7、nvidia、gpt4free、agnes-ai、sea-lion、kilo、replicate、baseten、parallel

## 手動新增 Provider

任何 **OpenAI-compatible** 的 `/chat/completions` 端點，都能直接在 `config.json` 的 `providers` 以物件形式加入：

```jsonc
"providers": {
  "my-proxy": {
    "apiKeys": ["sk-xxxx"],    // 必填：至少一把 key（keyless 端點尚不支援）
    "baseUrl": "https://xxx",  // 必填：target url，僅接受 http/https，否則啟動時跳過並告警
    "pathPrefix": "/v1",       // 選填：端點路徑前綴，預設 /v1（最終為 baseUrl + pathPrefix + /chat/completions）
    "rpm": 20                  // 選填：每把 key 的帳號級 RPM；省略時套用保守預設 10，避免無限速被 ban
  }
}
```

再於 `models` 把別名指向它即可：

```jsonc
"models": {
  "my-model": [{ "provider": "my-proxy", "model": "upstream-model-name" }]
}
```

- 透過 `/console` 的 Config 編輯器也能直接增刪，存檔後 server 自動重啟生效。
