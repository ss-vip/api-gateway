// Dashboard 認證 (SHA-256, 輕量)

const PW_MIN_LENGTH = 6;
const PW_MAX_LENGTH = 20;

export { PW_MIN_LENGTH, PW_MAX_LENGTH };

// ---- Password Hashing (SHA-256, ~0.01ms CPU) ---- //
export async function hashPassword(password) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return bytesToHex(new Uint8Array(hash));
}

// ---- Password Verification (SHA-256 comparison) ---- //
export async function verifyPassword(password, storedHash) {
  if (!storedHash || storedHash.length !== 64) return false;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  const inputHashHex = bytesToHex(new Uint8Array(hash));
  return inputHashHex === storedHash;
}

// ---- DB Helpers ---- //
export async function getAdminPass(c) {
  try {
    const cf = await c.env.DB.prepare("SELECT admin_password FROM config WHERE id=1").first();
    return cf?.admin_password || null;
  } catch (e) {
    return null;
  }
}

export async function hasAdminPass(c) {
  const pass = await getAdminPass(c);
  return pass !== null && pass !== "";
}

// ---- Internal helpers ---- //
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
