import { requireMarketingHost } from '@/lib/marketing';

export const dynamic = 'force-dynamic';

export default async function SignupSent({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  await requireMarketingHost();
  const { email } = await searchParams;
  return (
    <main className="mx-auto max-w-lg space-y-3 p-6" data-testid="signup-sent">
      <h1 className="text-2xl font-semibold">Kiểm tra email của bạn</h1>
      <p className="text-slate-600">Chúng tôi đã gửi liên kết xác nhận{email ? <> tới <b>{email}</b></> : ''}. Bấm vào liên kết (có hiệu lực 24 giờ) để tạo cửa hàng. Không thấy thư? Kiểm tra mục thư rác hoặc đăng ký lại.</p>
    </main>
  );
}
