import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Base32 không hợp lệ');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = () => base32Encode(randomBytes(20));

/** RFC 6238, HMAC-SHA1, 6 chữ số, bước 30 giây. */
export function totpAt(secret: string, timeMs: number, digits = 6, stepSec = 30): string {
  const counter = Math.floor(timeMs / 1000 / stepSec);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1]! & 0xf;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/** Cho phép lệch ±1 bước. Trả về bước khớp (để chống dùng lại) hoặc null. */
export function verifyTotp(secret: string, token: string, nowMs = Date.now(), window = 1, lastUsedStep?: number): number | null {
  if (!/^\d{6}$/.test(token)) return null;
  const step = Math.floor(nowMs / 1000 / 30);
  for (let d = -window; d <= window; d++) {
    const s = step + d;
    if (lastUsedStep !== undefined && s <= lastUsedStep) continue;
    const expected = Buffer.from(totpAt(secret, s * 30_000));
    if (timingSafeEqual(expected, Buffer.from(token))) return s;
  }
  return null;
}

export const otpauthUrl = (secret: string, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
