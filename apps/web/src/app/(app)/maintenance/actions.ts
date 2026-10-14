'use server';

import { ORDER_KINDS, zonedTimeToUtc, type OrderKind } from '@rentpro/core';
import {
  ValidationError, addOrderPhotos, cancelOrder, chargeCustomer, createMaintenancePlan, createOrder, disposeOrder, finishOrder, lookupForMaintenance, markUnrepairable, setMaintenancePlanActive,
  startOrder, toggleChecklist, updateOrder,
} from '@rentpro/db';
import type { ScanResult } from '@/components/scanner';
import { okUrl, parseMoney, photosOf } from '@/lib/forms';
import { run, safe, withService } from '@/lib/service';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const lines = (f: FormData, k: string) => str(f, k).split('\n').map((x) => x.trim()).filter(Boolean);
const optInt = (f: FormData, k: string) => (str(f, k) ? Number(str(f, k)) : null);

function localDate(v: string, tz: string): Date | null {
  if (!v) return null;
  const d = zonedTimeToUtc(v, tz);
  if (!d) throw new ValidationError('Thời gian không hợp lệ.');
  return d;
}

export async function createOrderAction(f: FormData) {
  await run('/maintenance/new', async () => {
    const kind = str(f, 'kind') as OrderKind;
    const id = await withService((c, s) => createOrder(c, {
      unitId: str(f, 'unitId'), kind: (ORDER_KINDS as readonly string[]).includes(kind) ? kind : 'OTHER', title: str(f, 'title'), description: str(f, 'description'),
      technicianId: str(f, 'technicianId') || null, vendor: str(f, 'vendor') || null, dueDate: str(f, 'dueDate') || null, checklist: lines(f, 'checklist'),
      windowStart: localDate(str(f, 'windowStart'), s.tenant.timezone), windowEnd: localDate(str(f, 'windowEnd'), s.tenant.timezone),
    }));
    return okUrl(`/maintenance/${id}`, 'Đã tạo phiếu.');
  });
}

export async function createPlanAction(f: FormData) {
  await run('/maintenance/plans', async () => {
    await withService((c) => createMaintenancePlan(c, {
      name: str(f, 'name'), modelId: str(f, 'modelId'), unitId: str(f, 'unitId') || null, everyDays: optInt(f, 'everyDays'), everyHours: optInt(f, 'everyHours'),
      everyRentals: optInt(f, 'everyRentals'), durationHours: optInt(f, 'durationHours') ?? 4, checklist: lines(f, 'checklist'),
    }));
    return okUrl('/maintenance/plans', 'Đã tạo kế hoạch bảo trì.');
  });
}

export async function togglePlanAction(id: string, active: boolean) {
  await run('/maintenance/plans', async () => { await withService((c) => setMaintenancePlanActive(c, id, active)); return okUrl('/maintenance/plans', active ? 'Đã bật kế hoạch.' : 'Đã tắt kế hoạch.'); });
}

export async function startAction(id: string) {
  const back = `/maintenance/${id}`;
  await run(back, async () => {
    const r = await withService((c) => startOrder(c, id));
    return okUrl(back, ['Đã bắt đầu. Thiết bị chuyển sang trạng thái Bảo trì.', ...r.warnings].join(' '));
  });
}

export async function finishAction(id: string, f: FormData) {
  const back = `/maintenance/${id}`;
  await run(back, async () => { await withService((c) => finishOrder(c, id, { note: str(f, 'note') })); return okUrl(back, 'Đã hoàn thành phiếu. Thiết bị sẵn sàng cho thuê.'); });
}

export async function unrepairableAction(id: string, f: FormData) {
  const back = `/maintenance/${id}`;
  await run(back, async () => { await withService((c) => markUnrepairable(c, id, str(f, 'reason'))); return okUrl(back, 'Đã ghi nhận không sửa được.'); });
}

export async function disposeAction(id: string, f: FormData) {
  const back = `/maintenance/${id}`;
  await run(back, async () => { await withService((c) => disposeOrder(c, id, str(f, 'reason'))); return okUrl(back, 'Đã thanh lý thiết bị.'); });
}

export async function cancelAction(id: string, f: FormData) {
  const back = `/maintenance/${id}`;
  await run(back, async () => { await withService((c) => cancelOrder(c, id, str(f, 'reason'))); return okUrl(back, 'Đã hủy phiếu.'); });
}

export async function updateAction(id: string, f: FormData) {
  const back = `/maintenance/${id}`;
  await run(back, async () => {
    const parts = lines(f, 'parts').map((l) => {
      const [name, qty, cost] = l.split('|').map((x) => x.trim());
      return { name: name ?? '', qty: Number(qty ?? 1), unitCost: Number(String(cost ?? '0').replace(/[.,\s]/g, '')) };
    });
    await withService((c) => updateOrder(c, id, {
      title: str(f, 'title'), description: str(f, 'description'), technicianId: str(f, 'technicianId') || null, vendor: str(f, 'vendor'), dueDate: str(f, 'dueDate') || null,
      laborCost: str(f, 'laborCost') ? parseMoney(f.get('laborCost'), 'Tiền công') : 0, vendorCost: str(f, 'vendorCost') ? parseMoney(f.get('vendorCost'), 'Chi phí sửa ngoài') : 0, parts,
    }));
    return okUrl(back, 'Đã lưu phiếu.');
  });
}

export async function checklistAction(id: string, index: number, done: boolean) {
  await run(`/maintenance/${id}`, async () => { await withService((c) => toggleChecklist(c, id, index, done)); });
}

export async function photosAction(id: string, when: 'before' | 'after', f: FormData) {
  const back = `/maintenance/${id}`;
  await run(back, async () => {
    const photos = await photosOf(f, 'photos');
    await withService((c) => addOrderPhotos(c, id, when, photos));
    return okUrl(back, 'Đã thêm ảnh.');
  });
}

export async function chargeAction(id: string, f: FormData) {
  const back = `/maintenance/${id}`;
  await run(back, async () => {
    await withService((c) => chargeCustomer(c, id, { amount: str(f, 'amount') ? parseMoney(f.get('amount')) : undefined, description: str(f, 'description') || undefined }));
    return okUrl(back, 'Đã chuyển chi phí thành khoản phí hư hỏng trên đơn thuê.');
  });
}

export async function scanAction(code: string): Promise<ScanResult> {
  const r = await safe(() => withService((c) => lookupForMaintenance(c, code)));
  if (!r.ok) return { tone: 'error', text: r.error };
  if (!r.data) return { tone: 'error', text: 'Không tìm thấy thiết bị với mã này.' };
  return r.data.openOrderId
    ? { tone: 'ok', text: `${r.data.barcode} · ${r.data.modelName}: mở phiếu đang làm`, href: `/maintenance/${r.data.openOrderId}` }
    : { tone: 'warn', text: `${r.data.barcode} · ${r.data.modelName}: chưa có phiếu, bấm để tạo`, href: `/maintenance/new?unit=${r.data.unitId}` };
}
