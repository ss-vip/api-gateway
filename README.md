# ⚡ API Gateway

基於 **Hono** 框架構建的 API 轉發服務。支援 OpenAI 相容格式，具備智慧路由、負載平衡及內容過濾功能。

---

## ✨ 功能特色

- **🌐 智慧路由**：支援多渠道權重分配、模型精準匹配與向下相容調用。
- **🛡️ 故障冷卻**：自動偵測 429 或 5xx 錯誤，觸發冷卻機制。
- **🩹 智慧自癒**：異常渠道 30 分鐘後自動嘗試恢復，並進入觀察期確保穩定性。
- **❄️ 回應過濾**：支援回應內容特定字串刪除或關鍵字後綴截斷。
- **📊 管理後台**：有 `/admin` 管理介面，`/health`服務狀態，支援 JSON 備份與還原。

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

訪問 `http://localhost:7860/admin` 進行初始密碼設定。

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
