import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ValidationError, changeOwnPassword } from '@rentpro/db';
import { Field, Notice, btn, card, input } from '@/components/ui';
import { okUrl } from '@/lib/forms';
import { run, withService } from '@/lib/service';
import { getAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';
const BACK = '/account/password';

async function change(f: FormData) {
  'use server';
  await run(BACK, async () => {
    const next = String(f.get('next') ?? '');
    if (next !== String(f.get('confirm') ?? '')) throw new ValidationError('Hai ô mật khẩu mới không giống nhau.');
    // allowMustChange: trang này là nơi DUY NHẤT người bị buộc đổi mật khẩu được phép thao tác
    await withService((c) => changeOwnPassword(c, String(f.get('current') ?? ''), next), { allowMustChange: true });
    return okUrl('/', 'Đã đổi mật khẩu.');
  });
}

/** Tự đổi mật khẩu. Nằm NGOÀI nhóm (app) để người bị buộc đổi mật khẩu vào được mà không bị chuyển hướng vòng. */
export default async function ChangePasswordPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await getAppSession();
  if (!s) redirect('/login');
  if (s.support) redirect('/');
  const q = await searchParams;
  return (
    <main className="mx-auto mt-16 w-full max-w-md space-y-4 p-4">
      {!s.mustChangePassword && <Link href="/" className="text-sm underline">← Về trang chủ</Link>}
      <h1 className="text-2xl font-semibold">Đổi mật khẩu</h1>
      {s.mustChangePassword && (
        <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-900" data-testid="must-change-notice">
          Mật khẩu của bạn vừa được đặt lại hộ. Vì an toàn, hãy đặt mật khẩu riêng của bạn trước khi tiếp tục.
        </p>
      )}
      <Notice error={q.error} />
      <form action={change} className={`${card} space-y-3`} data-testid="change-password-form">
        <Field label={s.mustChangePassword ? 'Mật khẩu tạm đã được cấp' : 'Mật khẩu hiện tại'}>
          <input name="current" type="password" required autoComplete="current-password" className={input} />
        </Field>
        <Field label="Mật khẩu mới (ít nhất 10 ký tự, có chữ và số)">
          <input name="next" type="password" required minLength={10} autoComplete="new-password" className={input} />
        </Field>
        <Field label="Nhập lại mật khẩu mới">
          <input name="confirm" type="password" required minLength={10} autoComplete="new-password" className={input} />
        </Field>
        <button className={btn}>Đổi mật khẩu</button>
      </form>
    </main>
  );
}
