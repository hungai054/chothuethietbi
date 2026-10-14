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
  const b = tenant.branding;
  return (
    <main className="mx-auto mt-24 w-full max-w-sm rounded-xl bg-white p-6 shadow" style={b.displayName || b.hasLogo ? { borderTop: `4px solid ${b.primaryColor}` } : undefined}>
      {b.hasLogo && <img src="/brand/logo" alt={`Logo ${b.displayName ?? tenant.name}`} className="mb-3 max-h-16" />}
      <h1 className="text-xl font-semibold" data-testid="login-title">{b.displayName ?? tenant.name}</h1>
      <p className="mb-4 text-sm text-slate-500">Đăng nhập để tiếp tục</p>
      <LoginForm />
      {!b.hideProductBrand && <p className="mt-4 text-center text-xs text-slate-400">Cung cấp bởi RentPro</p>}
    </main>
  );
}
