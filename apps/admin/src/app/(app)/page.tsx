import Link from 'next/link';
import { listPlans, listTenants, platformStats } from '@rentpro/db';
import { db, requireCan } from '@/lib/session';

export const dynamic = 'force-dynamic';
const vnd = (n: number | string) => new Intl.NumberFormat('vi-VN').format(Number(n)) + ' đ';

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; plan?: string }> }) {
  await requireCan('tenant.view');
  const f = await searchParams;
  const [stats, tenants, plans] = await Promise.all([platformStats(db()), listTenants(db(), f), listPlans(db())]);
  const Card = ({ label, value }: { label: string; value: string | number }) => (
    <div className="rounded-lg bg-white p-4 shadow-sm"><div className="text-sm text-slate-500">{label}</div><div className="text-2xl font-semibold">{value}</div></div>
  );
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card label="Đang trả phí" value={stats.active} />
        <Card label="Dùng thử" value={stats.trial} />
        <Card label="Chỉ đọc / khóa" value={stats.inactive} />
        <Card label="MRR" value={vnd(stats.mrr)} />
      </div>
      <form className="flex flex-wrap gap-2">
        <input name="q" defaultValue={f.q} placeholder="Tìm tên hoặc slug" className="rounded border bg-white px-3 py-2" />
        <select name="status" defaultValue={f.status ?? ''} className="rounded border bg-white px-3 py-2">
          <option value="">Mọi trạng thái</option>
          {['TRIAL', 'ACTIVE', 'READ_ONLY', 'SUSPENDED'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select name="plan" defaultValue={f.plan ?? ''} className="rounded border bg-white px-3 py-2">
          <option value="">Mọi gói</option>
          {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
        </select>
        <button className="rounded bg-slate-900 px-4 py-2 text-white">Lọc</button>
      </form>
      <div className="overflow-x-auto rounded-lg bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-50 text-slate-500">
            <tr><th className="p-3">Khách hàng</th><th>Gói</th><th>Trạng thái</th><th>Người dùng</th><th>Thiết bị</th><th>Đơn 30 ngày</th><th>Hết dùng thử</th></tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.id} className="border-b last:border-0">
                <td className="p-3"><Link className="font-medium underline" href={`/tenants/${t.id}`}>{t.name}</Link><div className="text-xs text-slate-500">{t.slug}</div></td>
                <td>{t.plan_name}</td><td>{t.status}</td><td>{t.users}</td><td>{t.equipment}</td><td>{t.bookings_30d}</td>
                <td>{t.trial_ends_at ? new Date(t.trial_ends_at).toLocaleDateString('vi-VN') : '—'}</td>
              </tr>
            ))}
            {tenants.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">Không có khách hàng phù hợp.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
