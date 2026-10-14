import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { CONDITIONS, CONDITION_LABEL, utcToZonedInput } from '@rentpro/core';
import { NotFoundError, getBooking, getHandovers, handoverRules } from '@rentpro/db';
import { Notice, btn, card, input } from '@/components/ui';
import { vnd } from '@/lib/format';
import { requireAccess } from '@/lib/session';
import { withService } from '@/lib/service';
import { deliverAction, receiveAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function HandoverPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireAccess('booking', 'booking.handover');
  const { id } = await params;
  const f = await searchParams;
  const data = await withService(async (c, s) => {
    try {
      const d = await getBooking(c, id);
      const h = await getHandovers(c, id);
      const rules = await handoverRules(c);
      return { ...d, h, tz: s.tenant.timezone, rules };
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  });
  if (!data) notFound();
  const { booking: b, allocations, h, tz } = data;
  if (b.status !== 'CONFIRMED' && b.status !== 'ACTIVE') redirect(`/bookings/${id}`);
  const delivering = b.status === 'CONFIRMED';
  const units = allocations.filter((a) => a.status !== 'RELEASED');
  const outItems = new Map((h.delivery?.items ?? []).filter((i) => i.unitId).map((i) => [i.unitId!, i]));
  const qtyLines = data.lines.filter((l) => !l.tracked);
  const action = (delivering ? deliverAction : receiveAction).bind(null, id);

  return (
    <div className="space-y-4">
      <Link href={`/bookings/${id}`} className="text-sm underline">← Đơn {b.code}</Link>
      <h1 className="text-2xl font-semibold">{delivering ? 'Giao thiết bị' : 'Nhận thiết bị về'} · <span className="font-mono">{b.code}</span></h1>
      <p className="text-sm text-slate-600">Khách: {b.customerName} · {b.customerPhone}</p>
      <Notice error={f.error} ok={f.ok} />

      <form action={action} className="space-y-4" data-testid={delivering ? 'deliver-form' : 'receive-form'}>
        <input type="hidden" name="count" value={units.length} />
        {units.map((u, i) => {
          const was = outItems.get(u.unitId);
          const accDefault = (was?.accessories ?? []).map((a) => `${a.name} | ${a.expected} | ${a.actual}`).join('\n');
          return (
            <section key={u.id} className={`${card} space-y-2`} data-testid={`item-${u.barcode}`}>
              <input type="hidden" name={`unit_${i}`} value={u.unitId} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-mono font-medium">{u.barcode}</h2>
                {was && <span className="text-xs text-slate-500">Lúc giao: {was.conditionLabel}{was.notes ? ` — ${was.notes}` : ''}</span>}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-sm">Tình trạng
                  <select name={`condition_${i}`} defaultValue="GOOD" className={`${input} mt-1`}>
                    {CONDITIONS.filter((c) => delivering ? c !== 'MISSING' : true).map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}
                  </select>
                </label>
                <label className="text-sm">Ghi chú (bắt buộc nếu hư hỏng)<input name={`notes_${i}`} className={`${input} mt-1`} /></label>
                <label className="text-sm">Phụ kiện đi kèm — mỗi dòng: Tên | số cần | số có
                  <textarea name={`acc_${i}`} rows={3} defaultValue={accDefault} placeholder="Pin | 2 | 2" className={`${input} mt-1`} />
                </label>
                <div className="space-y-2">
                  <label className="block text-sm">Ảnh tình trạng (tối đa 5)<input name={`photos_${i}`} type="file" accept="image/*" multiple className={`${input} mt-1`} /></label>
                  {!delivering && <label className="block text-sm">Phí hư hỏng (đ) nếu có<input name={`fee_${i}`} inputMode="numeric" className={`${input} mt-1`} /></label>}
                </div>
              </div>
            </section>
          );
        })}

        {qtyLines.length > 0 && (
          <section className={card}>
            <h2 className="mb-1 font-medium">Hàng theo số lượng</h2>
            <ul className="text-sm">{qtyLines.map((l) => <li key={l.id}>{l.modelName} × {l.qty} (ghi vào biên bản tự động)</li>)}</ul>
          </section>
        )}

        <section className={`${card} space-y-3`}>
          {!delivering && (
            <>
              <label className="block text-sm">Giờ nhận thực tế (để trống = bây giờ; hạn trả: {utcToZonedInput(b.endsAt, tz).replace('T', ' ')})
                <input name="returnedAt" type="datetime-local" className={`${input} mt-1 max-w-xs`} />
              </label>
              <p className="text-xs text-slate-500">Trả trễ quá ân hạn sẽ tự tính phí; trả sớm sẽ tính lại tiền thuê. Tổng đơn hiện tại {vnd(b.total)}.</p>
              <div className="grid gap-2 md:grid-cols-4">
                <label className="text-sm">Phí khác — loại<select name="extraKind" className={`${input} mt-1`}><option value="OTHER">Phí khác</option><option value="DAMAGE">Hư hỏng</option></select></label>
                <label className="text-sm md:col-span-2">Mô tả (VD: thiếu 1 pin, vệ sinh)<input name="extraDesc" className={`${input} mt-1`} /></label>
                <label className="text-sm">Số tiền (đ)<input name="extraAmount" inputMode="numeric" className={`${input} mt-1`} /></label>
              </div>
            </>
          )}
          <label className="block text-sm">Ghi chú chung<input name="notes" className={`${input} mt-1`} /></label>
          {delivering && (
            <p className="text-xs text-slate-500">
              Điều kiện giao: {data.rules?.requireContract ?? true ? 'hợp đồng đã ký' : 'không yêu cầu hợp đồng'}; {data.rules?.requireDeposit ?? true ? 'đủ tiền cọc' : 'không yêu cầu cọc'}.
            </p>
          )}
          <button className={btn} data-testid="submit-handover">{delivering ? 'Xác nhận đã giao' : 'Xác nhận đã nhận'}</button>
        </section>
      </form>
    </div>
  );
}
