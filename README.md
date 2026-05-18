# API Gateway

基於 **Hono** 構建的 AI API Gateway，部屬於 Cloudflare Workers。支援 OpenAI 相容格式，具備智慧路由、故障冷卻、內容過濾功能。

## 功能

- 智慧路由：多渠道權重分配、模型精準匹配、回應時間加權
- 故障冷卻：自動偵測 429/5xx 錯誤，支援 30 秒超時跳換渠道
- 自適應學習：自動識別不支援的功能 (vision/tools/參數) 並避開
- 回應過濾：支援關鍵字刪除或截斷
- 管理後台：`/admin` 網頁介面，`/health` 服務狀態

## 前置需求

- Node.js 18+
- Cloudflare 帳號
- 已建立 D1 資料庫 (填寫 wrangler.toml)

## 快速開始

```bash
# 安裝依賴
npm install

# 初始化 D1 資料庫 (首次測試執行)
npm run db:migrate-local

# 初始化 D1 資料庫 (首次部署執行)
npm run db:migrate-remote

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

## 排程維護 (選用)

建立排程任務：

```
URL: https://your-worker.workers.dev/health
Schedule: Every 5 minutes
```

此端點會自動恢復冷卻到期的渠道、清理狀態、寫入流量統計。

## AI Gateway (選用)

在 Cloudflare Dashboard 建立 AI Gateway 後，將渠道的 base_url 指向 AI Gateway 端點即可啟用快取與分析功能。
