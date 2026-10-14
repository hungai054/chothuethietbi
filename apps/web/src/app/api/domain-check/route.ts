import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Máy chủ chặn trước TLS (Caddy `on_demand_tls { ask … }`) hỏi tên miền nào được cấp chứng chỉ.
 * 200 chỉ khi tên miền thuộc một cửa hàng đã xác minh quyền sở hữu qua DNS; mọi trường hợp khác 404 (không lộ lý do).
 * Nếu đặt DOMAIN_CHECK_KEY thì phải gửi kèm ?key=… để người ngoài không dò tên miền khách hàng.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const key = process.env.DOMAIN_CHECK_KEY;
  if (key && u.searchParams.get('key') !== key) return new Response('Không tìm thấy.', { status: 404 });
  const domain = (u.searchParams.get('domain') ?? '').trim().toLowerCase();
  if (!/^[a-z0-9.-]{4,253}$/.test(domain)) return new Response('Không tìm thấy.', { status: 404 });
  const r = await pool().query('SELECT domain_is_verified($1) AS ok', [domain]);
  return new Response(r.rows[0]?.ok ? 'ok' : 'Không tìm thấy.', { status: r.rows[0]?.ok ? 200 : 404, headers: { 'cache-control': 'no-store' } });
}
