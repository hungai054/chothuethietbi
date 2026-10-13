import { redirect } from 'next/navigation';
import { permissionsFor } from '@rentpro/core';
import { auth, signOut } from '@/auth';
import { getTenant } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const tenant = await getTenant();
  const session = await auth();
  // Phiên của tenant khác (đổi host) không được dùng.
  if (!tenant || !session || session.user.tenantId !== tenant.id) redirect('/login');
  const perms = permissionsFor(session.user.role);
  const features = Object.entries(tenant.features).filter(([, v]) => v).map(([k]) => k);

  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{tenant.name}</h1>
        <form action={async () => { 'use server'; await signOut({ redirectTo: '/login' }); }}>
          <button className="text-sm text-slate-600 underline">Đăng xuất</button>
        </form>
      </header>
      <p className="mt-2 text-slate-600">{session.user.name} · {session.user.role} · {perms.size} quyền</p>
      <h2 className="mt-6 font-medium">Tính năng theo gói ({features.length})</h2>
      <p className="mt-1 text-sm text-slate-600">{features.join(', ')}</p>
    </main>
  );
}
