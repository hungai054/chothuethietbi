import Link from 'next/link';
import type { ReactNode } from 'react';
import { listInbox } from '@rentpro/db';
import { requireAppSession } from '@/lib/session';
import { withService } from '@/lib/service';
import { SignOutButton } from '../sign-out-button';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { tenant, user, permissions, support } = await requireAppSession();
  const unread = await withService((c) => listInbox(c, 50)).then((r) => r.unread).catch(() => 0);
  const L = tenant.labels;
  const b = tenant.branding;
  const f = tenant.features;
  const links = [
    { href: '/', label: 'Tổng quan', show: true },
    { href: '/inventory', label: L.unit, show: f.inventory && permissions.has('inventory.view') },
    { href: '/inventory/models', label: L.model, show: f.inventory && permissions.has('inventory.view') },
    { href: '/bookings', label: L.booking, show: f.booking && permissions.has('booking.view') },
    { href: '/bookings/timeline', label: L.timeline, show: f['booking.timeline'] && permissions.has('booking.view') },
    { href: '/reports', label: L.reports, show: f['reports.basic'] && permissions.has('reports.view') },
    { href: '/maintenance', label: L.maintenance, show: f.maintenance && permissions.has('maintenance.view') },
    { href: '/deposits', label: `Sổ ${L.deposit.toLowerCase().replace(/^tiền /, '')}`, show: f.deposit && permissions.has('deposit.view') },
    { href: '/notifications', label: 'Tin nhắn', show: f['notify.email'] && permissions.has('notification.view') },
    { href: '/customers', label: L.customer, show: f.customers && permissions.has('customer.view') },
    { href: '/pricing', label: L.pricing, show: f.pricing && permissions.has('pricing.view') },
    { href: '/inventory/scan', label: 'Quét mã', show: f['inventory.barcode'] && permissions.has('inventory.view') },
    { href: '/inventory/stocktake', label: 'Kiểm kê', show: f['inventory.stocktake'] && permissions.has('inventory.stocktake') },
    { href: '/settings', label: 'Cài đặt', show: permissions.has('settings.manage') || permissions.has('users.manage') },
  ].filter((l) => l.show);
  const readOnly = tenant.status === 'READ_ONLY' || tenant.status === 'SUSPENDED';
  const shown = b.displayName ?? tenant.name;
  return (
    <>
      {support && (
        <div role="alert" className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-black">
          Phiên hỗ trợ của {support.by} — hết hạn lúc {support.expiresAt.toLocaleTimeString('vi-VN')}. Mọi thao tác đều được ghi nhật ký.
        </div>
      )}
      {readOnly && <div role="status" className="bg-red-100 px-4 py-2 text-center text-sm text-red-900">Tài khoản đang ở chế độ chỉ đọc: bạn xem và xuất dữ liệu được, không tạo hoặc sửa được.</div>}
      <header className="flex flex-wrap items-center justify-between gap-2 bg-slate-900 px-4 py-3 text-white" style={{ background: b.primaryColor, color: b.textOnPrimary }} data-testid="app-header">
        <nav className="flex flex-wrap items-center gap-4 text-sm">
          {b.hasLogo && <img src="/brand/logo" alt={`Logo ${shown}`} className="h-8 max-w-[10rem] object-contain" />}
          <span className="font-semibold" data-testid="shop-name">{shown}</span>
          {links.map((l) => <Link key={l.href} href={l.href} className="hover:underline">{l.label}</Link>)}
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/inbox" className="hover:underline" data-testid="inbox-link" aria-label={`Thông báo, ${unread} chưa đọc`}>Thông báo{unread > 0 && <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-xs text-black">{unread}</span>}</Link>
          <span className="opacity-80">{user.name}</span>
          <span style={{ color: b.textOnPrimary }} className="[&_button]:text-inherit"><SignOutButton /></span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4 md:p-6">{children}</main>
      <footer className="mx-auto max-w-6xl px-4 pb-6 text-center text-xs text-slate-400" data-testid="app-footer">
        {b.footerText && <p>{b.footerText}</p>}
        {!b.hideProductBrand && <p>Cung cấp bởi RentPro</p>}
      </footer>
    </>
  );
}
