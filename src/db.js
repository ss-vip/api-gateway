export const getDbConfig = async (db, key) => {
  const res = await db.prepare("SELECT value FROM config WHERE key = ?").bind(key).first();
  return res?.value;
};

export const updateDbConfig = async (db, key, value) => {
  await db.prepare("UPDATE config SET value = ? WHERE key = ?").bind(value, key).run();
};

export const getChannels = async (db) => {
  const { results } = await db.prepare("SELECT * FROM channels ORDER BY id DESC").all();
  return results;
};

export const getAvailableChannels = async (db, cooldownSeconds = 300, isVision = false) => {
  const now = Math.floor(Date.now() / 1000);

  // Use Pacific Time (PT) for both RPM and RPD reset calculations
  const getPTDateTime = () => {
    const now = new Date();
    const ptStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(now);
    // Format: YYYY-MM-DD HH:MM -> YYYYMMDDHHMM
    return parseInt(ptStr.replace(/[-: T]/g, ''));
  };

  const nowMinute = getPTDateTime(); // YYYYMMDDHHMM for RPM

  const ptDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  const nowDay = parseInt(ptDateStr.replace(/-/g, '')); // YYYYMMDD

  const visionFilter = isVision ? "AND is_vision = 1" : "";

  const { results } = await db.prepare(`
    SELECT * FROM channels
    WHERE is_enabled = 1
    AND (? - last_429 > ?)
    ${visionFilter}
    AND (rpm = 0 OR last_rpm_reset < ? OR rpm_count < rpm)
    AND (rpd = 0 OR last_rpd_reset < ? OR rpd_count < rpd)
    AND (consecutive_errors < 20)
  `).bind(now, cooldownSeconds, nowMinute, nowDay).all();

  return results;
};

export const incrementChannelUsage = async (db, id) => {
  // Use consistent PT time format
  const getPTDateTime = () => {
    const now = new Date();
    const ptStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(now);
    return parseInt(ptStr.replace(/[-: T]/g, ''));
  };

  const nowMinute = getPTDateTime();

  const ptDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  const nowDay = parseInt(ptDateStr.replace(/-/g, ''));

  // Update counts and reset flags atomically
  await db.prepare(`
    UPDATE channels
    SET
      rpm_count = CASE WHEN last_rpm_reset < ? THEN 1 ELSE rpm_count + 1 END,
      last_rpm_reset = ?,
      rpd_count = CASE WHEN last_rpd_reset < ? THEN 1 ELSE rpd_count + 1 END,
      last_rpd_reset = ?
    WHERE id = ?
  `).bind(nowMinute, nowMinute, nowDay, nowDay, id).run();
};

export const resetChannelHealth = async (db, id) => {
  await db.prepare("UPDATE channels SET consecutive_errors = 0, last_error_msg = NULL WHERE id = ?").bind(id).run();
};

export const updateChannelError = async (db, id, errorMsg) => {
  await db.prepare("UPDATE channels SET consecutive_errors = consecutive_errors + 1, last_error_msg = ? WHERE id = ?").bind(errorMsg || "Unknown Error", id).run();
};


export const updateChannelCooldown = async (db, id) => {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("UPDATE channels SET last_429 = ? WHERE id = ?").bind(now, id).run();
};

export const insertLog = async (db, data) => {
  const {
    channel_name,
    model,
    prompt,
    request_body,
    target_url,
    response_status,
    response_body,
    latency_ms,
    error_msg = null
  } = data;

  await db.prepare(
    "INSERT INTO logs (channel_name, model, prompt, request_body, target_url, response_status, response_body, latency_ms, error_msg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    channel_name || "Unknown",
    model || "-",
    prompt || "",
    JSON.stringify(request_body || {}),
    target_url || "",
    response_status || 0,
    (response_body || "").substring(0, 5000),
    latency_ms || 0,
    error_msg
  ).run();
};

export const getLogs = async (db, limit = 50) => {
  const { results } = await db.prepare("SELECT id, channel_name, response_status, latency_ms, target_url, created_at FROM logs ORDER BY id DESC LIMIT ?").bind(limit).all();
  return results;
};

export const getChannelById = async (db, id) => {
  const res = await db.prepare("SELECT * FROM channels WHERE id = ?").bind(id).first();
  return res;
};

export const getLogById = async (db, id) => {
  const res = await db.prepare("SELECT * FROM logs WHERE id = ?").bind(id).first();
  return res;
};

export const clearLogs = async (db) => {
  await db.prepare("DELETE FROM logs").run();
};

// Filter Management
export const getFilters = async (db) => {
  const { results } = await db.prepare("SELECT * FROM filters ORDER BY id DESC").all();
  return results;
};


export const addFilter = async (db, text, mode, is_enabled) => {
  await db.prepare("INSERT INTO filters (text, mode, is_enabled) VALUES (?, ?, ?)").bind(text, mode || 0, is_enabled ? 1 : 0).run();
};

export const updateFilter = async (db, id, text, mode, is_enabled) => {
  await db.prepare("UPDATE filters SET text = ?, mode = ?, is_enabled = ? WHERE id = ?").bind(text, mode || 0, is_enabled ? 1 : 0, id).run();
};

export const deleteFilter = async (db, id) => {
  await db.prepare("DELETE FROM filters WHERE id = ?").bind(id).run();
};
