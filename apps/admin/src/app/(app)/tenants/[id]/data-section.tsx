import { redirect } from 'next/navigation';
import { softDeleteTenant } from '@rentpro/db';
import { platformCan } from '@rentpro/core';
import { act } from '@/lib/act';
import { actorOf, db, requireCan, requireUser } from '@/lib/session';

const box = 'rounded-lg bg-white p-5 shadow-sm space-y-3';

/** Xuất toàn bộ dữ liệu và xóa cửa hàng (xóa mềm, giữ 30 ngày, phải gõ lại địa chỉ cửa hàng để xác nhận). */
export async function DataSection({ tenantId, slug }: { tenantId: string; slug: string }) {
  const user = await requireUser();
  const canExport = platformCan(user.role, 'tenant.export');
  const canDelete = platformCan(user.role, 'tenant.delete');
  if (!canExport && !canDelete) return null;

  async function remove(f: FormData) {
    'use server';
    const u = await requireCan('tenant.delete');
    await act(`/tenants/${tenantId}`, async () => {
      await softDeleteTenant(db(), actorOf(u), tenantId, { confirmSlug: String(f.get('confirm') ?? ''), reason: String(f.get('reason') ?? '') });
      redirect('/tenants/deleted?ok=1');
    });
  }

  return (
    <section className={box} data-testid="data-section">
      <h2 className="font-medium">Dữ liệu &amp; xóa cửa hàng</h2>
      {canExport && (
        <p className="text-sm"><a href={`/tenants/${tenantId}/export`} className="underline" data-testid="export-tenant">Tải toàn bộ dữ liệu (ZIP: JSON + Excel + file đính kèm)</a></p>
      )}
      {canDelete && (
        <form action={remove} className="space-y-2 rounded border border-red-200 p-3" data-testid="delete-form">
          <p className="text-sm text-red-800">Xóa mềm: cửa hàng ngừng truy cập ngay, dữ liệu giữ 30 ngày và khôi phục được. Hãy tải dữ liệu cho khách trước.</p>
          <div className="flex flex-wrap items-end gap-2">
            <input name="reason" placeholder="Lý do xóa" className="rounded border px-3 py-2" />
            <input name="confirm" placeholder={`Gõ "${slug}" để xác nhận`} className="rounded border px-3 py-2" />
            <button className="rounded bg-red-700 px-4 py-2 text-white">Xóa cửa hàng</button>
          </div>
        </form>
      )}
    </section>
  );
}
