import Link from 'next/link';
import { resolve } from 'node:path';
import { LocalFsStorage, listDeletedTenants, purgeTenant, restoreTenant } from '@rentpro/db';
import { act, fmtDate } from '@/lib/act';
import { actorOf, db, requireCan } from '@/lib/session';

export const dynamic = 'force-dynamic';
const BACK = '/tenants/deleted';

/** Cửa hàng đã xóa mềm: khôi phục trong 30 ngày, hoặc xóa hẳn sau hạn giữ (gõ lại địa chỉ để xác nhận). */
export default async function DeletedTenants({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireCan('tenant.delete');
  const q = await searchParams;
  const list = await listDeletedTenants(db());

  async function restore(id: string) {
    'use server';
    const u = await requireCan('tenant.delete');
    await act(BACK, async () => { await restoreTenant(db(), actorOf(u), id); });
  }
  async function purge(id: string, f: FormData) {
    'use server';
    const u = await requireCan('tenant.delete');
    await act(BACK, async () => {
      const storage = new LocalFsStorage(process.env.STORAGE_DIR ?? resolve(process.cwd(), '../../.data/storage'));
      await purgeTenant(db(), actorOf(u), id, { confirmSlug: String(f.get('confirm') ?? ''), storage });
    });
  }

  return (
    <div className="space-y-4">
      <Link href="/" className="text-sm underline">← Danh sách khách hàng</Link>
      <h1 className="text-2xl font-semibold">Cửa hàng đã xóa</h1>
      {q.error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{q.error}</p>}
      {q.ok && <p role="status" className="rounded bg-green-50 p-3 text-sm text-green-700">Đã thực hiện.</p>}
      <p className="text-sm text-slate-600">Dữ liệu được giữ 30 ngày kể từ lúc xóa; trong thời gian này khôi phục được (về trạng thái tạm khóa). Sau hạn giữ mới được xóa hẳn, không hoàn tác.</p>
      {list.length === 0 ? <p className="rounded-lg bg-white p-6 text-center text-slate-500">Không có cửa hàng nào đã xóa.</p> : (
        <ul className="space-y-3" data-testid="deleted-list">
          {list.map((t) => (
            <li key={t.id} className="space-y-2 rounded-lg bg-white p-4 shadow-sm">
              <p><b>{t.name}</b> <code className="text-xs text-slate-500">{t.slug}</code> · xóa ngày {fmtDate(t.deleted_at)} · {t.can_purge ? 'đã hết hạn giữ' : `giữ đến ${fmtDate(t.purge_after)}`}</p>
              <div className="flex flex-wrap items-center gap-3">
                <form action={restore.bind(null, t.id)}><button className="rounded border px-3 py-1">Khôi phục</button></form>
                <a href={`/tenants/${t.id}/export`} className="text-sm underline">Tải dữ liệu (ZIP)</a>
                {t.can_purge && (
                  <form action={purge.bind(null, t.id)} className="flex items-center gap-2">
                    <input name="confirm" placeholder={`Gõ "${t.slug}" để xóa hẳn`} className="rounded border px-3 py-1" />
                    <button className="rounded bg-red-700 px-3 py-1 text-white">Xóa hẳn</button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
