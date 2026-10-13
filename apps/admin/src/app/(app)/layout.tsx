import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { endSession, requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div>
      <header className="flex items-center justify-between bg-slate-900 px-6 py-3 text-white">
        <nav className="flex gap-6 text-sm">
          <Link href="/" className="font-semibold">RentPro Admin</Link>
          <Link href="/tenants/new">Tạo khách hàng</Link>
        </nav>
        <form action={async () => { 'use server'; await endSession(); redirect('/login'); }} className="text-sm">
          <span className="mr-3 text-slate-300">{user.email} · {user.role}</span>
          <button className="underline">Đăng xuất</button>
        </form>
      </header>
      <div className="mx-auto max-w-6xl p-6">{children}</div>
    </div>
  );
}
