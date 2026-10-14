import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, vndInWords } from '@rentpro/core';
import { bookingLedger, getBooking, getDocTemplates } from '@rentpro/db';
import { PrintButton } from '@/components/print-button';
import { fmtDateTime, vnd } from '@/lib/format';
import { requireAccess } from '@/lib/session';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

/** Phiếu thu một khoản thanh toán (in / lưu PDF). Tiêu đề và chân trang theo mẫu của cửa hàng. */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string; paymentId: string }> }) {
  const sess = await requireAccess('payments', 'payment.view');
  const { id, paymentId } = await params;
  const d = await withService(async (c) => ({ l: await bookingLedger(c, id), b: (await getBooking(c, id)).booking, t: (await getDocTemplates(c)).resolved.receipt }));
  const p = d.l.payments.find((x) => x.id === paymentId);
  if (!p) notFound();
  const tz = sess.tenant.timezone;
  const br = sess.tenant.branding;
  const refund = p.kind === 'REFUND';
  return (
    <div className="mx-auto max-w-xl space-y-4 bg-white p-8 text-[15px] shadow-sm print:shadow-none" data-testid="receipt">
      <div className="flex justify-between print:hidden"><Link href={`/bookings/${id}`} className="text-sm underline">← Về đơn</Link><PrintButton /></div>
      {br.hasLogo && <img src="/brand/logo" alt="Logo" className="mx-auto max-h-14" />}
      <div className="text-center">
        <div className="font-semibold">{br.displayName ?? sess.tenant.name}</div>
        <h1 className="mt-2 text-xl font-bold">{refund ? 'PHIẾU CHI (HOÀN TIỀN)' : d.t.title}</h1>
        <div className="text-sm text-slate-600">{fmtDateTime(p.paidAt, tz)}</div>
        {p.voidedAt && <div className="mt-1 text-sm font-semibold text-red-700">ĐÃ HỦY: {p.voidReason}</div>}
      </div>
      <table className="w-full text-sm">
        <tbody>
          <tr><td className="py-1 text-slate-500">Khách hàng</td><td>{d.b.customerName}</td></tr>
          <tr><td className="py-1 text-slate-500">Đơn thuê</td><td className="font-mono">{d.b.code}</td></tr>
          <tr><td className="py-1 text-slate-500">Nội dung</td><td>{PAYMENT_KIND_LABEL[p.kind]}</td></tr>
          <tr><td className="py-1 text-slate-500">Hình thức</td><td>{PAYMENT_METHOD_LABEL[p.method]}{p.reference ? ` · ${p.reference}` : ''}</td></tr>
          {p.note && <tr><td className="py-1 text-slate-500">Ghi chú</td><td>{p.note}</td></tr>}
          <tr className="border-t text-base"><td className="py-2 font-semibold">Số tiền</td><td className="font-semibold">{vnd(p.amount)}</td></tr>
          <tr><td className="py-1 text-slate-500">Bằng chữ</td><td>{vndInWords(p.amount)}</td></tr>
        </tbody>
      </table>
      <div className="grid grid-cols-2 gap-6 pt-6 text-center text-sm"><div>Người nộp tiền<div className="h-16" /></div><div>Người lập phiếu<div className="h-16" /></div></div>
      {d.t.footer && <p className="text-center text-sm">{d.t.footer}</p>}
      {br.footerText && <p className="border-t pt-2 text-center text-xs text-slate-500">{br.footerText}</p>}
    </div>
  );
}
