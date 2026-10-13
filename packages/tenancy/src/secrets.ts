import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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
