import bwipjs from 'bwip-js/node';
import { getMyInvoice } from '@rentpro/db';
import { billingProviders } from '@/lib/platform';
import { isUserError, withService } from '@/lib/service';
import { getAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Mã QR chuyển khoản của một hóa đơn: chỉ người có quyền thanh toán của đúng cửa hàng mới lấy được. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getAppSession();
  if (!s || !s.permissions.has('billing.manage')) return new Response('Không có quyền.', { status: 403 });
  const { vietqr } = billingProviders();
  if (!vietqr) return new Response('Chưa cấu hình tài khoản nhận tiền.', { status: 404 });
  const { id } = await params;
  try {
    const inv = await withService((c) => getMyInvoice(c, id));
    if (!inv || inv.status !== 'OPEN') return new Response('Không có mã QR.', { status: 404 });
    const pay = await vietqr.createPayment({ orderCode: 1, amount: inv.amount, description: inv.payCode, returnUrl: '', cancelUrl: '' });
    const png = await bwipjs.toBuffer({ bcid: 'qrcode', text: pay.qrPayload!, scale: 5, paddingwidth: 2, paddingheight: 2 });
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store' } });
  } catch (e) {
    if (isUserError(e)) return new Response('Không tìm thấy.', { status: 404 });
    throw e;
  }
}
