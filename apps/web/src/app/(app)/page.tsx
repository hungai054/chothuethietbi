import { requireAppSession } from '@/lib/session';
import { withService } from '@/lib/service';
import { equipmentUsage } from '@rentpro/db';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const { tenant, user, permissions } = await requireAppSession();
  const usage = tenant.features.inventory ? await withService((c) => equipmentUsage(c)) : null;
  const features = Object.entries(tenant.features).filter(([, v]) => v).map(([k]) => k);
  return (
    <div>
      <h1 className="text-2xl font-semibold">{tenant.name}</h1>
      <p className="mt-2 text-slate-600">{user.name} · {user.role} · {permissions.size} quyền</p>
      {usage && (
        <p className={`mt-4 rounded p-3 text-sm ${usage.near ? 'bg-amber-50 text-amber-900' : 'bg-white'}`}>
          Thiết bị: {usage.used}{usage.limit !== null ? ` / ${usage.limit}` : ''}
          {usage.near && ' — sắp đạt hạn mức gói, hãy cân nhắc nâng cấp.'}
        </p>
      )}
      <h2 className="mt-6 font-medium">Tính năng theo gói ({features.length})</h2>
      <p className="mt-1 text-sm text-slate-600">{features.join(', ')}</p>
    </div>
  );
}
