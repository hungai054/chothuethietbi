import Link from 'next/link';
import { redirect } from 'next/navigation';
import { localDateKey, zonedTimeToUtc } from '@rentpro/core';
import { listCategoriesFlat, listCustomers, timeline } from '@rentpro/db';
import { Notice, btn, input } from '@/components/ui';
import { withService } from '@/lib/service';
import { requireAppSession } from '@/lib/session';
import { createAction, moveAction, swapAction } from './actions';
import { TimelineGrid } from './timeline-grid';

export const dynamic = 'force-dynamic';
const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export default async function TimelinePage({ searchParams }: { searchParams: Promise<{ from?: string; days?: string; category?: string }> }) {
  const s = await requireAppSession();
  if (!s.tenant.features['booking.timeline']) redirect('/bookings?error=' + encodeURIComponent('Gói hiện tại chưa có lịch dạng timeline.'));
  const f = await searchParams;
  const tz = s.tenant.timezone;
  const days = [7, 14, 30].includes(Number(f.days)) ? Number(f.days) : 14;
  const fromKey = /^\d{4}-\d{2}-\d{2}$/.test(f.from ?? '') ? f.from! : localDateKey(new Date(), tz);
  const from = zonedTimeToUtc(`${fromKey}T00:00`, tz)!;
  const to = zonedTimeToUtc(`${addDays(fromKey, days)}T00:00`, tz)!;
  const { rows, cats, customers, canEdit } = await withService(async (c, sess) => ({
    rows: await timeline(c, from, to, { categoryId: f.category || undefined }), cats: await listCategoriesFlat(c),
    customers: sess.permissions.has('booking.create') ? (await listCustomers(c, { pageSize: 200 })).rows.filter((x) => !x.blacklisted) : [],
    canEdit: sess.permissions.has('booking.create'),
  }));
  const nav = (key: string) => `/bookings/timeline?from=${key}&days=${days}${f.category ? `&category=${f.category}` : ''}`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Lịch thiết bị</h1>
        <div className="flex gap-2 text-sm"><Link className="underline" href="/bookings">Danh sách đơn</Link><Link className="underline" href="/bookings/availability">Tra cứu còn trống</Link></div>
      </div>
      <form className="flex flex-wrap items-center gap-2 text-sm">
        <Link className="rounded border bg-white px-3 py-2" href={nav(addDays(fromKey, -days))}>← Trước</Link>
        <input name="from" type="date" defaultValue={fromKey} className={`${input} max-w-44`} aria-label="Từ ngày" />
        <select name="days" defaultValue={days} className={`${input} max-w-32`} aria-label="Số ngày">{[7, 14, 30].map((d) => <option key={d} value={d}>{d} ngày</option>)}</select>
        <select name="category" defaultValue={f.category ?? ''} className={`${input} max-w-44`} aria-label="Danh mục"><option value="">Mọi danh mục</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className={btn}>Xem</button>
        <Link className="rounded border bg-white px-3 py-2" href={nav(addDays(fromKey, days))}>Sau →</Link>
      </form>
      {canEdit && <Notice ok="Kéo thanh để dời lịch (sang trái/phải) hoặc đổi chiếc (lên/xuống hàng cùng mẫu). Kéo trên ô trống của một hàng để giữ chỗ nhanh. Nhấp vào thanh để mở đơn." />}
      <TimelineGrid
        rows={JSON.parse(JSON.stringify(rows))} fromIso={from.toISOString()} toIso={to.toISOString()} tz={tz} customers={customers.map((c) => ({ id: c.id, name: c.name, phone: c.phone }))}
        canEdit={canEdit} move={moveAction} swap={swapAction} create={createAction}
      />
    </div>
  );
}
