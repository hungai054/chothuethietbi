import { labelSheet } from '@rentpro/db';
import { DEFAULT_LABEL } from '@rentpro/core';
import { isUserError, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = new URL(req.url);
  const ids = u.searchParams.getAll('ids').filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const num = (k: string, d: number) => Number(u.searchParams.get(k)) || d;
  try {
    const html = await withService((c) => labelSheet(c, ids, {
      widthMm: num('w', DEFAULT_LABEL.widthMm), heightMm: num('h', DEFAULT_LABEL.heightMm), columns: num('cols', DEFAULT_LABEL.columns),
      showQr: u.searchParams.get('qr') !== '0',
    }));
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  } catch (e) {
    if (isUserError(e) || (e instanceof Error && /Khổ tem|Số cột/.test(e.message))) return new Response(e instanceof Error ? e.message : 'Lỗi', { status: 400 });
    throw e;
  }
}
