import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getContract } from '@rentpro/db';
import { PrintButton } from '@/components/print-button';
import { vnd } from '@/lib/format';
import { requireAccess } from '@/lib/session';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

/** Hợp đồng dạng trang in: dùng "In / Lưu PDF" của trình duyệt (chọn Lưu thành PDF). Nội dung là bản đã chụp khi lập hợp đồng. */
export default async function ContractPrintPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAccess('contract', 'contract.view');
  const { id } = await params;
  const { active } = await withService((c) => getContract(c, id));
  if (!active) notFound();
  const c = active.content;
  return (
    <div className="mx-auto max-w-3xl space-y-4 bg-white p-8 text-[15px] leading-relaxed shadow-sm print:shadow-none" data-testid="contract-print">
      <div className="flex justify-between print:hidden"><Link href={`/bookings/${id}`} className="text-sm underline">← Về đơn</Link><PrintButton /></div>
      <div className="text-center">
        <div className="font-semibold">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
        <div className="text-sm">Độc lập – Tự do – Hạnh phúc</div>
        <h1 className="mt-4 text-xl font-bold">{c.title}</h1>
        <div>Số: <b>{c.number}</b> · Ngày {c.dateText}</div>
        {active.status !== 'SIGNED' && <div className="text-sm text-amber-700 print:hidden">(Bản chưa ký)</div>}
      </div>
      <section>
        <h2 className="font-semibold">Bên cho thuê (Bên A)</h2>
        <p>{c.store.name}{c.store.address && ` — ${c.store.address}`}{c.store.phone && ` — ĐT ${c.store.phone}`}{c.store.taxCode && ` — MST ${c.store.taxCode}`}{c.store.representative && ` — Đại diện: ${c.store.representative}`}</p>
      </section>
      <section>
        <h2 className="font-semibold">Bên thuê (Bên B)</h2>
        <p>
          {c.customer.type === 'COMPANY' ? `${c.customer.companyName ?? c.customer.name}${c.customer.taxCode ? ` — MST ${c.customer.taxCode}` : ''}${c.customer.representative ? ` — Đại diện: ${c.customer.representative}` : ''}` : c.customer.name}
          {` — ĐT ${c.customer.phone}`}{c.customer.address && ` — ${c.customer.address}`}{c.customer.idDocument && ` — ${c.customer.idDocument.label} ****${c.customer.idDocument.last4}`}
        </p>
      </section>
      <section>
        <h2 className="font-semibold">Thiết bị thuê (đơn {c.booking.code}: {c.booking.startText} → {c.booking.endText})</h2>
        <table className="w-full border-collapse text-sm">
          <thead><tr className="border-b text-left"><th className="py-1">Thiết bị</th><th>SL</th><th>Mã</th><th className="text-right">Thành tiền</th></tr></thead>
          <tbody>{c.items.map((i, n) => <tr key={n} className="border-b"><td className="py-1">{i.name}</td><td>{i.qty}</td><td className="font-mono text-xs">{i.units.join(', ')}</td><td className="text-right">{vnd(i.lineTotal)}</td></tr>)}</tbody>
        </table>
        <p className="mt-2">Tổng tiền thuê: <b>{vnd(c.money.rentTotal)}</b> (bằng chữ: {c.money.rentWords}).</p>
        {c.money.depositRequired > 0 && <p>Tiền đặt cọc: <b>{vnd(c.money.depositRequired)}</b> (bằng chữ: {c.money.depositWords}).</p>}
      </section>
      <section>
        <h2 className="font-semibold">Điều khoản</h2>
        <ol className="list-decimal space-y-1 pl-5">{c.terms.map((t, n) => <li key={n}>{t}</li>)}</ol>
      </section>
      <section className="grid grid-cols-2 gap-6 pt-6 text-center">
        <div>
          <div className="font-semibold">BÊN B (Bên thuê)</div>
          <div className="text-xs text-slate-500">(Ký, ghi rõ họ tên)</div>
          
          {active.hasCustomerSignature ? <img src={`/media/signature/${active.id}/customer`} alt="Chữ ký khách" className="mx-auto mt-2 h-24" /> : <div className="h-24" />}
          <div>{active.signedCustomerName ?? ''}</div>
        </div>
        <div>
          <div className="font-semibold">BÊN A (Bên cho thuê)</div>
          <div className="text-xs text-slate-500">(Ký, ghi rõ họ tên)</div>
          
          {active.hasStaffSignature ? <img src={`/media/signature/${active.id}/staff`} alt="Chữ ký nhân viên" className="mx-auto mt-2 h-24" /> : <div className="h-24" />}
        </div>
      </section>
    </div>
  );
}
