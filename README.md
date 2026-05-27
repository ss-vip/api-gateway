# API Gateway

相容 OpenAI API 代理閘道。支援加權負載平衡、故障冷卻、串流內容過濾。

## 功能

- **相容代理** — 完整 `/v1/chat/completions`、`/v1/models` 轉發
- **負載平衡** — 依 weight 權重隨機選取通道
- **故障冷卻** — HTTP 5xx/429/網路錯誤自動標記 degraded，120 秒後自動恢復
- **串流過濾** — RollingFilter 關鍵字刪除/截斷（TransformStream）

## 前置需求

- Node.js 18+
- Cloudflare 帳號
- D1 資料庫 (`wrangler d1 create api-gateway-db`)

## 快速開始

```bash
npm install
cp wrangler.toml.example wrangler.toml  # 填入 database_id
npm run dev    # 本地開發
npm run deploy # 部署上線
```

首次啟動自動建立 tables（channels / filters / config）。

## 管理後台

開啟 `<your-worker-url>/admin` 設定管理密碼。

Client Token 自動產生，可在 Dashboard 查看/修改。

## API 使用

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

`reasoning_content`（長思考模型）透明穿透，無需特殊處理。

## 架構備註

- Cloudflare Workers + Hono + D1
- 渠道快取 60 秒，token 快取 60 秒，filter 快取 180 秒
- 超時: upstream 120 秒（長思考模型適用），全域 300 秒
- 無 migrations — schema 由冷啟動 `ensureSchema()` 自動處理
