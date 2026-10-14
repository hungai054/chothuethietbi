import { notFound } from 'next/navigation';
import { ReportView } from '@/components/report-view';
import { Notice } from '@/components/ui';
import { isUserError, withService } from '@/lib/service';
import { requireAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Trang riêng do extension đăng ký (registerPage): extension mô tả bằng dữ liệu, hệ thống dựng bằng bộ hiển thị chung. Quyền kiểm ở server. */
export default async function ExtensionPage({ params }: { params: Promise<{ code: string; page: string }> }) {
  const { code, page } = await params;
  await requireAppSession();
  const out = await withService(async (c) => {
    const entry = c.ext?.pages().find((p) => p.code === code && p.page.path === page);
    if (!entry) return { kind: 'missing' as const };
    if (!c.permissions.has(entry.page.permission ?? 'reports.view')) return { kind: 'forbidden' as const };
    try {
      return { kind: 'ok' as const, ...(await c.ext!.renderPage(code, page)) };
    } catch (e) {
      if (!isUserError(e)) throw e;
      return { kind: 'error' as const, message: e.message, title: entry.page.title };
    }
  });
  if (out.kind === 'missing') notFound();
  if (out.kind === 'forbidden') return <p className="rounded bg-white p-6 text-slate-600">Bạn không có quyền xem trang này.</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold" data-testid="ext-title">{out.kind === 'ok' ? out.result.title : out.title}</h1>
      {out.kind === 'error' ? <Notice error={out.message} /> : <ReportView r={out.result} />}
    </div>
  );
}
