import Link from 'next/link';
import { todayBoard } from '@rentpro/db';
import { Empty } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

type Item = { id: string; code: string; customer_name: string; phone: string; starts_at: Date; ends_at: Date; hold_expires_at: Date | null };

function Section({ title, tone, items, tz, time }: { title: string; tone: string; items: Item[]; tz: string; time: (i: Item) => string }) {
  return (
    <section className={`rounded-lg bg-white p-4 shadow-sm ${tone}`} aria-label={title}>
      <h2 className="mb-2 font-medium">{title} <span className="font-normal text-slate-500">({items.length})</span></h2>
      {items.length === 0 ? <p className="text-sm text-slate-500">Không có.</p> : (
        <ul className="space-y-1 text-sm">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap justify-between gap-2">
              <span><Link className="font-mono underline" href={`/bookings/${i.id}`}>{i.code}</Link> · {i.customer_name} · {i.phone}</span>
              <span className="text-slate-500">{time(i)}</span>
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only">{tz}</span>
    </section>
  );
}

export default async function TodayPage() {
  const { board, tz } = await withService(async (c, s) => ({ board: await todayBoard(c), tz: s.tenant.timezone }));
  const empty = Object.values(board).every((l) => l.length === 0);
  return (
    <div className="space-y-4">
      <Link href="/bookings" className="text-sm underline">← Đơn thuê</Link>
      <h1 className="text-2xl font-semibold">Hôm nay</h1>
      {empty && <Empty>Hôm nay chưa có việc nào cần xử lý.</Empty>}
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Cần giao" tone="" items={board.toDeliver as Item[]} tz={tz} time={(i) => fmtDateTime(i.starts_at, tz)} />
        <Section title="Cần nhận về" tone="" items={board.toReceive as Item[]} tz={tz} time={(i) => fmtDateTime(i.ends_at, tz)} />
        <Section title="Quá hạn trả" tone="border border-red-200" items={board.overdue as Item[]} tz={tz} time={(i) => `hạn ${fmtDateTime(i.ends_at, tz)}`} />
        <Section title="Chưa giao dù đã quá giờ nhận" tone="border border-amber-200" items={board.lateDelivery as Item[]} tz={tz} time={(i) => `hẹn ${fmtDateTime(i.starts_at, tz)}`} />
        <Section title="Giữ chỗ sắp hết hạn" tone="border border-amber-200" items={board.holdsExpiring as Item[]} tz={tz} time={(i) => (i.hold_expires_at ? `hết hạn ${fmtDateTime(i.hold_expires_at, tz)}` : '')} />
      </div>
    </div>
  );
}
