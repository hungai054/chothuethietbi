import { getIdImage } from '@rentpro/db';
import { readIdImageToken } from '@/lib/files';
import { isUserError, withService } from '@/lib/service';
import { getAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

const deny = (status: number) => new Response(status === 404 ? 'Không tìm thấy.' : 'Không có quyền truy cập.', { status, headers: { 'cache-control': 'no-store' } });

export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  const claims = readIdImageToken((await params).token);
  if (!claims) return deny(403); // sai chữ ký hoặc hết hạn
  const s = await getAppSession();
  // Token chỉ dùng được trong đúng cửa hàng và đúng phiên đăng nhập của cửa hàng đó
  if (!s || s.tenant.id !== claims.tenantId) return deny(403);
  try {
    const f = await withService((c) => getIdImage(c, claims.documentId, claims.side));
    return new Response(Buffer.from(f.data), {
      headers: {
        'content-type': f.contentType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': 'inline', 'content-security-policy': "default-src 'none'; sandbox", 'referrer-policy': 'no-referrer',
      },
    });
  } catch (e) {
    if (isUserError(e)) return deny(e.name === 'NotFoundError' ? 404 : 403);
    throw e;
  }
}
