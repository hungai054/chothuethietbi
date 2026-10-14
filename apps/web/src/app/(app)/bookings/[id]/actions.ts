'use server';

import { addDepositAsset, addFee, closeBooking, createContract, listFieldDefs, recordPayment, returnDepositAsset, setDepositRequired, signContract, voidContract, voidFee, voidPayment } from '@rentpro/db';
import { PAYMENT_METHODS, type FeeKind, type PaymentKind, type PaymentMethod } from '@rentpro/core';
import { dataUrlBytes, okUrl, parseMoney, photosOf, readCustomForm } from '@/lib/forms';
import { run, withService } from '@/lib/service';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function createContractAction(id: string, f: FormData) {
  const back = `/bookings/${id}`;
  await run(back, async () => { await withService(async (c) => createContract(c, id, readCustomForm(f, await listFieldDefs(c, 'CONTRACT')))); return okUrl(back, 'Đã lập hợp đồng.'); });
}

export async function signContractAction(id: string, contractId: string, f: FormData) {
  const back = `/bookings/${id}`;
  await run(back, async () => {
    const mode = str(f, 'mode') === 'ESIGN' ? 'ESIGN' : 'PAPER';
    await withService((c) => signContract(c, contractId, { mode, customerName: str(f, 'customerName') || undefined, customerSignature: dataUrlBytes(f.get('customerSignature')), staffSignature: dataUrlBytes(f.get('staffSignature')) }));
    return okUrl(back, 'Đã ký hợp đồng.');
  });
}

export async function voidContractAction(id: string, contractId: string, f: FormData) {
  const back = `/bookings/${id}`;
  await run(back, async () => { await withService((c) => voidContract(c, contractId, str(f, 'reason'))); return okUrl(back, 'Đã hủy hợp đồng.'); });
}

export async function recordPaymentAction(id: string, f: FormData) {
  const back = `/bookings/${id}`;
  await run(back, async () => {
    const method = str(f, 'method') as PaymentMethod;
    const r = await withService((c) => recordPayment(c, {
      bookingId: id, kind: str(f, 'kind') as PaymentKind, method: (PAYMENT_METHODS as readonly string[]).includes(method) ? method : 'CASH',
      amount: parseMoney(f.get('amount')), reference: str(f, 'reference') || null, note: str(f, 'note') || null, idempotencyKey: str(f, 'key') || null,
    }));
    return okUrl(back, r.duplicate ? 'Khoản này đã được ghi trước đó (không ghi trùng).' : 'Đã ghi khoản thanh toán.');
  });
}

export async function voidPaymentAction(id: string, paymentId: string, f: FormData) {
  const back = `/bookings/${id}`;
  await run(back, async () => { await withService((c) => voidPayment(c, paymentId, str(f, 'reason'))); return okUrl(back, 'Đã hủy khoản thanh toán (vẫn lưu trong sổ).'); });
}

export async function addFeeAction(id: string, f: FormData) {
  const back = `/bookings/${id}`;
  await run(back, async () => {
    await withService((c) => addFee(c, id, { kind: str(f, 'kind') as FeeKind, description: str(f, 'description'), amount: parseMoney(f.get('amount')) }));
    return okUrl(back, 'Đã thêm khoản phí.');
  });
}

export async function voidFeeAction(id: string, feeId: string, f: FormData) {
  const back = `/bookings/${id}`;
  await run(back, async () => { await withService((c) => voidFee(c, feeId, str(f, 'reason'))); return okUrl(back, 'Đã hủy khoản phí.'); });
}

export async function setDepositAction(id: string, f: FormData) {
  const back = `/bookings/${id}`;
  await run(back, async () => { await withService((c) => setDepositRequired(c, id, parseMoney(f.get('amount'), 'Mức cọc'))); return okUrl(back, 'Đã cập nhật mức cọc.'); });
}

export async function addAssetAction(id: string, f: FormData) {
  const back = `/bookings/${id}`;
  await run(back, async () => {
    const photos = await photosOf(f, 'photos');
    await withService((c) => addDepositAsset(c, id, { description: str(f, 'description'), estimatedValue: str(f, 'value') ? parseMoney(f.get('value'), 'Giá trị') : 0, storageLocation: str(f, 'location') || null, photos }));
    return okUrl(back, 'Đã nhận tài sản thế chấp.');
  });
}

export async function returnAssetAction(id: string, assetId: string, f: FormData) {
  const back = `/bookings/${id}`;
  await run(back, async () => { await withService((c) => returnDepositAsset(c, assetId, str(f, 'note'))); return okUrl(back, 'Đã trả tài sản cho khách.'); });
}

export async function closeBookingAction(id: string) {
  const back = `/bookings/${id}`;
  await run(back, async () => { await withService((c) => closeBooking(c, id)); return okUrl(back, 'Đã đóng đơn.'); });
}
