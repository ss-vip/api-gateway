# ⚡ API Gateway

基於 **Hono** 框架與 **Cloudflare Workers + D1** 構建的 API 轉發服務。支援 OpenAI 與 Anthropic 相容格式，具備智慧路由、負載平衡及內容過濾功能。

---

## ✨ 功能特色

- **🌐 智慧路由**：支援多渠道權重分配、模型精準匹配與向下相容調用。
- **🛡️ 故障冷卻**：自動偵測 429 或 5xx 錯誤，觸發冷卻機制並自動重試（最高 5 次）。
- **🩹 智慧自癒**：異常渠道 30 分鐘後自動嘗試恢復，並進入觀察期確保穩定性。
- **❄️ 回應過濾**：支援回應內容特定字串刪除或關鍵字後綴截斷。
- **📊 管理後台**：內建 `/admin` 管理界面，支援配置 JSON 備份與還原。

---

## 🏗️ 快速部署

1. **資料庫準備**：執行 `npx wrangler d1 create <DB_NAME>` 並將 UUID 填入 `wrangler.toml`。
2. **本地啟動**：執行 `npm start` 初始化本地資料庫並啟動。
3. **佈署雲端**：執行 `npm run deploy` 同步程式碼與資料庫結構。

### 🛠️ 管理指令彙整


| 功能 | 本地指令 (Local) | 雲端指令 (Cloudflare) |
| :--- | :--- | :--- |
| **重置資料庫** | `npm run reset-db` | `npm run reset-remote-db` |
| **重置密碼** | `npm run reset-pw` | `npm run reset-remote-pw` |

---

## 📝 API 使用範例

```bash
curl -X POST https://your-host/v1/chat/completions \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": true
  }'
```
