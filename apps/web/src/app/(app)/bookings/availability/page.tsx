import Link from 'next/link';
import { utcToZonedInput, zonedTimeToUtc } from '@rentpro/core';
import { ValidationError, availability, listCategoriesFlat } from '@rentpro/db';
import { Empty, Field, Notice, btn, card, input } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { isUserError, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

export default async function AvailabilityPage({ searchParams }: { searchParams: Promise<{ start?: string; end?: string; category?: string; q?: string }> }) {
  const f = await searchParams;
  const data = await withService(async (c, s) => {
    const tz = s.tenant.timezone;
    const hour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
    const startVal = f.start ?? utcToZonedInput(new Date(hour), tz);
    const endVal = f.end ?? utcToZonedInput(new Date(hour + 24 * 3_600_000), tz);
    const cats = await listCategoriesFlat(c);
    let rows: Awaited<ReturnType<typeof availability>> = [];
    let error = '';
    const start = zonedTimeToUtc(startVal, tz);
    const end = zonedTimeToUtc(endVal, tz);
    try {
      if (!start || !end) throw new ValidationError('Thời gian không hợp lệ.');
      rows = await availability(c, start, end, { categoryId: f.category || undefined });
    } catch (e) {
      if (!isUserError(e)) throw e;
      error = e.message;
    }
    const q = f.q?.trim().toLowerCase();
    return { tz, startVal, endVal, cats, rows: q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows, error, start, end, canCreate: s.permissions.has('booking.create') };
  });
  return (
    <div className="space-y-4">
      <Link href="/bookings" className="text-sm underline">← Đơn thuê</Link>
      <h1 className="text-2xl font-semibold">Tra cứu còn trống</h1>
      <Notice error={data.error} />
      <form className={`${card} grid gap-3 md:grid-cols-5`}>
        <Field label={`Từ (giờ ${data.tz})`}><input name="start" type="datetime-local" defaultValue={data.startVal} className={input} /></Field>
        <Field label="Đến"><input name="end" type="datetime-local" defaultValue={data.endVal} className={input} /></Field>
        <Field label="Danh mục"><select name="category" defaultValue={f.category ?? ''} className={input}><option value="">Tất cả</option>{data.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Tên mẫu"><input name="q" defaultValue={f.q} className={input} /></Field>
        <div className="flex items-end"><button className={btn}>Tra cứu</button></div>
      </form>
      {data.start && data.end && !data.error && <p className="text-sm text-slate-600">Khoảng thời gian: {fmtDateTime(data.start, data.tz)} → {fmtDateTime(data.end, data.tz)} (đã tính thời gian đệm của từng mẫu)</p>}
      {data.rows.length === 0 ? <Empty>Không có mẫu thiết bị phù hợp.</Empty> : (
        <div className="overflow-x-auto rounded-lg bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-slate-50 text-slate-500"><tr><th className="p-3">Mẫu</th><th>Danh mục</th><th>Còn rảnh</th><th>Chiếc rảnh</th><th></th></tr></thead>
            <tbody>
              {data.rows.map((m) => (
                <tr key={m.modelId} className="border-b align-top last:border-0">
                  <td className="p-3 font-medium">{m.name}{!m.tracked && <div className="text-xs font-normal text-slate-500">Theo số lượng</div>}</td>
                  <td>{m.categoryName ?? '—'}</td>
                  <td data-testid={`free-${m.name}`}><b className={m.free === 0 ? 'text-red-700' : 'text-green-700'}>{m.free}</b> / {m.total}</td>
                  <td className="font-mono text-xs">{m.freeUnits.map((u) => u.barcode).join(', ') || '—'}</td>
                  <td className="pr-3">{data.canCreate && m.free > 0 && (
                    <Link className="underline" href={`/bookings/new?m1=${m.modelId}&q1=1&start=${encodeURIComponent(data.startVal)}&end=${encodeURIComponent(data.endVal)}`}>Tạo đơn</Link>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
