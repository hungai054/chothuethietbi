import { redirect } from 'next/navigation';
import { createTenant, listPlans, PlatformError } from '@rentpro/db';
import { actorOf, db, requireCan, setFlash } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function create(form: FormData) {
  'use server';
  const user = await requireCan('tenant.create');
  try {
    const r = await createTenant(db(), actorOf(user), {
      slug: String(form.get('slug')).trim().toLowerCase(),
      name: String(form.get('name')).trim(),
      planCode: String(form.get('plan')),
      ownerEmail: String(form.get('ownerEmail')).trim(),
      ownerName: String(form.get('ownerName')).trim(),
    });
    await setFlash({ tempPassword: r.tempPassword, email: String(form.get('ownerEmail')).trim() });
    redirect(`/tenants/${r.tenantId}?created=1`);
  } catch (e) {
    if (e instanceof PlatformError) redirect(`/tenants/new?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
}

export default async function NewTenant({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireCan('tenant.create');
  const [{ error }, plans] = await Promise.all([searchParams, listPlans(db())]);
  const input = 'w-full rounded border px-3 py-2';
  return (
    <form action={create} className="max-w-lg space-y-3 rounded-lg bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold">Tạo khách hàng</h1>
      <input name="name" required placeholder="Tên cửa hàng" className={input} />
      <input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,40}" placeholder="slug (tên miền con)" className={input} />
      <select name="plan" className={input}>{plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
      <input name="ownerName" required placeholder="Tên chủ cửa hàng" className={input} />
      <input name="ownerEmail" type="email" required placeholder="Email chủ cửa hàng" className={input} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="rounded bg-slate-900 px-4 py-2 text-white">Tạo</button>
    </form>
  );
}
