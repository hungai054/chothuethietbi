import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { attachPayment, getMyInvoice, nextOrderCode } from '@rentpro/db';
import { BANKS } from '@rentpro/core';
import { Notice, btn, card } from '@/components/ui';
import { fmtDate, vnd } from '@/lib/format';
import { billingProviders, platformPool } from '@/lib/platform';
import { run, withService } from '@/lib/service';
import { requirePermission } from '@/lib/session';
import { hostOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

async function startPayos(id: string) {
  'use server';
  const back = `/settings/subscription/pay/${id}`;
  await run(back, async () => {
    await requirePermission('billing.manage');
    const inv = await withService((c) => getMyInvoice(c, id));
    if (!inv || inv.status !== 'OPEN') return back;
    const { payos } = billingProviders();
    if (!payos) return `${back}?error=${encodeURIComponent('Cổng PayOS chưa được cấu hình.')}`;
    const h = await headers();
    const host = hostOf(h);
    const proto = h.get('x-forwarded-proto')?.split(',')[0] ?? (host.startsWith('localhost') || host.includes('.localhost') ? 'http' : 'https');
    const url = `${proto}://${host}${back}`;
    const orderCode = await nextOrderCode(platformPool(), id);
    const s = await payos.createPayment({ orderCode, amount: inv.amount, description: inv.payCode, returnUrl: url, cancelUrl: url });
    await attachPayment(platformPool(), id, { provider: 'PAYOS', providerRef: s.providerRef, checkoutUrl: s.checkoutUrl });
    redirect(s.checkoutUrl!);
  });
}

export default async function PayInvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  await requirePermission('billing.manage');
  const { id } = await params;
  const q = await searchParams;
  const inv = await withService((c) => getMyInvoice(c, id));
  if (!inv) notFound();
  const { payos, vietqr, account } = billingProviders();
  const bank = account ? BANKS.find((b) => b.bin === account.bin)?.name ?? account.bin : null;
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Link href="/settings/subscription" className="text-sm underline">← Gói dịch vụ</Link>
      <h1 className="text-2xl font-semibold">Hóa đơn {inv.number}</h1>
      <Notice error={q.error} />
      <div className={`${card} space-y-2 text-sm`} data-testid="invoice-detail">
        <p>Gói <b>{inv.planName}</b>{inv.kind === 'UPGRADE' ? ' (nâng cấp giữa kỳ)' : ''} · {fmtDate(inv.periodStart, 'Asia/Ho_Chi_Minh')} – {fmtDate(inv.periodEnd, 'Asia/Ho_Chi_Minh')}</p>
        {inv.discount > 0 && <p>Đã giảm: {vnd(inv.discount)}</p>}
        <p className="text-lg">Số tiền: <b data-testid="invoice-amount">{vnd(inv.amount)}</b></p>
        {inv.status === 'PAID' && <p role="status" className="rounded bg-green-50 p-3 text-green-700" data-testid="invoice-paid">Đã thanh toán{inv.paidAt ? ` lúc ${new Date(inv.paidAt).toLocaleString('vi-VN')}` : ''}. Cảm ơn bạn!</p>}
        {inv.status === 'VOID' && <p className="rounded bg-slate-100 p-3 text-slate-600">Hóa đơn này đã bị hủy.</p>}
      </div>
      {inv.status === 'OPEN' && (
        <>
          {payos && (
            <form action={startPayos.bind(null, id)} className={`${card} space-y-2`}>
              <p className="text-sm text-slate-600">Thanh toán trực tuyến qua PayOS (QR hoặc thẻ nội địa). Gói được kích hoạt tự động ngay khi nhận tiền.</p>
              <button className={btn} data-testid="pay-payos">Thanh toán qua PayOS</button>
            </form>
          )}
          {vietqr && account ? (
            <div className={`${card} space-y-2 text-sm`} data-testid="pay-vietqr">
              <p className="font-medium">Chuyển khoản (VietQR)</p>
              <img src={`/settings/subscription/pay/${id}/qr`} alt="Mã QR chuyển khoản" width={240} height={240} className="mx-auto rounded border" />
              <p>Ngân hàng: <b>{bank}</b><br />Số tài khoản: <b>{account.account}</b>{account.accountName && <> · {account.accountName}</>}<br />Số tiền: <b>{vnd(inv.amount)}</b><br />Nội dung chuyển khoản: <b data-testid="pay-code">{inv.payCode}</b></p>
              <p className="text-slate-500">Vui lòng nhập ĐÚNG nội dung chuyển khoản. Bộ phận quản trị xác nhận trong giờ làm việc và gói sẽ được kích hoạt; bạn sẽ nhận email xác nhận.</p>
            </div>
          ) : !payos && <p className={`${card} text-sm text-slate-600`}>Hệ thống chưa bật cổng thanh toán trực tuyến. Vui lòng liên hệ nhà cung cấp, nêu mã hóa đơn <b>{inv.number}</b>, để được hướng dẫn thanh toán.</p>}
        </>
      )}
    </div>
  );
}
