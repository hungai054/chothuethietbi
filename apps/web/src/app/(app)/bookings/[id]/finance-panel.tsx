import Link from 'next/link';
import { FEE_KIND_LABEL, FEE_KINDS, PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, PAYMENT_METHODS, PAYMENT_STATUS_LABEL, type PaymentKind } from '@rentpro/core';
import { ValidationError, bookingLedger, getContract, getHandovers, listFieldDefs, suggestBookingDeposit, vietQrFor } from '@rentpro/db';
import { CustomFieldInputs } from '@/components/custom-fields';
import { SignaturePad } from '@/components/signature-pad';
import { btn, btnGhost, card, input } from '@/components/ui';
import { fmtDateTime, vnd } from '@/lib/format';
import { withService } from '@/lib/service';
import {
  addAssetAction, addFeeAction, closeBookingAction, createContractAction, recordPaymentAction, returnAssetAction, setDepositAction, signContractAction,
  voidContractAction, voidFeeAction, voidPaymentAction,
} from './actions';

const maybe = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
  try { return await fn(); } catch (e) { if (e instanceof ValidationError) return null; throw e; }
};

/** Hợp đồng, thanh toán, cọc, tài sản thế chấp, quyết toán và lối vào biên bản giao/nhận của một đơn. */
export async function FinancePanel({ id, status, tz }: { id: string; status: string; tz: string }) {
  const d = await withService(async (c, s) => {
    const has = (p: Parameters<typeof s.permissions.has>[0]) => s.permissions.has(p);
    const f = s.tenant.features;
    const showContract = f.contract && has('contract.view');
    const showMoney = f.payments && has('payment.view');
    const contract = showContract ? await getContract(c, id) : null;
    const contractDefs = showContract ? await listFieldDefs(c, 'CONTRACT') : [];
    const ledger = showMoney ? await bookingLedger(c, id) : null;
    const handovers = await getHandovers(c, id);
    const qr = ledger && f.payments ? await maybe(() => vietQrFor(c, id, ledger.settlement.balanceOwed > 0 ? ledger.settlement.balanceOwed : null)) : null;
    const suggestion = ledger && has('deposit.collect') && f.deposit && ['QUOTE', 'HOLD', 'CONFIRMED'].includes(status) ? await maybe(() => suggestBookingDeposit(c, id)) : null;
    return { showContract, showMoney, contract, contractDefs, ledger, handovers, qr, suggestion, f, can: { handover: has('booking.handover'), create: has('contract.create'), sign: has('contract.sign'), pay: has('payment.create'), collect: has('deposit.collect'), refund: has('deposit.refund'), depositView: has('deposit.view') } };
  });
  const { contract, ledger, handovers, qr, suggestion, f, can } = d;
  const active = contract?.active ?? null;
  const key = crypto.randomUUID();
  const kinds: PaymentKind[] = [
    ...(can.pay ? (['RENT', 'FEE'] as const) : []), ...(can.collect && f.deposit ? (['DEPOSIT'] as const) : []), ...(can.refund ? (['REFUND', 'WRITE_OFF'] as const) : []),
  ];
  const closed = status === 'CLOSED' || status === 'CANCELLED';
  const st = ledger?.settlement;

  return (
    <>
      <section className={`${card} space-y-2`} data-testid="handover-section">
        <h2 className="font-medium">Giao / nhận thiết bị</h2>
        <div className="flex flex-wrap gap-2 text-sm">
          {can.handover && status === 'CONFIRMED' && <Link className={btn} href={`/bookings/${id}/handover`}>Giao thiết bị</Link>}
          {can.handover && status === 'ACTIVE' && <Link className={btn} href={`/bookings/${id}/handover`}>Nhận thiết bị về</Link>}
          {(handovers.delivery || handovers.ret) && <Link className={btnGhost} href={`/bookings/${id}/handover/print`}>Xem / in biên bản</Link>}
        </div>
        {handovers.delivery && <p className="text-sm text-slate-600">Đã giao lúc {fmtDateTime(handovers.delivery.performedAt, tz)}{handovers.ret && ` · đã nhận về lúc ${fmtDateTime(handovers.ret.performedAt, tz)}`}</p>}
        {handovers.issues.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-red-700" data-testid="handover-issues">{handovers.issues.map((i, n) => <li key={n}>{i.detail}</li>)}</ul>
        )}
      </section>

      {d.showContract && (
        <section className={`${card} space-y-3`} data-testid="contract-section">
          <h2 className="font-medium">Hợp đồng</h2>
          {!active && can.create && ['CONFIRMED', 'ACTIVE'].includes(status) && (
            <form action={createContractAction.bind(null, id)} className="space-y-3">
              <CustomFieldInputs defs={d.contractDefs} />
              <button className={btn}>Lập hợp đồng</button>
            </form>
          )}
          {!active && !['CONFIRMED', 'ACTIVE'].includes(status) && <p className="text-sm text-slate-500">Hợp đồng được lập sau khi đơn được xác nhận.</p>}
          {active && (
            <div className="space-y-3 text-sm">
              <p>
                <b data-testid="contract-number">{active.number}</b> ·{' '}
                {active.status === 'SIGNED' ? <span className="text-green-700" data-testid="contract-status">Đã ký {active.signMode === 'ESIGN' ? '(điện tử)' : '(bản giấy)'}{active.signedAt && ` lúc ${fmtDateTime(active.signedAt, tz)}`}</span> : <span className="text-amber-700" data-testid="contract-status">Chưa ký</span>}{' '}
                · <Link className="underline" href={`/bookings/${id}/contract`}>Xem / in hợp đồng</Link>
              </p>
              {active.status === 'DRAFT' && can.sign && (
                <div className="space-y-3">
                  {f['contract.e_signature'] && (
                    <form action={signContractAction.bind(null, id, active.id)} className="space-y-2 rounded border p-3">
                      <input type="hidden" name="mode" value="ESIGN" />
                      <div className="font-medium">Ký trên màn hình</div>
                      <input name="customerName" placeholder="Tên người ký (khách)" defaultValue={active.content.customer.name} className={`${input} max-w-sm`} />
                      <div className="flex flex-wrap gap-4"><SignaturePad name="customerSignature" label="Chữ ký khách hàng (Bên B)" /><SignaturePad name="staffSignature" label="Chữ ký nhân viên (Bên A)" /></div>
                      <button className={btn}>Xác nhận ký điện tử</button>
                    </form>
                  )}
                  <form action={signContractAction.bind(null, id, active.id)} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="mode" value="PAPER" />
                    <button className={btnGhost}>Đã ký bản giấy</button>
                  </form>
                </div>
              )}
              {active.status === 'SIGNED' && active.hasCustomerSignature && (
                <div className="flex flex-wrap gap-4">
                  
                  <figure><img src={`/media/signature/${active.id}/customer`} alt="Chữ ký khách" className="h-20 rounded border bg-white" /><figcaption className="text-xs text-slate-500">Khách: {active.signedCustomerName}</figcaption></figure>
                  
                  {active.hasStaffSignature && <figure><img src={`/media/signature/${active.id}/staff`} alt="Chữ ký nhân viên" className="h-20 rounded border bg-white" /><figcaption className="text-xs text-slate-500">Nhân viên</figcaption></figure>}
                </div>
              )}
              {can.create && status !== 'ACTIVE' && !closed && status !== 'RETURNED' && (
                <form action={voidContractAction.bind(null, id, active.id)} className="flex flex-wrap items-end gap-2">
                  <input name="reason" required placeholder="Lý do hủy hợp đồng" className={`${input} max-w-xs`} />
                  <button className={btnGhost}>Hủy hợp đồng</button>
                </form>
              )}
            </div>
          )}
          {contract && contract.voided.length > 0 && <p className="text-xs text-slate-500">Hợp đồng đã hủy: {contract.voided.map((v) => `${v.number} (${v.voidReason})`).join('; ')}</p>}
        </section>
      )}

      {ledger && st && (
        <section className={`${card} space-y-4`} data-testid="finance-section">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium">Thanh toán và cọc</h2>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs" data-testid="payment-status">{PAYMENT_STATUS_LABEL[ledger.paymentStatus]}</span>
          </div>

          <table className="w-full text-sm" data-testid="settlement">
            <tbody>
              <tr><td>Tiền thuê</td><td className="text-right">{vnd(st.rentTotal)}</td></tr>
              {ledger.fees.filter((x) => !x.voidedAt).map((x) => (
                <tr key={x.id}><td>{FEE_KIND_LABEL[x.kind]}: {x.description}
                  {can.handover && !closed && (
                    <form action={voidFeeAction.bind(null, id, x.id)} className="ml-2 inline-flex gap-1"><input name="reason" required placeholder="Lý do hủy" className="rounded border px-1 text-xs" /><button className="text-xs underline">Hủy phí</button></form>
                  )}</td><td className="text-right">{vnd(x.amount)}</td></tr>
              ))}
              <tr className="border-t font-medium"><td>Tổng phải thu</td><td className="text-right">{vnd(st.charges)}</td></tr>
              <tr><td>Đã thu (tiền thuê + phí)</td><td className="text-right">{vnd(st.collected)}</td></tr>
              <tr><td>Cọc đang giữ (tiền)</td><td className="text-right" data-testid="deposit-held">{vnd(st.depositHeld)}</td></tr>
              <tr><td>Cọc đã trừ vào khoản phải thu</td><td className="text-right">{vnd(st.depositApplied)}</td></tr>
              {st.writtenOff > 0 && <tr><td>Đã xóa nợ</td><td className="text-right">{vnd(st.writtenOff)}</td></tr>}
              <tr className="border-t font-semibold"><td>{st.refundDue > 0 ? 'Cần hoàn lại khách' : 'Khách còn nợ'}</td><td className="text-right" data-testid="settle-amount">{vnd(st.refundDue > 0 ? st.refundDue : st.balanceOwed)}</td></tr>
            </tbody>
          </table>

          <div>
            <h3 className="mb-1 text-sm font-medium">Cọc</h3>
            <p className="text-sm text-slate-700" data-testid="deposit-summary">
              Yêu cầu {vnd(ledger.deposit.required)} · đã có {vnd(ledger.deposit.heldMoney + ledger.deposit.heldAssets)} (tiền {vnd(ledger.deposit.heldMoney)}, tài sản {vnd(ledger.deposit.heldAssets)})
              {ledger.deposit.shortfall > 0 ? <span className="text-red-700"> · thiếu {vnd(ledger.deposit.shortfall)}</span> : ledger.deposit.required > 0 ? <span className="text-green-700"> · đủ</span> : null}
            </p>
            {suggestion && suggestion.amount > 0 && <p className="text-xs text-slate-500">Gợi ý theo quy tắc cửa hàng: {vnd(suggestion.amount)}{suggestion.warning ? ` — ${suggestion.warning}` : ''}</p>}
            {can.collect && !closed && (
              <form action={setDepositAction.bind(null, id)} className="mt-2 flex flex-wrap items-end gap-2">
                <label className="text-sm">Mức cọc yêu cầu (đ)<input name="amount" inputMode="numeric" defaultValue={ledger.deposit.required} className={`${input} mt-1 w-40`} /></label>
                <button className={btnGhost}>Đặt mức cọc</button>
              </form>
            )}
          </div>

          <div>
            <h3 className="mb-1 text-sm font-medium">Sổ thanh toán</h3>
            {ledger.payments.length === 0 ? <p className="text-sm text-slate-500">Chưa có khoản nào.</p> : (
              <ul className="space-y-1 text-sm" data-testid="payment-list">
                {ledger.payments.map((p) => (
                  <li key={p.id} className={p.voidedAt ? 'text-slate-400 line-through' : ''}>
                    {fmtDateTime(p.paidAt, tz)} · {PAYMENT_KIND_LABEL[p.kind]} · {PAYMENT_METHOD_LABEL[p.method]} · <b>{vnd(p.amount)}</b>{p.reference ? ` · ${p.reference}` : ''}{p.note ? ` · ${p.note}` : ''}
                    {p.voidedAt && <span className="no-underline"> (đã hủy: {p.voidReason})</span>}
                    <Link className="ml-2 text-xs underline" href={`/bookings/${id}/receipt/${p.id}`}>In phiếu</Link>
                    {!p.voidedAt && can.refund && !closed && (
                      <form action={voidPaymentAction.bind(null, id, p.id)} className="ml-2 inline-flex gap-1"><input name="reason" required placeholder="Lý do hủy" className="rounded border px-1 text-xs" /><button className="text-xs underline">Hủy khoản</button></form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {kinds.length > 0 && !closed && (
              <form action={recordPaymentAction.bind(null, id)} className="mt-3 grid gap-2 rounded border p-3 md:grid-cols-6" data-testid="payment-form">
                <input type="hidden" name="key" value={key} />
                <label className="text-sm">Loại<select name="kind" className={`${input} mt-1`}>{kinds.map((k) => <option key={k} value={k}>{PAYMENT_KIND_LABEL[k]}</option>)}</select></label>
                <label className="text-sm">Hình thức<select name="method" className={`${input} mt-1`}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}</select></label>
                <label className="text-sm">Số tiền (đ)<input name="amount" required inputMode="numeric" className={`${input} mt-1`} /></label>
                <label className="text-sm">Mã giao dịch<input name="reference" className={`${input} mt-1`} /></label>
                <label className="text-sm">Ghi chú<input name="note" className={`${input} mt-1`} /></label>
                <div className="flex items-end"><button className={btn}>Ghi khoản</button></div>
              </form>
            )}
            {can.handover && ['ACTIVE', 'RETURNED'].includes(status) && (
              <form action={addFeeAction.bind(null, id)} className="mt-3 grid gap-2 rounded border p-3 md:grid-cols-4">
                <label className="text-sm">Loại phí<select name="kind" className={`${input} mt-1`}>{FEE_KINDS.map((k) => <option key={k} value={k}>{FEE_KIND_LABEL[k]}</option>)}</select></label>
                <label className="text-sm">Mô tả<input name="description" required className={`${input} mt-1`} /></label>
                <label className="text-sm">Số tiền (đ)<input name="amount" required inputMode="numeric" className={`${input} mt-1`} /></label>
                <div className="flex items-end"><button className={btnGhost}>Thêm phí</button></div>
              </form>
            )}
          </div>

          {qr && !closed && (
            <div className="flex flex-wrap items-center gap-4" data-testid="qr-box">
              
              <img src={`/bookings/${id}/qr${st.balanceOwed > 0 ? `?amount=${st.balanceOwed}` : ''}`} alt="Mã QR chuyển khoản" width={160} height={160} className="rounded border bg-white" />
              <p className="text-sm text-slate-600">QR chuyển khoản VietQR<br />Tài khoản: {qr.bankLabel}<br />Nội dung: <b>{qr.memo}</b>{st.balanceOwed > 0 ? <><br />Số tiền: <b>{vnd(st.balanceOwed)}</b></> : <><br />Khách tự nhập số tiền.</>}</p>
            </div>
          )}

          {(d.f.deposit && (can.depositView || can.collect)) && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Tài sản thế chấp</h3>
              {ledger.assets.length === 0 ? <p className="text-sm text-slate-500">Không có.</p> : (
                <ul className="space-y-2 text-sm" data-testid="asset-list">
                  {ledger.assets.map((a) => (
                    <li key={a.id} className="rounded border p-2">
                      <b>{a.description}</b> · giá trị {vnd(a.estimatedValue)}{a.storageLocation ? ` · cất tại ${a.storageLocation}` : ''} · {a.status === 'HELD' ? <span className="text-amber-700">Đang giữ</span> : <span className="text-slate-500">Đã trả {a.returnedAt && fmtDateTime(a.returnedAt, tz)}{a.returnNote ? ` (${a.returnNote})` : ''}</span>}
                      <div className="mt-1 flex gap-1">{Array.from({ length: a.photoCount }, (_, n) => (

                        <img key={n} src={`/media/asset/${a.id}/${n}`} alt={`Ảnh ${a.description} ${n + 1}`} className="h-16 rounded border" />
                      ))}</div>
                      {a.status === 'HELD' && can.collect && (
                        <form action={returnAssetAction.bind(null, id, a.id)} className="mt-1 flex flex-wrap gap-2"><input name="note" required placeholder="Ghi chú trả (VD: khách nhận lại)" className={`${input} max-w-xs`} /><button className={btnGhost}>Trả tài sản</button></form>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {can.collect && !closed && (
                <form action={addAssetAction.bind(null, id)} className="mt-2 grid gap-2 rounded border p-3 md:grid-cols-5" data-testid="asset-form">
                  <label className="text-sm">Mô tả<input name="description" required placeholder="CCCD gốc, xe máy…" className={`${input} mt-1`} /></label>
                  <label className="text-sm">Giá trị ước tính (đ)<input name="value" inputMode="numeric" className={`${input} mt-1`} /></label>
                  <label className="text-sm">Nơi cất giữ<input name="location" className={`${input} mt-1`} /></label>
                  <label className="text-sm">Ảnh<input name="photos" type="file" accept="image/*" multiple className={`${input} mt-1`} /></label>
                  <div className="flex items-end"><button className={btnGhost}>Nhận tài sản</button></div>
                </form>
              )}
            </div>
          )}

          {status === 'RETURNED' && can.handover && (
            <form action={closeBookingAction.bind(null, id)}><button className={btn} data-testid="close-booking">Đóng đơn</button><span className="ml-2 text-xs text-slate-500">Đóng được khi đã thu/hoàn đủ và trả hết tài sản thế chấp.</span></form>
          )}
        </section>
      )}
    </>
  );
}
