import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { findPlatformUser } from '@rentpro/db';
import { verifyPassword, hashPassword } from '@rentpro/core';
import { clearLoginFailures, db, loginAllowed, recordLoginFailure, setPending } from '@/lib/session';

export const dynamic = 'force-dynamic';
const dummy = hashPassword('khong-ton-tai-0000');

async function login(form: FormData) {
  'use server';
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0] ?? 'local';
  const key = `${email}|${ip}`;
  if (!loginAllowed(key)) redirect('/login?error=locked');
  const user = await findPlatformUser(db(), email);
  const ok = await verifyPassword(user?.password_hash ?? (await dummy), String(form.get('password') ?? ''));
  if (!user || !user.active || !ok) {
    recordLoginFailure(key);
    redirect('/login?error=bad');
  }
  clearLoginFailures(key);
  await setPending(user.id);
  redirect('/login/totp');
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto mt-24 w-full max-w-sm rounded-xl bg-white p-6 shadow">
      <h1 className="text-xl font-semibold">RentPro Admin</h1>
      <p className="mb-4 text-sm text-slate-500">Đăng nhập quản trị hệ thống</p>
      <form action={login} className="space-y-3">
        <input name="email" type="email" required placeholder="Email" className="w-full rounded border px-3 py-2" />
        <input name="password" type="password" required placeholder="Mật khẩu" className="w-full rounded border px-3 py-2" />
        {error === 'bad' && <p className="text-sm text-red-600">Email hoặc mật khẩu không đúng.</p>}
        {error === 'locked' && <p className="text-sm text-red-600">Quá nhiều lần thử sai. Vui lòng thử lại sau 15 phút.</p>}
        <button className="w-full rounded bg-slate-900 px-3 py-2 text-white">Tiếp tục</button>
      </form>
    </main>
  );
}
