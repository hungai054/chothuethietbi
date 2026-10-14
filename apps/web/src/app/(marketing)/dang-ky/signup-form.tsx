'use client';
import { useState } from 'react';

/** Gợi ý slug từ tên cửa hàng (bỏ dấu tiếng Việt) cho tới khi người dùng tự sửa ô địa chỉ. */
function suggest(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
}

const box = 'w-full rounded border bg-white px-3 py-2';

export function SignupForm({ action, plans, selected }: { action: (f: FormData) => void | Promise<void>; plans: { code: string; label: string }[]; selected: string }) {
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  return (
    <form action={action} className="space-y-3 rounded-lg bg-white p-6 shadow-sm" data-testid="signup-form">
      <label className="block text-sm"><span className="mb-1 block text-slate-600">Tên cửa hàng</span>
        <input name="shopName" required className={box} placeholder="VD Cho Thuê Máy Ảnh An" onChange={(e) => { if (!touched) setSlug(suggest(e.target.value)); }} />
      </label>
      <label className="block text-sm"><span className="mb-1 block text-slate-600">Địa chỉ cửa hàng</span>
        <div className="flex items-center gap-1">
          <input name="slug" required className={box} value={slug} placeholder="may-anh-an" onChange={(e) => { setTouched(true); setSlug(e.target.value.toLowerCase()); }} />
        </div>
        <span className="mt-1 block text-xs text-slate-500">Cửa hàng truy cập tại địa chỉ riêng: <b>{slug || 'dia-chi'}</b>.tên-miền</span>
      </label>
      <label className="block text-sm"><span className="mb-1 block text-slate-600">Họ tên chủ cửa hàng</span><input name="ownerName" required className={box} autoComplete="name" /></label>
      <label className="block text-sm"><span className="mb-1 block text-slate-600">Email</span><input name="email" type="email" required className={box} autoComplete="email" /></label>
      <label className="block text-sm"><span className="mb-1 block text-slate-600">Mật khẩu (ít nhất 10 ký tự, gồm chữ và số)</span><input name="password" type="password" required minLength={10} className={box} autoComplete="new-password" /></label>
      <label className="block text-sm"><span className="mb-1 block text-slate-600">Gói dùng thử</span>
        <select name="plan" defaultValue={selected} className={box}>{plans.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}</select>
      </label>
      <div aria-hidden="true" className="absolute -left-[9999px]"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
      <button className="w-full rounded bg-slate-900 px-4 py-2 text-white" data-testid="signup-submit">Tạo cửa hàng</button>
    </form>
  );
}
