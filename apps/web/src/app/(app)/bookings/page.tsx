import Link from 'next/link';
import { BOOKING_STATUSES, BOOKING_STATUS_LABEL } from '@rentpro/core';
import { listBookings, listColumnsData } from '@rentpro/db';
import { StatusBadge } from '@/components/booking-status';
import { Empty, Notice, btn, btnGhost, input } from '@/components/ui';
import { fmtDateTime, vnd } from '@/lib/format';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const PAGE = 25;

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string; error?: string; ok?: string }> }) {
  const f = await searchParams;
  const page = Math.max(Number(f.page) || 1, 1);
  const { list, tz, canCreate, canSettings, timeline, cc, title } = await withService(async (c, s) => {
    const list = await listBookings(c, { q: f.q, status: f.status, page, pageSize: PAGE });
    return { list, tz: s.tenant.timezone, canCreate: s.permissions.has('booking.create'), canSettings: s.permissions.has('settings.manage'), timeline: s.tenant.features['booking.timeline'], cc: await listColumnsData(c, 'BOOKING', list.rows.map((r) => r.id)), title: s.tenant.labels.booking };
  });
  const pages = Math.max(Math.ceil(list.total / PAGE), 1);
  const qs = (p: number) => new URLSearchParams({ ...(f.q ? { q: f.q } : {}), ...(f.status ? { status: f.status } : {}), page: String(p) }).toString();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{title} <span className="text-base font-normal text-slate-500">({list.total})</span></h1>
        <div className="flex flex-wrap gap-2 text-sm">
          {canCreate && <Link className={btn} href="/bookings/new">Tạo đơn</Link>}
          <Link className={btnGhost} href="/bookings/today">Hôm nay</Link>
          <Link className={btnGhost} href="/bookings/availability">Tra cứu còn trống</Link>
          {timeline && <Link className={btnGhost} href="/bookings/timeline">Lịch</Link>}
          {canSettings && <Link className={btnGhost} href="/settings/booking">Cấu hình</Link>}
        </div>
      </div>
      <Notice error={f.error} ok={f.ok} />
      <form className="flex flex-wrap gap-2">
        <input name="q" defaultValue={f.q} placeholder="Tìm số đơn, tên hoặc SĐT khách" className={`${input} max-w-xs`} />
        <select name="status" defaultValue={f.status ?? ''} className={`${input} max-w-44`}>
          <option value="">Mọi trạng thái</option>
          {BOOKING_STATUSES.map((s) => <option key={s} value={s}>{BOOKING_STATUS_LABEL[s]}</option>)}
        </select>
        <button className={btn}>Lọc</button>
      </form>
      {list.rows.length === 0 ? <Empty>Chưa có đơn thuê nào phù hợp.</Empty> : (
        <div className="overflow-x-auto rounded-lg bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-slate-50 text-slate-500"><tr><th className="p-3">Số đơn</th><th>Khách hàng</th><th>Thời gian thuê</th><th>Trạng thái</th><th className="text-right">Tổng tiền</th>{cc.cols.map((k) => <th key={k.key}>{k.label}</th>)}</tr></thead>
            <tbody>
              {list.rows.map((b) => (
                <tr key={b.id} className="border-b last:border-0">
                  <td className="p-3"><Link className="font-mono font-medium underline" href={`/bookings/${b.id}`}>{b.code}</Link></td>
                  <td>{b.customerName}</td>
                  <td className="text-slate-600">{fmtDateTime(b.startsAt, tz)} → {fmtDateTime(b.endsAt, tz)}</td>
                  <td><StatusBadge status={b.status} />{b.status === 'HOLD' && b.holdExpiresAt && <div className="text-xs text-amber-700">hết hạn {fmtDateTime(b.holdExpiresAt, tz)}</div>}</td>
                  <td className="pr-3 text-right">{vnd(b.total)}</td>
                  {cc.cols.map((k) => <td key={k.key}>{cc.cells[b.id]?.[k.key] || '—'}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <nav className="flex items-center gap-3 text-sm" aria-label="Phân trang">
          {page > 1 && <Link className="underline" href={`/bookings?${qs(page - 1)}`}>← Trước</Link>}
          <span>Trang {page}/{pages}</span>
          {page < pages && <Link className="underline" href={`/bookings?${qs(page + 1)}`}>Sau →</Link>}
        </nav>
      )}
    </div>
  );
}
