import Link from 'next/link';
import { listReports } from '@rentpro/db';
import { Empty, card } from '@/components/ui';
import { requireAppSession } from '@/lib/session';
import { withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

export default async function ReportsIndex() {
  await requireAppSession();
  const defs = await withService(async (c) => listReports(c).map((d) => ({ key: d.key, title: d.title, description: d.description })));
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Báo cáo</h1>
      {defs.length === 0 ? <Empty>Bạn chưa có báo cáo nào trong gói hiện tại hoặc chưa được cấp quyền xem báo cáo.</Empty> : (
        <ul className="grid gap-3 md:grid-cols-2" data-testid="report-list">
          {defs.map((d) => (
            <li key={d.key}><Link href={`/reports/${d.key}`} className={`${card} block hover:bg-slate-50`}><div className="font-medium">{d.title}</div><div className="text-sm text-slate-600">{d.description}</div></Link></li>
          ))}
        </ul>
      )}
    </div>
  );
}
