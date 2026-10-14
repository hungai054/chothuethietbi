import { publicPaymentInfo } from '@rentpro/db';
import { isUserError, withPublicTenant } from '@/lib/service';
import { readPayToken } from '@/lib/files';
import { vnd } from '@/lib/format';

export const dynamic = 'force-dynamic';

const Shell = ({ children }: { children: React.ReactNode }) => (
  <main className="mx-auto max-w-md p-6"><div className="rounded-lg bg-white p-6 text-center shadow-sm">{children}</div></main>
);

/** Trang thanh toán công khai cho khách: chỉ hiện mã đơn, số tiền còn nợ và QR chuyển khoản. */
export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const claims = readPayToken((await params).token);
  if (!claims) return <Shell><h1 className="text-lg font-semibold">Liên kết không hợp lệ hoặc đã hết hạn</h1><p className="mt-2 text-sm text-slate-600">Vui lòng liên hệ cửa hàng để nhận liên kết mới.</p></Shell>;
  let info;
  try {
    info = await withPublicTenant((c, t) => (t.id === claims.tenantId ? publicPaymentInfo(c, claims.bookingId) : Promise.resolve(null)));
  } catch (e) {
    if (!isUserError(e)) throw e;
    info = null;
  }
  if (!info) return <Shell><h1 className="text-lg font-semibold">Không tìm thấy đơn</h1><p className="mt-2 text-sm text-slate-600">Liên kết không còn hiệu lực. Vui lòng liên hệ cửa hàng.</p></Shell>;
  return (
    <Shell>
      <p className="text-sm text-slate-500">{info.storeName}</p>
      <h1 className="mt-1 text-lg font-semibold">Thanh toán đơn {info.code}</h1>
      {info.settled || info.balanceOwed === 0 ? (
        <p className="mt-4 rounded bg-green-50 p-3 text-green-700" data-testid="pay-settled">Đơn này không còn khoản nào cần thanh toán. Cảm ơn bạn!</p>
      ) : (
        <>
          <p className="mt-3 text-2xl font-bold" data-testid="pay-amount">{vnd(info.balanceOwed)}</p>
          {info.qr ? (
            <>
              
              <img src={`/pay/${(await params).token}/qr`} alt="Mã QR chuyển khoản" width={240} height={240} className="mx-auto mt-4 rounded border" />
              <p className="mt-3 text-sm text-slate-600">Quét bằng ứng dụng ngân hàng.<br />Tài khoản nhận: {info.qr.bankLabel}<br />Nội dung chuyển khoản: <b>{info.qr.memo}</b></p>
            </>
          ) : <p className="mt-4 text-sm text-slate-600">Cửa hàng chưa bật thanh toán QR. Vui lòng liên hệ cửa hàng để thanh toán.</p>}
        </>
      )}
    </Shell>
  );
}
