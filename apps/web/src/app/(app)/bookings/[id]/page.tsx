import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BOOKING_STATUS_LABEL, UNIT_LABEL, canExtend, canReschedule, nextBookingStatuses, utcToZonedInput, zonedTimeToUtc, type BookingStatus } from '@rentpro/core';
import {
  NotFoundError, ValidationError, availability, cancelBooking, confirmBooking, extendBooking, getBooking, holdBooking, moveBooking, shortenBooking, swapUnit,
} from '@rentpro/db';
import { CustomFieldsPanel } from '@/components/custom-fields';
import { FinancePanel } from './finance-panel';
import { StatusBadge } from '@/components/booking-status';
import { Notice, btn, btnGhost, card, input } from '@/components/ui';
import { fmtDateTime, vnd } from '@/lib/format';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

// Hàm hỗ trợ đặt ở phạm vi module: server action không được bắt hàm cục bộ trong closure (Next phải mã hóa các biến closure).
const okUrl = (back: string, m: string) => `${back}?ok=${encodeURIComponent(m)}`;
const when = (v: FormDataEntryValue | null, tz: string) => {
  const d = zonedTimeToUtc(String(v ?? ''), tz);
  if (!d) throw new ValidationError('Thời gian không hợp lệ.');
  return d;
};

export default async function BookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const f = await searchParams;
  const data = await withService(async (c, s) => {
    try {
      const d = await getBooking(c, id);
      const canEdit = s.permissions.has('booking.create');
      // chiếc có thể đổi sang: cùng mẫu, còn rảnh trong khoảng thời gian của đơn
      const swap = new Map<string, { id: string; barcode: string }[]>();
      if (canEdit && canReschedule(d.booking.status)) {
        for (const m of new Set(d.allocations.map((a) => a.modelId))) {
          const av = await availability(c, d.booking.startsAt, d.booking.endsAt, { modelId: m });
          swap.set(m, av[0]?.freeUnits ?? []);
        }
      }
      return { ...d, tz: s.tenant.timezone, canEdit, canCancel: s.permissions.has('booking.cancel'), swap };
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  });
  if (!data) notFound();
  const { booking: b, lines, allocations, history, tz, canEdit, canCancel, swap } = data;
  const back = `/bookings/${id}`;
  async function hold() { 'use server'; await run(back, async () => { await withService((c) => holdBooking(c, id)); return okUrl(back, 'Đã giữ chỗ.'); }); }
  async function confirm() { 'use server'; await run(back, async () => { await withService((c) => confirmBooking(c, id)); return okUrl(back, 'Đã xác nhận đơn.'); }); }
  async function cancel(f: FormData) {
    'use server';
    await run(back, async () => { await withService((c) => cancelBooking(c, id, String(f.get('reason') ?? ''))); return okUrl(back, 'Đã hủy đơn.'); });
  }
  async function extend(f: FormData) {
    'use server';
    await run(back, async () => {
      const r = await withService((c, s) => extendBooking(c, id, when(f.get('end'), s.tenant.timezone)));
      return okUrl(back, `Đã gia hạn. Tổng tiền mới ${vnd(r.newTotal)} (${r.delta >= 0 ? '+' : '−'}${vnd(Math.abs(r.delta))}).`);
    });
  }
  async function shorten(f: FormData) {
    'use server';
    await run(back, async () => {
      const r = await withService((c, s) => shortenBooking(c, id, when(f.get('end'), s.tenant.timezone)));
      return okUrl(back, `Đã rút ngắn. Tổng tiền mới ${vnd(r.newTotal)} (${r.delta >= 0 ? '+' : '−'}${vnd(Math.abs(r.delta))}).`);
    });
  }
  async function move(f: FormData) {
    'use server';
    await run(back, async () => {
      const r = await withService((c, s) => moveBooking(c, id, when(f.get('start'), s.tenant.timezone)));
      return okUrl(back, `Đã dời lịch. Tổng tiền ${vnd(r.newTotal)}.`);
    });
  }
  async function swap1(f: FormData) {
    'use server';
    await run(back, async () => { await withService((c) => swapUnit(c, String(f.get('allocationId')), String(f.get('unitId')))); return okUrl(back, 'Đã đổi thiết bị.'); });
  }

  const next = nextBookingStatuses(b.status);
  const q = b.quote;
  return (
    <div className="space-y-4">
      <Link href="/bookings" className="text-sm underline">← Đơn thuê</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-2xl font-semibold">{b.code}</h1><StatusBadge status={b.status} />
        {b.status === 'HOLD' && b.holdExpiresAt && <span className="text-sm text-amber-700">Giữ chỗ đến {fmtDateTime(b.holdExpiresAt, tz)}</span>}
      </div>
      <Notice error={f.error} ok={f.ok} />
      <div className={`${card} grid gap-2 text-sm md:grid-cols-2`}>
        <div><span className="text-slate-500">Khách hàng:</span> <Link className="underline" href={`/customers/${b.customerId}`}>{b.customerName}</Link> · {b.customerPhone}</div>
        <div><span className="text-slate-500">Thời gian:</span> {fmtDateTime(b.startsAt, tz)} → {fmtDateTime(b.endsAt, tz)}</div>
        <div><span className="text-slate-500">Tổng tiền:</span> <b data-testid="booking-total">{vnd(b.total)}</b>{b.extendedCount > 0 && ` · đã gia hạn ${b.extendedCount} lần`}</div>
        {b.notes && <div><span className="text-slate-500">Ghi chú:</span> {b.notes}</div>}
        {b.cancelReason && <div className="text-red-700"><span className="text-slate-500">Lý do hủy:</span> {b.cancelReason}</div>}
      </div>

      <section className={card}>
        <h2 className="mb-2 font-medium">Thiết bị</h2>
        <ul className="space-y-2 text-sm">
          {lines.map((l) => (
            <li key={l.id} className="rounded border p-2">
              <div className="flex justify-between"><b>{l.modelName} × {l.qty}</b><span>{vnd(l.lineTotal)}</span></div>
              {!l.tracked && <div className="text-xs text-slate-500">Hàng theo số lượng</div>}
              <ul className="mt-1 space-y-1">
                {allocations.filter((a) => a.lineId === l.id && a.status !== 'RELEASED').map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{a.barcode}</span>
                    {canEdit && canReschedule(b.status) && (swap.get(a.modelId)?.length ?? 0) > 0 && (
                      <form action={swap1} className="flex items-center gap-1">
                        <input type="hidden" name="allocationId" value={a.id} />
                        <select name="unitId" aria-label={`Đổi ${a.barcode} sang`} className="rounded border px-2 py-1 text-xs">{swap.get(a.modelId)!.map((u) => <option key={u.id} value={u.id}>{u.barcode}</option>)}</select>
                        <button className="text-xs underline">Đổi chiếc</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      {q && (
        <section className={card}>
          <h2 className="mb-2 font-medium">Chi tiết giá (đã chốt)</h2>
          <table className="w-full text-sm"><tbody>
            {q.lines.map((l, i) => <tr key={i} className="border-b"><td className="py-1">{l.name} × {l.qty}<div className="text-xs text-slate-500">{l.parts.map((p) => `${p.count} ${UNIT_LABEL[p.unit]} × ${vnd(p.unitPrice)}`).join(' + ')}</div></td><td className="text-right">{vnd(l.total)}</td></tr>)}
            {q.discount && <tr><td>{q.discount.label}</td><td className="text-right">−{vnd(q.discount.amount)}</td></tr>}
            {q.delivery > 0 && <tr><td>Phí giao nhận</td><td className="text-right">{vnd(q.delivery)}</td></tr>}
            {q.adjustments.map((a, i) => <tr key={i}><td>{a.label}</td><td className="text-right">{a.amount < 0 ? '−' : ''}{vnd(Math.abs(a.amount))}</td></tr>)}
            {q.vat > 0 && <tr><td>VAT {q.vatRate}%</td><td className="text-right">{vnd(q.vat)}</td></tr>}
            <tr className="font-semibold"><td className="pt-2">Tổng cộng</td><td className="pt-2 text-right">{vnd(q.total)}</td></tr>
          </tbody></table>
        </section>
      )}

      {canEdit && (
        <section className={`${card} space-y-3`}>
          <h2 className="font-medium">Thao tác</h2>
          <div className="flex flex-wrap gap-2">
            {next.includes('HOLD') && <form action={hold}><button className={btn}>Giữ chỗ</button></form>}
            {next.includes('CONFIRMED') && <form action={confirm}><button className={btn}>Xác nhận đơn</button></form>}
          </div>
          {canReschedule(b.status) && (
            <form action={move} className="flex flex-wrap items-end gap-2">
              <label className="text-sm">Dời đơn sang (giờ nhận mới)<input name="start" type="datetime-local" required defaultValue={utcToZonedInput(b.startsAt, tz)} className={`${input} mt-1`} /></label>
              <button className={btnGhost}>Dời lịch</button>
            </form>
          )}
          {canExtend(b.status) && (
            <div className="flex flex-wrap gap-6">
              <form action={extend} className="flex flex-wrap items-end gap-2">
                <label className="text-sm">Gia hạn đến<input name="end" type="datetime-local" required defaultValue={utcToZonedInput(b.endsAt, tz)} className={`${input} mt-1`} /></label>
                <button className={btnGhost}>Gia hạn</button>
              </form>
              <form action={shorten} className="flex flex-wrap items-end gap-2">
                <label className="text-sm">Rút ngắn / trả sớm lúc<input name="end" type="datetime-local" required defaultValue={utcToZonedInput(b.endsAt, tz)} className={`${input} mt-1`} /></label>
                <button className={btnGhost}>Rút ngắn</button>
              </form>
            </div>
          )}
          {canCancel && next.includes('CANCELLED') && (
            <form action={cancel} className="flex flex-wrap items-end gap-2">
              <input name="reason" required placeholder="Lý do hủy (bắt buộc)" className={`${input} max-w-sm`} />
              <button className="rounded bg-red-700 px-4 py-2 text-white">Hủy đơn</button>
            </form>
          )}
        </section>
      )}

      <FinancePanel id={id} status={b.status} tz={tz} />
      <CustomFieldsPanel entity="BOOKING" id={id} back={back} />

      <section className={card}>
        <h2 className="mb-2 font-medium">Lịch sử</h2>
        <ul className="space-y-1 text-sm text-slate-700">
          {history.map((h, i) => (
            <li key={i}>{fmtDateTime(h.created_at, tz)} · {h.from_status && h.from_status !== h.to_status ? `${BOOKING_STATUS_LABEL[h.from_status as BookingStatus]} → ` : ''}{BOOKING_STATUS_LABEL[h.to_status as BookingStatus]}{h.reason ? ` · ${h.reason}` : ''}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
