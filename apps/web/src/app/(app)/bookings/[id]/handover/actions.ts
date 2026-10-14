'use server';

import { ValidationError, deliverBooking, receiveBooking, type HandoverItemInput } from '@rentpro/db';
import { CONDITIONS, zonedTimeToUtc, type FeeKind } from '@rentpro/core';
import { okUrl, parseAccessories, parseMoney, photosOf } from '@/lib/forms';
import { run, withService } from '@/lib/service';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

async function itemsOf(f: FormData, withFee: boolean): Promise<HandoverItemInput[]> {
  const n = Number(f.get('count') ?? 0);
  const out: HandoverItemInput[] = [];
  for (let i = 0; i < n; i++) {
    const condition = str(f, `condition_${i}`);
    if (!(CONDITIONS as readonly string[]).includes(condition)) throw new ValidationError('Tình trạng thiết bị không hợp lệ.');
    out.push({
      unitId: str(f, `unit_${i}`), condition: condition as HandoverItemInput['condition'], notes: str(f, `notes_${i}`) || null,
      accessories: parseAccessories(f.get(`acc_${i}`)), photos: await photosOf(f, `photos_${i}`),
      ...(withFee && str(f, `fee_${i}`) ? { damageFee: parseMoney(f.get(`fee_${i}`), 'Phí hư hỏng') } : {}),
    });
  }
  return out;
}

export async function deliverAction(id: string, f: FormData) {
  const back = `/bookings/${id}/handover`;
  await run(back, async () => {
    const items = await itemsOf(f, false);
    await withService((c) => deliverBooking(c, id, { items, notes: str(f, 'notes') || null }));
    return okUrl(`/bookings/${id}`, 'Đã giao thiết bị. Đơn chuyển sang "Đang thuê".');
  });
}

export async function receiveAction(id: string, f: FormData) {
  const back = `/bookings/${id}/handover`;
  await run(back, async () => {
    const items = await itemsOf(f, true);
    const at = str(f, 'returnedAt');
    const extra = str(f, 'extraAmount') ? [{ kind: (str(f, 'extraKind') === 'DAMAGE' ? 'DAMAGE' : 'OTHER') as FeeKind & ('DAMAGE' | 'OTHER'), description: str(f, 'extraDesc'), amount: parseMoney(f.get('extraAmount'), 'Phí khác') }] : [];
    const r = await withService((c, s) => {
      const returnedAt = at ? zonedTimeToUtc(at, s.tenant.timezone) : undefined;
      if (at && !returnedAt) throw new ValidationError('Giờ nhận không hợp lệ.');
      return receiveBooking(c, id, { items, extraFees: extra, notes: str(f, 'notes') || null, returnedAt: returnedAt ?? undefined });
    });
    const parts = ['Đã nhận thiết bị về.'];
    if (r.fees.length) parts.push(`Phí phát sinh: ${r.fees.map((x) => `${x.description} ${x.amount.toLocaleString('vi-VN')} đ`).join('; ')}.`);
    if (r.issues.length) parts.push(`Cần lưu ý: ${r.issues.map((x) => x.detail).join(' ')}`);
    if (r.warnings.length) parts.push(r.warnings.join(' '));
    return okUrl(`/bookings/${id}`, parts.join(' '));
  });
}
