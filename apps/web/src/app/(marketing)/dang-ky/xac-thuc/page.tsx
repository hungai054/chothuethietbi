import Link from 'next/link';
import { PlatformError, completeSignup } from '@rentpro/db';
import { requireMarketingHost, shopUrl } from '@/lib/marketing';
import { platformPool } from '@/lib/platform';

export const dynamic = 'force-dynamic';

/** Bấm liên kết trong thư: tạo cửa hàng (idempotent) rồi dẫn tới trang đăng nhập của cửa hàng. */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  await requireMarketingHost();
  const { token } = await searchParams;
  let result: { slug: string; already: boolean } | null = null;
  let error: string | null = null;
  try {
    if (!token) throw new PlatformError('Liên kết xác thực không hợp lệ.');
    result = await completeSignup(platformPool(), token);
  } catch (e) {
    if (e instanceof PlatformError) error = e.message;
    else throw e;
  }
  if (!result) {
    return (
      <main className="mx-auto max-w-lg space-y-3 p-6" data-testid="verify-error">
        <h1 className="text-2xl font-semibold">Không xác nhận được</h1>
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>
        <Link href="/dang-ky" className="underline">Đăng ký lại</Link>
      </main>
    );
  }
  const url = await shopUrl(result.slug);
  return (
    <main className="mx-auto max-w-lg space-y-3 p-6" data-testid="verify-ok">
      <h1 className="text-2xl font-semibold">{result.already ? 'Cửa hàng đã được tạo' : 'Đã tạo cửa hàng của bạn'}</h1>
      <p className="text-slate-600">Đăng nhập bằng email và mật khẩu bạn đã đặt, rồi làm theo hướng dẫn khởi tạo (nạp danh mục theo ngành, nhập thiết bị từ Excel, mời nhân viên).</p>
      <a href={`${url}/login`} className="inline-block rounded bg-slate-900 px-5 py-2 text-white" data-testid="go-login">Đăng nhập vào cửa hàng</a>
      <p className="text-xs text-slate-500">Địa chỉ cửa hàng: {url}</p>
    </main>
  );
}
