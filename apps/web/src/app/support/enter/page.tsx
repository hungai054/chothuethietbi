'use client';

import { useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';

/** Token nằm trong URL fragment (#token=...) nên không bao giờ đến máy chủ/log; đọc ở client rồi đổi lấy phiên. */
export default function SupportEnter() {
  const [error, setError] = useState(false);
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    history.replaceState(null, '', window.location.pathname);
    if (!token) return setError(true);
    signIn('support', { token, redirect: false }).then((r) => {
      if (r?.error || !r?.ok) setError(true);
      else window.location.replace('/');
    });
  }, []);
  return (
    <main className="mx-auto max-w-md p-8">
      {error ? <p className="text-red-600">Liên kết hỗ trợ không hợp lệ hoặc đã hết hạn.</p> : <p>Đang mở phiên hỗ trợ…</p>}
    </main>
  );
}
