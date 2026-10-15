# ⚡ API Gateway

輕量的 LLM API 聚合工具，採用 OpenAI 格式路由，具有多 Key 輪詢、故障轉移、Model 別名對應、SSE 串流功能。

<p align="center">
  <a href="https://skillicons.dev">
    <img src="https://ss-vip.github.io/api-gateway/assets/console_page.png" width="90%" />
  </a>
</p>

## 功能

- **多 Key 輪詢與健康降級** — 健康分數同分列隊輪詢、低分退為備援；只有 401/403/429/5xx 算健康訊號，400/404 等請求錯誤不污染金鑰
- **故障轉移** — Fallback Chain 依序換目標、跨別名 fallback、Circuit Breaker、Model Lockout、Quota 額度長降級（`gw-state.json` 重啟保留）
- **Model 別名路由** — 別名鏈、`endpoint_fallbacks` 端點派生、請求帶圖自動切 `vision`、`smart_route` 依 `max_tokens` 選 tier
- **SSE 串流** — 透傳上游串流、model 名改回 client 請求值、以「收到終端事件」判定串流健康
- **OpenAI 相容契約** — 統一錯誤信封、未知 model 回 404 `model_not_found`、`stream_options.include_usage` 補幀、`x-ratelimit-*` 回報
- **非 Chat 端點** — embeddings、moderations、rerank、images、audio、files、responses、messages、classifier、models、health
- **限流** — `rate_limit`（每把 key 請求間隔，毫秒）、`tpm_limit`（每分鐘 token）、provider `rpm`
- **管理後台 `/console`** — client-token 登入，檢視／編輯 config 與 Log、Provider 健康儀表板、config 熱重啟（改檔 1 秒後生效），各欄位有就地提示

## 執行環境

| Runtime | 支援 | 啟動方式 |
|---------|------|---------|
| Node.js 18+ | ✅ | `npm start` 或 `node src/index.js` |
| Bun | ✅ | `npm run bun` 或 `bun run src/index.js` |

## 測試

```bash
npm test         # 單元 + 整合測試
```

- `lib.test.js` — 純函式：JSONC 解析與自動修正、別名／Endpoint Fallback、Token 估算、Chat↔Responses↔Anthropic 轉換、SSE rewrite、example 一致性
- `integration.test.js` — 真實 gateway（subprocess）+ mock upstream 黑箱：路由、auth、SSE、錯誤信封、`x-ratelimit-*`、截斷、413
- `adaptive.test.js` — 健康會計：4xx 不污染金鑰、5xx 才開斷路器、401 只影響單一金鑰
- `keystate.test.js` — 重啟後降級狀態保留（`gw-state.json`）

## 快速開始

```bash
cp src/config.example.jsonc src/config.jsonc   # 填入 Client Token 與 API keys
npm start
```
Client Token 非必要但是建議使用，將會是用戶端 API 呼叫的 header auth 以及 /console 頁面的登入密碼。

## PM2 部署 (選用)

```bash
npm install -g pm2
pm2 start src/index.js --name api-gateway --node-args="--max-old-space-size=192" --max-memory-restart 300M --exp-backoff-restart-delay 10000 --kill-timeout 10000
pm2 save && pm2 startup
```

## 反向代理（Nginx，選用）

`/console` 的即時狀態走長連線 SSE。代理層若緩衝或壓縮它，會在瀏覽器出現 `ERR_HTTP2_PROTOCOL_ERROR`（客戶端會自動重連，功能不受影響，但 console 會有紅字）。Nginx 建議設定：

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;          # 關鍵：不要緩衝 SSE 長連線
  proxy_read_timeout 3600s;     # 覆蓋預設 60s，避免砍掉閒置串流
  proxy_set_header Host $host;
}
```

若前端是 Cloudflare，確認該路徑沒有開啟壓縮／Rocket Loader 之類會改寫串流的功能（服務端已送 `Cache-Control: no-cache, no-transform` 要求代理不要動它）。

## 健康檢查

具有 log 清理機制，建議排程 5 分鐘訪問一次（`log.json` 預設保留 7 天）。

```bash
curl http://localhost:3000/health
```

## 設定

手動編輯 config.json 或訪問 `/console` 路由可進入直接編寫 config.json 設定檔，存檔將會自動重啟生效。

所有欄位說明請參閱 `src/config.example.jsonc`。支援 `config.json` / `config.jsonc`（含 `//` 與 `/* */` 註解）。

**可由環境變數覆寫的只有**：`client_token`、`port`、`timeout`、`upstream_timeout`、`upstream_max_body`、`max_body_size`、`key_cooldown`、`max_key_backoff`、`quota_backoff`，以及 provider 金鑰（`<PROVIDER>_KEYS`，逗號分隔，**取代**而非附加 config 內的值）。`log`、`models`、`endpoint_fallbacks`、`smart_route`、`model_limits`、`rate_limit`、`tpm_limit`、`classifier` 僅能改檔案。

## 支援的 Provider

相容 OpenAI Chat Completions API：

| 類型 | Provider |
|------|----------|
| Chat / Embedding | openai、mistral、cerebras、deepseek、xai、groq、together、openrouter、orcarouter、cohere、perplexity、huggingface、pollinations、literouter、llm7、nvidia、gpt4free、agnes-ai、sea-lion、kilo、replicate、baseten、parallel、opencode、anthropic、vyceai、morph、aihorde、aihubmix、apinex、navy、ollama、hermes、tokenharbor、amd、bazaarlink、flatkey、tokenrouter |
| TTS / STT | cartesia、elevenlabs（內建 OpenAI ↔ 目標格式轉換） |

> ollama 為雲端服務（`https://ollama.com/v1`，key 在 Ollama Cloud 申請）。另支援 Workers-AI（`api.cloudflare.com/.../ai` base URL 自動判斷，image／TTS／STT 自動轉 `/ai/run/{model}`）。

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

## Client API 使用

相容 OpenAI Chat Completions API：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -d '{"model":"openai","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

- `model` 可為 config 中定義的別名或真實模型名稱
- 陣列中的目標依序嘗試：第一個目標所有 Key 失敗 → 自動換下一個
- 回應含 `X-Request-Id` header。Chat 非串流成功回應另附 `X-Provider` / `X-Upstream-Model`；SSE 串流因需逐幀改寫 model 名稱，不附這兩個 header

## 詳細功能說明

Model 別名／`endpoint_fallbacks`、格式轉換（TTS/STT/Workers-AI）、圖片預處理、可靠性與限流、Files／classifier 等行為細節，以 `src/config.example.jsonc` 內的註解為準。

---

## Repobeats analytics

<p align="center">
  <a href="https://skillicons.dev">
    <img src="https://repobeats.axiom.co/api/embed/5c642ec598f102ad85ea299cfaa9f01b812796ca.svg" width="90%" />
  </a>
</p>
