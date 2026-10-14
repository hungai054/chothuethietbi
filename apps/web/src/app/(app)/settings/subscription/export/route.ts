import { exportTenantZip } from '@rentpro/db';
import { throttled } from '@/lib/marketing';
import { platformPool } from '@/lib/platform';
import { appStorage } from '@/lib/service';
import { getAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Tải toàn bộ dữ liệu của chính cửa hàng (ZIP). Cần quyền `data.export` (chủ cửa hàng); dùng được cả khi tài khoản chỉ đọc hoặc hết hạn,
 * vì dữ liệu là của khách. Mỗi cửa hàng tối đa một lần mỗi phút để việc xuất (nặng) không bị lạm dụng.
 */
export async function GET() {
  const s = await getAppSession();
  if (!s || s.support || !s.permissions.has('data.export')) return new Response('Bạn không có quyền tải dữ liệu.', { status: 403 });
  if (throttled(`export:${s.tenant.id}`, 1, 60_000)) return new Response('Bạn vừa tải dữ liệu xong. Vui lòng thử lại sau 1 phút.', { status: 429 });
  const { zip, filename } = await exportTenantZip(platformPool(), s.tenant.id, {
    storage: appStorage(), actor: { id: '00000000-0000-0000-0000-000000000000', email: `tenant-user:${s.user.id}` },
  });
  return new Response(new Uint8Array(zip), {
    headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'private, no-store' },
  });
}
