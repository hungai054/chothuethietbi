import { getAssetPhoto, getContractSignature, getHandoverPhoto } from '@rentpro/db';
import { isUserError, withService } from '@/lib/service';
import { getAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

const deny = (status: number) => new Response(status === 404 ? 'Không tìm thấy.' : 'Không có quyền truy cập.', { status, headers: { 'cache-control': 'no-store' } });

/** Ảnh riêng tư của cửa hàng (tài sản thế chấp, biên bản giao/nhận, chữ ký). Quyền và tenant kiểm tra trong service; chỉ phục vụ cho người đã đăng nhập đúng cửa hàng. */
export async function GET(_: Request, { params }: { params: Promise<{ kind: string; id: string; n: string }> }) {
  const { kind, id, n } = await params;
  if (!(await getAppSession())) return deny(403);
  try {
    const f = await withService((c) => {
      if (kind === 'asset') return getAssetPhoto(c, id, Number(n) || 0);
      if (kind === 'handover') return getHandoverPhoto(c, id, Number(n) || 0);
      if (kind === 'signature' && (n === 'customer' || n === 'staff')) return getContractSignature(c, id, n);
      throw Object.assign(new Error('x'), { name: 'NotFoundError' });
    });
    return new Response(Buffer.from(f.data), {
      headers: {
        'content-type': f.contentType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': 'inline', 'content-security-policy': "default-src 'none'; sandbox", 'referrer-policy': 'no-referrer',
      },
    });
  } catch (e) {
    if (isUserError(e)) return deny(e.name === 'NotFoundError' ? 404 : 403);
    if (e instanceof Error && e.name === 'NotFoundError') return deny(404);
    throw e;
  }
}
