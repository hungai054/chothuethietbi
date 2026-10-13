import Link from 'next/link';
import { UNIT_STATUSES, UNIT_STATUS_LABEL } from '@rentpro/core';
import { listUnits, listModels } from '@rentpro/db';
import { Empty, Notice, btn, btnGhost, input } from '@/components/ui';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const PAGE = 25;

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; model?: string; page?: string; error?: string; ok?: string }> }) {
  const f = await searchParams;
  const page = Math.max(Number(f.page) || 1, 1);
  const { units, models, canManage, canLabel } = await withService(async (c, s) => ({
    units: await listUnits(c, { q: f.q, status: f.status, modelId: f.model, page, pageSize: PAGE }),
    models: await listModels(c),
    canManage: s.permissions.has('inventory.manage'),
    canLabel: s.tenant.features['inventory.barcode'],
  }));
  const pages = Math.max(Math.ceil(units.total / PAGE), 1);
  const qs = (p: number) => new URLSearchParams({ ...(f.q ? { q: f.q } : {}), ...(f.status ? { status: f.status } : {}), ...(f.model ? { model: f.model } : {}), page: String(p) }).toString();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Thiết bị <span className="text-base font-normal text-slate-500">({units.total})</span></h1>
        <div className="flex flex-wrap gap-2 text-sm">
          {canManage && <Link className={btn} href="/inventory/units/new">Thêm thiết bị</Link>}
          {canManage && <Link className={btnGhost} href="/inventory/import">Nhập Excel</Link>}
          <a className={btnGhost} href="/inventory/export">Xuất Excel</a>
        </div>
      </div>
      <Notice error={f.error} ok={f.ok} />
      <form className="flex flex-wrap gap-2">
        <input name="q" defaultValue={f.q} placeholder="Tìm mã vạch, serial, tên" className={`${input} max-w-xs`} />
        <select name="status" defaultValue={f.status ?? ''} className={`${input} max-w-44`}>
          <option value="">Mọi trạng thái</option>
          {UNIT_STATUSES.map((s) => <option key={s} value={s}>{UNIT_STATUS_LABEL[s]}</option>)}
        </select>
        <select name="model" defaultValue={f.model ?? ''} className={`${input} max-w-56`}>
          <option value="">Mọi mẫu</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button className={btn}>Lọc</button>
      </form>

      {units.rows.length === 0 ? <Empty>Chưa có thiết bị nào phù hợp.{canManage && ' Hãy thêm thiết bị hoặc nhập từ file Excel.'}</Empty> : (
        <form action="/inventory/labels" method="get" target="_blank">
          <div className="overflow-x-auto rounded-lg bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-slate-50 text-slate-500">
                <tr><th className="w-8 p-3"></th><th>Mã vạch</th><th>Mẫu</th><th>Serial</th><th>Trạng thái</th><th>Chi nhánh</th></tr>
              </thead>
              <tbody>
                {units.rows.map((u) => (
                  <tr key={u.id} className="border-b last:border-0">
                    <td className="p-3">{canLabel && <input type="checkbox" name="ids" value={u.id} aria-label={`Chọn ${u.barcode}`} />}</td>
                    <td><Link className="font-mono underline" href={`/inventory/units/${u.id}`}>{u.barcode}</Link></td>
                    <td>{u.modelName}<div className="text-xs text-slate-500">{u.categoryName}</div></td>
                    <td>{u.serial ?? '—'}</td>
                    <td>{UNIT_STATUS_LABEL[u.status]}</td>
                    <td>{u.branchName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canLabel && <button className={`${btnGhost} mt-3`}>In tem cho thiết bị đã chọn</button>}
        </form>
      )}

      {pages > 1 && (
        <nav className="flex items-center gap-3 text-sm" aria-label="Phân trang">
          {page > 1 && <Link className="underline" href={`/inventory?${qs(page - 1)}`}>← Trước</Link>}
          <span>Trang {page}/{pages}</span>
          {page < pages && <Link className="underline" href={`/inventory?${qs(page + 1)}`}>Sau →</Link>}
        </nav>
      )}
    </div>
  );
}
