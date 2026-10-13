import { signToken, verifyToken } from '@rentpro/core';

const secret = () => {
  const s = process.env.FILE_URL_SECRET ?? process.env.AUTH_SECRET;
  if (!s) throw new Error('Thiếu FILE_URL_SECRET/AUTH_SECRET');
  return s;
};

const TTL_SECONDS = 120;

/** URL ký có thời hạn ngắn tới ảnh giấy tờ. Mỗi lần mở vẫn kiểm tra quyền và ghi nhật ký truy cập. */
export function idImageUrl(tenantId: string, documentId: string, side: 'front' | 'back'): string {
  return `/files/${signToken({ t: tenantId, d: documentId, s: side }, secret(), TTL_SECONDS)}`;
}

export function readIdImageToken(token: string): { tenantId: string; documentId: string; side: 'front' | 'back' } | null {
  const c = verifyToken<{ t: string; d: string; s: string }>(token, secret());
  if (!c || (c.s !== 'front' && c.s !== 'back') || typeof c.t !== 'string' || typeof c.d !== 'string') return null;
  return { tenantId: c.t, documentId: c.d, side: c.s };
}
