import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getBooking, getDocTemplates, getHandovers, type HandoverView } from '@rentpro/db';
import { PrintButton } from '@/components/print-button';
import { fmtDateTime } from '@/lib/format';
import { requireAccess } from '@/lib/session';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

function Report({ title, v, tz }: { title: string; v: HandoverView; tz: string }) {
  return (
    <section className="space-y-2 break-inside-avoid">
      <h2 className="font-semibold">{title} — {fmtDateTime(v.performedAt, tz)}</h2>
      <table className="w-full border-collapse text-sm">
        <thead><tr className="border-b text-left"><th className="py-1">Thiết bị</th><th>Tình trạng</th><th>Phụ kiện</th><th>Ghi chú</th><th>Ảnh</th></tr></thead>
        <tbody>
          {v.items.map((i) => (
            <tr key={i.id} className="border-b align-top">
              <td className="py-1">{i.label}</td><td>{i.conditionLabel}</td>
              <td>{i.accessories.map((a) => `${a.name}: ${a.actual}/${a.expected}`).join('; ') || '—'}</td><td>{i.notes ?? ''}</td>
              <td className="flex gap-1">{Array.from({ length: i.photoCount }, (_, n) => (

                <img key={n} src={`/media/handover/${i.id}/${n}`} alt={`Ảnh ${i.label} ${n + 1}`} className="h-14" />
              ))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {v.notes && <p className="text-sm">Ghi chú: {v.notes}</p>}
    </section>
  );
}

export default async function HandoverPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const sess = await requireAccess('booking', 'booking.view');
  const { id } = await params;
  const d = await withService(async (c, s) => ({ b: (await getBooking(c, id)).booking, h: await getHandovers(c, id), tz: s.tenant.timezone, t: (await getDocTemplates(c)).resolved.handover }));
  if (!d.h.delivery && !d.h.ret) notFound();
  return (
    <div className="mx-auto max-w-3xl space-y-5 bg-white p-8 text-[15px] shadow-sm print:shadow-none" data-testid="handover-print">
      <div className="flex justify-between print:hidden"><Link href={`/bookings/${id}`} className="text-sm underline">← Về đơn</Link><PrintButton /></div>
      <h1 className="text-center text-xl font-bold">{d.t.title}</h1>
      <p className="text-center">Đơn <b className="font-mono">{d.b.code}</b> · Khách: {d.b.customerName} · {d.b.customerPhone}</p>
      {d.h.delivery && <Report title="Biên bản giao" v={d.h.delivery} tz={d.tz} />}
      {d.h.ret && <Report title="Biên bản nhận về" v={d.h.ret} tz={d.tz} />}
      {d.h.issues.length > 0 && (
        <section className="rounded border border-red-300 p-3">
          <h2 className="font-semibold text-red-700">Chênh lệch giữa lúc giao và lúc nhận</h2>
          <ul className="list-disc pl-5 text-sm">{d.h.issues.map((i, n) => <li key={n}>{i.detail}</li>)}</ul>
        </section>
      )}
      <section className="grid grid-cols-2 gap-6 pt-6 text-center"><div className="font-semibold">Khách hàng ký</div><div className="font-semibold">Nhân viên ký</div></section>
      {d.t.footer && <p className="text-center text-sm">{d.t.footer}</p>}
      {sess.tenant.branding.footerText && <p className="border-t pt-2 text-center text-xs text-slate-500">{sess.tenant.branding.footerText}</p>}
    </div>
  );
}
