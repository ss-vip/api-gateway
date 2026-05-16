#!/bin/bash
# add cron job:  bash cron.sh
# do restart:    bash cron.sh restart
# custom url:    BASE_URL=https://api-gateway-host bash cron.sh restart
# custom port:   PORT=8080 bash cron.sh
BASE_URL="${BASE_URL:-http://${HOST:-localhost}:${PORT:-7860}}"
PORT="${PORT:-7860}"
LOG_DIR="system/logs"

do_restart() {
  TS="[$(date '+%Y-%m-%d %H:%M:%S')]"
  echo "$TS [cron] restarting on port $PORT..."
  mkdir -p "$LOG_DIR" "system/temp"
  # Find PID by port
  PID=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2)
  [ -z "$PID" ] && PID=$(lsof -ti :$PORT 2>/dev/null)
  [ -z "$PID" ] && PID=$(netstat -ano 2>/dev/null | findstr ":$PORT " 2>/dev/null | findstr LISTEN 2>/dev/null | awk "{print \$NF}" 2>/dev/null)
  # Kill
  if [ -n "$PID" ]; then
    kill $PID 2>/dev/null; sleep 1; kill -9 $PID 2>/dev/null
    echo "$TS [cron] killed pid $PID"
  fi
  # Start
  nohup node --expose-gc app.js >> "$LOG_DIR/startup.log" 2>&1 & disown
  echo "$TS [cron] started pid $!"
  # Health check (wait up to 15s)
  for i in $(seq 1 15); do
    sleep 1
    if curl -sf $BASE_URL/health > /dev/null 2>&1; then
      echo "$TS [cron] health OK"; return 0
    fi
  done
  echo "$TS [cron] health FAILED — check $LOG_DIR/startup.log"
  return 1
}

# restart mode
if [ "$1" = "restart" ]; then
  do_restart
  exit $?
fi

# cron mode (default)
TS="[$(date '+%Y-%m-%d %H:%M:%S')]"
ss -tlnp 2>/dev/null | grep -q ":$PORT " || lsof -i :$PORT 2>/dev/null | grep -q LISTEN || do_restart
curl -sf $BASE_URL/health > /dev/null 2>&1