import { globalSearch } from '@rentpro/db';
import { isUserError, withService } from '@/lib/service';
import { getAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** Tìm nhanh cho Ctrl+K. Chỉ cho người đã đăng nhập; quyền và gói kiểm trong service (nhóm không đủ quyền trả rỗng). */
export async function GET(req: Request) {
  if (!(await getAppSession())) return json({ error: 'Chưa đăng nhập.' }, 401);
  try {
    const q = new URL(req.url).searchParams.get('q') ?? '';
    return json(await withService((c) => globalSearch(c, q)));
  } catch (e) {
    if (isUserError(e)) return json({ error: e.message }, 400);
    throw e;
  }
}
