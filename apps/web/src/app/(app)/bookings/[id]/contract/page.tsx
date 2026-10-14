import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getContract } from '@rentpro/db';
import { ContractDocument } from '@/components/contract-document';
import { PrintButton } from '@/components/print-button';
import { requireAccess } from '@/lib/session';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

/** Hợp đồng dạng trang in: dùng "In / Lưu PDF" của trình duyệt (chọn Lưu thành PDF). Nội dung là bản đã chụp khi lập hợp đồng. */
export default async function ContractPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const sess = await requireAccess('contract', 'contract.view');
  const { id } = await params;
  const { active } = await withService((c) => getContract(c, id));
  if (!active) notFound();
  const b = sess.tenant.branding;
  return (
    <div className="mx-auto max-w-3xl space-y-4 bg-white p-8 text-[15px] leading-relaxed shadow-sm print:shadow-none" data-testid="contract-print">
      <div className="flex justify-between print:hidden"><Link href={`/bookings/${id}`} className="text-sm underline">← Về đơn</Link><PrintButton /></div>
      {b.hasLogo && <img src="/brand/logo" alt="Logo" className="mx-auto max-h-16" />}
      {active.status !== 'SIGNED' && <div className="text-center text-sm text-amber-700 print:hidden">(Bản chưa ký)</div>}
      <ContractDocument
        c={active.content}
        sig={{ customer: active.hasCustomerSignature ? `/media/signature/${active.id}/customer` : undefined, staff: active.hasStaffSignature ? `/media/signature/${active.id}/staff` : undefined, customerName: active.signedCustomerName }}
      />
      {b.footerText && <p className="border-t pt-2 text-center text-xs text-slate-500">{b.footerText}</p>}
    </div>
  );
}
