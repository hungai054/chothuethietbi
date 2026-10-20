import Link from 'next/link';
import { listAuditFacets, listAuditLog, type AuditFilter } from '@rentpro/db';
import { Empty, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { requireAccess } from '@/lib/session';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const PAGE = 50;

type Q = { action?: string; entity?: string; user?: string; q?: string; from?: string; to?: string; page?: string };

const filterOf = (f: Q): AuditFilter => ({ action: f.action, entity: f.entity, userId: f.user, q: f.q, from: f.from, to: f.to });
const qs = (f: Q, extra: Record<string, string> = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v);
  return p.toString();
};

/** Nhật ký thao tác: ai làm gì, lúc nào, trên đối tượng nào. Chỉ thêm, không sửa/xóa được từ giao diện. */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Q> }) {
  const sess = await requireAccess('audit.log', 'audit.view');
  const f = await searchParams;
  const page = Math.max(Number(f.page) || 1, 1);
  const canExport = sess.permissions.has('data.export');
  let error: string | undefined;
  const data = await withService(async (c) => {
    const facets = await listAuditFacets(c);
    try { return { facets, ...(await listAuditLog(c, { ...filterOf(f), page, pageSize: PAGE })) }; }
    catch (e) { error = (e as Error).message; return { facets, rows: [], total: 0 }; }
  });
  const pages = Math.max(Math.ceil(data.total / PAGE), 1);
  return (
    <div className="space-y-4">
      <Link href="/settings" className="text-sm underline">← Cài đặt</Link>
      <h1 className="text-2xl font-semibold">Nhật ký thao tác</h1>
      <Notice error={error} />
      <form className={`${card} flex flex-wrap items-end gap-3 text-sm`} data-testid="audit-filter">
        <label>Thao tác<select name="action" defaultValue={f.action ?? ''} className={`${input} mt-1`}><option value="">Tất cả</option>{data.facets.actions.map((a) => <option key={a} value={a}>{a}</option>)}</select></label>
        <label>Đối tượng<select name="entity" defaultValue={f.entity ?? ''} className={`${input} mt-1`}><option value="">Tất cả</option>{data.facets.entities.map((a) => <option key={a} value={a}>{a}</option>)}</select></label>
        <label>Người dùng<select name="user" defaultValue={f.user ?? ''} className={`${input} mt-1`}><option value="">Tất cả</option>{data.facets.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label>Từ ngày<input type="date" name="from" defaultValue={f.from ?? ''} className={`${input} mt-1`} /></label>
        <label>Đến ngày<input type="date" name="to" defaultValue={f.to ?? ''} className={`${input} mt-1`} /></label>
        <label>Tìm<input name="q" defaultValue={f.q ?? ''} maxLength={80} placeholder="Mã, tên, nội dung…" className={`${input} mt-1`} /></label>
        <button className={btn}>Lọc</button>
        <Link href="/settings/audit" className={btnGhost}>Xóa lọc</Link>
        {canExport && <a href={`/settings/audit/export?${qs(f, { page: '' })}`} className={btnGhost} data-testid="audit-export">Xuất CSV</a>}
      </form>
      <p className="text-sm text-slate-500" data-testid="audit-total">{data.total} bản ghi</p>
      {data.rows.length === 0 ? <Empty>Không có bản ghi nào.</Empty> : (
        <div className={`${card} overflow-x-auto p-0`}>
          <table className="w-full text-left text-sm" data-testid="audit-table">
            <thead className="border-b bg-slate-50 text-slate-500"><tr><th className="p-3">Thời gian</th><th>Người thực hiện</th><th>Thao tác</th><th>Đối tượng</th><th>Chi tiết</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="border-b align-top last:border-0">
                  <td className="whitespace-nowrap p-3">{fmtDateTime(r.at, sess.tenant.timezone)}</td>
                  <td>{r.userName ?? <span className="text-slate-400">Hệ thống</span>}</td>
                  <td><code>{r.action}</code></td>
                  <td className="text-xs">{r.entity}{r.entityId && <div className="break-all text-slate-500">{r.entityId}</div>}</td>
                  <td className="max-w-md break-words font-mono text-xs text-slate-600">{Object.keys(r.data).length ? JSON.stringify(r.data).slice(0, 300) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center gap-3 text-sm">
          {page > 1 && <Link className="underline" href={`/settings/audit?${qs(f, { page: String(page - 1) })}`}>← Trước</Link>}
          <span>Trang {page}/{pages}</span>
          {page < pages && <Link className="underline" href={`/settings/audit?${qs(f, { page: String(page + 1) })}`}>Sau →</Link>}
        </div>
      )}
    </div>
  );
}
