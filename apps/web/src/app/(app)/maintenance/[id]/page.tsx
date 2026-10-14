import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError, getOrder, listTechnicians } from '@rentpro/db';
import { Field, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { fmtDateTime, vnd } from '@/lib/format';
import { requireAppSession } from '@/lib/session';
import { withService } from '@/lib/service';
import { cancelAction, chargeAction, checklistAction, disposeAction, finishAction, photosAction, startAction, unrepairableAction, updateAction } from '../actions';

export const dynamic = 'force-dynamic';

const TONE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800', IN_PROGRESS: 'bg-blue-100 text-blue-800', DONE: 'bg-green-100 text-green-800',
  UNREPAIRABLE: 'bg-red-100 text-red-700', DISPOSED: 'bg-slate-200 text-slate-600', CANCELLED: 'bg-slate-100 text-slate-500',
};

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const f = await searchParams;
  const sess = await requireAppSession();
  const data = await withService(async (c) => {
    try { return { o: await getOrder(c, id), techs: sess.permissions.has('maintenance.manage') ? await listTechnicians(c) : [] }; } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
  });
  if (!data) notFound();
  const { o, techs } = data;
  const tz = sess.tenant.timezone;
  const manage = sess.permissions.has('maintenance.manage');
  const open = o.status === 'PENDING' || o.status === 'IN_PROGRESS';
  const canCharge = sess.permissions.has('booking.handover') && sess.tenant.features.payments && !!o.bookingId && o.status !== 'CANCELLED';
  const row = 'flex flex-wrap items-end gap-2';

  return (
    <div className="space-y-4">
      <Link href="/maintenance" className="text-sm underline">← Bảo trì</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-2xl font-semibold" data-testid="order-code">{o.code}</h1>
        <span className={`rounded px-2 py-0.5 text-xs ${TONE[o.status]}`} data-testid="order-status">{o.statusLabel}</span>
      </div>
      <Notice error={f.error} ok={f.ok} />

      <section className={`${card} grid gap-2 text-sm md:grid-cols-2`}>
        <div className="md:col-span-2 text-base font-medium">{o.title}</div>
        <div><span className="text-slate-500">Thiết bị:</span> <Link className="font-mono underline" href={`/inventory/units/${o.unitId}`}>{o.barcode}</Link> · {o.modelName} · <span data-testid="unit-status">{o.unitStatus}</span></div>
        <div><span className="text-slate-500">Loại:</span> {o.kindLabel}</div>
        <div><span className="text-slate-500">Kỹ thuật viên:</span> {o.technicianName ?? 'Chưa giao'}{o.vendor ? ` · sửa ngoài: ${o.vendor}` : ''}</div>
        <div><span className="text-slate-500">Hạn:</span> {o.dueDate ? <span className={o.overdue ? 'text-red-700' : ''}>{o.dueDate}{o.overdue ? ' (quá hạn)' : ''}</span> : '—'}</div>
        {o.scheduledStart && o.scheduledEnd && <div className="md:col-span-2"><span className="text-slate-500">Khung giờ giữ lịch:</span> {fmtDateTime(o.scheduledStart, tz)} → {fmtDateTime(o.scheduledEnd, tz)}</div>}
        {o.bookingId && <div className="md:col-span-2"><span className="text-slate-500">Phát sinh từ đơn thuê:</span> <Link className="font-mono underline" href={`/bookings/${o.bookingId}`}>{o.bookingCode}</Link></div>}
        {o.description && <div className="md:col-span-2 whitespace-pre-line"><span className="text-slate-500">Mô tả:</span> {o.description}</div>}
        {o.startedAt && <div><span className="text-slate-500">Bắt đầu:</span> {fmtDateTime(o.startedAt, tz)}</div>}
        {o.finishedAt && <div><span className="text-slate-500">Hoàn thành:</span> {fmtDateTime(o.finishedAt, tz)}</div>}
        {o.closeNote && <div className="md:col-span-2 whitespace-pre-line"><span className="text-slate-500">Ghi chú kết thúc:</span> {o.closeNote}</div>}
      </section>

      {o.conflicts.length > 0 && open && (
        <p className="rounded bg-amber-50 p-3 text-sm text-amber-900" data-testid="order-conflicts">Chiếc này đang có đơn sắp tới: {o.conflicts.map((c) => `${c.code} (${fmtDateTime(c.start, tz)})`).join(', ')}. Hãy đổi sang chiếc khác cho các đơn này nếu việc kéo dài.</p>
      )}

      {manage && (
        <section className={`${card} space-y-3`}>
          <h2 className="font-medium">Thao tác</h2>
          <div className={row}>
            {o.status === 'PENDING' && <form action={startAction.bind(null, o.id)}><button className={btn} data-testid="start-order">Bắt đầu làm</button></form>}
            {o.status === 'IN_PROGRESS' && (
              <>
                <form action={finishAction.bind(null, o.id)} className={row}>
                  <input name="note" placeholder="Ghi chú kết thúc (bắt buộc nếu bỏ qua checklist)" className={`${input} w-80`} />
                  <button className={btn} data-testid="finish-order">Hoàn thành</button>
                </form>
                <form action={unrepairableAction.bind(null, o.id)} className={row}>
                  <input name="reason" required placeholder="Lý do không sửa được" className={`${input} w-64`} />
                  <button className={btnGhost}>Không sửa được</button>
                </form>
              </>
            )}
            {o.status === 'UNREPAIRABLE' && (
              <form action={disposeAction.bind(null, o.id)} className={row}>
                <input name="reason" required placeholder="Lý do thanh lý" className={`${input} w-64`} />
                <button className="rounded bg-red-700 px-4 py-2 text-white">Thanh lý thiết bị</button>
              </form>
            )}
            {o.status === 'PENDING' && (
              <form action={cancelAction.bind(null, o.id)} className={row}>
                <input name="reason" required placeholder="Lý do hủy phiếu" className={`${input} w-64`} />
                <button className={btnGhost}>Hủy phiếu</button>
              </form>
            )}
          </div>
        </section>
      )}

      <section className={card}>
        <h2 className="mb-2 font-medium">Checklist</h2>
        {o.checklist.length === 0 ? <p className="text-sm text-slate-500">Không có.</p> : (
          <ul className="space-y-2" data-testid="checklist">
            {o.checklist.map((c, i) => (
              <li key={i}>
                <form action={checklistAction.bind(null, o.id, i, !c.done)}>
                  <button disabled={!manage || !open} className={`flex w-full items-center gap-3 rounded border px-3 py-3 text-left text-base ${c.done ? 'bg-green-50' : 'bg-white'} disabled:opacity-80`}>
                    <span aria-hidden>{c.done ? '☑' : '☐'}</span><span className={c.done ? 'line-through' : ''}>{c.text}</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={`${card} space-y-3`}>
        <div className="flex items-center justify-between"><h2 className="font-medium">Chi phí</h2><span className="text-lg font-semibold" data-testid="order-cost">{vnd(o.costTotal)}</span></div>
        {o.parts.length > 0 && (
          <table className="w-full text-sm"><tbody>{o.parts.map((p, i) => <tr key={i} className="border-b"><td className="py-1">{p.name} × {p.qty}</td><td className="text-right">{vnd(p.qty * p.unitCost)}</td></tr>)}
            {o.laborCost > 0 && <tr className="border-b"><td className="py-1">Tiền công</td><td className="text-right">{vnd(o.laborCost)}</td></tr>}
            {o.vendorCost > 0 && <tr><td className="py-1">Sửa ngoài{o.vendor ? ` (${o.vendor})` : ''}</td><td className="text-right">{vnd(o.vendorCost)}</td></tr>}</tbody></table>
        )}
        {manage && open && (
          <form action={updateAction.bind(null, o.id)} className="space-y-3 border-t pt-3" data-testid="order-edit">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Tiêu đề"><input name="title" defaultValue={o.title} className={input} /></Field>
              <Field label="Hạn hoàn thành"><input name="dueDate" type="date" defaultValue={o.dueDate ?? ''} className={input} /></Field>
              <Field label="Kỹ thuật viên"><select name="technicianId" defaultValue={o.technicianId ?? ''} className={input}><option value="">— Chưa giao —</option>{techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
              <Field label="Đơn vị sửa ngoài"><input name="vendor" defaultValue={o.vendor ?? ''} className={input} /></Field>
              <Field label="Tiền công (đ)"><input name="laborCost" inputMode="numeric" defaultValue={o.laborCost || ''} className={input} /></Field>
              <Field label="Chi phí sửa ngoài (đ)"><input name="vendorCost" inputMode="numeric" defaultValue={o.vendorCost || ''} className={input} /></Field>
            </div>
            <Field label="Mô tả"><textarea name="description" rows={2} defaultValue={o.description ?? ''} className={input} /></Field>
            <Field label="Linh kiện — mỗi dòng: Tên | số lượng | đơn giá"><textarea name="parts" rows={3} defaultValue={o.parts.map((p) => `${p.name} | ${p.qty} | ${p.unitCost}`).join('\n')} className={input} /></Field>
            <button className={btnGhost}>Lưu phiếu</button>
          </form>
        )}
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="font-medium">Ảnh trước / sau</h2>
        {(['before', 'after'] as const).map((w) => {
          const n = w === 'before' ? o.photosBefore : o.photosAfter;
          return (
            <div key={w}>
              <div className="mb-1 text-sm text-slate-600">{w === 'before' ? 'Trước khi sửa' : 'Sau khi sửa'}</div>
              <div className="flex flex-wrap gap-2">{Array.from({ length: n }, (_, i) => <img key={i} src={`/media/order-${w}/${o.id}/${i}`} alt={`Ảnh ${w === 'before' ? 'trước' : 'sau'} ${i + 1}`} className="h-24 rounded border" />)}{n === 0 && <span className="text-sm text-slate-400">Chưa có ảnh</span>}</div>
              {manage && open && (
                <form action={photosAction.bind(null, o.id, w)} className={`${row} mt-2`}>
                  <input name="photos" type="file" accept="image/*" capture="environment" multiple className={`${input} max-w-xs`} />
                  <button className={btnGhost}>Tải lên</button>
                </form>
              )}
            </div>
          );
        })}
      </section>

      {canCharge && (
        <section className={`${card} space-y-2`} data-testid="charge-section">
          <h2 className="font-medium">Tính phí cho khách</h2>
          {o.chargedFeeId ? <p className="text-sm text-green-700">Đã chuyển thành khoản phí hư hỏng trên đơn <Link className="underline" href={`/bookings/${o.bookingId}`}>{o.bookingCode}</Link>.</p> : (
            <form action={chargeAction.bind(null, o.id)} className={row}>
              <Field label="Số tiền (để trống = tổng chi phí phiếu)"><input name="amount" inputMode="numeric" placeholder={String(o.costTotal)} className={input} /></Field>
              <Field label="Mô tả trên đơn"><input name="description" className={`${input} w-72`} /></Field>
              <button className={btn}>Chuyển thành phí hư hỏng</button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
