# API Gateway

Client → Proxy (Node) → 上游 Provider。
多 Key 輪詢、故障轉移、Model 別名路由、SSE 串流。

## 功能

- **多 Key 輪詢** — 每個 Provider 獨立 Round-Robin
- **Key 故障轉移** — 429/5xx/網路錯誤 → 退避降級，成功後逐步恢復
- **Provider 降級** — Fallback Chain 依序嘗試備援 Provider
- **Model 別名路由** — 依 context window 自動選擇最適合的別名
- **端點自動派生** — `endpoint_defaults` 讓單一 model 名稱自動對應各端點的 model 別名
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

## 端點自動派生

Client 送任何不在 `models` 中的 model 名稱（例如 `"openai"`），Gateway 會依端點路徑自動從 `endpoint_fallbacks` 查到對應的 model 別名再解析：

```json
{
  "endpoint_fallbacks": {
    "/v1/chat/completions":     "gpt-4o",
    "/v1/images/generations":  "dall-e-3",
    "/v1/audio/speech":       "tts-1",
    "/v1/audio/transcriptions": "whisper-1",
    "/v1/embeddings":         "text-embedding-3-small"
  },
  "models": {
    "gpt-4o":        [{ "provider": "llm7", "model": "gpt-5.5" }],
    "dall-e-3":      [{ "provider": "llm7", "model": "gpt-image-2" }],
    "tts-1":         [{ "provider": "pollinations", "model": "universal-2" }],
    "whisper-1":     [{ "provider": "pollinations", "model": "whisper" }],
    "text-embedding-3-small": [{ "provider": "pollinations", "model": "openai-3-small" }]
  }
}
```

流程範例：client 送 `model:"openai"` 到 `/v1/images/generations`
- `resolveModel("openai")` → 不在 `models` 中，回傳 null
- 查 `endpoint_fallbacks["/v1/images/generations"]` → `"dall-e-3"`
- `resolveModel("dall-e-3")` → `[{ provider: "llm7", model: "gpt-image-2" }]`

client 只認得一個 model 名稱，gateway 依端點決定實際路由。如果 client 送了 `models` 中已存在的 model（如 `gpt-5.5`），則直接命中，不走 defaults。

## 圖片辨識自動路由

請求含圖片（`image_url`）時，Gateway 會自動將 `model` 切換到 `vision` 別名（若存在於 `models` 中）：

```json
"models": {
  "vision": [
    { "provider": "llm7", "model": "gpt-5.4-mini" },
    { "provider": "opencode", "model": "deepseek-v4-flash-free" }
  ]
}
```

Client 端不需要知道哪些 provider 支援 vision，只要附圖，Gateway 自動優先調用支援 vision 的 provider，失敗則 fallback 到一般 chat chain。

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

openai、mistral、cerebras、deepseek、xai、groq、together、openrouter、cohere、perplexity、huggingface、pollinations、literouter、llm7、nvidia、gpt4free、agnes-ai、sea-lion、kilo、replicate、baseten、parallel、cartesia、elevenlabs

### TTS (Text-to-Speech)

`/v1/audio/speech` 端點內建 **Cartesia** 與 **ElevenLabs** 的格式轉換。非 OpenAI 相容的 TTS provider 無需手動適配，Gateway 會自動將 OpenAI 請求轉成目標 provider 格式：

```jsonc
// config.json
"providers": {
  "cartesia": ["sk_car_..."],
  "elevenlabs": ["xi-api-key..."]
},
"models": {
  "tts-1": [
    { "provider": "cartesia", "model": "sonic-3.5" },
    { "provider": "elevenlabs", "model": "eleven_multilingual_v2" }
  ]
}
```

client 送標準 OpenAI TTS 請求即可，Gateway 依 `model` 別名自動轉發。

### STT (Speech-to-Text)

`/v1/audio/transcriptions` 端點同樣支援 Cartesia 與 ElevenLabs，自動處理 multipart 欄位名稱與模型值轉換。

```jsonc
"models": {
  "tts-1": [
    { "provider": "cartesia", "model": "sonic-3.5" },
    { "provider": "elevenlabs", "model": "eleven_multilingual_v2" }
  ],
  "whisper-1": [
    { "provider": "cartesia", "model": "ink-whisper" },
    { "provider": "elevenlabs", "model": "scribe" }
  ]
}
```

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
