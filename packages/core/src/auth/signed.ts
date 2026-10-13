import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Token ký HMAC-SHA256 dạng `payload.signature` (base64url), có hạn.
 * Dùng cho phiên admin và liên kết đăng nhập thay. Không mã hóa: đừng đưa bí mật vào payload.
 */
export function signToken(payload: Record<string, unknown>, secret: string, ttlSeconds: number, nowMs = Date.now()): string {
  if (secret.length < 16) throw new Error('Khóa ký quá ngắn');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(nowMs / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string, secret: string, nowMs = Date.now()): (T & { exp: number }) | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(mac(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
    return typeof data.exp === 'number' && data.exp * 1000 > nowMs ? data : null;
  } catch {
    return null;
  }
}

const mac = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url');
