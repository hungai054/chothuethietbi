import Link from 'next/link';
import { BOOKING_STATUS_LABEL, type BookingStatus } from '@rentpro/core';
import { depositLedger } from '@rentpro/db';
import { Empty, card } from '@/components/ui';
import { vnd } from '@/lib/format';
import { requireAccess } from '@/lib/session';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

/** Sổ theo dõi cọc: mọi đơn đang giữ tiền cọc hoặc tài sản thế chấp. */
export default async function DepositsPage() {
  await requireAccess('deposit', 'deposit.view');
  const rows = await withService((c) => depositLedger(c));
  const totalMoney = rows.reduce((a, r) => a + r.heldMoney, 0);
  const totalAssets = rows.reduce((a, r) => a + r.assets.reduce((x, y) => x + y.value, 0), 0);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Sổ theo dõi cọc</h1>
      <div className={`${card} flex flex-wrap gap-8 text-sm`}>
        <div>Tiền cọc đang giữ: <b data-testid="total-money">{vnd(totalMoney)}</b></div>
        <div>Giá trị tài sản đang giữ: <b data-testid="total-assets">{vnd(totalAssets)}</b></div>
        <div>Số đơn: <b>{rows.length}</b></div>
      </div>
      {rows.length === 0 ? <Empty>Hiện không giữ cọc hay tài sản thế chấp nào.</Empty> : (
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-sm" data-testid="deposit-table">
            <thead><tr className="border-b text-left"><th className="py-2">Đơn</th><th>Khách</th><th>Trạng thái</th><th className="text-right">Tiền cọc</th><th>Tài sản thế chấp</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.bookingId} className="border-b align-top">
                  <td className="py-2"><Link className="font-mono underline" href={`/bookings/${r.bookingId}`}>{r.code}</Link></td>
                  <td>{r.customerName}</td><td>{BOOKING_STATUS_LABEL[r.status as BookingStatus]}</td>
                  <td className="text-right">{r.heldMoney > 0 ? vnd(r.heldMoney) : '—'}</td>
                  <td>{r.assets.length ? r.assets.map((a) => <div key={a.id}>{a.description} ({vnd(a.value)}){a.location ? ` · ${a.location}` : ''}</div>) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
