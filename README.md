# ⚡ API Gateway

輕量的 LLM API 聚合工具，採用 OpenAI 格式路由，具有多 Key 輪詢、故障轉移、Model 別名對應、SSE 串流功能。

<p align="center">
  <a href="https://skillicons.dev">
    <img src="https://ss-vip.github.io/api-gateway/assets/console_page.png" width="90%" />
  </a>
</p>

## 功能

- **多 Key 輪詢** — 每個 Provider 獨立 Round-Robin
- **Key 故障轉移** — 429/5xx/網路錯誤 → 退避降級，成功後逐步恢復
- **Provider 降級** — Fallback Chain 依序嘗試備援 Provider
- **Model 別名路由** — 依 context window 自動選擇最適合的別名
- **端點自動派生** — `endpoint_fallbacks` 讓單一 model 名稱自動對應各端點的 model 別名
- **SSE 串流** — 透傳上游串流，自動改回 client 請求的 model 名稱
- **非 Chat 端點** — embeddings、images/generations、images/edits、images/variations、audio/speech、audio/transcriptions、audio/translations、files
- **請求頻率限制** — 可設定 RPM（rate_limit）與 TPM（tpm_limit）
- **Circuit Breaker** — 連續 5 次 5xx 自動跳過該 provider 30 秒，成功後立即關閉
- **Model Lockout** — 同一 provider/model 連續失敗達 threshold（預設 3）次後暫時停用，避免一直打到壞 model 或塞車的 tier
- **Quota 額度降級** — 429/403 且訊息含 quota/credit/billing 特徵時，該 key 長期降級（預設 1 小時，`quota_backoff` 可設），不讓短 cooldown 後又去打額度耗盡的 key
- **管理後台** — `GET /console` 使用 client-token 登入，可檢視/編輯 config、Log
- **運行儀表板** — `/console` 的 Status 顯示各 provider 健康度，並彙總成功/失敗次數、平均延遲、錯誤率
- **配置檔熱重啟** — 修改 config 檔 1 秒後自動重啟

> `log.json` 預設保留 7 天（檔名可由 `log.path` 指定），清理機制由 `/health` 每小時清理，並在每寫入 200 筆（且距上次清理超過 10 分鐘）時觸發，避免資料無限增長。

---

## 執行環境

| Runtime | 支援 | 啟動方式 |
|---------|------|---------|
| Node.js 18+ | ✅ | `npm start` 或 `node src/index.js` |
| Bun | ✅ | `npm run bun` 或 `bun run src/index.js` |

## 測試

```bash
npm test         # 單元測試
```

測試位於 `test/` 目錄，由 `npm test`（`node --test test/*.test.js`）執行：
- `lib.test.js` — 單元測試：Config 解析（JSONC、自動修正）、Model 別名解析與 Endpoint Fallback、Chat 請求驗證、Token 估算、Utility 函數（uptime、key masking、SSE rewrite 等）
- `integration.test.js` — 整合測試：啟動真實 gateway（subprocess）+ mock upstream，黑箱驗證路由 / auth / SSE rewrite / 錯誤處理 / 各 provider 轉發

核心邏輯提取在 `src/lib.js`，`src/index.js` 透過 delegation 呼叫。

## 快速開始

```bash
cp src/config.example.json src/config.json   # 填入 Client Token 與 API keys
npm start
```
Client Token 非必要但是建議使用，將會是用戶端 API 調用的 header auth 以及 /console 頁面的登入密碼。

## PM2 部署 (選用)

```bash
npm install -g pm2
pm2 start src/index.js --name api-gateway --node-args="--max-old-space-size=192" --max-memory-restart 300M --exp-backoff-restart-delay 10000 --kill-timeout 10000
pm2 save && pm2 startup
```

## 健康檢查

具有 log 清理機制，建議排程 5 分鐘訪問一次。

```bash
curl http://localhost:3000/health
```

---

## 設定

手動編輯 config.json 或訪問 `/console` 路由可進入直接編寫 config.json 設定檔，存檔將會自動重啟生效。

所有欄位說明請參閱 `src/config.example.json`。支援 `config.json` / `config.jsonc`（含 `//` 與 `/* */` 註解），各參數值可由同名稱環境變數覆寫。

## 支援的 Provider

相容 OpenAI Chat Completions API：

| 類型 | Provider |
|------|----------|
| Chat / Embedding | openai、mistral、cerebras、deepseek、xai、groq、together、openrouter、orcarouter、cohere、perplexity、huggingface、pollinations、literouter、llm7、nvidia、gpt4free、agnes-ai、sea-lion、kilo、replicate、baseten、parallel、opencode、morph、aihorde、aihubmix、navy、ollama、hermes、tokenharbor、amd、bazaarlink |
| TTS / STT | cartesia、elevenlabs（內建 OpenAI ↔ 目標格式轉換） |

> ollama 為雲端服務（`https://ollama.com/v1`，key 在 Ollama Cloud 申請）。

- 額外支援 Workers-AI（自動判斷 `https://api.cloudflare.com/client/v4/accounts` URL）：chat / embeddings 原生 OpenAI 相容；image / TTS / STT 自動轉成 Workers AI `/ai/run/{model}` 格式（image 回應轉為 `b64_json`、TTS 回應轉為二進位音檔、STT 回應轉為 `{text}`）

在 providers 加入：
```jsonc
// config.json
"providers": {
  "xxx-cf-workers": {
    "apiKeys": ["cfut_xxx"],
    "baseUrl": "https://api.cloudflare.com/client/v4/accounts/accountID-xxx/ai",
    "pathPrefix": "/v1",
    "rpm": 20
  }
},

"models": {
  "image": [
    { "provider": "xxx-cf-workers", "model": "@cf/black-forest-labs/flux-1-schnell" }
  ],
  "tts": [
    { "provider": "xxx-cf-workers", "model": "@cf/myshell-ai/melotts" }
  ],
  "stt": [
    { "provider": "xxx-cf-workers", "model": "@cf/openai/whisper" }
  ]
}
```

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

### STT (Speech-to-Text) / Translation

`/v1/audio/transcriptions` 與 `/v1/audio/translations` 端點同樣支援 Cartesia 與 ElevenLabs，自動處理 multipart 欄位名稱與模型值轉換。transcriptions 輸出原始語言文字，translations 固定輸出英文（OpenAI 規格）。

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

---

## API 使用

相容 OpenAI Chat Completions API：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -d '{"model":"openai","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

- `model` 可為 config 中定義的別名或真實模型名稱
- 陣列中的目標依序嘗試：第一個目標所有 Key 失敗 → 自動換下一個
- 回應含 `X-Request-Id` header；非串流成功回應目前不附 `X-Provider` / `X-Upstream-Model`（僅 SSE 透傳路徑會帶上游 model 資訊）

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
    "/v1/chat/completions":      "gpt-4o",
    "/v1/images/generations":    "dall-e-3",
    "/v1/images/edits":          "dall-e-3",
    "/v1/images/variations":     "dall-e-3",
    "/v1/audio/speech":          "tts-1",
    "/v1/audio/transcriptions":  "whisper-1",
    "/v1/audio/translations":    "whisper-1",
    "/v1/embeddings":            "text-embedding-3-small",
    "/v1/files":                 "file-store"
  },
  "models": {
    "_note": "key = client 送的 model 名稱；value = provider/model 的 fallback 鏈，依序嘗試",
    "gpt-4o": [
      { "provider": "openrouter", "model": "nvidia/nemotron-3-ultra-550b-a55b:free" },
      { "provider": "openrouter", "model": "google/gemma-4-31b-it:free" },
      { "provider": "mistral", "model": "mistral-small-latest" }
    ],
    "dall-e-3":      [{ "provider": "together", "model": "black-forest-labs/FLUX.1-schnell-free" }],
    "tts-1":         [{ "provider": "cartesia", "model": "sonic-3.5" }],
    "whisper-1":     [{ "provider": "nvidia", "model": "canary-1" }],
    "text-embedding-3-small": [{ "provider": "sea-lion", "model": "aisingapore/SEA-LION-ModernBERT-Embedding-600M" }],
    "file-store":    [{ "provider": "nvidia", "model": "" }]
  }
}
```

流程範例：client 送 `model:"openai"` 到 `/v1/images/generations`
- `resolveModel("openai")` → 不在 `models` 中，回傳 null
- 查 `endpoint_fallbacks["/v1/images/generations"]` → `"dall-e-3"`
- `resolveModel("dall-e-3")` → `[{ provider: "together", model: "black-forest-labs/FLUX.1-schnell-free" }]`

client 只認得一個 model 名稱，gateway 依端點決定實際路由。如果 client 送了 `models` 中已存在的 model（如 `nvidia/nemotron-3-ultra-550b-a55b:free`），則直接命中，不走 defaults。

## 圖片辨識自動路由

請求含圖片（`image_url`）時，Gateway 會自動將 `model` 切換到 `vision` 別名（若存在於 `models` 中）：

```json
"models": {
  "vision": [
    { "provider": "openrouter", "model": "google/gemma-4-31b-it:free" },
    { "provider": "openrouter", "model": "nvidia/nemotron-nano-12b-v2-vl:free" },
    { "provider": "mistral", "model": "mistral-small-latest" }
  ]
}
```

Client 端不需要知道哪些 provider 支援 vision，只要附圖，Gateway 自動優先調用支援 vision 的 provider，失敗則 fallback 到一般 chat chain。

## 圖像編輯與變體

`/v1/images/edits`（編輯）與 `/v1/images/variations`（變體）為 multipart 端點，raw body 直接 forward 到上游。model 由 multipart body 中的 `model` 欄位決定，未指定時透過 `endpoint_fallbacks` 指定 model 別名：

```json
"/v1/images/edits": "image",
"/v1/images/variations": "image"
```

model 別名與 `images/generations` 共用同一 `image` 鏈即可。

## Files API

`/v1/files` 支援：

| Method | 路徑 | 用途 |
|--------|------|------|
| `GET` | `/v1/files` | 列出檔案 |
| `GET` | `/v1/files/:id` | 查詢檔案 |
| `GET` | `/v1/files/:id/content` | 下載檔案內容 |
| `POST` | `/v1/files` | 上傳檔案（multipart） |
| `DELETE` | `/v1/files/:id` | 刪除檔案 |

需在 `endpoint_fallbacks` 指定檔案儲存的上游 provider：

```json
"/v1/files": "nvidia"
```

## Repobeats analytics

<p align="center">
  <a href="https://skillicons.dev">
    <img src="https://repobeats.axiom.co/api/embed/5c642ec598f102ad85ea299cfaa9f01b812796ca.svg" width="90%" />
  </a>
</p>
