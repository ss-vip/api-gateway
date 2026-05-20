export function generateToken() {
  const bytes = new Uint8Array(30);
  crypto.getRandomValues(bytes);
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let t = "sk-";
  for (let i = 0; i < 30; i++) t += chars[bytes[i] % chars.length];
  return t;
}
