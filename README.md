# ⚡ API Gateway

基於 **Hono** 框架構建的 API 轉發服務。支援 OpenAI 相容格式，具備智慧路由、負載平衡及內容過濾功能。

---

## ✨ 功能特色

- **🌐 智慧路由**：支援多渠道權重分配、模型精準匹配與向下相容調用。
- **🛡️ 故障冷卻**：自動偵測 429 或 5xx 錯誤，觸發冷卻機制。
- **🩹 智慧自癒**：異常渠道 30 分鐘後自動嘗試恢復，並進入觀察期確保穩定性。
- **❄️ 回應過濾**：支援回應內容特定字串刪除或關鍵字後綴截斷。
- **📊 管理後台**：有 `/admin` 管理介面，`/health`服務狀態，支援 JSON 備份與還原。
- **⚙️ 自動維護**：記憶體趨勢記錄、日誌與每日資料庫變更備份（保留 7 天）。

## 🚀 快速開始

### 安裝依賴

```bash
npm install
```

### 啟動服務

```bash
npm start
```

### 管理後台

開啟 `http://localhost:7860/admin` 進行初始密碼設定。

Client Token 將自動產生，可在 Dashboard 設定頁面查看或修改。

### 儲存位置

日誌與資料庫備份預設儲存於專案目錄中：

```text
api-gateway/                    ← 專案根目錄
├── logs/                       ← 日誌（gitignore）
│   ├── mem.log                 ← 記憶體趨勢
│   ├── backup.log              ← 備份紀錄
│   └── restart.log             ← 重啟紀錄
└── backups/                    ← 資料庫備份（gitignore）
    └── db.20260515.json.gz     ← gzip 壓縮
```

可使用環境變數更改，範例：

```bash
LOG_DIR=/var/log/api-gateway BACKUP_DIR=/data/backups node app.js
```

### 保活腳本

若需要確保服務運作，可修改 `cron.sh` 配置與 chmod +x 權限後，加入 cron job 定期執行。

## 📝 API 使用範例

```bash
curl -X POST http://localhost:7860/v1/chat/completions \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": true
  }'
```
