import {
  FINANCE_SETTINGS_VERSION, FinanceSettingsSchema, PAYMENT_KINDS, PAYMENT_METHODS, applyDepositHook, buildVietQrPayload, computeSettlement, firstZodMessage,
  paymentStatus, sanitizeMemo, sniffImage, suggestDeposit, upgradeFinanceSettings, validateBankAccount, validateDocPattern, DEFAULT_HANDOVER,
  type FinanceSettings, type PaymentKind, type PaymentMethod, type Settlement, type FeeKind, type PaymentStatus, FEE_KINDS, ID_IMAGE_MAX_BYTES, VietQrError,
} from '@rentpro/core';
import { NotFoundError, ValidationError, audit, guard, need, type ServiceCtx } from './service';
import { newPrivatePath } from './storage';

type Row = Record<string, any>;

// ===== Cấu hình =====
export async function rawFinanceSettings(ctx: ServiceCtx): Promise<FinanceSettings> {
  const r = (await ctx.db.query('SELECT settings FROM tenant WHERE id=$1', [ctx.tenantId])).rows[0];
  return upgradeFinanceSettings(r?.settings?.finance);
}

export async function getFinanceSettings(ctx: ServiceCtx): Promise<FinanceSettings> {
  guard(ctx, 'settings.manage', 'payments');
  return rawFinanceSettings(ctx);
}

export async function updateFinanceSettings(ctx: ServiceCtx, patch: unknown): Promise<FinanceSettings> {
  guard(ctx, 'settings.manage', 'payments', { write: true });
  const p = FinanceSettingsSchema.safeParse({ v: FINANCE_SETTINGS_VERSION, ...(patch as object) });
  if (!p.success) throw new ValidationError(firstZodMessage(p.error));
  if (p.data.contractPattern) {
    const bad = validateDocPattern(p.data.contractPattern);
    if (bad) throw new ValidationError(bad);
  }
  if (p.data.bank) {
    const bad = validateBankAccount(p.data.bank);
    if (bad) throw new ValidationError(bad);
  }
  const clean = JSON.parse(JSON.stringify(p.data)) as FinanceSettings;
  await ctx.db.query(`UPDATE tenant SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{finance}', $2::jsonb, true) WHERE id=$1`, [ctx.tenantId, JSON.stringify(clean)]);
  await audit(ctx, 'settings.finance', 'tenant', ctx.tenantId, { ...clean, bank: clean.bank ? { bin: clean.bank.bin, account: '***' + clean.bank.account.slice(-4) } : undefined });
  return clean;
}

// ===== Sổ cái của một đơn =====
export interface LedgerPayment { id: string; kind: PaymentKind; method: PaymentMethod; amount: number; reference: string | null; note: string | null; paidAt: Date; voidedAt: Date | null; voidReason: string | null }
export interface LedgerFee { id: string; kind: FeeKind; description: string; amount: number; unitId: string | null; createdAt: Date; voidedAt: Date | null; voidReason: string | null }
export interface LedgerAsset { id: string; description: string; estimatedValue: number; storageLocation: string | null; photoCount: number; status: 'HELD' | 'RETURNED'; receivedAt: Date; returnedAt: Date | null; returnNote: string | null }

export interface Ledger {
  booking: { id: string; code: string; status: string; total: number; depositRequired: number };
  payments: LedgerPayment[]; fees: LedgerFee[]; assets: LedgerAsset[];
  settlement: Settlement; paymentStatus: PaymentStatus;
  /** Cọc đã có (tiền + giá trị tài sản đang giữ) so với mức yêu cầu */
  deposit: { required: number; heldMoney: number; heldAssets: number; shortfall: number; satisfied: boolean };
}

export async function computeLedger(ctx: ServiceCtx, bookingId: string): Promise<Ledger> {
  const b = (await ctx.db.query('SELECT id, code, status, total, deposit_required FROM booking WHERE id=$1 AND deleted_at IS NULL', [bookingId])).rows[0];
  if (!b) throw new NotFoundError('đơn thuê');
  const pays = (await ctx.db.query('SELECT * FROM payment WHERE booking_id=$1 ORDER BY paid_at, created_at', [bookingId])).rows;
  const fees = (await ctx.db.query('SELECT * FROM booking_fee WHERE booking_id=$1 ORDER BY created_at', [bookingId])).rows;
  const assets = (await ctx.db.query('SELECT * FROM deposit_asset WHERE booking_id=$1 ORDER BY received_at', [bookingId])).rows;
  const paid: Partial<Record<PaymentKind, number>> = {};
  for (const p of pays) if (!p.voided_at) paid[p.kind as PaymentKind] = (paid[p.kind as PaymentKind] ?? 0) + Number(p.amount);
  const feesTotal = fees.filter((f) => !f.voided_at).reduce((a, f) => a + Number(f.amount), 0);
  const settlement = computeSettlement({ rentTotal: b.status === 'CANCELLED' ? 0 : Number(b.total), fees: feesTotal, paid });
  const heldMoney = settlement.depositHeld;
  const heldAssets = assets.filter((a) => a.status === 'HELD').reduce((s, a) => s + Number(a.estimated_value), 0);
  const required = Number(b.deposit_required);
  const shortfall = Math.max(0, required - heldMoney - heldAssets);
  return {
    booking: { id: b.id, code: b.code, status: b.status, total: Number(b.total), depositRequired: required },
    payments: pays.map((p) => ({ id: p.id, kind: p.kind, method: p.method, amount: Number(p.amount), reference: p.reference, note: p.note, paidAt: p.paid_at, voidedAt: p.voided_at, voidReason: p.void_reason })),
    fees: fees.map((f) => ({ id: f.id, kind: f.kind, description: f.description, amount: Number(f.amount), unitId: f.unit_id, createdAt: f.created_at, voidedAt: f.voided_at, voidReason: f.void_reason })),
    assets: assets.map((a) => ({ id: a.id, description: a.description, estimatedValue: Number(a.estimated_value), storageLocation: a.storage_location, photoCount: (a.photo_paths as string[]).length, status: a.status, receivedAt: a.received_at, returnedAt: a.returned_at, returnNote: a.return_note })),
    settlement, paymentStatus: paymentStatus(settlement),
    deposit: { required, heldMoney, heldAssets, shortfall, satisfied: shortfall === 0 },
  };
}

export async function bookingLedger(ctx: ServiceCtx, bookingId: string): Promise<Ledger> {
  guard(ctx, 'payment.view', 'payments');
  return computeLedger(ctx, bookingId);
}

async function lockBookingRow(ctx: ServiceCtx, id: string): Promise<Row> {
  const b = (await ctx.db.query('SELECT * FROM booking WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
  if (!b) throw new NotFoundError('đơn thuê');
  return b;
}

// ===== Thanh toán =====
export interface PaymentInput {
  bookingId: string; kind: PaymentKind; method: PaymentMethod; amount: number;
  reference?: string | null; note?: string | null; idempotencyKey?: string | null;
}

const MONEY_MAX = 1_000_000_000_000;

/**
 * Ghi một khoản thu/chi. Có khóa idempotency để bấm hai lần hoặc gửi lại form không tạo khoản trùng.
 * Khóa dòng đơn trước khi kiểm tra để hai người thu cùng lúc không vượt số còn phải thu.
 */
export async function recordPayment(ctx: ServiceCtx, i: PaymentInput): Promise<{ id: string; duplicate: boolean }> {
  if (!PAYMENT_KINDS.includes(i.kind)) throw new ValidationError('Loại khoản thu không hợp lệ.');
  if (!PAYMENT_METHODS.includes(i.method)) throw new ValidationError('Hình thức thanh toán không hợp lệ.');
  if (i.kind === 'DEPOSIT') guard(ctx, 'deposit.collect', 'deposit', { write: true });
  else if (i.kind === 'REFUND') guard(ctx, 'deposit.refund', 'deposit', { write: true });
  else if (i.kind === 'WRITE_OFF') guard(ctx, 'deposit.refund', 'payments', { write: true });
  else guard(ctx, 'payment.create', 'payments', { write: true });
  if (!Number.isInteger(i.amount) || i.amount <= 0 || i.amount > MONEY_MAX) throw new ValidationError('Số tiền phải là số nguyên dương (VND).');
  if (i.kind === 'WRITE_OFF' && !i.note?.trim()) throw new ValidationError('Xóa nợ cần ghi rõ lý do.');
  if (i.idempotencyKey && i.idempotencyKey.length > 100) throw new ValidationError('Khóa chống trùng quá dài.');

  const b = await lockBookingRow(ctx, i.bookingId);
  if (i.idempotencyKey) {
    const ex = (await ctx.db.query('SELECT id, booking_id FROM payment WHERE idempotency_key=$1', [i.idempotencyKey])).rows[0];
    if (ex) {
      if (ex.booking_id !== i.bookingId) throw new ValidationError('Khóa chống trùng đã được dùng cho đơn khác.');
      return { id: ex.id, duplicate: true };
    }
  }
  if (b.status === 'QUOTE') throw new ValidationError('Đơn còn là báo giá. Hãy giữ chỗ hoặc xác nhận đơn trước khi thu tiền.');
  if (b.status === 'CLOSED') throw new ValidationError('Đơn đã đóng, không ghi thêm khoản thu chi.');

  const l = await computeLedger(ctx, i.bookingId);
  const paidOf = (k: PaymentKind) => l.payments.filter((p) => p.kind === k && !p.voidedAt).reduce((a, p) => a + p.amount, 0);
  const s = l.settlement;
  if (i.kind === 'RENT') {
    const outstanding = Math.max(0, s.rentTotal - paidOf('RENT'));
    if (i.amount > outstanding) throw new ValidationError(`Số tiền vượt quá tiền thuê còn phải thu (${outstanding.toLocaleString('vi-VN')} đ).`);
  } else if (i.kind === 'FEE') {
    const outstanding = Math.max(0, s.fees - paidOf('FEE'));
    if (i.amount > outstanding) throw new ValidationError(`Số tiền vượt quá phí còn phải thu (${outstanding.toLocaleString('vi-VN')} đ).`);
  } else if (i.kind === 'REFUND') {
    if (!['RETURNED', 'CANCELLED'].includes(b.status)) throw new ValidationError('Chỉ hoàn tiền sau khi đã nhận lại thiết bị hoặc khi đơn đã hủy.');
    if (i.amount > s.refundDue) throw new ValidationError(`Số tiền hoàn vượt quá số cửa hàng phải hoàn (${s.refundDue.toLocaleString('vi-VN')} đ).`);
  } else if (i.kind === 'WRITE_OFF') {
    if (b.status !== 'RETURNED') throw new ValidationError('Chỉ xóa nợ khi đã nhận lại thiết bị và chưa đóng đơn.');
    if (i.amount > s.balanceOwed) throw new ValidationError(`Số tiền xóa nợ vượt quá số khách còn nợ (${s.balanceOwed.toLocaleString('vi-VN')} đ).`);
  }

  const r = await ctx.db.query(
    `INSERT INTO payment(tenant_id,booking_id,kind,method,amount,reference,note,idempotency_key,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
    [ctx.tenantId, i.bookingId, i.kind, i.method, i.amount, i.reference?.trim() || null, i.note?.trim() || null, i.idempotencyKey || null, ctx.userId]);
  if (!r.rowCount) {
    const ex = (await ctx.db.query('SELECT id FROM payment WHERE idempotency_key=$1', [i.idempotencyKey])).rows[0];
    return { id: ex.id, duplicate: true };
  }
  await audit(ctx, 'payment.record', 'booking', i.bookingId, { paymentId: r.rows[0].id, kind: i.kind, method: i.method, amount: i.amount });
  return { id: r.rows[0].id, duplicate: false };
}

/** Hủy một khoản (không xóa): cần quyền quản lý và lý do. Đơn đã đóng thì không hủy được. */
export async function voidPayment(ctx: ServiceCtx, paymentId: string, reason: string): Promise<void> {
  guard(ctx, 'deposit.refund', 'payments', { write: true });
  if (!reason.trim()) throw new ValidationError('Vui lòng nhập lý do hủy khoản thu chi.');
  const p = (await ctx.db.query('SELECT id, booking_id, voided_at, amount, kind FROM payment WHERE id=$1 FOR UPDATE', [paymentId])).rows[0];
  if (!p) throw new NotFoundError('khoản thu chi');
  if (p.voided_at) throw new ValidationError('Khoản này đã được hủy trước đó.');
  const b = await lockBookingRow(ctx, p.booking_id);
  if (b.status === 'CLOSED') throw new ValidationError('Đơn đã đóng, không hủy được khoản thu chi.');
  await ctx.db.query('UPDATE payment SET voided_at=now(), void_reason=$2, voided_by=$3 WHERE id=$1', [paymentId, reason.trim(), ctx.userId]);
  await audit(ctx, 'payment.void', 'booking', p.booking_id, { paymentId, kind: p.kind, amount: Number(p.amount), reason });
}

// ===== Phí phát sinh =====
export async function addFee(ctx: ServiceCtx, bookingId: string, i: { kind: FeeKind; description: string; amount: number; unitId?: string | null }): Promise<string> {
  guard(ctx, 'booking.handover', 'payments', { write: true });
  return insertFee(ctx, bookingId, i);
}

/** Dùng nội bộ (nhận thiết bị tự sinh phí trễ/hư hỏng/mất): không kiểm tra lại quyền của người gọi. */
export async function insertFee(ctx: ServiceCtx, bookingId: string, i: { kind: FeeKind; description: string; amount: number; unitId?: string | null }): Promise<string> {
  if (!FEE_KINDS.includes(i.kind)) throw new ValidationError('Loại phí không hợp lệ.');
  if (!i.description.trim()) throw new ValidationError('Vui lòng nhập mô tả khoản phí.');
  if (!Number.isInteger(i.amount) || i.amount <= 0 || i.amount > MONEY_MAX) throw new ValidationError('Số tiền phí phải là số nguyên dương (VND).');
  const b = await lockBookingRow(ctx, bookingId);
  if (!['ACTIVE', 'RETURNED'].includes(b.status)) throw new ValidationError('Chỉ thêm phí cho đơn đang thuê hoặc đã nhận lại thiết bị.');
  const r = await ctx.db.query('INSERT INTO booking_fee(tenant_id,booking_id,kind,description,amount,unit_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [ctx.tenantId, bookingId, i.kind, i.description.trim(), i.amount, i.unitId ?? null, ctx.userId]);
  await audit(ctx, 'fee.add', 'booking', bookingId, { feeId: r.rows[0].id, kind: i.kind, amount: i.amount });
  return r.rows[0].id;
}

export async function voidFee(ctx: ServiceCtx, feeId: string, reason: string): Promise<void> {
  guard(ctx, 'deposit.refund', 'payments', { write: true });
  if (!reason.trim()) throw new ValidationError('Vui lòng nhập lý do hủy khoản phí.');
  const f = (await ctx.db.query('SELECT id, booking_id, voided_at, amount, kind FROM booking_fee WHERE id=$1 FOR UPDATE', [feeId])).rows[0];
  if (!f) throw new NotFoundError('khoản phí');
  if (f.voided_at) throw new ValidationError('Khoản phí này đã được hủy trước đó.');
  const b = await lockBookingRow(ctx, f.booking_id);
  if (b.status === 'CLOSED') throw new ValidationError('Đơn đã đóng, không hủy được khoản phí.');
  await ctx.db.query('UPDATE booking_fee SET voided_at=now(), void_reason=$2, voided_by=$3 WHERE id=$1', [feeId, reason.trim(), ctx.userId]);
  await audit(ctx, 'fee.void', 'booking', f.booking_id, { feeId, kind: f.kind, amount: Number(f.amount), reason });
}

// ===== Tiền cọc yêu cầu =====
async function depositContext(ctx: ServiceCtx, bookingId: string) {
  const b = (await ctx.db.query('SELECT total FROM booking WHERE id=$1', [bookingId])).rows[0];
  if (!b) throw new NotFoundError('đơn thuê');
  const rows = (await ctx.db.query(
    `SELECT l.qty, COALESCE(u.compensation_value, m.compensation_value, u.purchase_price, 0) AS v
     FROM booking_line l JOIN equipment_model m ON m.id=l.model_id LEFT JOIN equipment_unit u ON u.id=l.unit_id WHERE l.booking_id=$1`, [bookingId])).rows;
  return { rentTotal: Number(b.total), equipmentValue: rows.reduce((a, r) => a + r.qty * Number(r.v), 0) };
}

export async function suggestBookingDeposit(ctx: ServiceCtx, bookingId: string): Promise<{ amount: number; warning?: string }> {
  const rule = (await rawFinanceSettings(ctx)).deposit ?? { mode: 'NONE' as const };
  const c = await depositContext(ctx, bookingId);
  return applyDepositHook(suggestDeposit(rule, c), c, ctx.depositHook);
}

/** Cập nhật mức cọc yêu cầu của đơn theo quy tắc cửa hàng (gọi khi giữ chỗ, xác nhận, đổi thời gian trước lúc giao). */
export async function syncDepositRequirement(ctx: ServiceCtx, bookingId: string): Promise<void> {
  if (!ctx.features.deposit) return;
  const b = (await ctx.db.query('SELECT status FROM booking WHERE id=$1', [bookingId])).rows[0];
  if (!b || !['QUOTE', 'HOLD', 'CONFIRMED'].includes(b.status)) return;
  const { amount } = await suggestBookingDeposit(ctx, bookingId);
  await ctx.db.query('UPDATE booking SET deposit_required=$2 WHERE id=$1', [bookingId, amount]);
}

/** Nhân viên có thể đổi mức cọc yêu cầu của một đơn (VD khách quen được giảm cọc). */
export async function setDepositRequired(ctx: ServiceCtx, bookingId: string, amount: number): Promise<void> {
  guard(ctx, 'deposit.collect', 'deposit', { write: true });
  if (!Number.isInteger(amount) || amount < 0 || amount > MONEY_MAX) throw new ValidationError('Mức cọc phải là số nguyên không âm.');
  const b = await lockBookingRow(ctx, bookingId);
  if (['ACTIVE', 'RETURNED', 'CLOSED', 'CANCELLED'].includes(b.status)) throw new ValidationError('Chỉ đổi mức cọc khi đơn chưa giao thiết bị.');
  await ctx.db.query('UPDATE booking SET deposit_required=$2 WHERE id=$1', [bookingId, amount]);
  await audit(ctx, 'deposit.required', 'booking', bookingId, { from: Number(b.deposit_required), to: amount });
}

// ===== Tài sản thế chấp =====
export async function addDepositAsset(ctx: ServiceCtx, bookingId: string, i: { description: string; estimatedValue?: number; storageLocation?: string | null; photos?: { data: Uint8Array }[] }): Promise<string> {
  guard(ctx, 'deposit.collect', 'deposit', { write: true });
  if (!i.description.trim()) throw new ValidationError('Vui lòng mô tả tài sản thế chấp (VD: CCCD gốc, xe máy Wave biển số…).');
  const value = i.estimatedValue ?? 0;
  if (!Number.isInteger(value) || value < 0 || value > MONEY_MAX) throw new ValidationError('Giá trị ước tính phải là số nguyên không âm.');
  const photos = i.photos ?? [];
  if (photos.length > 6) throw new ValidationError('Tối đa 6 ảnh cho mỗi tài sản.');
  const b = await lockBookingRow(ctx, bookingId);
  if (['QUOTE', 'CLOSED', 'CANCELLED'].includes(b.status)) throw new ValidationError('Chỉ nhận tài sản thế chấp cho đơn đã giữ chỗ hoặc đang thuê.');
  const paths: string[] = [];
  try {
    for (const ph of photos) paths.push(await storePhoto(ctx, ph.data, 'asset'));
    const r = await ctx.db.query(
      'INSERT INTO deposit_asset(tenant_id,booking_id,description,estimated_value,storage_location,photo_paths,received_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [ctx.tenantId, bookingId, i.description.trim(), value, i.storageLocation?.trim() || null, paths, ctx.userId]);
    await audit(ctx, 'asset.receive', 'booking', bookingId, { assetId: r.rows[0].id, description: i.description, value });
    return r.rows[0].id;
  } catch (e) {
    await Promise.all(paths.map((p) => ctx.storage!.delete(p).catch(() => undefined)));
    throw e;
  }
}

/** Trả tài sản thế chấp. Khách còn nợ thì giữ lại, trừ khi người có quyền hoàn tiền cho phép (force). */
export async function returnDepositAsset(ctx: ServiceCtx, assetId: string, note: string, opts: { force?: boolean } = {}): Promise<void> {
  guard(ctx, 'deposit.collect', 'deposit', { write: true });
  const a = (await ctx.db.query('SELECT * FROM deposit_asset WHERE id=$1 FOR UPDATE', [assetId])).rows[0];
  if (!a) throw new NotFoundError('tài sản thế chấp');
  if (a.status === 'RETURNED') throw new ValidationError('Tài sản này đã được trả.');
  const b = await lockBookingRow(ctx, a.booking_id);
  if (!['RETURNED', 'CLOSED', 'CANCELLED'].includes(b.status)) throw new ValidationError('Chỉ trả tài sản thế chấp sau khi đã nhận lại thiết bị hoặc khi đơn đã hủy.');
  const l = await computeLedger(ctx, a.booking_id);
  if (l.settlement.balanceOwed > 0) {
    if (!opts.force) throw new ValidationError(`Khách còn nợ ${l.settlement.balanceOwed.toLocaleString('vi-VN')} đ nên chưa trả tài sản thế chấp.`);
    guard(ctx, 'deposit.refund', 'deposit', { write: true });
  }
  await ctx.db.query(`UPDATE deposit_asset SET status='RETURNED', returned_at=now(), return_note=$2, returned_by=$3 WHERE id=$1`, [assetId, note.trim() || null, ctx.userId]);
  await audit(ctx, 'asset.return', 'booking', a.booking_id, { assetId, note, force: !!opts.force });
}

export async function getAssetPhoto(ctx: ServiceCtx, assetId: string, index: number) {
  guard(ctx, 'deposit.view', 'deposit');
  const a = (await ctx.db.query('SELECT photo_paths FROM deposit_asset WHERE id=$1', [assetId])).rows[0];
  const path = (a?.photo_paths as string[] | undefined)?.[index];
  if (!path) throw new NotFoundError('ảnh');
  const f = await need(ctx.storage, 'storage').get(path);
  if (!f) throw new NotFoundError('ảnh');
  return f;
}

/** Lưu ảnh (kiểm tra chữ ký file, tối đa 5 MB) vào vùng riêng của cửa hàng. */
export async function storePhoto(ctx: ServiceCtx, data: Uint8Array, area: string): Promise<string> {
  if (data.byteLength === 0) throw new ValidationError('Ảnh trống.');
  if (data.byteLength > ID_IMAGE_MAX_BYTES) throw new ValidationError('Ảnh quá lớn (tối đa 5 MB).');
  const kind = sniffImage(data);
  if (!kind) throw new ValidationError('Ảnh phải là JPG, PNG hoặc WebP.');
  const path = newPrivatePath(ctx.tenantId, area, kind.ext);
  await need(ctx.storage, 'storage').put(path, data, kind.mime);
  return path;
}

// ===== Sổ theo dõi cọc =====
export interface DepositLedgerRow {
  bookingId: string; code: string; status: string; customerName: string; heldMoney: number; assets: { id: string; description: string; value: number; location: string | null }[];
}

/** Đơn đang giữ tiền cọc hoặc tài sản thế chấp (đơn đã đóng thì đã quyết toán xong, không còn nằm trong sổ). */
export async function depositLedger(ctx: ServiceCtx): Promise<DepositLedgerRow[]> {
  guard(ctx, 'deposit.view', 'deposit');
  const rows = (await ctx.db.query(
    `SELECT b.id, b.code, b.status, c.name AS customer_name,
       COALESCE((SELECT sum(amount) FROM payment p WHERE p.booking_id=b.id AND p.voided_at IS NULL AND p.kind='DEPOSIT'),0)
       - COALESCE((SELECT sum(amount) FROM payment p WHERE p.booking_id=b.id AND p.voided_at IS NULL AND p.kind='REFUND'),0) AS held
     FROM booking b JOIN customer c ON c.id=b.customer_id
     WHERE b.deleted_at IS NULL AND b.status <> 'CLOSED' AND (
       EXISTS (SELECT 1 FROM deposit_asset a WHERE a.booking_id=b.id AND a.status='HELD')
       OR COALESCE((SELECT sum(amount) FROM payment p WHERE p.booking_id=b.id AND p.voided_at IS NULL AND p.kind='DEPOSIT'),0)
        - COALESCE((SELECT sum(amount) FROM payment p WHERE p.booking_id=b.id AND p.voided_at IS NULL AND p.kind='REFUND'),0) > 0)
     ORDER BY b.created_at DESC LIMIT 200`)).rows;
  const assets = (await ctx.db.query(`SELECT id, booking_id, description, estimated_value, storage_location FROM deposit_asset WHERE status='HELD' AND booking_id = ANY($1::uuid[])`, [rows.map((r) => r.id)])).rows;
  return rows.map((r) => ({
    bookingId: r.id, code: r.code, status: r.status, customerName: r.customer_name, heldMoney: Math.max(0, Number(r.held)),
    assets: assets.filter((a) => a.booking_id === r.id).map((a) => ({ id: a.id, description: a.description, value: Number(a.estimated_value), location: a.storage_location })),
  }));
}

// ===== VietQR =====
export interface QrResult { payload: string; memo: string; amount: number | null; bankLabel: string }

export async function vietQrFor(ctx: ServiceCtx, bookingId: string, amount?: number | null): Promise<QrResult> {
  guard(ctx, 'payment.view', 'payments');
  const bank = (await rawFinanceSettings(ctx)).bank;
  if (!bank) throw new ValidationError('Cửa hàng chưa cài tài khoản nhận tiền. Hãy vào Cài đặt → Tài chính để nhập tài khoản ngân hàng.');
  const b = (await ctx.db.query('SELECT code FROM booking WHERE id=$1 AND deleted_at IS NULL', [bookingId])).rows[0];
  if (!b) throw new NotFoundError('đơn thuê');
  // Nội dung chuyển khoản là số hợp đồng (nếu đã có) để kế toán đối soát; chưa có thì dùng số đơn
  const c = (await ctx.db.query(`SELECT number FROM contract WHERE booking_id=$1 AND status <> 'VOID'`, [bookingId])).rows[0];
  const memo = sanitizeMemo(c?.number ?? b.code);
  try {
    return { payload: buildVietQrPayload({ bin: bank.bin, account: bank.account, amount: amount ?? undefined, memo }), memo, amount: amount ?? null, bankLabel: `${bank.accountName ?? ''} ${'*'.repeat(Math.max(0, bank.account.length - 4))}${bank.account.slice(-4)}`.trim() };
  } catch (e) {
    if (e instanceof VietQrError) throw new ValidationError(e.message);
    throw e;
  }
}

export const handoverRules = async (ctx: ServiceCtx) => ({ ...DEFAULT_HANDOVER, ...((await rawFinanceSettings(ctx)).handover ?? {}) });
