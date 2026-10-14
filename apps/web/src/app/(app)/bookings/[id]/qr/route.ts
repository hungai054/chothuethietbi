import bwipjs from 'bwip-js/node';
import { vietQrFor } from '@rentpro/db';
import { isUserError, withService } from '@/lib/service';
import { getAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Ảnh QR chuyển khoản (VietQR) cho đơn: ?amount=… để nhúng sẵn số tiền. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAppSession())) return new Response('Không có quyền truy cập.', { status: 403 });
  const raw = new URL(req.url).searchParams.get('amount');
  const amount = raw && /^\d{1,12}$/.test(raw) ? Number(raw) : null;
  const { id } = await params;
  try {
    const q = await withService((c) => vietQrFor(c, id, amount));
    const png = await bwipjs.toBuffer({ bcid: 'qrcode', text: q.payload, scale: 5, paddingwidth: 2, paddingheight: 2 });
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store', 'x-memo': encodeURIComponent(q.memo) } });
  } catch (e) {
    if (isUserError(e)) return new Response(e.message, { status: 400, headers: { 'cache-control': 'no-store' } });
    throw e;
  }
}
