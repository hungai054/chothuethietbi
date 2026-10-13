import { redirect } from 'next/navigation';
import { confirmTotp, recordTotpStep, storeTotpSecret } from '@rentpro/db';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '@rentpro/core';
import { db, getPendingUser, loginAllowed, recordLoginFailure, startSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function verify(form: FormData) {
  'use server';
  const user = await getPendingUser();
  if (!user) redirect('/login');
  const key = `totp|${user.id}`;
  if (!loginAllowed(key)) redirect('/login/totp?error=locked');
  const code = String(form.get('code') ?? '').replace(/\s/g, '');
  if (!user.totp_secret) redirect('/login/totp');
  const last = user.totp_last_step === null ? undefined : Number(user.totp_last_step);
  const step = verifyTotp(user.totp_secret, code, Date.now(), 1, last);
  if (step === null) {
    recordLoginFailure(key);
    redirect('/login/totp?error=bad');
  }
  if (user.totp_enabled) await recordTotpStep(db(), user.id, step);
  else await confirmTotp(db(), user.id, step); // lần đầu: xác nhận đã quét mã thành công
  await startSession(user.id);
  redirect('/');
}

export default async function TotpPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await getPendingUser();
  if (!user) redirect('/login');
  const { error } = await searchParams;

  // Chưa bật 2FA: bắt buộc đăng ký. Tạo khóa nếu chưa có (và giữ nguyên khi tải lại trang).
  let enroll: string | null = null;
  if (!user.totp_enabled) {
    const secret = user.totp_secret ?? generateTotpSecret();
    if (!user.totp_secret) await storeTotpSecret(db(), user.id, secret);
    enroll = secret;
  }

  return (
    <main className="mx-auto mt-24 w-full max-w-sm rounded-xl bg-white p-6 shadow">
      <h1 className="text-xl font-semibold">Xác thực 2 lớp</h1>
      {enroll ? (
        <div className="mb-4 mt-2 space-y-2 text-sm text-slate-600">
          <p>Tài khoản này chưa bật xác thực 2 lớp (bắt buộc). Thêm khóa vào ứng dụng xác thực (Google Authenticator, Authy…) rồi nhập mã 6 số.</p>
          <p>Khóa: <code className="break-all rounded bg-slate-100 px-1">{enroll}</code></p>
          <p className="break-all text-xs">Hoặc mở: <code>{otpauthUrl(enroll, user.email, 'RentPro Admin')}</code></p>
        </div>
      ) : (
        <p className="mb-4 mt-2 text-sm text-slate-500">Nhập mã 6 số từ ứng dụng xác thực.</p>
      )}
      <form action={verify} className="space-y-3">
        <input name="code" inputMode="numeric" autoComplete="one-time-code" required maxLength={7} placeholder="123456" className="w-full rounded border px-3 py-2 tracking-widest" />
        {error === 'bad' && <p className="text-sm text-red-600">Mã không đúng hoặc đã được dùng.</p>}
        {error === 'locked' && <p className="text-sm text-red-600">Quá nhiều lần thử sai. Vui lòng thử lại sau.</p>}
        <button className="w-full rounded bg-slate-900 px-3 py-2 text-white">Xác nhận</button>
      </form>
    </main>
  );
}
