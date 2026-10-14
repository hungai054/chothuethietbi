import {
  BOOKING_STATUS_LABEL, CONDITIONS, CONDITION_LABEL, assertBookingTransition, compareHandover, lateFee,
  type AccessoryCheck, type BookingStatus, type HandoverIssue, type HandoverItemData, type ItemCondition, type LateFeeResult, type QuoteInput, type Settlement,
} from '@rentpro/core';
import { lockBooking, shortenLocked } from './booking';
import { computeLedger, handoverRules, insertFee, storePhoto } from './finance';
import { setUnitStatus } from './inventory';
import { createDamageOrder } from './maintenance';
import { NotFoundError, ValidationError, audit, guard, need, type ServiceCtx } from './service';

type Row = Record<string, any>;
const MAX_PHOTOS = 5;

export interface HandoverItemInput {
  /** Hàng theo từng chiếc */
  unitId?: string | null;
  /** Hàng theo số lượng */
  modelId?: string | null;
  qty?: number;
  condition: ItemCondition;
  accessories?: AccessoryCheck[];
  notes?: string | null;
  photos?: { data: Uint8Array }[];
  /** Chỉ khi nhận về: phí hư hỏng cho chiếc này (VND) */
  damageFee?: number;
}

const money = (n: number) => `${n.toLocaleString('vi-VN')} đ`;

function cleanAccessories(a: AccessoryCheck[] | undefined): AccessoryCheck[] {
  return (a ?? []).map((x) => {
    if (!x.name?.trim() || !Number.isInteger(x.expected) || !Number.isInteger(x.actual) || x.expected < 0 || x.actual < 0 || x.expected > 1000 || x.actual > 1000)
      throw new ValidationError('Phụ kiện phải có tên và số lượng là số nguyên không âm.');
    return { name: x.name.trim(), expected: x.expected, actual: x.actual };
  });
}

async function saveItems(ctx: ServiceCtx, handoverId: string, items: HandoverItemInput[], stored: string[]): Promise<void> {
  for (const it of items) {
    const photos = it.photos ?? [];
    if (photos.length > MAX_PHOTOS) throw new ValidationError(`Tối đa ${MAX_PHOTOS} ảnh cho mỗi thiết bị.`);
    const paths: string[] = [];
    for (const ph of photos) { const p = await storePhoto(ctx, ph.data, 'handover'); paths.push(p); stored.push(p); }
    await ctx.db.query(
      `INSERT INTO handover_item(tenant_id,handover_id,unit_id,model_id,qty,condition,accessories,notes,photo_paths) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.tenantId, handoverId, it.unitId ?? null, it.unitId ? null : it.modelId ?? null, it.qty ?? 1, it.condition, JSON.stringify(cleanAccessories(it.accessories)), it.notes?.trim() || null, paths]);
  }
}

/** Kiểm tra danh sách thiết bị trong biên bản khớp đúng với thiết bị đã phân bổ cho đơn. */
function validateCoverage(items: HandoverItemInput[], units: Row[], qtyModels: Row[], kind: 'DELIVERY' | 'RETURN'): HandoverItemInput[] {
  const seen = new Set<string>();
  const out: HandoverItemInput[] = [];
  for (const it of items) {
    if (!CONDITIONS.includes(it.condition)) throw new ValidationError('Tình trạng thiết bị không hợp lệ.');
    if (it.unitId) {
      const u = units.find((x) => x.unit_id === it.unitId);
      if (!u) throw new ValidationError('Có thiết bị không thuộc đơn này trong biên bản.');
      if (seen.has(it.unitId)) throw new ValidationError(`Thiết bị ${u.barcode} bị ghi hai lần.`);
      seen.add(it.unitId);
    } else if (it.modelId) {
      if (!qtyModels.some((q) => q.model_id === it.modelId)) throw new ValidationError('Có mẫu hàng không thuộc đơn này trong biên bản.');
      if (seen.has(`m:${it.modelId}`)) throw new ValidationError('Một mẫu hàng bị ghi hai lần.');
      seen.add(`m:${it.modelId}`);
    } else throw new ValidationError('Mỗi dòng biên bản cần một thiết bị hoặc một mẫu hàng.');
    if (kind === 'DELIVERY' && it.condition === 'MISSING') throw new ValidationError('Không thể giao thiết bị ở tình trạng "mất".');
    if (it.condition === 'DAMAGED' && !it.notes?.trim()) throw new ValidationError('Thiết bị hư hỏng cần ghi chú mô tả tình trạng.');
    out.push(it);
  }
  const missing = units.filter((u) => !seen.has(u.unit_id));
  if (missing.length) throw new ValidationError(`Chưa quét/ghi nhận: ${missing.map((m) => m.barcode).join(', ')}.`);
  for (const q of qtyModels) if (!seen.has(`m:${q.model_id}`)) out.push({ modelId: q.model_id, qty: q.qty, condition: 'GOOD' });
  return out;
}

async function loadAllocations(ctx: ServiceCtx, bookingId: string, status: string) {
  const units = (await ctx.db.query(
    `SELECT a.id AS alloc_id, a.unit_id, u.barcode, u.status, u.model_id, u.compensation_value, u.purchase_price, m.compensation_value AS model_comp, m.name AS model_name
     FROM unit_allocation a JOIN equipment_unit u ON u.id=a.unit_id JOIN equipment_model m ON m.id=u.model_id
     WHERE a.booking_id=$1 AND a.status=$2 ORDER BY u.barcode`, [bookingId, status])).rows;
  const qtyModels = (await ctx.db.query(
    `SELECT q.model_id, q.qty, m.name FROM qty_allocation q JOIN equipment_model m ON m.id=q.model_id WHERE q.booking_id=$1 AND q.status=$2`, [bookingId, status])).rows;
  return { units, qtyModels };
}

// ===== Giao thiết bị =====
export async function deliverBooking(ctx: ServiceCtx, bookingId: string, input: { items: HandoverItemInput[]; notes?: string | null }): Promise<{ handoverId: string }> {
  guard(ctx, 'booking.handover', 'booking', { write: true });
  const b = await lockBooking(ctx, bookingId);
  if (b.status === 'ACTIVE') throw new ValidationError('Đơn này đã được giao.');
  if (b.status !== 'CONFIRMED') throw new ValidationError(`Chỉ giao được đơn đã xác nhận (đơn đang ở trạng thái "${BOOKING_STATUS_LABEL[b.status as BookingStatus]}").`);
  assertBookingTransition('CONFIRMED', 'ACTIVE');

  const rules = await handoverRules(ctx);
  if (ctx.features.contract && rules.requireContract) {
    const c = (await ctx.db.query(`SELECT status FROM contract WHERE booking_id=$1 AND status <> 'VOID'`, [bookingId])).rows[0];
    if (!c) throw new ValidationError('Chưa có hợp đồng. Hãy lập và ký hợp đồng trước khi giao thiết bị.');
    if (c.status !== 'SIGNED') throw new ValidationError('Hợp đồng chưa được ký. Hãy ký hợp đồng trước khi giao thiết bị.');
  }
  if (ctx.features.deposit && rules.requireDeposit && Number(b.deposit_required) > 0) {
    const l = await computeLedger(ctx, bookingId);
    if (!l.deposit.satisfied)
      throw new ValidationError(`Chưa đủ tiền cọc: cần ${money(l.deposit.required)}, hiện có ${money(l.deposit.heldMoney + l.deposit.heldAssets)} (thiếu ${money(l.deposit.shortfall)}).`);
  }

  const { units, qtyModels } = await loadAllocations(ctx, bookingId, 'CONFIRMED');
  if (units.length === 0 && qtyModels.length === 0) throw new ValidationError('Đơn chưa có thiết bị được phân bổ.');
  const items = validateCoverage(input.items, units, qtyModels, 'DELIVERY');
  const notReady = units.filter((u) => u.status !== 'AVAILABLE');
  if (notReady.length) throw new ValidationError(`Thiết bị chưa sẵn sàng để giao: ${notReady.map((u) => `${u.barcode} (${u.status})`).join(', ')}. Hãy đổi sang chiếc khác.`);

  const stored: string[] = [];
  try {
    for (const u of units) {
      await setUnitStatus(ctx, u.unit_id, 'RESERVED', `Chuẩn bị giao (đơn ${b.code})`);
      await setUnitStatus(ctx, u.unit_id, 'RENTED', `Giao cho khách (đơn ${b.code})`);
    }
    await ctx.db.query(`UPDATE unit_allocation SET status='ACTIVE' WHERE booking_id=$1 AND status='CONFIRMED'`, [bookingId]);
    await ctx.db.query(`UPDATE qty_allocation SET status='ACTIVE' WHERE booking_id=$1 AND status='CONFIRMED'`, [bookingId]);
    await ctx.db.query(`UPDATE booking SET status='ACTIVE', delivered_at=now() WHERE id=$1`, [bookingId]);
    const h = (await ctx.db.query('INSERT INTO handover(tenant_id,booking_id,kind,performed_by,notes) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [ctx.tenantId, bookingId, 'DELIVERY', ctx.userId, input.notes?.trim() || null])).rows[0];
    await saveItems(ctx, h.id, items, stored);
    await ctx.db.query('INSERT INTO booking_status_log(tenant_id,booking_id,from_status,to_status,user_id,reason) VALUES ($1,$2,$3,$4,$5,$6)', [ctx.tenantId, bookingId, 'CONFIRMED', 'ACTIVE', ctx.userId, 'Giao thiết bị']);
    await audit(ctx, 'booking.deliver', 'booking', bookingId, { handoverId: h.id, units: units.map((u) => u.barcode) });
    return { handoverId: h.id };
  } catch (e) {
    await Promise.all(stored.map((p) => ctx.storage!.delete(p).catch(() => undefined)));
    throw e;
  }
}

// ===== Nhận thiết bị về =====
export interface ReceiveInput {
  items: HandoverItemInput[];
  /** Phí khác do nhân viên nhập (thiếu phụ kiện, vệ sinh…) */
  extraFees?: { kind: 'DAMAGE' | 'OTHER'; description: string; amount: number }[];
  returnedAt?: Date;
  notes?: string | null;
}

export interface ReceiveResult {
  late: LateFeeResult;
  issues: HandoverIssue[];
  fees: { kind: string; description: string; amount: number }[];
  warnings: string[];
  settlement: Settlement;
}

export async function receiveBooking(ctx: ServiceCtx, bookingId: string, input: ReceiveInput): Promise<ReceiveResult> {
  guard(ctx, 'booking.handover', 'booking', { write: true });
  const b = await lockBooking(ctx, bookingId);
  if (b.status === 'RETURNED' || b.status === 'CLOSED') throw new ValidationError('Đơn này đã nhận lại thiết bị.');
  if (b.status !== 'ACTIVE') throw new ValidationError(`Chỉ nhận lại được đơn đang thuê (đơn đang ở trạng thái "${BOOKING_STATUS_LABEL[b.status as BookingStatus]}").`);
  assertBookingTransition('ACTIVE', 'RETURNED');

  const now = new Date();
  const returnedAt = input.returnedAt ?? now;
  if (returnedAt.getTime() > now.getTime() + 5 * 60_000) throw new ValidationError('Giờ nhận lại không được ở tương lai.');
  if (b.delivered_at && returnedAt.getTime() < b.delivered_at.getTime()) throw new ValidationError('Giờ nhận lại không được trước giờ giao.');

  const { units, qtyModels } = await loadAllocations(ctx, bookingId, 'ACTIVE');
  const items = validateCoverage(input.items, units, qtyModels, 'RETURN');
  for (const f of input.extraFees ?? []) {
    if (!f.description.trim()) throw new ValidationError('Phí phát sinh cần có mô tả.');
    if (!Number.isInteger(f.amount) || f.amount <= 0) throw new ValidationError('Phí phát sinh phải là số nguyên dương (VND).');
  }
  for (const it of items) if (it.damageFee !== undefined && (!Number.isInteger(it.damageFee) || it.damageFee < 0)) throw new ValidationError('Phí hư hỏng phải là số nguyên không âm.');

  const pricing = b.pricing_input as Pick<QuoteInput, 'lines' | 'config'> | null;
  if (!pricing) throw new ValidationError('Đơn này không có dữ liệu giá để tính phí trễ.');
  // Phí trễ tính theo giờ hẹn gốc, TRƯỚC khi rút ngắn
  const late = lateFee({ scheduledEnd: b.ends_at, returnedAt, lines: pricing.lines, config: pricing.config });
  const fees: ReceiveResult['fees'] = [];
  const warnings: string[] = [];

  if (returnedAt.getTime() < b.ends_at.getTime() && returnedAt.getTime() > b.starts_at.getTime()) await shortenLocked(ctx, b, returnedAt);

  if (late.amount > 0) {
    const d = `Trả trễ ${late.billedHours} giờ (đã trừ ân hạn)`;
    await insertFee(ctx, bookingId, { kind: 'LATE', description: d, amount: late.amount });
    fees.push({ kind: 'LATE', description: d, amount: late.amount });
  }

  const stored: string[] = [];
  try {
    for (const it of items) {
      if (!it.unitId) continue;
      const u = units.find((x) => x.unit_id === it.unitId)!;
      if (it.condition === 'MISSING') {
        await setUnitStatus(ctx, u.unit_id, 'LOST', `Không được trả lại (đơn ${b.code})`);
        const comp = Number(u.compensation_value ?? u.model_comp ?? u.purchase_price ?? 0);
        if (comp > 0) {
          const d = `Mất ${u.barcode} (${u.model_name})`;
          await insertFee(ctx, bookingId, { kind: 'LOSS', description: d, amount: comp, unitId: u.unit_id });
          fees.push({ kind: 'LOSS', description: d, amount: comp });
        } else warnings.push(`${u.barcode} bị mất nhưng chưa có giá trị bồi thường: hãy thêm phí bồi thường thủ công.`);
        continue;
      }
      await setUnitStatus(ctx, u.unit_id, 'INSPECTING', `Nhận lại từ khách (đơn ${b.code})`);
      if (it.condition === 'DAMAGED') {
        await setUnitStatus(ctx, u.unit_id, 'MAINTENANCE', `Hư hỏng khi trả: ${it.notes?.trim()}`);
        await createDamageOrder(ctx, { unitId: u.unit_id, bookingId, bookingCode: b.code, notes: it.notes!.trim() });
        if (it.damageFee && it.damageFee > 0) {
          const d = `Hư hỏng ${u.barcode}: ${it.notes?.trim()}`;
          await insertFee(ctx, bookingId, { kind: 'DAMAGE', description: d, amount: it.damageFee, unitId: u.unit_id });
          fees.push({ kind: 'DAMAGE', description: d, amount: it.damageFee });
        } else warnings.push(`${u.barcode} hư hỏng nhưng chưa tính phí hư hỏng: hãy cập nhật khi có chi phí sửa chữa.`);
      } else {
        await setUnitStatus(ctx, u.unit_id, 'AVAILABLE', `Kiểm tra xong, sẵn sàng cho thuê (đơn ${b.code})`);
      }
    }
    for (const f of input.extraFees ?? []) {
      await insertFee(ctx, bookingId, { kind: f.kind, description: f.description, amount: f.amount });
      fees.push({ kind: f.kind, description: f.description.trim(), amount: f.amount });
    }

    await ctx.db.query(`UPDATE unit_allocation SET status='RELEASED' WHERE booking_id=$1 AND status='ACTIVE'`, [bookingId]);
    await ctx.db.query(`UPDATE qty_allocation SET status='RELEASED' WHERE booking_id=$1 AND status='ACTIVE'`, [bookingId]);
    await ctx.db.query(`UPDATE booking SET status='RETURNED', returned_at=$2 WHERE id=$1`, [bookingId, returnedAt]);
    const h = (await ctx.db.query('INSERT INTO handover(tenant_id,booking_id,kind,performed_by,performed_at,notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [ctx.tenantId, bookingId, 'RETURN', ctx.userId, returnedAt, input.notes?.trim() || null])).rows[0];
    await saveItems(ctx, h.id, items, stored);
    await ctx.db.query('INSERT INTO booking_status_log(tenant_id,booking_id,from_status,to_status,user_id,reason) VALUES ($1,$2,$3,$4,$5,$6)', [ctx.tenantId, bookingId, 'ACTIVE', 'RETURNED', ctx.userId, 'Nhận lại thiết bị']);
    await audit(ctx, 'booking.receive', 'booking', bookingId, { handoverId: h.id, late: late.amount, fees });
  } catch (e) {
    await Promise.all(stored.map((p) => ctx.storage!.delete(p).catch(() => undefined)));
    throw e;
  }

  const { issues } = await getHandoversInternal(ctx, bookingId);
  const l = await computeLedger(ctx, bookingId);
  return { late, issues, fees, warnings, settlement: l.settlement };
}

// ===== Đóng đơn =====
/** Đóng đơn khi đã quyết toán xong: không còn nợ, không còn phải hoàn, đã trả hết tài sản thế chấp. */
export async function closeBooking(ctx: ServiceCtx, bookingId: string): Promise<void> {
  guard(ctx, 'booking.handover', 'booking', { write: true });
  const b = await lockBooking(ctx, bookingId);
  if (b.status !== 'RETURNED') throw new ValidationError(b.status === 'CLOSED' ? 'Đơn đã được đóng.' : 'Chỉ đóng được đơn đã nhận lại thiết bị.');
  const l = await computeLedger(ctx, bookingId);
  const problems: string[] = [];
  if (l.settlement.balanceOwed > 0) problems.push(`khách còn nợ ${money(l.settlement.balanceOwed)}`);
  if (l.settlement.refundDue > 0) problems.push(`cần hoàn lại cho khách ${money(l.settlement.refundDue)}`);
  const heldAssets = l.assets.filter((a) => a.status === 'HELD');
  if (heldAssets.length) problems.push(`còn giữ tài sản thế chấp: ${heldAssets.map((a) => a.description).join(', ')}`);
  if (problems.length) throw new ValidationError(`Chưa đóng được đơn: ${problems.join('; ')}.`);
  assertBookingTransition('RETURNED', 'CLOSED');
  await ctx.db.query(`UPDATE booking SET status='CLOSED', closed_at=now() WHERE id=$1`, [bookingId]);
  await ctx.db.query('INSERT INTO booking_status_log(tenant_id,booking_id,from_status,to_status,user_id,reason) VALUES ($1,$2,$3,$4,$5,$6)', [ctx.tenantId, bookingId, 'RETURNED', 'CLOSED', ctx.userId, 'Đã quyết toán']);
  await audit(ctx, 'booking.close', 'booking', bookingId, { total: l.booking.total, fees: l.settlement.fees });
}

// ===== Xem biên bản =====
export interface HandoverView {
  id: string; kind: 'DELIVERY' | 'RETURN'; performedAt: Date; notes: string | null;
  items: { id: string; unitId: string | null; modelId: string | null; label: string; qty: number; condition: ItemCondition; conditionLabel: string; accessories: AccessoryCheck[]; notes: string | null; photoCount: number }[];
}

async function getHandoversInternal(ctx: ServiceCtx, bookingId: string): Promise<{ delivery: HandoverView | null; ret: HandoverView | null; issues: HandoverIssue[] }> {
  const hs = (await ctx.db.query('SELECT * FROM handover WHERE booking_id=$1', [bookingId])).rows;
  const view = async (h: Row | undefined): Promise<HandoverView | null> => {
    if (!h) return null;
    const rows = (await ctx.db.query(
      `SELECT i.*, u.barcode, COALESCE(m1.name, m2.name) AS model_name FROM handover_item i
       LEFT JOIN equipment_unit u ON u.id=i.unit_id LEFT JOIN equipment_model m1 ON m1.id=u.model_id LEFT JOIN equipment_model m2 ON m2.id=i.model_id
       WHERE i.handover_id=$1 ORDER BY u.barcode NULLS LAST, model_name`, [h.id])).rows;
    return {
      id: h.id, kind: h.kind, performedAt: h.performed_at, notes: h.notes,
      items: rows.map((r) => ({
        id: r.id, unitId: r.unit_id, modelId: r.model_id, label: r.barcode ? `${r.barcode} · ${r.model_name}` : `${r.model_name} × ${r.qty}`, qty: r.qty,
        condition: r.condition, conditionLabel: CONDITION_LABEL[r.condition as ItemCondition], accessories: r.accessories as AccessoryCheck[], notes: r.notes, photoCount: (r.photo_paths as string[]).length,
      })),
    };
  };
  const delivery = await view(hs.find((h) => h.kind === 'DELIVERY'));
  const ret = await view(hs.find((h) => h.kind === 'RETURN'));
  const data = (v: HandoverView): HandoverItemData[] => v.items.map((i) => ({ key: i.unitId ?? `m:${i.modelId}`, label: i.label, condition: i.condition, accessories: i.accessories, notes: i.notes }));
  return { delivery, ret, issues: delivery && ret ? compareHandover(data(delivery), data(ret)) : [] };
}

export async function getHandovers(ctx: ServiceCtx, bookingId: string) {
  guard(ctx, 'booking.view', 'booking');
  if (!(await ctx.db.query('SELECT 1 FROM booking WHERE id=$1 AND deleted_at IS NULL', [bookingId])).rowCount) throw new NotFoundError('đơn thuê');
  return getHandoversInternal(ctx, bookingId);
}

export async function getHandoverPhoto(ctx: ServiceCtx, itemId: string, index: number) {
  guard(ctx, 'booking.view', 'booking');
  const it = (await ctx.db.query('SELECT photo_paths FROM handover_item WHERE id=$1', [itemId])).rows[0];
  const path = (it?.photo_paths as string[] | undefined)?.[index];
  if (!path) throw new NotFoundError('ảnh');
  const f = await need(ctx.storage, 'storage').get(path);
  if (!f) throw new NotFoundError('ảnh');
  return f;
}
