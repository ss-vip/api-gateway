#!/bin/bash
# Serv00 keep-alive cron: checks service health, keeps PID file updated
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=7860
PID_FILE="$APP_DIR/system/temp/app.pid"
RESTART_LOG="$APP_DIR/system/logs/restart.log"

# Check if service is responding
if curl -sf http://localhost:$PORT/health > /dev/null 2>&1; then
  # Service is alive — update PID file via port (for npm run restart to use)
  lsof -ti :$PORT 2>/dev/null > "$PID_FILE" || true
  exit 0
fi

# Service is down — restart
mkdir -p "$APP_DIR/system/logs" "$APP_DIR/system/temp" "$APP_DIR/system/backups"
cd "$APP_DIR" && nohup node --expose-gc app.js >> "$APP_DIR/system/logs/startup.log" 2>&1 &
echo "$!" > "$PID_FILE"
echo "[$(date)] restarted (pid $!)" >> "$RESTART_LOG"