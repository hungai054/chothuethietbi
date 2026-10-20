import { toCsv } from '@rentpro/core';
import { exportAuditLog } from '@rentpro/db';
import { isUserError, withService } from '@/lib/service';
import { getAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

const deny = (status: number, msg: string) => new Response(msg, { status, headers: { 'cache-control': 'no-store' } });

/** Xuất nhật ký ra CSV theo đúng bộ lọc đang xem. Quyền `audit.view` + `data.export` kiểm trong service; mỗi lần xuất được ghi nhật ký. */
export async function GET(req: Request) {
  if (!(await getAppSession())) return deny(401, 'Chưa đăng nhập.');
  const p = new URL(req.url).searchParams;
  try {
    const { rows, truncated } = await withService((c) => exportAuditLog(c, {
      action: p.get('action') ?? undefined, entity: p.get('entity') ?? undefined, userId: p.get('user') ?? undefined,
      q: p.get('q') ?? undefined, from: p.get('from') ?? undefined, to: p.get('to') ?? undefined,
    }));
    const body = toCsv(['Thời gian (UTC)', 'Người thực hiện', 'Thao tác', 'Đối tượng', 'Mã đối tượng', 'Chi tiết'],
      rows.map((r) => [r.at.toISOString(), r.userName ?? 'Hệ thống', r.action, r.entity, r.entityId, r.data]));
    return new Response(body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': 'attachment; filename="nhat-ky-thao-tac.csv"', ...(truncated ? { 'x-truncated': 'true' } : {}),
      },
    });
  } catch (e) {
    if (isUserError(e)) return deny(e.name === 'ForbiddenError' ? 403 : 400, e.message);
    throw e;
  }
}
