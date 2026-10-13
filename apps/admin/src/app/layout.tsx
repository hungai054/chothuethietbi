import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'RentPro Admin', description: 'Cổng quản trị hệ thống' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body className="min-h-screen bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
