#!/bin/bash
# add cron job: bash cron.sh
# do restart: bash cron.sh restart
# other host: HOST=your-host PORT=8080 bash cron.sh restart
HOST="${HOST:-localhost}"
PORT="${PORT:-7860}"
LOG_DIR="system/logs"
BASE_URL="http://$HOST:$PORT"

do_restart() {
  echo "[cron] restarting on port $PORT..."
  mkdir -p "$LOG_DIR" "system/temp"
  # Find PID by port
  PID=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2)
  [ -z "$PID" ] && PID=$(lsof -ti :$PORT 2>/dev/null)
  [ -z "$PID" ] && PID=$(netstat -ano 2>/dev/null | findstr ":$PORT " 2>/dev/null | findstr LISTEN 2>/dev/null | awk "{print \$NF}" 2>/dev/null)
  # Kill
  if [ -n "$PID" ]; then
    kill $PID 2>/dev/null; sleep 1; kill -9 $PID 2>/dev/null
    echo "[cron] killed pid $PID"
  fi
  # Start
  nohup node --expose-gc app.js >> "$LOG_DIR/startup.log" 2>&1 & disown
  echo "[cron] started pid $!"
  # Health check (wait up to 15s)
  for i in $(seq 1 15); do
    sleep 1
    if curl -sf $BASE_URL/health > /dev/null 2>&1; then
      echo "[cron] health OK"; return 0
    fi
  done
  echo "[cron] health FAILED — check $LOG_DIR/startup.log"
  return 1
}

# restart mode
if [ "$1" = "restart" ]; then
  do_restart
  exit $?
fi

# cron mode (default)
ss -tlnp 2>/dev/null | grep -q ":$PORT " || lsof -i :$PORT 2>/dev/null | grep -q LISTEN || do_restart
curl -sf $BASE_URL/health > /dev/null 2>&1