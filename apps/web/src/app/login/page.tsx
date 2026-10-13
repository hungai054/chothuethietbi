import { getTenant } from '@/lib/tenant';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const tenant = await getTenant();
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
      <LoginForm />
    </main>
  );
}
