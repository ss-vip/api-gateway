// 通道池管理 — 輕量版
// 從 D1 載入 channels，in-memory 健康狀態追蹤 + cooldown
// cooldown 時間 = UPSTREAM_TIMEOUT_MS（由 constants.js 統一控制）

import { CHANNEL_COOLDOWN_MS } from "./constants.js";

const REFRESH_MS = 60_000; // 每分鐘重新載入通道清單

let cachedChannels = null;
let lastLoad = 0;
let loadPromise = null;
const degradedUntil = new Map(); // channelId → timestamp

/** 從 D1 載入已啟用的通道清單 */
async function loadChannels(env) {
  const now = Date.now();
  if (cachedChannels && now - lastLoad < REFRESH_MS) return cachedChannels;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const { results } = await env.DB.prepare(
        "SELECT id, name, base_url, api_key, weight FROM channels WHERE is_enabled = 1 ORDER BY weight DESC"
      ).all();
      cachedChannels = results || [];
    } catch (e) {
      console.error("[channel] load error:", e.message);
      cachedChannels = cachedChannels || [];
    }
    lastLoad = Date.now();
    loadPromise = null;
    return cachedChannels;
  })();

  return loadPromise;
}

/** 清除通道快取（供 dashboard 修改通道後呼叫） */
function clearChannelCache() {
  cachedChannels = null;
  lastLoad = 0;
}

/** 加權隨機選擇一個健康通道 */
function selectChannel(channels, exclude = new Set()) {
  const healthy = channels.filter(c => !exclude.has(c.id) && !isDegraded(c.id));
  if (healthy.length === 0) return null;

  const totalWeight = healthy.reduce((s, c) => s + Math.max(c.weight, 1), 0);
  let r = Math.random() * totalWeight;
  for (const c of healthy) {
    r -= Math.max(c.weight, 1);
    if (r <= 0) return c;
  }
  return healthy[healthy.length - 1];
}

/** 標記通道為異常 — cooldown 時間取決於 CHANNEL_COOLDOWN_MS */
function markDegraded(channelId) {
  degradedUntil.set(channelId, Date.now() + CHANNEL_COOLDOWN_MS);
}

/** 標記通道為健康 */
function markHealthy(channelId) {
  degradedUntil.delete(channelId);
}

/** 檢查通道是否在 cooldown 中 */
function isDegraded(channelId) {
  const until = degradedUntil.get(channelId);
  if (!until) return false;
  if (Date.now() < until) return true;
  degradedUntil.delete(channelId);
  return false;
}

export { loadChannels, clearChannelCache, selectChannel, markDegraded, markHealthy };
