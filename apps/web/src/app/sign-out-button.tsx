'use client';

import { signOut } from 'next-auth/react';

export function SignOutButton() {
  return (
    <button
      className="text-sm text-slate-600 underline"
      onClick={async () => {
        await signOut({ redirect: false });
        window.location.assign('/login');
      }}
    >
      Đăng xuất
    </button>
  );
}
