import Link from 'next/link';
import { TRUST_LABEL } from '@rentpro/core';
import { listCustomers, listGroups } from '@rentpro/db';
import { Empty, Notice, btn, btnGhost, input } from '@/components/ui';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const PAGE = 25;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; group?: string; bl?: string; page?: string; error?: string; ok?: string }> }) {
  const f = await searchParams;
  const page = Math.max(Number(f.page) || 1, 1);
  const { list, groups, canManage } = await withService(async (c, s) => ({
    list: await listCustomers(c, { q: f.q, groupId: f.group || undefined, blacklisted: f.bl === '1' ? true : undefined, page, pageSize: PAGE }),
    groups: await listGroups(c), canManage: s.permissions.has('customer.manage'),
  }));
  const pages = Math.max(Math.ceil(list.total / PAGE), 1);
  const qs = (p: number) => new URLSearchParams({ ...(f.q ? { q: f.q } : {}), ...(f.group ? { group: f.group } : {}), ...(f.bl ? { bl: f.bl } : {}), page: String(p) }).toString();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Khách hàng <span className="text-base font-normal text-slate-500">({list.total})</span></h1>
        <div className="flex gap-2 text-sm">
          {canManage && <Link className={btn} href="/customers/new">Thêm khách hàng</Link>}
          <Link className={btnGhost} href="/customers/groups">Nhóm khách</Link>
        </div>
      </div>
      <Notice error={f.error} ok={f.ok} />
      <form className="flex flex-wrap gap-2">
        <input name="q" defaultValue={f.q} placeholder="Tìm tên, SĐT, email, công ty" className={`${input} max-w-xs`} />
        <select name="group" defaultValue={f.group ?? ''} className={`${input} max-w-48`}>
          <option value="">Mọi nhóm</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="bl" value="1" defaultChecked={f.bl === '1'} /> Chỉ danh sách đen</label>
        <button className={btn}>Lọc</button>
      </form>
      {list.rows.length === 0 ? <Empty>Chưa có khách hàng phù hợp.</Empty> : (
        <div className="overflow-x-auto rounded-lg bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-slate-50 text-slate-500"><tr><th className="p-3">Khách hàng</th><th>SĐT</th><th>Loại</th><th>Nhóm</th><th>Mức tin cậy</th></tr></thead>
            <tbody>
              {list.rows.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="p-3"><Link className="font-medium underline" href={`/customers/${c.id}`}>{c.name}</Link>
                    {c.blacklisted && <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">Danh sách đen</span>}
                    {c.companyName && <div className="text-xs text-slate-500">{c.companyName}</div>}</td>
                  <td className="font-mono">{c.phone}</td>
                  <td>{c.type === 'COMPANY' ? 'Doanh nghiệp' : 'Cá nhân'}</td>
                  <td>{c.groupName ?? '—'}</td>
                  <td>{TRUST_LABEL[c.trustLevel]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <nav className="flex items-center gap-3 text-sm" aria-label="Phân trang">
          {page > 1 && <Link className="underline" href={`/customers?${qs(page - 1)}`}>← Trước</Link>}
          <span>Trang {page}/{pages}</span>
          {page < pages && <Link className="underline" href={`/customers?${qs(page + 1)}`}>Sau →</Link>}
        </nav>
      )}
    </div>
  );
}
