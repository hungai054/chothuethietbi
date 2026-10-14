import { isGroupBy } from '@rentpro/core';
import { exportReportXlsx } from '@rentpro/db';
import { isUserError, withService } from '@/lib/service';
import { getAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Tải báo cáo .xlsx. Bộ lọc lấy từ query giống trang báo cáo. */
export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  if (!(await getAppSession())) return new Response('Chưa đăng nhập.', { status: 401 });
  const { key } = await params;
  const u = new URL(req.url).searchParams;
  const gb = u.get('groupBy');
  try {
    const f = await withService((c) => exportReportXlsx(c, key, { from: u.get('from') || undefined, to: u.get('to') || undefined, branchId: u.get('branchId') || null, categoryId: u.get('categoryId') || null, groupBy: isGroupBy(gb) ? gb : undefined }));
    return new Response(new Uint8Array(f.data), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${f.filename}"`,
        'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
      },
    });
  } catch (e) {
    if (isUserError(e)) return new Response(e.message, { status: e.name === 'ForbiddenError' || e.name === 'FeatureDisabledError' ? 403 : 400, headers: { 'cache-control': 'no-store' } });
    throw e;
  }
}
