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
  const links = [
    { href: '/', label: 'Tổng quan', show: true },
    { href: '/inventory', label: 'Thiết bị', show: tenant.features.inventory && permissions.has('inventory.view') },
    { href: '/inventory/models', label: 'Mẫu thiết bị', show: tenant.features.inventory && permissions.has('inventory.view') },
    { href: '/bookings', label: 'Đơn thuê', show: tenant.features.booking && permissions.has('booking.view') },
    { href: '/bookings/timeline', label: 'Lịch', show: tenant.features['booking.timeline'] && permissions.has('booking.view') },
    { href: '/reports', label: 'Báo cáo', show: tenant.features['reports.basic'] && permissions.has('reports.view') },
    { href: '/maintenance', label: 'Bảo trì', show: tenant.features.maintenance && permissions.has('maintenance.view') },
    { href: '/deposits', label: 'Sổ cọc', show: tenant.features.deposit && permissions.has('deposit.view') },
    { href: '/settings/finance', label: 'Tài chính', show: tenant.features.payments && permissions.has('settings.manage') },
    { href: '/notifications', label: 'Tin nhắn', show: tenant.features['notify.email'] && permissions.has('notification.view') },
    { href: '/settings/notifications', label: 'Cấu hình tin nhắn', show: tenant.features['notify.email'] && permissions.has('settings.manage') },
    { href: '/customers', label: 'Khách hàng', show: tenant.features.customers && permissions.has('customer.view') },
    { href: '/pricing', label: 'Bảng giá', show: tenant.features.pricing && permissions.has('pricing.view') },
    { href: '/inventory/scan', label: 'Quét mã', show: tenant.features['inventory.barcode'] && permissions.has('inventory.view') },
    { href: '/inventory/stocktake', label: 'Kiểm kê', show: tenant.features['inventory.stocktake'] && permissions.has('inventory.stocktake') },
  ].filter((l) => l.show);
  const readOnly = tenant.status === 'READ_ONLY' || tenant.status === 'SUSPENDED';
  return (
    <>
      {support && (
        <div role="alert" className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-black">
          Phiên hỗ trợ của {support.by} — hết hạn lúc {support.expiresAt.toLocaleTimeString('vi-VN')}. Mọi thao tác đều được ghi nhật ký.
        </div>
      )}
      {readOnly && <div role="status" className="bg-red-100 px-4 py-2 text-center text-sm text-red-900">Tài khoản đang ở chế độ chỉ đọc: bạn xem và xuất dữ liệu được, không tạo hoặc sửa được.</div>}
      <header className="flex flex-wrap items-center justify-between gap-2 bg-slate-900 px-4 py-3 text-white">
        <nav className="flex flex-wrap gap-4 text-sm">
          <span className="font-semibold">{tenant.name}</span>
          {links.map((l) => <Link key={l.href} href={l.href} className="hover:underline">{l.label}</Link>)}
        </nav>
        <div className="flex items-center gap-3 text-sm"><Link href="/inbox" className="hover:underline" data-testid="inbox-link" aria-label={`Thông báo, ${unread} chưa đọc`}>Thông báo{unread > 0 && <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-xs text-black">{unread}</span>}</Link><span className="text-slate-300">{user.name}</span><span className="[&_button]:text-white"><SignOutButton /></span></div>
      </header>
      <main className="mx-auto max-w-6xl p-4 md:p-6">{children}</main>
    </>
  );
}
