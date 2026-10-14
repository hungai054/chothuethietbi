import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { hostOf } from './tenant';

/** Host của trang giới thiệu/đăng ký: chính tên miền gốc (hoặc www.), chỉ ở chế độ shared. Subdomain là cửa hàng. */
export function isMarketingHost(host: string, env: Record<string, string | undefined> = process.env): boolean {
  if (env.DEPLOY_MODE === 'dedicated') return false;
  const h = host.toLowerCase().split(':')[0] ?? '';
  const base = (env.BASE_DOMAIN ?? 'localhost').toLowerCase();
  return h === base || h === `www.${base}`;
}

/** Dùng ở đầu trang tiếp thị: trên host cửa hàng (hoặc chế độ dedicated) trả 404. */
export async function requireMarketingHost(): Promise<void> {
  const h = await headers();
  if (!isMarketingHost(hostOf(h))) notFound();
}

/** Địa chỉ gốc của request hiện tại, VD http://localhost:3000. Dùng dựng liên kết trong thư xác thực. */
export async function originOf(): Promise<string> {
  const h = await headers();
  const host = hostOf(h);
  const proto = h.get('x-forwarded-proto')?.split(',')[0] ?? (host.startsWith('localhost') || host.includes('.localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Địa chỉ cửa hàng theo slug: PUBLIC_URL_TEMPLATE ("https://{slug}.rentpro.vn") hoặc suy ra từ host hiện tại. */
export async function shopUrl(slug: string): Promise<string> {
  const tpl = process.env.PUBLIC_URL_TEMPLATE;
  if (tpl) return tpl.replace('{slug}', slug);
  const h = await headers();
  const host = hostOf(h);
  const origin = await originOf();
  const proto = origin.split('://')[0];
  const base = host.toLowerCase().replace(/^www\./, '');
  return `${proto}://${slug}.${base}`;
}

/** Giới hạn tốc độ đơn giản trong bộ nhớ (theo IP): chống gửi biểu mẫu hàng loạt. Nhiều máy chủ thì thay bằng kho chung. */
const hits = new Map<string, number[]>();
export function throttled(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) { hits.set(key, recent); return true; }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
  return false;
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown';
}
