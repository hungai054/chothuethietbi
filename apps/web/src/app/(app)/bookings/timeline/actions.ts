'use server';

import { ValidationError, createBooking, moveBooking, swapUnit } from '@rentpro/db';
import { safe, withService } from '@/lib/service';

type Result = { ok: true; message?: string; url?: string } | { ok: false; error: string };

const date = (iso: string): Date => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new ValidationError('Thời gian không hợp lệ.');
  return d;
};

/** Kéo thanh sang trái/phải: dời cả đơn. Mọi kiểm tra trùng lịch nằm ở service và ràng buộc DB, không phải ở trình duyệt. */
export async function moveAction(bookingId: string, newStartIso: string): Promise<Result> {
  const r = await safe(() => withService((c) => moveBooking(c, bookingId, date(newStartIso))));
  return r.ok ? { ok: true, message: 'Đã dời lịch.' } : r;
}

/** Kéo thanh sang hàng khác (cùng mẫu): đổi chiếc. */
export async function swapAction(allocationId: string, unitId: string): Promise<Result> {
  const r = await safe(() => withService((c) => swapUnit(c, allocationId, unitId)));
  return r.ok ? { ok: true, message: 'Đã đổi thiết bị.' } : r;
}

/** Kéo trên hàng trống: tạo giữ chỗ cho đúng chiếc đó. */
export async function createAction(input: { unitId: string; modelId: string; customerId: string; startIso: string; endIso: string }): Promise<Result> {
  if (!input.customerId) return { ok: false, error: 'Hãy chọn khách hàng.' };
  const r = await safe(() => withService((c) => createBooking(c, {
    customerId: input.customerId, lines: [{ modelId: input.modelId, qty: 1, unitId: input.unitId }], start: date(input.startIso), end: date(input.endIso), status: 'HOLD',
  })));
  return r.ok ? { ok: true, message: `Đã giữ chỗ ${r.data.code}.`, url: `/bookings/${r.data.id}` } : r;
}
