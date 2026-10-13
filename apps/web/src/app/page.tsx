import { signOut } from '@/auth';
import { requireAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const { tenant, user, permissions, support } = await requireAppSession();
  const features = Object.entries(tenant.features).filter(([, v]) => v).map(([k]) => k);

  return (
    <>
      {support && (
        <div role="alert" className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-black">
          Phiên hỗ trợ của {support.by} — hết hạn lúc {support.expiresAt.toLocaleTimeString('vi-VN')}. Mọi thao tác đều được ghi nhật ký.
        </div>
      )}
      <main className="mx-auto max-w-3xl p-8">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{tenant.name}</h1>
          <form action={async () => { 'use server'; await signOut({ redirectTo: '/login' }); }}>
            <button className="text-sm text-slate-600 underline">Đăng xuất</button>
          </form>
        </header>
        <p className="mt-2 text-slate-600">{user.name} · {user.role} · {permissions.size} quyền</p>
        <h2 className="mt-6 font-medium">Tính năng theo gói ({features.length})</h2>
        <p className="mt-1 text-sm text-slate-600">{features.join(', ')}</p>
      </main>
    </>
  );
}
