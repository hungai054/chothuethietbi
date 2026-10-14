import Link from 'next/link';
import { listTenantExtensions } from '@rentpro/db';
import { Empty, card } from '@/components/ui';
import { requireAccess } from '@/lib/session';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

/** Extension của cửa hàng (chỉ xem). Việc bật/tắt và cấu hình do nhà cung cấp làm ở cổng quản trị. */
export default async function ExtensionsSettingsPage() {
  await requireAccess('extensions', 'settings.manage');
  const list = await withService((c) => listTenantExtensions(c));
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/settings" className="text-sm underline">← Cài đặt</Link>
      <h1 className="text-2xl font-semibold">Extension</h1>
      <p className="text-sm text-slate-600">Module mở rộng riêng cho cửa hàng của bạn, do nhà cung cấp phát triển và bật. Cần thêm hoặc đổi cấu hình, hãy liên hệ nhà cung cấp.</p>
      {list.length === 0 ? <Empty>Cửa hàng chưa bật extension nào.</Empty> : (
        <ul className="space-y-3" data-testid="extension-list">
          {list.map((e) => (
            <li key={e.code} className={`${card} space-y-1 text-sm`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-base font-medium">{e.name} <span className="font-mono text-xs text-slate-500">{e.code} v{e.version}</span></span>
                {e.enabled ? <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">Đang chạy</span> : <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Chưa chạy</span>}
              </div>
              {e.description && <p className="text-slate-600">{e.description}</p>}
              <p className="text-xs text-slate-500">Can thiệp: {e.hooks.length ? e.hooks.join(', ') : 'không có móc'} · {e.reports} báo cáo · {e.pages} trang · {e.jobs} tác vụ nền</p>
              {e.skippedReason && <p className="text-xs text-red-700">{e.skippedReason}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
