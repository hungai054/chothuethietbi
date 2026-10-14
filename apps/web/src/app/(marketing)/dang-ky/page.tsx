import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PlatformError, listSignupPlans, requestSignup } from '@rentpro/db';
import { Notice } from '@/components/ui';
import { vnd } from '@/lib/format';
import { pool } from '@/lib/db';
import { clientIp, originOf, requireMarketingHost, throttled } from '@/lib/marketing';
import { platformPool } from '@/lib/platform';
import { SignupForm } from './signup-form';

export const dynamic = 'force-dynamic';

async function signup(f: FormData) {
  'use server';
  await requireMarketingHost();
  const back = (msg: string) => redirect(`/dang-ky?error=${encodeURIComponent(msg)}&plan=${encodeURIComponent(String(f.get('plan') ?? ''))}`);
  // Ô ẩn dành cho bot: người thật không thấy nên không điền
  if (String(f.get('website') ?? '')) redirect('/dang-ky/da-gui');
  if (throttled(`signup:${await clientIp()}`, 8, 10 * 60_000)) back('Bạn thao tác quá nhanh. Vui lòng thử lại sau vài phút.');
  const origin = await originOf();
  const email = String(f.get('email') ?? '');
  try {
    await requestSignup(platformPool(), {
      email, ownerName: String(f.get('ownerName') ?? ''), shopName: String(f.get('shopName') ?? ''), slug: String(f.get('slug') ?? '').trim().toLowerCase(),
      password: String(f.get('password') ?? ''), planCode: String(f.get('plan') ?? ''),
    }, { verifyUrl: (token) => `${origin}/dang-ky/xac-thuc?token=${token}` });
  } catch (e) {
    if (e instanceof PlatformError) back(e.message);
    throw e;
  }
  redirect(`/dang-ky/da-gui?email=${encodeURIComponent(email.trim().toLowerCase())}`);
}

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string; plan?: string }> }) {
  await requireMarketingHost();
  const q = await searchParams;
  const plans = await listSignupPlans(pool());
  const selected = plans.find((p) => p.code === q.plan)?.code ?? plans[0]?.code ?? '';
  return (
    <main className="mx-auto max-w-lg space-y-4 p-6">
      <Link href="/" className="text-sm underline">← RentPro</Link>
      <h1 className="text-2xl font-semibold">Tạo cửa hàng và dùng thử miễn phí</h1>
      <p className="text-sm text-slate-600">Không cần thẻ. Chúng tôi sẽ gửi email xác nhận để bạn bắt đầu.</p>
      <Notice error={q.error} />
      <SignupForm action={signup} plans={plans.map((p) => ({ code: p.code, label: `${p.name} — ${vnd(p.priceMonth)}/tháng` }))} selected={selected} />
    </main>
  );
}
