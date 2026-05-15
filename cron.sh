#!/bin/bash
APP_DIR=~/domains/www.your-host.net/public_nodejs
PORT=7860
PID_FILE="$APP_DIR/temp/app.pid"
RESTART_LOG="$APP_DIR/logs/restart.log"
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    exit 0
  fi
fi
mkdir -p "$APP_DIR/logs"
cd "$APP_DIR" && nohup node --expose-gc app.js > /dev/null 2>&1 &
echo "[$(date)] restarted via cron" >> "$RESTART_LOG"