import { readBrandAsset, withTenantId } from '@rentpro/db';
import { pool } from '@/lib/db';
import { appStorage } from '@/lib/service';
import { getTenant } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** Logo / favicon của cửa hàng (theo tên miền). Công khai vì cần hiện ở trang đăng nhập; chỉ phục vụ khi gói có white-label. */
export async function GET(_: Request, { params }: { params: Promise<{ which: string }> }) {
  const { which } = await params;
  if (which !== 'logo' && which !== 'favicon') return new Response('Không tìm thấy.', { status: 404 });
  const tenant = await getTenant();
  if (!tenant) return new Response('Không tìm thấy.', { status: 404 });
  const f = await withTenantId(pool(), tenant.id, (db) => readBrandAsset({ db, tenantId: tenant.id, features: tenant.features, storage: appStorage() }, which));
  if (!f) return new Response('Không tìm thấy.', { status: 404 });
  return new Response(new Uint8Array(f.data), {
    headers: {
      'content-type': f.contentType, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline',
    },
  });
}
