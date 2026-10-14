import Link from 'next/link';
import { PlatformError, businessMetrics, createCoupon, getBillingConfig, listCoupons, listInvoices, markInvoicePaid, setBillingConfig, setCouponActive } from '@rentpro/db';
import { platformCan } from '@rentpro/core';
import { act, fmtDate, vnd } from '@/lib/act';
import { actorOf, db, requireCan, requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';
const BACK = '/billing';
const box = 'rounded-lg bg-white p-5 shadow-sm space-y-3';
const input = 'rounded border px-3 py-2';

const Card = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
  <div className="rounded-lg bg-white p-4 shadow-sm"><div className="text-sm text-slate-500">{label}</div><div className="text-2xl font-semibold">{value}</div>{sub && <div className="text-xs text-slate-500">{sub}</div>}</div>
);

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string; days?: string }> }) {
  const user = await requireUser();
  await requireCan('billing.view');
  const q = await searchParams;
  const days = [30, 90, 365].includes(Number(q.days)) ? Number(q.days) : 30;
  const now = new Date();
  const range = { from: new Date(now.getTime() - days * 86_400_000), to: new Date(now.getTime() + 1) };
  const [m, open, recent, coupons, cfg] = await Promise.all([
    businessMetrics(db(), range, now), listInvoices(db(), { status: 'OPEN', limit: 50 }), listInvoices(db(), { status: 'PAID', limit: 10 }), listCoupons(db()), getBillingConfig(db()),
  ]);
  const canConfirm = platformCan(user.role, 'billing.confirm');
  const canCoupon = platformCan(user.role, 'coupon.manage');
  const canPlan = platformCan(user.role, 'plan.manage');

  async function confirm(invoiceId: string, f: FormData) {
    'use server';
    const u = await requireCan('billing.confirm');
    await act(BACK, async () => { await markInvoicePaid(db(), actorOf(u), { invoiceId, by: `${u.email}${f.get('note') ? `: ${String(f.get('note'))}` : ''}`, provider: 'MANUAL' }); });
  }
  async function addCoupon(f: FormData) {
    'use server';
    const u = await requireCan('coupon.manage');
    await act(BACK, async () => {
      const num = (k: string) => { const v = String(f.get(k) ?? '').replace(/[.,\s]/g, ''); return v ? Number(v) : null; };
      const until = String(f.get('until') ?? '');
      await createCoupon(db(), actorOf(u), {
        code: String(f.get('code') ?? ''), description: String(f.get('desc') ?? ''), percentOff: num('percent'), amountOff: num('amount'),
        planCodes: String(f.get('plans') ?? '').split(',').map((s) => s.trim()).filter(Boolean), maxRedemptions: num('max'), validUntil: until ? new Date(`${until}T16:59:59Z`) : null,
      });
    });
  }
  async function toggleCoupon(id: string, active: boolean) {
    'use server';
    const u = await requireCan('coupon.manage');
    await act(BACK, async () => { await setCouponActive(db(), actorOf(u), id, active); });
  }
  async function saveConfig(f: FormData) {
    'use server';
    const u = await requireCan('plan.manage');
    await act(BACK, async () => {
      const n = (k: string) => Number(String(f.get(k) ?? '').trim());
      if ([n('trial'), n('grace'), n('lock')].some(Number.isNaN)) throw new PlatformError('Các số ngày phải là số nguyên.');
      await setBillingConfig(db(), actorOf(u), { trialDays: n('trial'), graceDays: n('grace'), lockDays: n('lock') });
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Thuê bao &amp; doanh thu</h1>
        <div className="flex gap-2 text-sm">{[30, 90, 365].map((d) => <Link key={d} href={`${BACK}?days=${d}`} className={`rounded border px-3 py-1 ${d === days ? 'bg-slate-900 text-white' : 'bg-white'}`}>{d} ngày</Link>)}</div>
      </div>
      {q.error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{q.error}</p>}
      {q.ok && <p role="status" className="rounded bg-green-50 p-3 text-sm text-green-700">Đã lưu.</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4" data-testid="metrics">
        <Card label="MRR" value={vnd(m.mrr)} sub={`${m.payingTenants} khách đang trả phí`} />
        <Card label="ARR" value={vnd(m.arr)} />
        <Card label={`Khách mới (${days} ngày)`} value={m.newCustomers} />
        <Card label={`Rời bỏ (${days} ngày)`} value={m.churned} sub="chuyển chỉ đọc/khóa do hết hạn" />
        <Card label="Dùng thử bắt đầu" value={m.trialStarted} />
        <Card label="Đã chuyển sang trả phí" value={m.trialConverted} />
        <Card label="Tỷ lệ chuyển đổi" value={m.conversionRate === null ? '—' : `${Math.round(m.conversionRate * 100)}%`} />
      </div>

      <section className={box}>
        <h2 className="font-medium">Khách theo gói</h2>
        <table className="w-full text-left text-sm" data-testid="by-plan">
          <thead><tr className="border-b text-slate-500"><th>Gói</th><th>Đang trả</th><th>Dùng thử</th><th className="text-right">MRR</th></tr></thead>
          <tbody>{m.byPlan.map((p) => <tr key={p.plan} className="border-b last:border-0"><td>{p.name}</td><td>{p.tenants}</td><td>{p.trial}</td><td className="text-right">{vnd(p.mrr)}</td></tr>)}</tbody>
        </table>
      </section>

      <section className={box}>
        <h2 className="font-medium">Doanh thu theo tháng (hóa đơn đã thu)</h2>
        {m.revenueByMonth.length === 0 ? <p className="text-sm text-slate-500">Chưa có hóa đơn nào được thanh toán.</p> : (
          <ul className="grid gap-1 text-sm md:grid-cols-3" data-testid="revenue-by-month">{m.revenueByMonth.map((r) => <li key={r.month} className="flex justify-between rounded border px-3 py-1"><span>{r.month}</span><b>{vnd(r.revenue)}</b></li>)}</ul>
        )}
      </section>

      <section className={box}>
        <h2 className="font-medium">Sắp hết hạn (14 ngày tới)</h2>
        {m.expiringSoon.length === 0 ? <p className="text-sm text-slate-500">Không có.</p> : (
          <ul className="space-y-1 text-sm" data-testid="expiring">{m.expiringSoon.map((t) => <li key={t.id}><Link href={`/tenants/${t.id}`} className="underline">{t.name}</Link> · {t.plan} · {t.kind === 'TRIAL' ? 'hết dùng thử' : 'hết hạn gói'} {fmtDate(t.endsAt)}</li>)}</ul>
        )}
      </section>

      <section className={box} data-testid="open-invoices">
        <h2 className="font-medium">Hóa đơn chờ thanh toán ({open.length})</h2>
        {open.length === 0 ? <p className="text-sm text-slate-500">Không có hóa đơn nào chờ.</p> : (
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th>Số</th><th>Khách</th><th>Gói</th><th className="text-right">Số tiền</th><th>Mã CK</th><th /></tr></thead>
            <tbody>
              {open.map((i) => (
                <tr key={i.id} className="border-b last:border-0">
                  <td className="py-1 font-mono">{i.number}</td><td><Link href={`/tenants/${i.tenant_id}`} className="underline">{i.tenant_name}</Link></td><td>{i.plan_name}</td>
                  <td className="text-right">{vnd(i.amount)}</td><td className="font-mono">{i.pay_code}</td>
                  <td className="text-right">{canConfirm && <form action={confirm.bind(null, i.id)} className="flex justify-end gap-1"><input name="note" placeholder="Mã GD ngân hàng" className={`${input} w-40 py-1`} /><button className="rounded bg-green-700 px-3 py-1 text-white">Xác nhận đã nhận tiền</button></form>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {recent.length > 0 && <p className="text-xs text-slate-500">Gần đây đã thu: {recent.map((i) => `${i.number} (${i.tenant_name}, ${vnd(i.amount)})`).join(' · ')}</p>}
      </section>

      <section className={box} data-testid="coupons">
        <h2 className="font-medium">Mã giảm giá</h2>
        {coupons.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b text-slate-500"><th>Mã</th><th>Giảm</th><th>Áp dụng</th><th>Đã dùng</th><th>Hạn</th><th /></tr></thead>
            <tbody>
              {coupons.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="py-1 font-mono">{c.code}</td><td>{c.percent_off ? `${c.percent_off}%` : vnd(c.amount_off ?? 0)}</td><td>{c.plan_codes?.join(', ') ?? 'mọi gói'}</td>
                  <td>{c.redeemed}{c.max_redemptions ? ` / ${c.max_redemptions}` : ''}</td><td>{c.valid_until ? fmtDate(c.valid_until) : '—'}</td>
                  <td className="text-right">{canCoupon && <form action={toggleCoupon.bind(null, c.id, !c.active)}><button className="rounded border px-3 py-1">{c.active ? 'Tắt' : 'Bật lại'}</button></form>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canCoupon && (
          <form action={addCoupon} className="flex flex-wrap items-end gap-2" data-testid="coupon-form">
            <input name="code" placeholder="MÃ (VD KHAITRUONG)" className={input} required />
            <input name="percent" placeholder="Giảm %" className={`${input} w-24`} />
            <input name="amount" placeholder="hoặc giảm đ" className={`${input} w-32`} />
            <input name="plans" placeholder="Gói (vd pro,basic) – trống = mọi gói" className={`${input} w-64`} />
            <input name="max" placeholder="Số lượt tối đa" className={`${input} w-32`} />
            <label className="text-sm">Hạn<input type="date" name="until" className={`${input} ml-2`} /></label>
            <input name="desc" placeholder="Ghi chú" className={input} />
            <button className="rounded bg-slate-900 px-4 py-2 text-white">Tạo mã</button>
          </form>
        )}
      </section>

      {canPlan && (
        <section className={box}>
          <h2 className="font-medium">Chính sách dùng thử và hết hạn</h2>
          <form action={saveConfig} className="flex flex-wrap items-end gap-2" data-testid="billing-config">
            <label className="text-sm">Dùng thử (ngày)<input name="trial" defaultValue={cfg.trialDays} className={`${input} ml-2 w-20`} /></label>
            <label className="text-sm">Ân hạn trước khi chỉ đọc (ngày)<input name="grace" defaultValue={cfg.graceDays} className={`${input} ml-2 w-20`} /></label>
            <label className="text-sm">Chỉ đọc trước khi khóa (ngày)<input name="lock" defaultValue={cfg.lockDays} className={`${input} ml-2 w-20`} /></label>
            <button className="rounded bg-slate-900 px-4 py-2 text-white">Lưu</button>
          </form>
          <p className="text-xs text-slate-500">Không bao giờ tự xóa dữ liệu: sau khi khóa, dữ liệu vẫn được giữ và mở lại ngay khi gia hạn.</p>
        </section>
      )}
    </div>
  );
}
