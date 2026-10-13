import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'RentPro', description: 'Quản lý cho thuê thiết bị' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
