import { scrypt as _scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(_scrypt);

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}
export async function verifyPassword(pw, stored) {
  const [v, saltHex, keyHex] = String(stored).split('$');
  if (v !== 's1') return false;
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(keyHex, 'hex');
  return key.length === want.length && timingSafeEqual(key, want);
}
export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (t) => createHash('sha256').update(t).digest('hex');

// In-memory sliding-window limiter (per process). Enough for a single small instance.
export function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    return true;
  };
}
