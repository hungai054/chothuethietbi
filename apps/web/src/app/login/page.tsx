import { redirect } from 'next/navigation';
import { AuthError } from 'next-auth';
import { signIn } from '@/auth';
import { getTenant } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const tenant = await getTenant();
  const { error } = await searchParams;

  async function login(form: FormData) {
    'use server';
    try {
      await signIn('credentials', { email: form.get('email'), password: form.get('password'), redirectTo: '/' });
    } catch (e) {
      if (e instanceof AuthError) redirect('/login?error=1');
      throw e;
    }
  }

  if (!tenant) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="text-xl font-semibold">Không tìm thấy cửa hàng</h1>
        <p className="mt-2 text-slate-600">Địa chỉ này chưa gắn với cửa hàng nào.</p>
      </main>
    );
  }
  return (
    <main className="mx-auto mt-24 w-full max-w-sm rounded-xl bg-white p-6 shadow">
      <h1 className="text-xl font-semibold">{tenant.name}</h1>
      <p className="mb-4 text-sm text-slate-500">Đăng nhập để tiếp tục</p>
      <form action={login} className="space-y-3">
        <input name="email" type="email" required placeholder="Email" className="w-full rounded border px-3 py-2" />
        <input name="password" type="password" required placeholder="Mật khẩu" className="w-full rounded border px-3 py-2" />
        {error && <p className="text-sm text-red-600">Email hoặc mật khẩu không đúng.</p>}
        <button className="w-full rounded bg-slate-900 px-3 py-2 text-white">Đăng nhập</button>
      </form>
    </main>
  );
}
