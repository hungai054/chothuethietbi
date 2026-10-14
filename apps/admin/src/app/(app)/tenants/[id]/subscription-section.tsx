import { PlatformError, createSubscriptionInvoice, extendSubscriptionManual, getSubscription, listInvoices, listPlans, markInvoicePaid, voidInvoice } from '@rentpro/db';
import { platformCan } from '@rentpro/core';
import { act, fmtDate, vnd } from '@/lib/act';
import { actorOf, db, requireCan, requireUser } from '@/lib/session';

const box = 'rounded-lg bg-white p-5 shadow-sm space-y-3';
const input = 'rounded border px-3 py-2';

/** Thuê bao của một khách hàng: hiện trạng, hóa đơn (xác nhận chuyển khoản), gia hạn thủ công cho hợp đồng ký ngoài. */
export async function SubscriptionSection({ tenantId }: { tenantId: string }) {
  const user = await requireUser();
  const back = `/tenants/${tenantId}`;
  const [sub, invoices, plans, events] = await Promise.all([
    getSubscription(db(), tenantId), listInvoices(db(), { tenantId, limit: 20 }), listPlans(db()),
    db().query('SELECT kind, plan_code, cycle, mrr, amount, period_end, at FROM subscription_event WHERE tenant_id=$1 ORDER BY id DESC LIMIT 12', [tenantId]).then((r) => r.rows),
  ]);
  const canConfirm = platformCan(user.role, 'billing.confirm');

  async function confirm(invoiceId: string, f: FormData) {
    'use server';
    const u = await requireCan('billing.confirm');
    await act(back, async () => { await markInvoicePaid(db(), actorOf(u), { invoiceId, by: `${u.email}${f.get('note') ? `: ${String(f.get('note'))}` : ''}`, provider: 'MANUAL' }); });
  }
  async function voidIt(invoiceId: string, f: FormData) {
    'use server';
    const u = await requireCan('billing.confirm');
    await act(back, async () => { await voidInvoice(db(), actorOf(u), invoiceId, String(f.get('reason') ?? '')); });
  }
  async function create(f: FormData) {
    'use server';
    const u = await requireCan('billing.confirm');
    await act(back, async () => {
      await createSubscriptionInvoice(db(), actorOf(u), { tenantId, planCode: String(f.get('plan')), cycle: String(f.get('cycle')), couponCode: String(f.get('coupon') ?? '').trim() || null });
    });
  }
  async function extend(f: FormData) {
    'use server';
    const u = await requireCan('billing.confirm');
    await act(back, async () => {
      const unlimited = f.get('unlimited') === 'on';
      const end = String(f.get('ends') ?? '');
      if (!unlimited && !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new PlatformError('Nhập ngày hết hạn hoặc chọn "không thời hạn".');
      const amount = String(f.get('amount') ?? '').replace(/[.,\s]/g, '');
      await extendSubscriptionManual(db(), actorOf(u), {
        tenantId, planCode: String(f.get('plan')), cycle: String(f.get('cycle')), endsAt: unlimited ? null : new Date(`${end}T16:59:59Z`), // hết ngày theo giờ Việt Nam
        amount: amount ? Number(amount) : undefined, note: String(f.get('note') ?? '') || undefined,
      });
    });
  }

  return (
    <section className={box} data-testid="subscription-section">
      <h2 className="font-medium">Thuê bao &amp; hóa đơn</h2>
      {sub ? (
        <p className="text-sm" data-testid="sub-current">Gói <b>{sub.plan_name}</b> · chu kỳ {sub.cycle === 'YEAR' ? 'năm' : 'tháng'} · kỳ {fmtDate(sub.period_start)} – {sub.period_end ? fmtDate(sub.period_end) : 'không thời hạn'} · MRR {vnd(sub.mrr)}{Number(sub.credit) > 0 && <> · số dư {vnd(sub.credit)}</>}</p>
      ) : <p className="text-sm text-slate-500">Chưa có thuê bao trả phí (đang dùng thử hoặc hợp đồng chưa nhập).</p>}

      {invoices.length > 0 && (
        <table className="w-full text-left text-sm" data-testid="tenant-invoices">
          <thead><tr className="border-b text-slate-500"><th>Số</th><th>Gói</th><th>Kỳ</th><th className="text-right">Số tiền</th><th>Mã CK</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} className="border-b align-top last:border-0">
                <td className="py-1 font-mono">{i.number}</td><td>{i.plan_name}{i.kind === 'UPGRADE' ? ' (nâng cấp)' : ''}</td>
                <td>{fmtDate(i.period_start)} – {fmtDate(i.period_end)}</td><td className="text-right">{vnd(i.amount)}</td>
                <td className="font-mono">{i.pay_code}</td>
                <td>{i.status === 'PAID' ? <span className="text-green-700">Đã trả{i.paid_by ? ` (${i.paid_by.split(':')[0]})` : ''}</span> : i.status === 'OPEN' ? <span className="text-amber-700">Chờ trả</span> : <span className="text-slate-400">Đã hủy</span>}</td>
                <td className="space-y-1 text-right">
                  {i.status === 'OPEN' && canConfirm && (
                    <>
                      <form action={confirm.bind(null, i.id)} className="flex justify-end gap-1"><input name="note" placeholder="Ghi chú (mã GD ngân hàng)" className={`${input} w-48 py-1`} /><button className="rounded bg-green-700 px-3 py-1 text-white" data-testid={`confirm-${i.number}`}>Xác nhận đã nhận tiền</button></form>
                      <form action={voidIt.bind(null, i.id)} className="flex justify-end gap-1"><input name="reason" placeholder="Lý do hủy" className={`${input} w-48 py-1`} /><button className="rounded border px-3 py-1">Hủy</button></form>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canConfirm && (
        <>
          <form action={create} className="flex flex-wrap items-end gap-2" data-testid="admin-invoice-form">
            <label className="text-sm">Tạo hóa đơn<select name="plan" className={`${input} ml-2`}>{plans.filter((p) => Number(p.price_month) > 0).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></label>
            <select name="cycle" className={input}><option value="MONTH">Tháng</option><option value="YEAR">Năm</option></select>
            <input name="coupon" placeholder="Mã giảm giá" className={input} />
            <button className="rounded bg-slate-900 px-4 py-2 text-white">Tạo hóa đơn</button>
          </form>
          <form action={extend} className="space-y-2 rounded border p-3" data-testid="manual-extend">
            <p className="text-sm font-medium">Gia hạn / kích hoạt thủ công (hợp đồng ký ngoài)</p>
            <div className="flex flex-wrap items-end gap-2">
              <select name="plan" className={input}>{plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
              <select name="cycle" className={input}><option value="YEAR">Năm</option><option value="MONTH">Tháng</option></select>
              <label className="text-sm">Hết hạn<input type="date" name="ends" className={`${input} ml-2`} /></label>
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="unlimited" /> Không thời hạn</label>
              <input name="amount" placeholder="Số tiền đã thu (đ)" className={input} />
              <input name="note" placeholder="Ghi chú (số hợp đồng)" className={input} />
              <button className="rounded bg-slate-900 px-4 py-2 text-white">Áp dụng</button>
            </div>
          </form>
        </>
      )}

      {events.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-slate-600">Lịch sử thuê bao</summary>
          <ul className="mt-2 text-xs text-slate-600" data-testid="sub-events">
            {events.map((e, i) => <li key={i}>{fmtDate(e.at)} · {e.kind}{e.plan_code ? ` · ${e.plan_code}` : ''}{Number(e.amount) > 0 ? ` · ${vnd(e.amount)}` : ''}{e.period_end ? ` · đến ${fmtDate(e.period_end)}` : ''}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
