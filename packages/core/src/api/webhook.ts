import { createHmac, timingSafeEqual } from 'node:crypto';

/** Webhook đi: sự kiện, ký HMAC, lịch thử lại, kiểm tra địa chỉ đích (chống SSRF). Logic thuần. */

export const WEBHOOK_EVENTS = ['booking.created', 'booking.confirmed', 'booking.cancelled', 'booking.delivered', 'booking.returned', 'payment.recorded'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const isWebhookEvent = (s: string): s is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(s);

export const WEBHOOK_EVENT_LABEL: Record<WebhookEvent, string> = {
  'booking.created': 'Tạo đơn thuê mới', 'booking.confirmed': 'Xác nhận đơn thuê', 'booking.cancelled': 'Hủy đơn thuê',
  'booking.delivered': 'Giao thiết bị cho khách', 'booking.returned': 'Nhận thiết bị trả về', 'payment.recorded': 'Ghi nhận khoản thu/chi',
};

export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Chữ ký `v1=<hex>` của `${timestamp}.${body}` bằng HMAC-SHA256 với bí mật của endpoint. Gắn timestamp để chống phát lại. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Bên nhận dùng hàm này (hoặc tự viết tương đương) để kiểm tra chữ ký và độ tươi của timestamp. */
export function verifyWebhookSignature(secret: string, timestamp: number, body: string, header: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** Lần thử lại thứ n (n = số lần đã thử, bắt đầu 1) sau bao nhiêu giây; null = hết lượt. */
export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 43_200] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;
export const retryDelay = (attempts: number): number | null => RETRY_DELAYS_SECONDS[attempts - 1] ?? null;
/** Số lần thất bại liên tiếp của một endpoint thì tự tắt */
export const ENDPOINT_AUTO_DISABLE_AFTER = 30;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function newWebhookSecret(random: (n: number) => Uint8Array): string {
  let s = '';
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  while (s.length < 32) for (const b of random(64)) if (b < limit && s.length < 32) s += ALPHABET[b % ALPHABET.length];
  return `whsec_${s}`;
}

/** Địa chỉ IP thuộc dải nội bộ/đặc biệt (không được gọi tới từ webhook). */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v.includes(':')) {
    if (v === '::' || v === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd)/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
  }
  return false;
}

export interface UrlOptions { /** Cho phép http và địa chỉ nội bộ (chỉ dev/test) */ allowInsecure?: boolean }

/** Kiểm tra cú pháp địa chỉ đích. Việc phân giải DNS và so IP làm lúc gửi (chống DNS rebinding). */
export function validateWebhookUrl(raw: string, o: UrlOptions = {}): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return 'Địa chỉ webhook không hợp lệ.'; }
  if (u.username || u.password) return 'Địa chỉ webhook không được chứa tên đăng nhập/mật khẩu.';
  if (!o.allowInsecure) {
    if (u.protocol !== 'https:') return 'Địa chỉ webhook phải dùng HTTPS.';
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'Không gọi tới địa chỉ nội bộ.';
    const bare = host.replace(/^\[|\]$/g, '');
    if (isPrivateAddress(bare)) return 'Không gọi tới địa chỉ IP nội bộ.';
    if (u.port && !['443', '8443'].includes(u.port)) return 'Chỉ dùng cổng 443 hoặc 8443.';
  } else if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Địa chỉ webhook phải là http(s).';
  if (raw.length > 500) return 'Địa chỉ webhook quá dài.';
  return null;
}
