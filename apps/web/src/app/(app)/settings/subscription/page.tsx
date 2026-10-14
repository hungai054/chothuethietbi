import Link from 'next/link';
import { changePlanMidTerm, createSubscriptionInvoice, getMySubscription, priceOf, quotePlanChange, SYSTEM_ACTOR } from '@rentpro/db';
import type { Cycle } from '@rentpro/core';
import { Empty, Field, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { fmtDate, vnd } from '@/lib/format';
import { okUrl } from '@/lib/forms';
import { platformPool } from '@/lib/platform';
import { run, withService } from '@/lib/service';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const BACK = '/settings/subscription';

const PHASE_TEXT: Record<string, { cls: string; text: string }> = {
  ACTIVE: { cls: 'bg-green-100 text-green-800', text: 'Đang hoạt động' },
  GRACE: { cls: 'bg-amber-100 text-amber-800', text: 'Đã hết hạn, đang trong thời gian ân hạn' },
  READ_ONLY: { cls: 'bg-red-100 text-red-800', text: 'Chỉ đọc: gia hạn để dùng lại' },
  SUSPENDED: { cls: 'bg-red-100 text-red-800', text: 'Tạm khóa: gia hạn hoặc liên hệ hỗ trợ' },
};

/** Thanh toán/hóa đơn dùng role quản trị nhưng tenantId luôn lấy từ phiên đã kiểm quyền `billing.manage`; làm được cả khi tài khoản đang chỉ đọc. */
const selfActor = (userId: string) => ({ ...SYSTEM_ACTOR, email: `tenant-user:${userId}` });

async function buy(f: FormData) {
  'use server';
  await run(BACK, async () => {
    const s = await requirePermission('billing.manage');
    const inv = await createSubscriptionInvoice(platformPool(), selfActor(s.user.id), {
      tenantId: s.tenant.id, planCode: String(f.get('plan') ?? ''), cycle: String(f.get('cycle') ?? ''), couponCode: String(f.get('coupon') ?? '').trim() || null,
    });
    return `${BACK}/pay/${inv.id}`;
  });
}

async function change(f: FormData) {
  'use server';
  await run(BACK, async () => {
    const s = await requirePermission('billing.manage');
    const r = await changePlanMidTerm(platformPool(), selfActor(s.user.id), s.tenant.id, String(f.get('plan') ?? ''));
    if (r.invoice) return `${BACK}/pay/${r.invoice.id}`;
    return okUrl(BACK, `Đã hạ gói. Phần giá trị chưa dùng (${vnd(r.creditLeft)}) được trừ vào hóa đơn kế tiếp.`);
  });
}

export default async function SubscriptionPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const sess = await requirePermission('billing.manage');
  const q = await searchParams;
  const tz = sess.tenant.timezone;
  const me = await withService((c) => getMySubscription(c));
  const phase = PHASE_TEXT[me.phase]!;
  const canChange = me.subscription?.periodEnd && me.subscription.periodEnd.getTime() > Date.now();
  const quotes = canChange
    ? await Promise.all(me.plans.filter((p) => p.selfServe && p.code !== me.plan.code).map(async (p) => {
        try { return { p, q: await quotePlanChange(platformPool(), sess.tenant.id, p.code) }; } catch { return { p, q: null }; }
      }))
    : [];
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link href="/settings" className="text-sm underline">← Cài đặt</Link>
      <h1 className="text-2xl font-semibold">Gói dịch vụ</h1>
      <Notice error={q.error} ok={q.ok} />

      <section className={`${card} space-y-2`} data-testid="subscription-summary">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">Gói {me.plan.name}</h2>
          <span className={`rounded px-2 py-0.5 text-xs ${phase.cls}`} data-testid="subscription-phase">{phase.text}</span>
        </div>
        {me.subscription ? (
          <p className="text-sm text-slate-600">Chu kỳ {me.subscription.cycle === 'YEAR' ? 'năm' : 'tháng'} · {me.endsAt ? <>hết hạn <b>{fmtDate(me.endsAt, tz)}</b> (còn {Math.max(0, me.daysLeft ?? 0)} ngày)</> : 'không thời hạn (hợp đồng riêng)'}{me.subscription.credit > 0 && <> · số dư được trừ vào kỳ sau: <b>{vnd(me.subscription.credit)}</b></>}</p>
        ) : (
          <p className="text-sm text-slate-600">{me.tenantStatus === 'TRIAL' && me.trialEndsAt ? <>Đang dùng thử, hết hạn <b>{fmtDate(me.trialEndsAt, tz)}</b> (còn {Math.max(0, me.daysLeft ?? 0)} ngày).</> : 'Chưa có thuê bao trả phí.'}</p>
        )}
        {me.phase !== 'ACTIVE' && me.readOnlyAt && me.phase === 'GRACE' && <p className="text-sm text-amber-700">Sau {fmtDate(me.readOnlyAt, tz)} tài khoản sẽ chuyển sang chế độ chỉ đọc (xem và xuất dữ liệu được, không tạo/sửa được). Dữ liệu luôn được giữ nguyên.</p>}
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="text-lg font-medium">Mức sử dụng</h2>
        <ul className="grid gap-2 text-sm md:grid-cols-2" data-testid="usage-list">
          {me.usage.map((u) => (
            <li key={u.key} className="rounded border p-2">
              <div className="flex justify-between"><span>{u.label}</span><b>{u.used}{u.limit !== null ? ` / ${u.limit}` : ' / không giới hạn'}</b></div>
              {u.limit !== null && <div className="mt-1 h-2 rounded bg-slate-100"><div className={`h-2 rounded ${u.over ? 'bg-red-500' : u.near ? 'bg-amber-500' : 'bg-green-500'}`} style={{ width: `${Math.min(100, Math.round((u.used / Math.max(1, u.limit)) * 100))}%` }} /></div>}
              {u.near && <p className="mt-1 text-xs text-amber-700">Đã dùng từ 80% hạn mức gói. Cân nhắc nâng cấp.</p>}
            </li>
          ))}
        </ul>
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="text-lg font-medium">{me.subscription ? 'Gia hạn hoặc mua gói' : 'Mua gói'}</h2>
        <form action={buy} className="grid gap-3 md:grid-cols-4" data-testid="buy-form">
          <Field label="Gói">
            <select name="plan" defaultValue={me.plan.code} className={input}>
              {me.plans.filter((p) => p.selfServe).map((p) => <option key={p.code} value={p.code}>{p.name} — {vnd(p.priceMonth)}/tháng</option>)}
            </select>
          </Field>
          <Field label="Chu kỳ">
            <select name="cycle" defaultValue={me.subscription?.cycle ?? 'MONTH'} className={input}>
              <option value="MONTH">Theo tháng</option>
              <option value="YEAR">Theo năm (tiết kiệm hơn)</option>
            </select>
          </Field>
          <Field label="Mã giảm giá (nếu có)"><input name="coupon" className={input} placeholder="VD KHAITRUONG" /></Field>
          <div className="flex items-end"><button className={btn}>Tạo hóa đơn</button></div>
        </form>
        <p className="text-xs text-slate-500">Bảng giá: {me.plans.filter((p) => p.selfServe).map((p) => `${p.name} ${vnd(priceOf(p, 'MONTH' as Cycle))}/tháng hoặc ${vnd(priceOf(p, 'YEAR' as Cycle))}/năm`).join(' · ')}. Gói Doanh nghiệp: liên hệ để được báo giá.</p>
      </section>

      {canChange && quotes.length > 0 && (
        <section className={`${card} space-y-3`} data-testid="change-plan">
          <h2 className="text-lg font-medium">Đổi gói giữa kỳ</h2>
          <p className="text-sm text-slate-600">Tính theo tỷ lệ số ngày còn lại của kỳ hiện tại. Nâng gói: trả phần chênh lệch. Hạ gói: áp dụng ngay, phần chưa dùng được trừ vào kỳ sau.</p>
          <ul className="space-y-2">
            {quotes.map(({ p, q }) => (
              <li key={p.code} className="flex flex-wrap items-center justify-between gap-2 rounded border p-3 text-sm">
                <span><b>{p.name}</b>{q && <> · còn {q.proration.daysLeft}/{q.proration.totalDays} ngày · {q.direction === 'UP' ? <>cần trả thêm <b>{vnd(q.proration.amountDue)}</b></> : q.direction === 'DOWN' ? <>được cộng dư <b>{vnd(q.proration.creditLeft)}</b></> : 'cùng giá'}</>}</span>
                <form action={change}><input type="hidden" name="plan" value={p.code} /><button className={btnGhost}>{q?.direction === 'DOWN' ? 'Hạ xuống gói này' : 'Nâng lên gói này'}</button></form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={`${card} space-y-3`}>
        <h2 className="text-lg font-medium">Hóa đơn</h2>
        {me.invoices.length === 0 ? <Empty>Chưa có hóa đơn.</Empty> : (
          <table className="w-full text-left text-sm" data-testid="invoice-list">
            <thead><tr className="border-b text-slate-500"><th className="py-1">Số</th><th>Gói</th><th>Kỳ</th><th className="text-right">Số tiền</th><th>Trạng thái</th><th /></tr></thead>
            <tbody>
              {me.invoices.map((i) => (
                <tr key={i.id} className="border-b last:border-0">
                  <td className="py-1 font-mono">{i.number}</td>
                  <td>{i.planName}{i.kind === 'UPGRADE' && ' (nâng cấp)'}</td>
                  <td>{fmtDate(i.periodStart, tz)} – {fmtDate(i.periodEnd, tz)}</td>
                  <td className="text-right">{vnd(i.amount)}</td>
                  <td>{i.status === 'PAID' ? <span className="text-green-700">Đã thanh toán</span> : i.status === 'OPEN' ? <span className="text-amber-700">Chờ thanh toán</span> : <span className="text-slate-400">Đã hủy</span>}</td>
                  <td className="text-right">{i.status === 'OPEN' && <Link href={`${BACK}/pay/${i.id}`} className="underline">Thanh toán</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {sess.permissions.has('data.export') && (
        <section className={`${card} space-y-2`}>
          <h2 className="text-lg font-medium">Dữ liệu của bạn</h2>
          <p className="text-sm text-slate-600">Tải toàn bộ dữ liệu cửa hàng (thiết bị, khách, đơn thuê, tiền, hợp đồng…) bất cứ lúc nào, kể cả khi tài khoản chỉ đọc.</p>
          <a href="/settings/subscription/export" className={`${btnGhost} inline-block`} data-testid="export-link">Tải dữ liệu (ZIP)</a>
        </section>
      )}
    </div>
  );
}
