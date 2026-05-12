// ============================================================
// Dashboard Authentication
// PBKDF2 password hashing + constant-time verification
// Designed for Workers 10ms CPU budget: 1,000 iterations ≈ 2ms
// ============================================================
import { timingSafeEqual } from "hono/utils/buffer";

const PBKDF2_ITERATIONS = 1_000;
const PW_MIN_LENGTH = 6;
const PW_MAX_LENGTH = 20;

export { PW_MIN_LENGTH, PW_MAX_LENGTH };

// ---- Password Hashing (PBKDF2, Workers Web Crypto API) ---- //
export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key, 256
  );
  const saltHex = bytesToHex(salt);
  const hashHex = bytesToHex(new Uint8Array(hashBuffer));
  return saltHex + ":" + hashHex;
}

// ---- Password Verification (constant-time) ---- //
export async function verifyPassword(password, storedHash) {
  if (!storedHash || storedHash.length < 32) return false;
  const parts = storedHash.split(":");
  if (parts.length !== 2) return false;
  const [saltHex, storedHashHex] = parts;

  const encoder = new TextEncoder();
  const salt = hexToBytes(saltHex);
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key, 256
  );
  const inputHashHex = bytesToHex(new Uint8Array(hashBuffer));

  // Constant-time: hash both inputs to guarantee equal length
  const hashEq = async (s) => {
    const buf = await crypto.subtle.digest("SHA-256", encoder.encode(s));
    return bytesToHex(new Uint8Array(buf));
  };
  return timingSafeEqual(inputHashHex, storedHashHex, hashEq);
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

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
}
