#!/bin/bash
# Serv00 keep-alive cron: runs every 5 minutes
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=7860
RESTART_LOG="$APP_DIR/system/logs/restart.log"

# Check if service is actually responding on the port (not relying on pid file)
if curl -sf http://localhost:$PORT/health > /dev/null 2>&1; then
  exit 0
fi

# Service is down — restart
mkdir -p "$APP_DIR/system/logs" "$APP_DIR/system/temp" "$APP_DIR/system/backups"
cd "$APP_DIR" && nohup node --expose-gc app.js >> "$APP_DIR/system/logs/startup.log" 2>&1 &
echo "[$(date)] restarted (pid $!)" >> "$RESTART_LOG"