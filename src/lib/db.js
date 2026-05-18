export function generateToken() {
  const bytes = new Uint8Array(30);
  crypto.getRandomValues(bytes);
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let t = "sk-";
  for (let i = 0; i < 30; i++) t += chars[bytes[i] % chars.length];
  return t;
}

function hexFromBytes(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function quickHash(obj) {
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return hexFromBytes(new Uint8Array(hash)).slice(0, 16);
}
