import { resolve } from 'node:path';
import { LocalFsStorage, exportTenantZip } from '@rentpro/db';
import { platformCan } from '@rentpro/core';
import { actorOf, currentUser, db } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Xuất toàn bộ dữ liệu một cửa hàng (ZIP) cho quản trị viên có quyền `tenant.export`. Mỗi lần xuất ghi nhật ký nền tảng. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u || !platformCan(u.role, 'tenant.export')) return new Response('Không có quyền.', { status: 403 });
  const { id } = await params;
  const storage = new LocalFsStorage(process.env.STORAGE_DIR ?? resolve(process.cwd(), '../../.data/storage'));
  try {
    const { zip, filename } = await exportTenantZip(db(), id, { storage, actor: actorOf(u) });
    return new Response(new Uint8Array(zip), { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'private, no-store' } });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : 'Lỗi xuất dữ liệu.', { status: 400 });
  }
}
