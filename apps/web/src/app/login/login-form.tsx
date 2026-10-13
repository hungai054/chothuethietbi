'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';

/**
 * Đăng nhập phía client với redirect: false rồi tự điều hướng bằng đường dẫn tương đối.
 * Auth.js dựng URL chuyển hướng từ địa chỉ nội bộ của máy chủ nên sẽ làm mất subdomain của tenant.
 */
export function LoginForm() {
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(false);
    const f = new FormData(e.currentTarget);
    const r = await signIn('credentials', { email: f.get('email'), password: f.get('password'), redirect: false });
    if (!r || r.error || !r.ok) {
      setError(true);
      setBusy(false);
      return;
    }
    window.location.assign('/');
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <input name="email" type="email" required placeholder="Email" className="w-full rounded border px-3 py-2" />
      <input name="password" type="password" required placeholder="Mật khẩu" className="w-full rounded border px-3 py-2" />
      {error && <p className="text-sm text-red-600">Email hoặc mật khẩu không đúng.</p>}
      <button disabled={busy} className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-60">Đăng nhập</button>
    </form>
  );
}
