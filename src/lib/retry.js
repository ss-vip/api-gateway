/**
 * 共享 retry 函式 - 支援指數退避重試 (上限 3 秒)
 * 用途：D1 batch write、fetch 等可能因 race condition 或暫時性網路問題而失敗的操作
 */
export async function retry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) {
      if (i === retries) throw e;
      const delay = Math.min(100 * Math.pow(2, i), 3000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
