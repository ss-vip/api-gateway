#!/bin/bash
# Serv00 keep-alive cron: runs every 5 minutes
APP_DIR=~/domains/aigw.nett.to/public_nodejs
PORT=7860
PID_FILE="$APP_DIR/system/temp/app.pid"
RESTART_LOG="$APP_DIR/system/logs/restart.log"
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    exit 0
  fi
fi
mkdir -p "$APP_DIR/system/logs" "$APP_DIR/system/temp" "$APP_DIR/system/backups"
cd "$APP_DIR" && nohup node --expose-gc app.js > /dev/null 2>&1 &
echo "[$(date)] restarted via cron (pid $!)" >> "$RESTART_LOG"