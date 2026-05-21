export function generateToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const rand = new Uint32Array(30);
  crypto.getRandomValues(rand);
  let t = "sk-";
  for (let i = 0; i < 30; i++) t += chars[rand[i] % chars.length];
  return t;
}
