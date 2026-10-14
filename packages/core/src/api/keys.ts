import { createHash } from 'node:crypto';
import type { Permission } from '../auth/permissions';

/** Khóa API theo cửa hàng với phạm vi quyền hẹp. Khóa chỉ hiện MỘT lần lúc tạo; hệ thống chỉ lưu băm SHA-256. */

export const API_SCOPES = ['inventory:read', 'customers:read', 'customers:write', 'bookings:read', 'bookings:write', 'availability:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_LABEL: Record<ApiScope, string> = {
  'inventory:read': 'Xem mẫu thiết bị và thiết bị',
  'customers:read': 'Xem khách hàng (không gồm giấy tờ tùy thân)',
  'customers:write': 'Tạo/sửa khách hàng',
  'bookings:read': 'Xem đơn thuê',
  'bookings:write': 'Tạo đơn thuê',
  'availability:read': 'Tra cứu thiết bị còn trống',
};

/** Quyền nội bộ tương ứng. API KHÔNG BAO GIỜ có quyền giấy tờ tùy thân, tiền cọc/hoàn tiền hay cài đặt. */
export const SCOPE_PERMISSIONS: Record<ApiScope, readonly Permission[]> = {
  'inventory:read': ['inventory.view'],
  'customers:read': ['customer.view'],
  'customers:write': ['customer.view', 'customer.manage'],
  'bookings:read': ['booking.view'],
  'bookings:write': ['booking.view', 'booking.create', 'customer.view'],
  'availability:read': ['booking.view', 'inventory.view'],
};

export const isApiScope = (s: string): s is ApiScope => (API_SCOPES as readonly string[]).includes(s);

export function permissionsForScopes(scopes: readonly string[]): ReadonlySet<Permission> {
  const out = new Set<Permission>();
  for (const s of scopes) if (isApiScope(s)) for (const p of SCOPE_PERMISSIONS[s]) out.add(p);
  return out;
}

export function validateScopes(scopes: readonly string[]): string | null {
  if (scopes.length === 0) return 'Chọn ít nhất một phạm vi quyền cho khóa API.';
  const bad = scopes.find((s) => !isApiScope(s));
  return bad ? `Phạm vi không hợp lệ: ${bad}` : null;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const randomString = (random: (n: number) => Uint8Array, len: number) => {
  let s = '';
  // loại bỏ thiên lệch: chỉ dùng byte nhỏ hơn bội số lớn nhất của độ dài bảng ký tự
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  while (s.length < len) for (const b of random(len * 2)) if (b < limit && s.length < len) s += ALPHABET[b % ALPHABET.length];
  return s;
};

export const API_KEY_PREFIX = 'rp_live_';

export function generateApiKey(random: (n: number) => Uint8Array): { key: string; prefix: string } {
  const key = `${API_KEY_PREFIX}${randomString(random, 32)}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 6) };
}

export const hashApiKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/** Định dạng hợp lệ trước khi chạm DB (loại bỏ rác sớm, tránh truy vấn vô ích). */
export const looksLikeApiKey = (s: string): boolean => /^rp_live_[A-Za-z0-9]{32}$/.test(s);

export function parseBearer(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1]! : null;
}

/** Giới hạn tốc độ cửa sổ trượt theo khóa (bộ nhớ). Trả số giây phải chờ, hoặc 0 nếu được phép. */
export function rateLimit(hits: Map<string, number[]>, key: string, max: number, windowMs: number, now = Date.now()): number {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return Math.max(1, Math.ceil((windowMs - (now - recent[0]!)) / 1000));
  }
  recent.push(now);
  hits.set(key, recent);
  return 0;
}
