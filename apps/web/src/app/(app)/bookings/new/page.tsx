import Link from 'next/link';
import { redirect } from 'next/navigation';
import { UNIT_LABEL, utcToZonedInput, zonedTimeToUtc, type Discount } from '@rentpro/core';
import { ValidationError, availability, createBooking, listCustomers, listFieldDefs, listModels, quoteForCustomer, setCustomValues, type BookingLineInput, type QuoteResult } from '@rentpro/db';
import { CustomFieldInputs } from '@/components/custom-fields';
import { Field, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { fmtDateTime, vnd } from '@/lib/format';
import { isUserError, run, withService } from '@/lib/service';
import { requireAccess } from '@/lib/session';

export const dynamic = 'force-dynamic';
const LINES = 4;
type Params = Record<string, string | undefined>;

/** Đọc form/URL thành dữ liệu đặt đơn. Thời gian nhập theo giờ của cửa hàng, đổi sang UTC. */
function parse(p: Params, tz: string) {
  const start = p.start ? zonedTimeToUtc(p.start, tz) : null;
  const end = p.end ? zonedTimeToUtc(p.end, tz) : null;
  const lines: BookingLineInput[] = [];
  for (let i = 1; i <= LINES; i++) {
    const modelId = p[`m${i}`];
    if (modelId) lines.push({ modelId, qty: Math.max(1, Number(p[`q${i}`]) || 1), unitId: i === 1 && p.u1 ? p.u1 : null });
  }
  const pct = Number(p.discount);
  const discount: Discount | null = pct > 0 ? { type: 'PERCENT', value: pct } : null;
  return { customerId: p.customer ?? '', start, end, lines, discount, deliveryFee: Math.max(0, Math.round(Number(p.delivery) || 0)), notes: p.notes ?? '' };
}

const toQuery = (f: FormData) => {
  const q = new URLSearchParams();
  for (const [k, v] of f.entries()) if (typeof v === 'string' && v !== '' && k !== 'status' && !k.startsWith('$ACTION')) q.set(k, v);
  return q;
};

async function create(form: FormData) {
  'use server';
  const q = toQuery(form);
  const back = `/bookings/new?${q.toString()}&check=1`;
  await run(back, async () => {
    const r = await withService(async (c, s) => {
      const d = parse(Object.fromEntries(q), s.tenant.timezone);
      if (!d.start || !d.end) throw new ValidationError('Thời gian không hợp lệ.');
      const status = String(form.get('status')) as 'QUOTE' | 'HOLD' | 'CONFIRMED';
      const made = await createBooking(c, { customerId: d.customerId, lines: d.lines, start: d.start, end: d.end, status, discount: d.discount, deliveryFee: d.deliveryFee, notes: d.notes });
      // Trường tùy chỉnh đi cùng địa chỉ (form GET): ghi trong cùng giao dịch để trường bắt buộc không bị bỏ sót
      const defs = (await listFieldDefs(c, 'BOOKING')).filter((x) => x.kind !== 'FILE');
      if (defs.length) await setCustomValues(c, 'BOOKING', made.id, Object.fromEntries(defs.map((x) => [x.key, q.get(`cf_${x.key}`) ?? ''])), true);
      return made;
    });
    return `/bookings/${r.id}?ok=${encodeURIComponent(`Đã tạo đơn ${r.code}.`)}`;
  });
}

export default async function NewBooking({ searchParams }: { searchParams: Promise<Params> }) {
  const s = await requireAccess('booking', 'booking.create');
  const f = await searchParams;
  if (!s.tenant.features.pricing) redirect('/bookings?error=' + encodeURIComponent('Cần bật tính năng bảng giá để tạo đơn.'));
  const tz = s.tenant.timezone;
  const hourNow = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  const startVal = f.start ?? utcToZonedInput(new Date(hourNow), tz);
  const endVal = f.end ?? utcToZonedInput(new Date(hourNow + 24 * 3_600_000), tz);

  const data = await withService(async (c) => {
    const [customers, models, defs] = await Promise.all([listCustomers(c, { pageSize: 200 }), listModels(c), listFieldDefs(c, 'BOOKING')]);
    let quote: QuoteResult | null = null;
    let problems: string[] = [];
    let error = f.error ?? '';
    if (f.check) {
      const d = parse({ ...f, start: startVal, end: endVal }, tz);
      try {
        if (!d.customerId) throw new ValidationError('Hãy chọn khách hàng.');
        if (!d.start || !d.end) throw new ValidationError('Thời gian không hợp lệ.');
        if (d.lines.length === 0) throw new ValidationError('Hãy chọn ít nhất một thiết bị.');
        quote = await quoteForCustomer(c, { customerId: d.customerId, lines: d.lines.map((l) => ({ modelId: l.modelId, qty: l.qty })), start: d.start, end: d.end, discount: d.discount, deliveryFee: d.deliveryFee });
        const av = await availability(c, d.start, d.end);
        problems = d.lines.flatMap((l) => {
          const m = av.find((x) => x.modelId === l.modelId);
          if (!m) return [];
          if (l.unitId) return m.freeUnits.some((u) => u.id === l.unitId) ? [] : [`Thiết bị đã chọn đang bận trong khoảng thời gian này.`];
          return m.free >= l.qty ? [] : [`"${m.name}": cần ${l.qty}, chỉ còn ${m.free} rảnh trong khoảng thời gian này.`];
        });
      } catch (e) {
        if (!isUserError(e)) throw e;
        error = e.message;
      }
    }
    return { customers: customers.rows, models, quote, problems, error, defs };
  });

  const field = (name: string, def?: string) => f[name] ?? def ?? '';
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link href="/bookings" className="text-sm underline">← Đơn thuê</Link>
      <h1 className="text-2xl font-semibold">Tạo đơn thuê</h1>
      <Notice error={data.error} />

      <form className={`${card} space-y-3`}>
        <input type="hidden" name="check" value="1" />
        {f.u1 && <input type="hidden" name="u1" value={f.u1} />}
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Khách hàng (*)">
            <select name="customer" required defaultValue={field('customer')} className={input}>
              <option value="">— chọn —</option>
              {data.customers.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.phone}{c.blacklisted ? ' (danh sách đen)' : ''}</option>)}
            </select>
          </Field>
          <Field label={`Nhận thiết bị (giờ ${tz})`}><input name="start" type="datetime-local" required defaultValue={startVal} className={input} /></Field>
          <Field label="Trả thiết bị"><input name="end" type="datetime-local" required defaultValue={endVal} className={input} /></Field>
        </div>
        <fieldset className="space-y-2 rounded border p-3">
          <legend className="px-1 text-sm text-slate-500">Thiết bị{f.u1 ? ' (dòng 1: chiếc đã chọn trên lịch)' : ''}</legend>
          {Array.from({ length: LINES }, (_, i) => i + 1).map((i) => (
            <div key={i} className="grid grid-cols-[1fr_6rem] gap-2">
              <select name={`m${i}`} aria-label={`Thiết bị ${i}`} defaultValue={field(`m${i}`)} className={input}>
                <option value="">{i === 1 ? '— chọn thiết bị —' : '— thêm thiết bị (tùy chọn) —'}</option>
                {data.models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.tracked ? '' : ' (theo số lượng)'}</option>)}
              </select>
              <input name={`q${i}`} aria-label={`Số lượng ${i}`} type="number" min={1} defaultValue={field(`q${i}`, '1')} className={input} />
            </div>
          ))}
        </fieldset>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Giảm giá (%) — để trống = theo nhóm khách"><input name="discount" type="number" min={0} max={100} step="0.5" defaultValue={field('discount')} className={input} /></Field>
          <Field label="Phí giao nhận (VND)"><input name="delivery" type="number" min={0} defaultValue={field('delivery')} className={input} /></Field>
          <Field label="Ghi chú"><input name="notes" defaultValue={field('notes')} className={input} /></Field>
        </div>
        <CustomFieldInputs defs={data.defs} booleanAsSelect defaults={f} />
        <button className={btnGhost}>Tính giá &amp; kiểm tra lịch</button>
      </form>

      {data.quote && (
        <form action={create} className={`${card} space-y-3`} data-testid="booking-preview">
          {Object.entries({ ...f, start: startVal, end: endVal }).filter(([k, v]) => v && !['check', 'error', 'ok'].includes(k)).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <h2 className="font-medium">Kết quả: {data.quote.priceListName}{data.quote.groupName ? ` · nhóm ${data.quote.groupName}` : ''}</h2>
          <table className="w-full text-left text-sm">
            <tbody>
              {data.quote.quote.lines.map((l, i) => (
                <tr key={i} className="border-b"><td className="py-1">{l.name} × {l.qty}<div className="text-xs text-slate-500">{l.parts.map((p) => `${p.count} ${UNIT_LABEL[p.unit]} × ${vnd(p.unitPrice)}`).join(' + ')}</div></td><td className="text-right">{vnd(l.total)}</td></tr>
              ))}
              {data.quote.quote.discount && <tr><td>{data.quote.quote.discount.label}</td><td className="text-right">−{vnd(data.quote.quote.discount.amount)}</td></tr>}
              {data.quote.quote.delivery > 0 && <tr><td>Phí giao nhận</td><td className="text-right">{vnd(data.quote.quote.delivery)}</td></tr>}
              {data.quote.quote.vat > 0 && <tr><td>VAT {data.quote.quote.vatRate}%</td><td className="text-right">{vnd(data.quote.quote.vat)}</td></tr>}
              <tr className="font-semibold"><td className="pt-2">Tổng cộng</td><td className="pt-2 text-right" data-testid="preview-total">{vnd(data.quote.quote.total)}</td></tr>
            </tbody>
          </table>
          {data.problems.length > 0 && (
            <div role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">
              <b>Chưa đủ thiết bị:</b>
              <ul className="list-disc pl-5">{data.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
              <p className="mt-1">Bạn vẫn lưu được báo giá. Muốn giữ chỗ hoặc xác nhận, hãy đổi thời gian hoặc thiết bị.</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button name="status" value="QUOTE" className={btnGhost}>Lưu báo giá (chưa giữ chỗ)</button>
            <button name="status" value="HOLD" disabled={data.problems.length > 0} className={btn}>Giữ chỗ</button>
            <button name="status" value="CONFIRMED" disabled={data.problems.length > 0} className={btn}>Xác nhận đơn</button>
          </div>
          <p className="text-xs text-slate-500">Khoảng thời gian: {fmtDateTime(zonedTimeToUtc(startVal, tz)!, tz)} → {fmtDateTime(zonedTimeToUtc(endVal, tz)!, tz)}. Hệ thống kiểm tra lại lịch khi lưu, nên nếu người khác vừa đặt trước bạn sẽ được báo ngay.</p>
        </form>
      )}
    </div>
  );
}
