import bwipjs from 'bwip-js/node';
import { publicPaymentInfo } from '@rentpro/db';
import { readPayToken } from '@/lib/files';
import { isUserError, withPublicTenant } from '@/lib/service';

export const dynamic = 'force-dynamic';

export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  const claims = readPayToken((await params).token);
  if (!claims) return new Response('Liên kết không hợp lệ.', { status: 403 });
  try {
    const info = await withPublicTenant((c, t) => (t.id === claims.tenantId ? publicPaymentInfo(c, claims.bookingId) : Promise.resolve(null)));
    if (!info?.qr) return new Response('Không có mã QR.', { status: 404 });
    const png = await bwipjs.toBuffer({ bcid: 'qrcode', text: info.qr.payload, scale: 5, paddingwidth: 2, paddingheight: 2 });
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store' } });
  } catch (e) {
    if (isUserError(e)) return new Response('Không tìm thấy.', { status: 404 });
    throw e;
  }
}
