import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getTenant } from '@/lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTenant().catch(() => null);
  const b = t?.branding;
  return {
    title: b?.displayName || 'RentPro', description: 'Quản lý cho thuê thiết bị',
    ...(b?.hasFavicon ? { icons: { icon: '/brand/favicon' } } : {}),
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
