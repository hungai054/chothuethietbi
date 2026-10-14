import Link from 'next/link';
import { DEFAULT_PRIMARY, LOGO_MAX_BYTES } from '@rentpro/core';
import { getBranding, updateBranding } from '@rentpro/db';
import { Field, Notice, btn, card, input } from '@/components/ui';
import { okUrl } from '@/lib/forms';
import { requireAccess } from '@/lib/session';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const BACK = '/settings/branding';
const s = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

async function fileBytes(f: FormData, k: string): Promise<Uint8Array | undefined> {
  const x = f.get(k);
  return typeof x !== 'string' && x && x.size > 0 ? new Uint8Array(await x.arrayBuffer()) : undefined;
}

async function save(f: FormData) {
  'use server';
  await run(BACK, async () => {
    const logo = f.get('removeLogo') === 'on' ? null : await fileBytes(f, 'logo');
    const favicon = f.get('removeFavicon') === 'on' ? null : await fileBytes(f, 'favicon');
    await withService((c) => updateBranding(c, {
      displayName: s(f, 'displayName'), primaryColor: s(f, 'primaryColor'), emailFromName: s(f, 'emailFromName'), footerText: s(f, 'footerText'),
      hideProductBrand: f.get('hideProductBrand') === 'on', logo, favicon,
    }));
    return okUrl(BACK, 'Đã lưu thương hiệu.');
  });
}

export default async function BrandingPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireAccess('white_label', 'settings.manage');
  const q = await searchParams;
  const { raw, resolved } = await withService((c) => getBranding(c));
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/settings" className="text-sm underline">← Cài đặt</Link>
      <h1 className="text-2xl font-semibold">Thương hiệu (white-label)</h1>
      <Notice error={q.error} ok={q.ok} />
      <form action={save} className={`${card} space-y-3`} data-testid="branding-form">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Tên hiển thị (thay tên cửa hàng ở đầu trang, trang đăng nhập, tiêu đề tab)"><input name="displayName" defaultValue={raw.displayName ?? ''} maxLength={60} className={input} /></Field>
          <Field label="Màu chủ đạo (thanh trên cùng)">
            <div className="flex gap-2"><input name="primaryColor" defaultValue={raw.primaryColor ?? DEFAULT_PRIMARY} pattern="#[0-9a-fA-F]{6}" className={input} /><span className="h-10 w-10 shrink-0 rounded border" style={{ background: resolved.primaryColor }} aria-hidden /></div>
          </Field>
          <Field label="Tên người gửi trong email/tin nhắn"><input name="emailFromName" defaultValue={raw.emailFromName ?? ''} maxLength={80} className={input} /></Field>
          <Field label="Chân trang tài liệu in (hotline, địa chỉ…)"><input name="footerText" defaultValue={raw.footerText ?? ''} maxLength={200} className={input} /></Field>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={`Logo (JPG/PNG/WebP, tối đa ${LOGO_MAX_BYTES / 1024} KB)`}>
            {resolved.hasLogo && <img src="/brand/logo" alt="Logo hiện tại" className="mb-2 max-h-16" />}
            <input name="logo" type="file" accept="image/png,image/jpeg,image/webp" className={input} />
            {resolved.hasLogo && <label className="mt-1 flex items-center gap-1 text-xs"><input type="checkbox" name="removeLogo" /> Xóa logo</label>}
          </Field>
          <Field label="Favicon (biểu tượng tab, tối đa 256 KB)">
            {resolved.hasFavicon && <img src="/brand/favicon" alt="Favicon hiện tại" className="mb-2 h-8" />}
            <input name="favicon" type="file" accept="image/png,image/jpeg,image/webp" className={input} />
            {resolved.hasFavicon && <label className="mt-1 flex items-center gap-1 text-xs"><input type="checkbox" name="removeFavicon" /> Xóa favicon</label>}
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="hideProductBrand" defaultChecked={raw.hideProductBrand === true} /> Ẩn dòng &quot;Cung cấp bởi RentPro&quot;</label>
        <p className="text-xs text-slate-500">Logo và favicon được lưu riêng tư và chỉ phục vụ qua địa chỉ của cửa hàng bạn. Không dùng SVG để tránh mã độc.</p>
        <button className={btn}>Lưu thương hiệu</button>
      </form>
    </div>
  );
}
