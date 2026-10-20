import Link from 'next/link';
import { Empty, card } from '@/components/ui';
import { requireAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Trung tâm cài đặt: chỉ hiện mục người dùng có quyền; mục bị khóa theo gói hiện rõ để biết cần nâng cấp. */
export default async function SettingsHub() {
  const { tenant, permissions } = await requireAppSession();
  const f = tenant.features;
  const manage = permissions.has('settings.manage');
  const items: { href: string; title: string; desc: string; show: boolean; locked?: boolean }[] = [
    { href: '/settings/finance', title: 'Tài chính và hợp đồng', desc: 'Tài khoản nhận tiền (QR), quy tắc cọc, thông tin cửa hàng, mẫu số hợp đồng.', show: manage && f.payments },
    { href: '/settings/booking', title: 'Đặt lịch', desc: 'Thời gian giữ chỗ, mẫu số đơn thuê.', show: manage && f.booking },
    { href: '/settings/pricing', title: 'Tính giá', desc: 'Ân hạn, phí trễ hạn, VAT, trả sớm.', show: manage && f.pricing },
    { href: '/settings/notifications', title: 'Tin nhắn và nhắc nhở', desc: 'Kênh gửi, tài khoản SMS/Zalo/Email, mẫu tin, giờ nghỉ.', show: manage && f['notify.email'] },
    { href: '/settings/templates', title: 'Mẫu tài liệu', desc: 'Sửa điều khoản hợp đồng, phiếu thu, biên bản giao nhận; xem trước.', show: manage && f.contract },
    { href: '/settings/labels', title: 'Nhãn và thuật ngữ', desc: 'Đổi tên gọi: "Thiết bị" thành "Sản phẩm", "Đơn thuê" thành "Booking"…', show: manage },
    { href: '/settings/custom-fields', title: 'Trường tùy chỉnh', desc: 'Thêm trường riêng cho thiết bị, khách hàng, đơn thuê, hợp đồng.', show: manage, locked: !f.custom_fields },
    { href: '/settings/branding', title: 'Thương hiệu (white-label)', desc: 'Logo, màu chủ đạo, favicon, tên hiển thị, chân trang, ẩn thương hiệu RentPro.', show: manage, locked: !f.white_label },
    { href: '/settings/subscription', title: 'Gói dịch vụ', desc: 'Gói đang dùng, hạn sử dụng, mức sử dụng, hóa đơn, gia hạn và đổi gói, tải dữ liệu.', show: permissions.has('billing.manage') },
    { href: '/settings/extensions', title: 'Extension', desc: 'Module mở rộng đang bật cho cửa hàng của bạn (do nhà cung cấp cài đặt).', show: manage && f.extensions },
    { href: '/settings/users', title: 'Người dùng', desc: 'Thêm nhân viên, đổi vai trò, khóa tài khoản, đặt lại mật khẩu.', show: permissions.has('users.manage') },
    { href: '/settings/roles', title: 'Vai trò tùy chỉnh', desc: 'Tự tạo vai trò với ma trận quyền chi tiết.', show: permissions.has('roles.manage'), locked: !f.custom_roles },
    { href: '/settings/audit', title: 'Nhật ký thao tác', desc: 'Ai đã làm gì, lúc nào; lọc theo người, thao tác, ngày và xuất CSV.', show: permissions.has('audit.view') && f['audit.log'] },
    { href: '/settings/api', title: 'API và webhook', desc: 'Khóa API, địa chỉ nhận webhook, nhật ký gửi.', show: manage, locked: !f.api },
    { href: '/settings/domains', title: 'Tên miền riêng', desc: 'Dùng tên miền của cửa hàng thay vì địa chỉ mặc định.', show: manage, locked: !f.custom_domain },
  ].filter((i) => i.show);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Cài đặt</h1>
      {items.length === 0 ? <Empty>Bạn không có quyền cài đặt.</Empty> : (
        <ul className="grid gap-3 md:grid-cols-2" data-testid="settings-hub">
          {items.map((i) => (
            <li key={i.href}>
              <Link href={i.href} className={`${card} block hover:bg-slate-50 ${i.locked ? 'opacity-60' : ''}`}>
                <div className="font-medium">{i.title}{i.locked && <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Cần nâng cấp gói</span>}</div>
                <div className="text-sm text-slate-600">{i.desc}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
