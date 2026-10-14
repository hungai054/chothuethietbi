import Link from 'next/link';
import { applyIndustryTemplate, getFinanceSettings, listIndustryTemplates, onboardingStatus, updateFinanceSettings } from '@rentpro/db';
import { Field, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { okUrl } from '@/lib/forms';
import { requireAccess } from '@/lib/session';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const BACK = '/onboarding';
const s = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

async function saveShop(f: FormData) {
  'use server';
  await run(BACK, async () => {
    await withService(async (c) => {
      const cur = await getFinanceSettings(c);
      await updateFinanceSettings(c, { ...cur, store: { ...(cur.store ?? {}), name: s(f, 'name'), address: s(f, 'address'), phone: s(f, 'phone') } });
    });
    return okUrl(BACK, 'Đã lưu thông tin cửa hàng.');
  });
}

async function loadTemplate(f: FormData) {
  'use server';
  await run(BACK, async () => {
    const r = await withService((c) => applyIndustryTemplate(c, s(f, 'template')));
    return okUrl(BACK, r.created === 0 ? 'Các mẫu của ngành này đã có sẵn, không thêm mới.' : `Đã thêm ${r.created} mẫu thiết bị${r.priced ? ` kèm giá gợi ý (sửa ở mục Bảng giá)` : ''}.`);
  });
}

const LABEL: Record<string, { title: string; hint: string }> = {
  shop: { title: 'Thông tin cửa hàng', hint: 'Tên, địa chỉ, số điện thoại: in trên hợp đồng và phiếu thu.' },
  bank: { title: 'Tài khoản nhận tiền', hint: 'Để tạo mã QR chuyển khoản cho khách.' },
  catalog: { title: 'Danh mục thiết bị theo ngành', hint: 'Nạp mẫu thiết bị và giá gợi ý của ngành bạn, rồi chỉnh lại.' },
  units: { title: 'Thiết bị cụ thể', hint: 'Nhập từng chiếc (mã vạch, số serial) từ file Excel hoặc thêm tay.' },
  pricing: { title: 'Bảng giá', hint: 'Kiểm tra và chỉnh giá theo giờ/ngày/tuần/tháng.' },
  team: { title: 'Mời nhân viên', hint: 'Tạo tài khoản cho nhân viên quầy, kỹ thuật.' },
};

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const sess = await requireAccess('inventory', 'settings.manage');
  const q = await searchParams;
  const [st, fin] = await withService(async (c) => [await onboardingStatus(c), await getFinanceSettings(c)] as const);
  const done = (k: string) => st.steps.find((x) => x.key === k)?.done ?? false;
  const templates = listIndustryTemplates();
  const Badge = ({ k }: { k: string }) => done(k) ? <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">Xong</span> : <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Chưa làm</span>;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Thiết lập cửa hàng</h1>
      <p className="text-sm text-slate-600" data-testid="onboarding-progress">Đã xong {st.done}/{st.total} bước. Làm theo thứ tự hoặc bỏ qua bước nào cũng được, bạn quay lại bất cứ lúc nào.</p>
      <Notice error={q.error} ok={q.ok} />

      <section className={`${card} space-y-3`} data-testid="step-shop">
        <div className="flex items-center justify-between"><h2 className="font-medium">1. {LABEL.shop!.title}</h2><Badge k="shop" /></div>
        <p className="text-sm text-slate-500">{LABEL.shop!.hint}</p>
        <form action={saveShop} className="grid gap-3 md:grid-cols-3">
          <Field label="Tên cửa hàng"><input name="name" defaultValue={fin.store?.name ?? sess.tenant.name} className={input} required /></Field>
          <Field label="Địa chỉ"><input name="address" defaultValue={fin.store?.address ?? ''} className={input} /></Field>
          <Field label="Điện thoại"><input name="phone" defaultValue={fin.store?.phone ?? ''} className={input} /></Field>
          <div className="md:col-span-3"><button className={btn}>Lưu thông tin</button></div>
        </form>
      </section>

      <section className={`${card} space-y-2`} data-testid="step-bank">
        <div className="flex items-center justify-between"><h2 className="font-medium">2. {LABEL.bank!.title}</h2><Badge k="bank" /></div>
        <p className="text-sm text-slate-500">{LABEL.bank!.hint}</p>
        <Link href="/settings/finance" className={`${btnGhost} inline-block`}>Cài đặt tài khoản nhận tiền</Link>
      </section>

      <section className={`${card} space-y-3`} data-testid="step-catalog">
        <div className="flex items-center justify-between"><h2 className="font-medium">3. {LABEL.catalog!.title}</h2><Badge k="catalog" /></div>
        <p className="text-sm text-slate-500">{LABEL.catalog!.hint}</p>
        <ul className="grid gap-2 md:grid-cols-2">
          {templates.map((t) => (
            <li key={t.key} className="rounded border p-3 text-sm">
              <p className="font-medium">{t.name}</p>
              <p className="text-slate-500">{t.description} ({t.models} mẫu)</p>
              <form action={loadTemplate} className="mt-2"><input type="hidden" name="template" value={t.key} /><button className={btnGhost} data-testid={`template-${t.key}`}>Nạp mẫu ngành này</button></form>
            </li>
          ))}
        </ul>
      </section>

      <section className={`${card} space-y-2`} data-testid="step-units">
        <div className="flex items-center justify-between"><h2 className="font-medium">4. {LABEL.units!.title}</h2><Badge k="units" /></div>
        <p className="text-sm text-slate-500">{LABEL.units!.hint}</p>
        <div className="flex flex-wrap gap-2"><Link href="/inventory/import" className={`${btnGhost} inline-block`}>Nhập từ Excel (có file mẫu)</Link><Link href="/inventory/units" className={`${btnGhost} inline-block`}>Thêm thủ công</Link></div>
      </section>

      <section className={`${card} space-y-2`} data-testid="step-pricing">
        <div className="flex items-center justify-between"><h2 className="font-medium">5. {LABEL.pricing!.title}</h2><Badge k="pricing" /></div>
        <p className="text-sm text-slate-500">{LABEL.pricing!.hint}</p>
        <Link href="/pricing" className={`${btnGhost} inline-block`}>Mở bảng giá</Link>
      </section>

      <section className={`${card} space-y-2`} data-testid="step-team">
        <div className="flex items-center justify-between"><h2 className="font-medium">6. {LABEL.team!.title}</h2><Badge k="team" /></div>
        <p className="text-sm text-slate-500">{LABEL.team!.hint}</p>
        <Link href="/settings/users" className={`${btnGhost} inline-block`}>Quản lý người dùng</Link>
      </section>
    </div>
  );
}
