// PM2 設定檔
module.exports = {
  apps: [{
    name: "api-gateway",
    script: "src/index.js",
    node_args: "--expose-gc",
    env: {
      PORT: 7860,
      NODE_ENV: "production",
    },
    cwd: __dirname,
    // 自動重啟
    max_restarts: 10,
    min_uptime: "10s",
    restart_delay: 3000,
    // 暫時啟用日誌找出連線問題
    error_file: "./pm2-error.log",
    out_file: "./pm2-out.log",
    // 資源限制
    max_memory_restart: "500M",
  }],
};
