import Link from 'next/link';
import { redirect } from 'next/navigation';
import { UNIT_LABEL, utcToZonedInput, zonedTimeToUtc } from '@rentpro/core';
import { ValidationError, listCustomers, listModels, quoteForCustomer, type QuoteResult } from '@rentpro/db';
import { Field, Notice, btn, card, input } from '@/components/ui';
import { isUserError, withService } from '@/lib/service';
import { requireAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';
const vnd = (n: number) => new Intl.NumberFormat('vi-VN').format(n) + ' đ';

export default async function QuotePage({ searchParams }: { searchParams: Promise<{ model?: string; qty?: string; customer?: string; start?: string; end?: string; discount?: string; delivery?: string }> }) {
  const s = await requireAppSession();
  if (!s.tenant.features.pricing) redirect('/');
  const f = await searchParams;
  const tz = s.tenant.timezone;
  const defStart = f.start ?? utcToZonedInput(new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000), tz);
  const defEnd = f.end ?? utcToZonedInput(new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 24 * 3_600_000), tz);

  const { models, customers, result, error } = await withService(async (c) => {
    const models = await listModels(c);
    const customers = s.tenant.features.customers ? (await listCustomers(c, { pageSize: 200 })).rows : [];
    let result: QuoteResult | null = null;
    let error = '';
    if (f.model) {
      const start = zonedTimeToUtc(defStart, tz);
      const end = zonedTimeToUtc(defEnd, tz);
      const discount = Number(f.discount) > 0 ? ({ type: 'PERCENT', value: Number(f.discount) } as const) : null;
      try {
        if (!start || !end) throw new ValidationError('Thời gian không hợp lệ.');
        result = await quoteForCustomer(c, {
          customerId: f.customer || null, lines: [{ modelId: f.model, qty: Math.max(1, Number(f.qty) || 1) }], start, end, discount, deliveryFee: Number(f.delivery) || 0,
        });
      } catch (e) {
        if (!isUserError(e)) throw e;
        error = (e as Error).message;
      }
    }
    return { models, customers, result, error };
  });

  return (
    <div className="space-y-4">
      <Link href="/pricing" className="text-sm underline">← Bảng giá</Link>
      <h1 className="text-2xl font-semibold">Báo giá thử</h1>
      <Notice error={error} />
      <form className={`${card} grid gap-3 md:grid-cols-3`}>
        <Field label="Thiết bị"><select name="model" defaultValue={f.model ?? ''} required className={input}><option value="">—</option>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        <Field label="Số lượng"><input name="qty" type="number" min={1} defaultValue={f.qty ?? 1} className={input} /></Field>
        {customers.length > 0 && <Field label="Khách hàng (để áp nhóm giá)"><select name="customer" defaultValue={f.customer ?? ''} className={input}><option value="">Khách lẻ</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.phone}</option>)}</select></Field>}
        <Field label={`Bắt đầu (giờ ${tz})`}><input name="start" type="datetime-local" defaultValue={defStart} required className={input} /></Field>
        <Field label="Kết thúc"><input name="end" type="datetime-local" defaultValue={defEnd} required className={input} /></Field>
        <Field label="Giảm giá (%)"><input name="discount" type="number" min={0} max={100} defaultValue={f.discount ?? ''} className={input} /></Field>
        <Field label="Phí giao nhận (VND)"><input name="delivery" type="number" min={0} defaultValue={f.delivery ?? ''} className={input} /></Field>
        <div className="flex items-end"><button className={btn}>Tính giá</button></div>
      </form>

      {result && (
        <div className={`${card} space-y-2`} data-testid="quote-result">
          <h2 className="font-medium">Kết quả: {result.priceListName}{result.groupName ? ` · nhóm ${result.groupName}` : ''}</h2>
          <p className="text-sm text-slate-600">Thời lượng tính phí: {result.quote.durationHours} giờ{result.quote.calendarDays ? ` (${result.quote.calendarDays} ngày lịch)` : ''}</p>
          <table className="w-full text-left text-sm">
            <tbody>
              {result.quote.lines.map((l) => (
                <tr key={l.modelId} className="border-b"><td className="py-1">{l.name} × {l.qty}<div className="text-xs text-slate-500">{l.parts.map((p) => `${p.count} ${UNIT_LABEL[p.unit]} × ${vnd(p.unitPrice)}`).join(' + ')}</div></td><td className="text-right">{vnd(l.total)}</td></tr>
              ))}
              <tr><td className="py-1">Tạm tính</td><td className="text-right">{vnd(result.quote.subtotal)}</td></tr>
              {result.quote.discount && <tr><td>{result.quote.discount.label}</td><td className="text-right">−{vnd(result.quote.discount.amount)}</td></tr>}
              {result.quote.delivery > 0 && <tr><td>Phí giao nhận</td><td className="text-right">{vnd(result.quote.delivery)}</td></tr>}
              {result.quote.adjustments.map((a, i) => <tr key={i}><td>{a.label}</td><td className="text-right">{a.amount < 0 ? '−' : ''}{vnd(Math.abs(a.amount))}</td></tr>)}
              {result.quote.vat > 0 && <tr><td>VAT {result.quote.vatRate}%</td><td className="text-right">{vnd(result.quote.vat)}</td></tr>}
              <tr className="font-semibold"><td className="pt-2">Tổng cộng</td><td className="pt-2 text-right" data-testid="quote-total">{vnd(result.quote.total)}</td></tr>
            </tbody>
          </table>
          {result.usedFallbackFor.length > 0 && <p className="text-xs text-amber-700">Dùng giá niêm yết cho: {result.usedFallbackFor.join(', ')} (bảng giá của nhóm chưa có).</p>}
          {result.quote.warnings.map((w, i) => <p key={i} className="text-xs text-amber-700">{w}</p>)}
        </div>
      )}
    </div>
  );
}
