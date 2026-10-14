import Link from 'next/link';
import { listOrders, maintenanceSummary, planProgress } from '@rentpro/db';
import { Empty, Notice, btn, btnGhost, card } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { requireAppSession } from '@/lib/session';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

const TABS = [['open', 'Đang mở'], ['mine', 'Việc của tôi'], ['overdue', 'Quá hạn'], ['done', 'Đã xong']] as const;
const TONE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800', IN_PROGRESS: 'bg-blue-100 text-blue-800', DONE: 'bg-green-100 text-green-800',
  UNREPAIRABLE: 'bg-red-100 text-red-700', DISPOSED: 'bg-slate-200 text-slate-600', CANCELLED: 'bg-slate-100 text-slate-500',
};

/** Bảng việc bảo trì / sửa chữa. Dùng tốt trên điện thoại: thẻ lớn, mở phiếu bằng một chạm hoặc quét mã. */
export default async function MaintenancePage({ searchParams }: { searchParams: Promise<{ v?: string; error?: string; ok?: string }> }) {
  const f = await searchParams;
  const sess = await requireAppSession();
  const v = TABS.some(([k]) => k === f.v) ? f.v! : 'open';
  const canManage = sess.permissions.has('maintenance.manage');
  const tz = sess.tenant.timezone;
  const data = await withService(async (c) => {
    const orders = await listOrders(c, v === 'done' ? { status: 'DONE', limit: 50 } : v === 'mine' ? { status: 'OPEN', technicianId: sess.user.id } : v === 'overdue' ? { status: 'OPEN', overdue: true } : { status: 'OPEN' });
    const summary = await maintenanceSummary(c);
    const soon = (await planProgress(c)).filter((p) => !p.openOrderId && !p.evaluation.due && Math.max(0, ...Object.values(p.evaluation.progress)) >= 0.8).slice(0, 8);
    return { orders, summary, soon };
  });
  const { orders, summary, soon } = data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Bảo trì và sửa chữa</h1>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/maintenance/scan" className={btnGhost}>Quét mã</Link>
          <Link href="/maintenance/plans" className={btnGhost}>Kế hoạch định kỳ</Link>
          {canManage && <Link href="/maintenance/new" className={btn}>Tạo phiếu</Link>}
        </div>
      </div>
      <Notice error={f.error} ok={f.ok} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="maint-summary">
        {[['Chờ làm', summary.pending], ['Đang làm', summary.inProgress], ['Không sửa được', summary.unrepairable], ['Quá hạn', summary.overdue], ['Đến hạn bảo trì', summary.due]].map(([k, n]) => (
          <div key={k as string} className={`${card} text-center`}><div className="text-2xl font-semibold">{n}</div><div className="text-xs text-slate-500">{k}</div></div>
        ))}
      </div>
      <nav className="flex flex-wrap gap-2 text-sm">
        {TABS.map(([k, label]) => <Link key={k} href={`/maintenance?v=${k}`} className={v === k ? 'rounded bg-slate-900 px-4 py-2 text-white' : btnGhost}>{label}</Link>)}
      </nav>
      {orders.length === 0 ? <Empty>Không có phiếu nào.</Empty> : (
        <ul className="grid gap-3 md:grid-cols-2" data-testid="order-list">
          {orders.map((o) => (
            <li key={o.id}>
              <Link href={`/maintenance/${o.id}`} className={`${card} block hover:bg-slate-50`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm">{o.code}</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${TONE[o.status]}`}>{o.statusLabel}</span>
                </div>
                <div className="mt-1 font-medium">{o.title}</div>
                <div className="text-sm text-slate-600">{o.barcode} · {o.modelName} · {o.kindLabel}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                  {o.technicianName && <span>KTV: {o.technicianName}</span>}
                  {o.dueDate && <span className={o.overdue ? 'font-medium text-red-700' : ''}>Hạn {o.dueDate}{o.overdue ? ' (quá hạn)' : ''}</span>}
                  {o.scheduledStart && <span>Lịch {fmtDateTime(o.scheduledStart, tz)}</span>}
                  {o.source === 'DAMAGE' && <span className="text-amber-700">Từ biên bản hư hỏng{o.bookingCode ? ` · đơn ${o.bookingCode}` : ''}</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {soon.length > 0 && (
        <section className={card}>
          <h2 className="mb-2 font-medium">Sắp đến hạn bảo trì định kỳ</h2>
          <ul className="space-y-1 text-sm" data-testid="soon-list">
            {soon.map((p) => <li key={`${p.planId}-${p.unitId}`}><span className="font-mono">{p.barcode}</span> · {p.planName} · {Math.round(Math.max(...Object.values(p.evaluation.progress)) * 100)}% chu kỳ</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
