import Link from 'next/link';
import { listSignupPlans } from '@rentpro/db';
import { vnd } from '@/lib/format';
import { pool } from '@/lib/db';
import { requireMarketingHost } from '@/lib/marketing';
import { enterShop } from '../actions';

export const dynamic = 'force-dynamic';

const FEATURES: [string, string][] = [
  ['Đặt lịch không trùng', 'Kiểm tra thiết bị rảnh theo giờ, có thời gian đệm vệ sinh/kiểm tra; hai người đặt cùng lúc chỉ một người thành công.'],
  ['Giá linh hoạt', 'Giá theo giờ, ngày, tuần, tháng; bảng giá theo nhóm khách; tự tính phí trễ hạn, VAT, trả sớm.'],
  ['Hợp đồng và thu tiền', 'Hợp đồng điện tử có chữ ký, cọc, tài sản thế chấp, QR chuyển khoản VietQR, quyết toán khi trả máy.'],
  ['Nhắc việc tự động', 'Nhắc khách trả đồ, quá hạn, công nợ qua Zalo, SMS, email; giữ chỗ tự hết hạn.'],
  ['Bảo trì và sửa chữa', 'Lịch bảo trì theo ngày, giờ dùng, số lượt thuê; thiết bị hỏng tự tạo phiếu sửa.'],
  ['Báo cáo cho chủ cửa hàng', 'Doanh thu, công nợ, hiệu suất từng thiết bị, ROI, xuất Excel.'],
];

const PLAN_FLAGS: [string, string][] = [
  ['booking.timeline', 'Lịch timeline kéo thả'], ['notify.sms', 'Nhắc qua SMS'], ['notify.zalo', 'Nhắc qua Zalo'], ['reports.advanced', 'Báo cáo nâng cao'],
  ['custom_fields', 'Trường tùy chỉnh'], ['multi_branch', 'Nhiều chi nhánh'],
];

export default async function Landing() {
  await requireMarketingHost();
  const plans = await listSignupPlans(pool());
  return (
    <main className="mx-auto max-w-5xl space-y-16 p-6 md:p-10" data-testid="landing">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xl font-bold">RentPro</span>
        <nav className="flex items-center gap-4 text-sm">
          <a href="#bang-gia" className="hover:underline">Bảng giá</a>
          <Link href="/dang-ky" className="rounded bg-slate-900 px-4 py-2 text-white" data-testid="cta-signup-top">Dùng thử miễn phí</Link>
        </nav>
      </header>

      <section className="space-y-4 text-center">
        <h1 className="text-4xl font-bold leading-tight md:text-5xl">Quản lý cho thuê thiết bị<br />gọn, đúng và không thất thoát</h1>
        <p className="mx-auto max-w-2xl text-lg text-slate-600">Phần mềm cho cửa hàng cho thuê máy ảnh, âm thanh, ánh sáng, dụng cụ, đồ dã ngoại… Đặt lịch, hợp đồng, thu cọc, nhắc trả đồ, bảo trì và báo cáo trong một nơi.</p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/dang-ky" className="rounded bg-slate-900 px-6 py-3 text-white" data-testid="cta-signup">Dùng thử 14 ngày, không cần thẻ</Link>
          <a href="#bang-gia" className="rounded border bg-white px-6 py-3">Xem bảng giá</a>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {FEATURES.map(([t, d]) => <div key={t} className="rounded-lg bg-white p-5 shadow-sm"><h3 className="font-semibold">{t}</h3><p className="mt-1 text-sm text-slate-600">{d}</p></div>)}
      </section>

      <section id="bang-gia" className="space-y-6">
        <h2 className="text-center text-3xl font-bold">Bảng giá</h2>
        <div className="grid gap-4 md:grid-cols-3" data-testid="pricing">
          {plans.map((p, i) => (
            <div key={p.code} className={`space-y-3 rounded-lg bg-white p-6 shadow-sm ${i === 1 ? 'ring-2 ring-slate-900' : ''}`} data-testid={`plan-${p.code}`}>
              <h3 className="text-xl font-semibold">{p.name}</h3>
              <p className="text-3xl font-bold">{vnd(p.priceMonth)}<span className="text-base font-normal text-slate-500">/tháng</span></p>
              <p className="text-sm text-slate-500">hoặc {vnd(p.priceYear)}/năm (tiết kiệm {Math.max(0, Math.round((1 - p.priceYear / (p.priceMonth * 12)) * 100))}%)</p>
              <ul className="space-y-1 text-sm">
                <li>{p.limits.users ?? 'Không giới hạn'} người dùng · {p.limits.branches ?? 'không giới hạn'} chi nhánh</li>
                <li>{p.limits.equipment ?? 'Không giới hạn'} thiết bị</li>
                {PLAN_FLAGS.filter(([k]) => p.features[k]).map(([k, label]) => <li key={k}>✓ {label}</li>)}
              </ul>
              <Link href={`/dang-ky?plan=${p.code}`} className="block rounded bg-slate-900 px-4 py-2 text-center text-white">Dùng thử gói {p.name}</Link>
            </div>
          ))}
          <div className="space-y-3 rounded-lg bg-white p-6 shadow-sm" data-testid="plan-enterprise">
            <h3 className="text-xl font-semibold">Doanh nghiệp</h3>
            <p className="text-3xl font-bold">Liên hệ</p>
            <ul className="space-y-1 text-sm"><li>Không giới hạn thiết bị, người dùng</li><li>✓ White-label, tên miền riêng</li><li>✓ Vai trò tùy chỉnh, API, webhook</li><li>✓ Tùy biến theo quy trình của bạn</li></ul>
            <a href="mailto:lienhe@rentpro.vn" className="block rounded border px-4 py-2 text-center">Nhận báo giá</a>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-md space-y-3 rounded-lg bg-white p-6 shadow-sm" id="dang-nhap">
        <h2 className="text-xl font-semibold">Đã có cửa hàng?</h2>
        <form action={enterShop} className="flex gap-2">
          <input name="slug" required placeholder="địa-chỉ-cửa-hàng" aria-label="Địa chỉ cửa hàng" className="w-full rounded border px-3 py-2" />
          <button className="rounded border bg-white px-4 py-2">Vào</button>
        </form>
      </section>

      <footer className="pb-6 text-center text-xs text-slate-400">© RentPro · Quản lý cho thuê thiết bị</footer>
    </main>
  );
}
