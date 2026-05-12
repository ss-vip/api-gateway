// ============================================================
// Structured Logger — zero-dependency, Workers-compatible
// ============================================================

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
let currentLevel = LOG_LEVELS.INFO;

export function setLogLevel(level) {
  currentLevel = LOG_LEVELS[level] ?? LOG_LEVELS.INFO;
}

export function log(level, tag, message, data = {}) {
  if (LOG_LEVELS[level] < currentLevel) return;
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      l: level.slice(0, 4),
      tag,
      msg: message,
      ...data,
    })
  );
}
