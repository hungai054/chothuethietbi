import { notFound, redirect } from 'next/navigation';
import {
  changePlan, getTenantDetail, getTenantPlanFeatures, listAudit, listExtensionErrors, listPlans, listSupportAccess, listTenantExtensionsAdmin, listTenantOwners, PlatformError, resetOwnerPassword, setTenantExtension,
  setFeatureOverrides, setLimitOverrides, setTenantNotes, setTenantStatus, startImpersonation, SETTABLE_STATUSES,
} from '@rentpro/db';
import { FEATURE_KEYS, LIMIT_KEYS } from '@rentpro/tenancy';
import { platformCan, signToken } from '@rentpro/core';
import { actorOf, db, readFlash, requireCan, setFlash } from '@/lib/session';
import { DataSection } from './data-section';
import { SubscriptionSection } from './subscription-section';

export const dynamic = 'force-dynamic';

const fail = (id: string, e: unknown): never => {
  if (e instanceof PlatformError) redirect(`/tenants/${id}?error=${encodeURIComponent(e.message)}`);
  throw e;
};
// redirect() ném lỗi đặc biệt của Next; phải cho nó đi qua.
const isRedirect = (e: unknown) => typeof e === 'object' && e !== null && 'digest' in e && String((e as { digest: unknown }).digest).startsWith('NEXT_REDIRECT');
async function guard(id: string, fn: () => Promise<void>, after?: () => string) {
  try { await fn(); } catch (e) { if (isRedirect(e)) throw e; fail(id, e); }
  redirect(after ? after() : `/tenants/${id}?ok=1`);
}

export default async function TenantPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string; created?: string; reset?: string }>;
}) {
  const { id } = await params;
  const q = await searchParams;
  const me = await requireCan('tenant.view');
  const canReset = platformCan(me.role, 'tenant.reset_password');
  const tenant = await getTenantDetail(db(), id);
  if (!tenant) notFound();
  const [plans, planFeatures, access, audit, extensions, extErrors, flash, owners] = await Promise.all([
    listPlans(db()), getTenantPlanFeatures(db(), id), listSupportAccess(db(), id), listAudit(db(), id, 15), listTenantExtensionsAdmin(db(), id), listExtensionErrors(db(), id, 10),
    q.created || q.reset ? readFlash<{ tempPassword: string; email: string; kind?: string }>() : null,
    listTenantOwners(db(), id),
  ]);

  async function doPlan(f: FormData) {
    'use server';
    const u = await requireCan('tenant.change_plan');
    await guard(id, () => changePlan(db(), actorOf(u), id, String(f.get('plan'))));
  }
  async function doStatus(f: FormData) {
    'use server';
    const u = await requireCan('tenant.suspend');
    await guard(id, () => setTenantStatus(db(), actorOf(u), id, String(f.get('status')), String(f.get('reason') ?? '')));
  }
  async function doFlags(f: FormData) {
    'use server';
    const u = await requireCan('tenant.override_features');
    const o: Record<string, boolean | null> = {};
    for (const k of FEATURE_KEYS) { const v = f.get(`f:${k}`); o[k] = v === 'on' ? true : v === 'off' ? false : null; }
    await guard(id, () => setFeatureOverrides(db(), actorOf(u), id, o));
  }
  async function doLimits(f: FormData) {
    'use server';
    const u = await requireCan('tenant.override_features');
    const o: Record<string, number | null | undefined> = {};
    for (const k of LIMIT_KEYS) {
      const v = String(f.get(`l:${k}`) ?? '').trim();
      o[k] = v === '' ? undefined : v === 'unlimited' ? null : Number(v);
      if (typeof o[k] === 'number' && Number.isNaN(o[k])) o[k] = -1;
    }
    await guard(id, () => setLimitOverrides(db(), actorOf(u), id, o));
  }
  async function doExtension(code: string, f: FormData) {
    'use server';
    const u = await requireCan('tenant.override_features');
    const raw = String(f.get('config') ?? '').trim();
    let config: unknown = {};
    if (raw) {
      try { config = JSON.parse(raw); } catch { redirect(`/tenants/${id}?error=${encodeURIComponent('Cấu hình phải là JSON hợp lệ.')}`); }
    }
    await guard(id, () => setTenantExtension(db(), actorOf(u), id, code, { enabled: f.get('enabled') === 'on', config }));
  }
  async function doResetOwner(f: FormData) {
    'use server';
    const u = await requireCan('tenant.reset_password');
    await guard(id, async () => {
      const r = await resetOwnerPassword(db(), actorOf(u), id, { reason: String(f.get('reason') ?? ''), email: String(f.get('email') ?? '') || undefined });
      await setFlash({ tempPassword: r.tempPassword, email: r.email, kind: 'reset' }); // cookie httpOnly 30 giây, không đặt vào URL
    }, () => `/tenants/${id}?reset=1`);
  }
  async function doNotes(f: FormData) {
    'use server';
    const u = await requireCan('tenant.change_plan');
    await guard(id, () => setTenantNotes(db(), actorOf(u), id, String(f.get('notes') ?? '')));
  }
  async function doImpersonate(f: FormData) {
    'use server';
    const u = await requireCan('tenant.impersonate');
    const minutes = Number(f.get('minutes'));
    let url = '';
    await guard(id, async () => {
      const s = await startImpersonation(db(), actorOf(u), id, String(f.get('reason') ?? ''), minutes);
      const token = signToken({ sid: s.id, tid: id }, process.env.SUPPORT_SECRET ?? '', 120);
      const base = (process.env.TENANT_URL_TEMPLATE ?? '').replace('{slug}', tenant!.slug);
      url = `${base}/support/enter#token=${token}`; // fragment: không đi vào log máy chủ
    }, () => url);
  }

  const box = 'rounded-lg bg-white p-5 shadow-sm space-y-3';
  const input = 'rounded border px-3 py-2';
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{tenant.name}</h1>
        <p className="text-sm text-slate-500">{tenant.slug} · {tenant.plan_name} · {tenant.status} · {tenant.users} người dùng · {tenant.equipment} thiết bị</p>
      </div>
      {q.error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{q.error}</p>}
      {q.ok && <p className="rounded bg-green-50 p-3 text-sm text-green-700">Đã lưu.</p>}
      {flash && (
        <p className="rounded bg-amber-50 p-3 text-sm text-amber-900" data-testid="temp-password-flash">
          {flash.kind === 'reset' ? 'Đã đặt lại mật khẩu.' : 'Đã tạo khách hàng.'} Tài khoản chủ cửa hàng: <b>{flash.email}</b>, mật khẩu tạm: <code className="font-bold">{flash.tempPassword}</code>. Chỉ hiện một lần, hãy chuyển cho khách an toàn.
        </p>
      )}

      <section className={box}>
        <h2 className="font-medium">Gói &amp; trạng thái</h2>
        <form action={doPlan} className="flex gap-2">
          <select name="plan" defaultValue={tenant.plan_code} className={input}>{plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
          <button className="rounded bg-slate-900 px-4 py-2 text-white">Đổi gói</button>
        </form>
        <form action={doStatus} className="flex flex-wrap gap-2">
          <select name="status" defaultValue={tenant.status} className={input}>{SETTABLE_STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
          <input name="reason" placeholder="Lý do" className={input} />
          <button className="rounded bg-slate-900 px-4 py-2 text-white">Đổi trạng thái</button>
        </form>
      </section>

      <section className={box}>
        <h2 className="font-medium">Ghi đè tính năng</h2>
        <form action={doFlags} className="space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            {FEATURE_KEYS.map((k) => {
              const cur = tenant.feature_overrides[k];
              return (
                <label key={k} className="flex items-center justify-between gap-2 text-sm">
                  <span>{k} <span className="text-slate-400">(gói: {planFeatures[k] ? 'bật' : 'tắt'})</span></span>
                  <select name={`f:${k}`} defaultValue={cur === undefined ? '' : cur ? 'on' : 'off'} className="rounded border px-2 py-1">
                    <option value="">theo gói</option><option value="on">bật</option><option value="off">tắt</option>
                  </select>
                </label>
              );
            })}
          </div>
          <button className="rounded bg-slate-900 px-4 py-2 text-white">Lưu tính năng</button>
        </form>
      </section>

      <section className={box}>
        <h2 className="font-medium">Ghi đè giới hạn</h2>
        <p className="text-sm text-slate-500">Để trống = theo gói. Nhập <code>unlimited</code> = không giới hạn.</p>
        <form action={doLimits} className="grid gap-2 md:grid-cols-3">
          {LIMIT_KEYS.map((k) => {
            const cur = tenant.limit_overrides[k];
            return <label key={k} className="text-sm">{k}<input name={`l:${k}`} defaultValue={cur === undefined ? '' : cur === null ? 'unlimited' : String(cur)} className={`${input} mt-1 w-full`} /></label>;
          })}
          <div className="md:col-span-3"><button className="rounded bg-slate-900 px-4 py-2 text-white">Lưu giới hạn</button></div>
        </form>
      </section>

      <section className={box} data-testid="extensions-section">
        <h2 className="font-medium">Extension (module mở rộng bằng code)</h2>
        <p className="text-sm text-slate-500">Chỉ extension đã được cài trong bản triển khai này. Bật cho khách cần gói/ghi đè có tính năng <code>extensions</code>. Cấu hình là JSON, kiểm tra theo schema của extension.</p>
        {extensions.length === 0 && <p className="text-sm text-slate-500">Chưa cài extension nào (chạy <code>pnpm ext:new</code>).</p>}
        {extensions.map((x) => (
          <form key={x.code} action={doExtension.bind(null, x.code)} className="space-y-2 rounded border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span><b>{x.name}</b> <code className="text-xs text-slate-500">{x.code} v{x.version}</code></span>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={x.enabled} /> Bật cho khách này</label>
            </div>
            {x.description && <p className="text-sm text-slate-600">{x.description}</p>}
            <p className="text-xs text-slate-500">Móc: {x.hooks.join(', ') || '—'}{x.enabledBy ? ` · bật bởi ${x.enabledBy}` : ''}</p>
            {x.compatible && <p className="text-xs text-red-700">{x.compatible}</p>}
            <textarea name="config" rows={3} defaultValue={JSON.stringify(x.config ?? {}, null, 2)} aria-label={`Cấu hình ${x.code}`} className={`${input} w-full font-mono text-sm`} />
            <button className="rounded bg-slate-900 px-4 py-2 text-white">Lưu extension</button>
          </form>
        ))}
        {extErrors.length > 0 && (
          <div>
            <h3 className="text-sm font-medium">Lỗi extension gần đây (đã được cô lập)</h3>
            <ul className="text-xs text-slate-600" data-testid="extension-errors">{extErrors.map((e, i) => <li key={i}>{new Date(e.created_at).toLocaleString('vi-VN')} · {e.extension_code} · {e.hook} · {e.message}</li>)}</ul>
          </div>
        )}
      </section>

      <SubscriptionSection tenantId={id} />

      <DataSection tenantId={id} slug={tenant.slug} />

      <section className={box}>
        <h2 className="font-medium">Ghi chú nội bộ</h2>
        <form action={doNotes} className="space-y-2">
          <textarea name="notes" defaultValue={tenant.notes ?? ''} rows={3} className={`${input} w-full`} />
          <button className="rounded bg-slate-900 px-4 py-2 text-white">Lưu ghi chú</button>
        </form>
      </section>

      {canReset && (
        <section className={box} data-testid="reset-owner">
          <h2 className="font-medium">Chủ cửa hàng quên mật khẩu</h2>
          <p className="text-sm text-slate-500">Tạo mật khẩu tạm ngẫu nhiên (hiện một lần) và mở lại tài khoản nếu đang bị khóa. Hãy xác minh danh tính chủ cửa hàng trước (gọi lại số đã đăng ký). Lý do bắt buộc; việc này được ghi vào nhật ký quản trị và cả nhật ký của cửa hàng. Mật khẩu cũ mất hiệu lực ngay.</p>
          <form action={doResetOwner} className="flex flex-wrap gap-2">
            {owners.length > 1 ? (
              <select name="email" required className={input}>{owners.map((o) => <option key={o.email} value={o.email}>{o.email}{o.active ? '' : ' (đang khóa)'}</option>)}</select>
            ) : (
              <span className="self-center text-sm text-slate-600">{owners[0]?.email ?? 'Chưa có tài khoản chủ'}{owners[0] && !owners[0].active ? ' (đang khóa)' : ''}</span>
            )}
            <input name="reason" required minLength={5} maxLength={300} placeholder="Lý do (VD: quên mật khẩu, đã gọi xác minh)" className={`${input} min-w-80 flex-1`} />
            <button className="rounded bg-amber-600 px-4 py-2 text-white" disabled={owners.length === 0}>Đặt lại mật khẩu chủ</button>
          </form>
        </section>
      )}

      <section className={box}>
        <h2 className="font-medium">Hỗ trợ: đăng nhập thay</h2>
        <p className="text-sm text-slate-500">Bắt buộc nhập lý do. Phiên có thời hạn, hiện băng rôn cảnh báo, không xem được giấy tờ tùy thân. Khách xem được lịch sử này.</p>
        <form action={doImpersonate} className="flex flex-wrap gap-2">
          <input name="reason" required minLength={5} placeholder="Lý do (VD: khách báo lỗi in hợp đồng)" className={`${input} min-w-80 flex-1`} />
          <input name="minutes" type="number" min={5} max={120} defaultValue={30} className={`${input} w-24`} />
          <button className="rounded bg-amber-600 px-4 py-2 text-white">Đăng nhập thay</button>
        </form>
        <ul className="text-sm text-slate-600">
          {access.map((a) => (
            <li key={a.id}>{new Date(a.created_at).toLocaleString('vi-VN')} · {a.platform_user_email} · {a.reason}{a.ended_at ? ' · đã kết thúc' : ''}</li>
          ))}
        </ul>
      </section>

      <section className={box}>
        <h2 className="font-medium">Nhật ký quản trị gần đây</h2>
        <ul className="text-sm text-slate-600">
          {audit.map((a) => <li key={a.id}>{new Date(a.created_at).toLocaleString('vi-VN')} · {a.action} · {a.data.actor}{a.reason ? ` · ${a.reason}` : ''}</li>)}
        </ul>
      </section>
    </div>
  );
}
