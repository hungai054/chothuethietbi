import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/** AES-256-GCM. Định dạng: v1.<keyId>.<iv>.<tag>.<data> (base64url). Xoay khóa theo keyId. */
export type KeyRing = { current: string; keys: Record<string, Buffer> };

export function encryptSecret(plain: string, ring: KeyRing): string {
  const key = ring.keys[ring.current];
  if (!key || key.length !== 32) throw new Error('Khóa chủ phải dài 32 byte');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return ['v1', ring.current, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptSecret(token: string, ring: KeyRing): string {
  const [v, keyId, iv, tag, data] = token.split('.');
  if (v !== 'v1' || !keyId || !iv || !tag || !data) throw new Error('Bí mật không hợp lệ');
  const key = ring.keys[keyId];
  if (!key) throw new Error(`Không có khóa ${keyId}`);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

/** Giải mã bằng khóa cũ, mã hóa lại bằng khóa hiện tại. */
export function rotateSecret(token: string, ring: KeyRing): string {
  return encryptSecret(decryptSecret(token, ring), ring);
}

/**
 * Khóa chủ từ môi trường: MASTER_KEY (base64, 32 byte) là khóa hiện tại; MASTER_KEY_PREVIOUS (tùy chọn) để giải mã dữ liệu cũ khi xoay khóa.
 * Production bắt buộc có MASTER_KEY; môi trường phát triển dùng khóa dev cố định (KHÔNG an toàn) kèm cảnh báo.
 */
export function keyRingFromEnv(env: Record<string, string | undefined> = process.env): KeyRing {
  const decode = (v: string, name: string) => {
    const b = Buffer.from(v, 'base64');
    if (b.length !== 32) throw new Error(`${name} phải là 32 byte mã hóa base64 (dùng: openssl rand -base64 32).`);
    return b;
  };
  const keys: Record<string, Buffer> = {};
  let current = env.MASTER_KEY_ID ?? 'k1';
  if (env.MASTER_KEY) keys[current] = decode(env.MASTER_KEY, 'MASTER_KEY');
  else if (env.NODE_ENV === 'production') throw new Error('Thiếu MASTER_KEY trong môi trường production.');
  else {
    keys[current] = Buffer.alloc(32, 'rentpro-dev-key');
    if (!(globalThis as { __warnedDevKey?: boolean }).__warnedDevKey) {
      (globalThis as { __warnedDevKey?: boolean }).__warnedDevKey = true;
      console.warn('[rentpro] Đang dùng khóa mã hóa DEV. Đặt MASTER_KEY trước khi triển khai.');
    }
  }
  if (env.MASTER_KEY_PREVIOUS) keys[env.MASTER_KEY_PREVIOUS_ID ?? 'k0'] = decode(env.MASTER_KEY_PREVIOUS, 'MASTER_KEY_PREVIOUS');
  return { current, keys };
}

/** Chỉ mục mù để tìm trùng/danh sách đen mà không giải mã: HMAC-SHA256 với khóa hiện tại + ngữ cảnh. */
export function blindIndex(value: string, context: string, ring: KeyRing): string {
  const key = ring.keys[ring.current];
  if (!key) throw new Error('Không có khóa hiện tại');
  return createHmac('sha256', key).update(`${context}\0${value}`).digest('base64url');
}
