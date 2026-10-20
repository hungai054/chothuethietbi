import {
  BookingSettingsSchema, BOOKING_SETTINGS_VERSION, DEFAULT_BOOKING_PATTERN, DEFAULT_HOLD_HOURS, PricingError, applyPricingHook,
  assertBookingTransition, canExtend, canReschedule, conflictMessage, earliestStartWithCapacity, earlyReturn, findFreeWindow, firstZodMessage, formatDocNumber,
  holdExpiry, localDateKey, occupiedRange, quantityFree, quoteRental, repriceForNewEnd, upgradeBookingSettings, validateDocPattern,
  type BookingSettings, type BookingStatus, type Discount, type Quote, type QuoteInput, type Range,
} from '@rentpro/core';
import { NotFoundError, ValidationError, audit, guard, type ServiceCtx } from './service';
import { loadPricingConfig, quoteForCustomer, type PricingInput } from './pricing';
import { syncDepositRequirement } from './finance';
import { emitBookingEvent } from './api';

const FEATURE = 'booking' as const;
export const ACTIVE_ALLOC = ['HOLD', 'CONFIRMED', 'ACTIVE', 'MAINTENANCE'] as const;
const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';
type Row = Record<string, any>;

export const tzOf = (ctx: ServiceCtx) => ctx.timezone ?? DEFAULT_TZ;
export const fmtTime = (ctx: ServiceCtx) => (d: Date) =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: tzOf(ctx), day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);

// ===== Cấu hình =====
async function rawSettings(ctx: ServiceCtx): Promise<BookingSettings> {
  const r = (await ctx.db.query('SELECT settings FROM tenant WHERE id=$1', [ctx.tenantId])).rows[0];
  return upgradeBookingSettings(r?.settings?.booking);
}

export async function getBookingSettings(ctx: ServiceCtx): Promise<BookingSettings> {
  guard(ctx, 'booking.view', FEATURE);
  return rawSettings(ctx);
}

export async function updateBookingSettings(ctx: ServiceCtx, patch: unknown): Promise<BookingSettings> {
  guard(ctx, 'settings.manage', FEATURE, { write: true });
  const p = BookingSettingsSchema.safeParse({ v: BOOKING_SETTINGS_VERSION, ...(patch as object) });
  if (!p.success) throw new ValidationError(firstZodMessage(p.error));
  if (p.data.codePattern) {
    const bad = validateDocPattern(p.data.codePattern);
    if (bad) throw new ValidationError(bad);
  }
  const clean = JSON.parse(JSON.stringify(p.data)) as BookingSettings;
  await ctx.db.query(`UPDATE tenant SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{booking}', $2::jsonb, true) WHERE id=$1`, [ctx.tenantId, JSON.stringify(clean)]);
  await audit(ctx, 'settings.booking', 'tenant', ctx.tenantId, clean);
  return clean;
}

// ===== Tiện ích nội bộ =====
/** Chạy một câu lệnh trong savepoint: nếu vi phạm exclusion constraint thì quay lại savepoint để còn truy vấn gợi ý tiếp. */
async function attempt(ctx: ServiceCtx, sql: string, args: unknown[]): Promise<{ ok: true; rows: Row[]; rowCount: number } | { ok: false }> {
  await ctx.db.query('SAVEPOINT attempt_sp');
  try {
    const r = await ctx.db.query(sql, args);
    await ctx.db.query('RELEASE SAVEPOINT attempt_sp');
    return { ok: true, rows: r.rows, rowCount: r.rowCount ?? 0 };
  } catch (e) {
    if ((e as { code?: string }).code === '23P01') {
      await ctx.db.query('ROLLBACK TO SAVEPOINT attempt_sp');
      return { ok: false };
    }
    throw e;
  }
}

interface ModelInfo { id: string; name: string; tracked: boolean; buffer: number; stock: number }

async function loadModels(ctx: ServiceCtx, ids: string[]): Promise<Map<string, ModelInfo>> {
  const { rows } = await ctx.db.query('SELECT id, name, tracked, buffer_minutes, stock_qty FROM equipment_model WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [ids]);
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, tracked: r.tracked, buffer: r.buffer_minutes, stock: r.stock_qty }]));
}

const range = (r: Range) => [r.start, r.end] as const;

/**
 * Xếp hàng các giao dịch cùng đụng tới một mẫu thiết bị (khóa advisory kéo dài đến hết giao dịch).
 * Nếu để hai giao dịch cùng chèn lịch trùng vào exclusion constraint, mỗi bên thấy bản ghi chưa commit của bên kia và chờ nhau:
 * Postgres phải hủy một bên bằng "deadlock detected" sau 1 giây. Xếp hàng theo thứ tự cố định (sắp xếp id) tránh vòng chờ;
 * constraint vẫn là chốt chặn cuối cùng. Mọi chỗ ghi lịch (kể cả bảo trì ở Giai đoạn 8) phải gọi hàm này trước.
 */
export async function lockModels(ctx: ServiceCtx, modelIds: string[]): Promise<void> {
  for (const id of [...new Set(modelIds)].sort()) {
    await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`booking-model:${ctx.tenantId}:${id}`]);
  }
}

/** Chiếc rảnh của một mẫu trong khoảng đã gồm đệm (không tính chiếc đã thanh lý/mất/đang bảo trì). */
async function freeUnits(ctx: ServiceCtx, modelId: string, r: Range, excludeBookingId?: string): Promise<{ id: string; barcode: string }[]> {
  return (await ctx.db.query(
    `SELECT u.id, u.barcode FROM equipment_unit u
     WHERE u.model_id=$1 AND u.deleted_at IS NULL AND u.status NOT IN ('RETIRED','LOST','MAINTENANCE')
       AND NOT EXISTS (SELECT 1 FROM unit_allocation a WHERE a.unit_id=u.id AND a.status = ANY($4::text[])
                         AND ($5::uuid IS NULL OR a.booking_id <> $5) AND a.period && tstzrange($2::timestamptz, $3::timestamptz, '[)'))
     ORDER BY u.barcode`, [modelId, ...range(r), ACTIVE_ALLOC, excludeBookingId ?? null])).rows;
}

async function busyByUnit(ctx: ServiceCtx, modelId: string, from: Date, to: Date): Promise<{ units: { id: string; barcode: string }[]; busy: Range[][] }> {
  const units = (await ctx.db.query(
    `SELECT id, barcode FROM equipment_unit WHERE model_id=$1 AND deleted_at IS NULL AND status NOT IN ('RETIRED','LOST','MAINTENANCE') ORDER BY barcode`, [modelId])).rows;
  const { rows } = await ctx.db.query(
    `SELECT unit_id, lower(period) AS s, upper(period) AS e FROM unit_allocation
     WHERE unit_id = ANY($1::uuid[]) AND status = ANY($2::text[]) AND period && tstzrange($3::timestamptz, $4::timestamptz, '[)')`,
    [units.map((u) => u.id), ACTIVE_ALLOC, from, to]);
  const byUnit = new Map<string, Range[]>();
  for (const r of rows) byUnit.set(r.unit_id, [...(byUnit.get(r.unit_id) ?? []), { start: r.s, end: r.e }]);
  return { units, busy: units.map((u) => byUnit.get(u.id) ?? []) };
}

/** Gợi ý: khung giờ sớm nhất có đủ `qty` chiếc cùng mẫu (tìm trong 120 ngày tới). */
async function suggestStart(ctx: ServiceCtx, model: ModelInfo, want: Range, qty: number, duration: number): Promise<Date | null> {
  const to = new Date(want.start.getTime() + 120 * 86_400_000);
  const { busy } = await busyByUnit(ctx, model.id, want.start, to);
  return earliestStartWithCapacity(busy, want.start, duration, model.buffer * 60_000, qty);
}

const logStatus = (ctx: ServiceCtx, bookingId: string, from: string | null, to: string, reason?: string | null) =>
  ctx.db.query('INSERT INTO booking_status_log(tenant_id,booking_id,from_status,to_status,user_id,reason) VALUES ($1,$2,$3,$4,$5,$6)',
    [ctx.tenantId, bookingId, from, to, ctx.userId, reason ?? null]);

export async function lockBooking(ctx: ServiceCtx, id: string): Promise<Row> {
  const b = (await ctx.db.query('SELECT * FROM booking WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
  if (!b) throw new NotFoundError('đơn thuê');
  return b;
}

/** Hủy các giữ chỗ đã quá hạn (chạy lười trước mỗi thao tác đặt lịch; tác vụ nền Giai đoạn 7 cũng gọi hàm này). */
export async function releaseExpiredHolds(ctx: ServiceCtx): Promise<number> {
  const { rows } = await ctx.db.query(
    `UPDATE booking SET status='CANCELLED', cancel_reason='Hết hạn giữ chỗ', cancelled_at=now(), hold_expires_at=NULL
     WHERE status='HOLD' AND hold_expires_at <= now() RETURNING id`);
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  await ctx.db.query(`UPDATE unit_allocation SET status='RELEASED' WHERE booking_id = ANY($1::uuid[])`, [ids]);
  await ctx.db.query(`UPDATE qty_allocation SET status='RELEASED' WHERE booking_id = ANY($1::uuid[])`, [ids]);
  for (const id of ids) await logStatus(ctx, id, 'HOLD', 'CANCELLED', 'Hết hạn giữ chỗ');
  return ids.length;
}

async function nextBookingCode(ctx: ServiceCtx): Promise<string> {
  const pattern = (await rawSettings(ctx)).codePattern ?? DEFAULT_BOOKING_PATTERN;
  const year = Number(localDateKey(new Date(), tzOf(ctx)).slice(0, 4));
  const n = (await ctx.db.query(
    `INSERT INTO doc_counter(tenant_id,kind,year,last_value) VALUES ($1,'booking',$2,1)
     ON CONFLICT (tenant_id,kind,year) DO UPDATE SET last_value = doc_counter.last_value + 1 RETURNING last_value`, [ctx.tenantId, year])).rows[0].last_value;
  return formatDocNumber(pattern, year, Number(n));
}

// ===== Phân bổ thiết bị =====
interface LineAlloc { lineId: string; modelId: string; qty: number; unitId: string | null }

async function allocateLines(ctx: ServiceCtx, bookingId: string, start: Date, end: Date, lines: LineAlloc[], status: 'HOLD' | 'CONFIRMED'): Promise<void> {
  await lockModels(ctx, lines.map((l) => l.modelId));
  const models = await loadModels(ctx, lines.map((l) => l.modelId));
  for (const l of lines) {
    const m = models.get(l.modelId);
    if (!m) throw new NotFoundError('mẫu thiết bị');
    const occ = occupiedRange(start, end, m.buffer);
    const duration = end.getTime() - start.getTime();
    if (!m.tracked) await allocateQty(ctx, bookingId, l, m, occ, status, null);
    else if (l.unitId) await allocateSpecific(ctx, bookingId, l, m, occ, status, duration);
    else await allocateAuto(ctx, bookingId, l, m, occ, status, duration);
  }
}

const insertUnitAlloc = (ctx: ServiceCtx, bookingId: string, lineId: string, unitId: string, r: Range, status: string) =>
  attempt(ctx,
    `INSERT INTO unit_allocation(tenant_id,booking_id,booking_line_id,unit_id,period,status)
     VALUES ($1,$2,$3,$4,tstzrange($5::timestamptz,$6::timestamptz,'[)'),$7)`, [ctx.tenantId, bookingId, lineId, unitId, ...range(r), status]);

async function allocateSpecific(ctx: ServiceCtx, bookingId: string, l: LineAlloc, m: ModelInfo, occ: Range, status: string, duration: number) {
  const u = (await ctx.db.query('SELECT id, barcode, model_id, status FROM equipment_unit WHERE id=$1 AND deleted_at IS NULL', [l.unitId])).rows[0];
  if (!u || u.model_id !== m.id) throw new NotFoundError('thiết bị');
  if (['RETIRED', 'LOST', 'MAINTENANCE'].includes(u.status)) throw new ValidationError(`Thiết bị ${u.barcode} đang không sẵn sàng cho thuê (bảo trì, mất hoặc đã thanh lý).`);
  const ok = await insertUnitAlloc(ctx, bookingId, l.lineId, u.id, occ, status);
  if (ok.ok) return;
  const free = await freeUnits(ctx, m.id, occ);
  const { units, busy } = await busyByUnit(ctx, m.id, occ.start, new Date(occ.start.getTime() + 120 * 86_400_000));
  const idx = units.findIndex((x) => x.id === u.id);
  const next = idx >= 0 ? findFreeWindow(busy[idx]!, occ.start, duration, m.buffer * 60_000) : null;
  throw new ValidationError(`${u.barcode}: ${conflictMessage({ freeUnitCodes: free.map((f) => f.barcode), nextStart: next, fmt: fmtTime(ctx) })}`);
}

async function allocateAuto(ctx: ServiceCtx, bookingId: string, l: LineAlloc, m: ModelInfo, occ: Range, status: string, duration: number) {
  let got = 0;
  // Hai người đặt cùng lúc có thể chọn cùng một chiếc: constraint chặn người đến sau, ta thử chiếc kế tiếp.
  for (const u of await freeUnits(ctx, m.id, occ)) {
    if (got === l.qty) break;
    if ((await insertUnitAlloc(ctx, bookingId, l.lineId, u.id, occ, status)).ok) got++;
  }
  if (got === l.qty) return;
  const next = await suggestStart(ctx, m, occ, l.qty, duration);
  throw new ValidationError(
    `Không đủ thiết bị "${m.name}": cần ${l.qty} chiếc, chỉ còn ${got} chiếc rảnh trong khoảng thời gian này.` +
    (next ? ` Thời điểm sớm nhất có đủ ${l.qty} chiếc: ${fmtTime(ctx)(next)}.` : ' Không có thời điểm nào trong 120 ngày tới đủ số chiếc.'));
}

async function qtyFreeFor(ctx: ServiceCtx, m: ModelInfo, occ: Range, excludeBookingId: string | null): Promise<number> {
  // Khóa dòng mẫu để các đơn đặt cùng mẫu theo số lượng được xử lý lần lượt, nên không thể đặt vượt tồn kho.
  // PHẢI dùng FOR NO KEY UPDATE: FOR UPDATE xung đột với khóa KEY SHARE mà khóa ngoại (booking_line.model_id) đã giữ,
  // khiến hai giao dịch cùng đặt một mẫu chờ nhau và bị deadlock.
  const stock = (await ctx.db.query('SELECT stock_qty FROM equipment_model WHERE id=$1 FOR NO KEY UPDATE', [m.id])).rows[0]?.stock_qty ?? 0;
  const { rows } = await ctx.db.query(
    `SELECT qty, lower(period) AS s, upper(period) AS e FROM qty_allocation
     WHERE model_id=$1 AND status IN ('HOLD','CONFIRMED','ACTIVE') AND ($4::uuid IS NULL OR booking_id <> $4)
       AND period && tstzrange($2::timestamptz,$3::timestamptz,'[)')`, [m.id, ...range(occ), excludeBookingId]);
  return quantityFree(stock, rows.map((r) => ({ qty: r.qty, range: { start: r.s, end: r.e } })), occ);
}

async function allocateQty(ctx: ServiceCtx, bookingId: string, l: LineAlloc, m: ModelInfo, occ: Range, status: string, _: null) {
  const free = await qtyFreeFor(ctx, m, occ, bookingId);
  if (l.qty > free) throw new ValidationError(`Không đủ "${m.name}": cần ${l.qty}, chỉ còn ${free} trong khoảng thời gian này.`);
  await ctx.db.query(
    `INSERT INTO qty_allocation(tenant_id,booking_id,booking_line_id,model_id,qty,period,status) VALUES ($1,$2,$3,$4,$5,tstzrange($6::timestamptz,$7::timestamptz,'[)'),$8)`,
    [ctx.tenantId, bookingId, l.lineId, m.id, l.qty, ...range(occ), status]);
}

// ===== Tạo đơn =====
/** Giới hạn số dòng thiết bị trong một đơn (chặn đầu vào bất thường qua API; giao diện giới hạn thấp hơn) */
export const MAX_BOOKING_LINES = 50;

export interface BookingLineInput { modelId: string; qty: number; unitId?: string | null }
export interface CreateBookingInput {
  customerId: string; lines: BookingLineInput[]; start: Date; end: Date;
  status?: 'QUOTE' | 'HOLD' | 'CONFIRMED'; holdHours?: number; discount?: Discount | null; deliveryFee?: number; notes?: string | null;
}

export async function createBooking(ctx: ServiceCtx, input: CreateBookingInput): Promise<{ id: string; code: string }> {
  guard(ctx, 'booking.create', FEATURE, { write: true });
  const status = input.status ?? 'QUOTE';
  if (!['QUOTE', 'HOLD', 'CONFIRMED'].includes(status)) throw new ValidationError('Trạng thái ban đầu không hợp lệ.');
  if (!(input.end.getTime() > input.start.getTime())) throw new ValidationError('Thời gian kết thúc phải sau thời gian bắt đầu.');
  if (input.lines.length === 0) throw new ValidationError('Chưa chọn thiết bị nào.');
  if (input.lines.length > MAX_BOOKING_LINES) throw new ValidationError(`Một đơn tối đa ${MAX_BOOKING_LINES} dòng thiết bị. Hãy tách thành nhiều đơn.`);
  // Extension có thể từ chối đơn (ExtensionVeto) trước khi ghi bất cứ thứ gì
  await ctx.ext?.beforeBookingCreate({ customerId: input.customerId, start: input.start, end: input.end, status, lines: input.lines.map((l) => ({ modelId: l.modelId, qty: l.qty })), notes: input.notes ?? null });
  const seen = new Set<string>();
  for (const l of input.lines) {
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 1000) throw new ValidationError('Số lượng phải từ 1 đến 1000.');
    if (l.unitId) {
      if (l.qty !== 1) throw new ValidationError('Chọn đích danh một thiết bị thì số lượng là 1.');
      if (seen.has(l.unitId)) throw new ValidationError('Một thiết bị không được chọn hai lần trong cùng đơn.');
      seen.add(l.unitId);
    }
  }
  await releaseExpiredHolds(ctx);

  let qr;
  try {
    qr = await quoteForCustomer(ctx, { customerId: input.customerId, lines: input.lines.map((l) => ({ modelId: l.modelId, qty: l.qty })), start: input.start, end: input.end, discount: input.discount, deliveryFee: input.deliveryFee });
  } catch (e) {
    if (e instanceof PricingError) throw new ValidationError(e.message);
    throw e;
  }
  const settings = await rawSettings(ctx);
  const hours = input.holdHours ?? settings.holdHours ?? DEFAULT_HOLD_HOURS;
  const expires = status === 'HOLD' ? holdExpiry(new Date(), hours) : null;

  const placeholder = `TMP-${crypto.randomUUID()}`;
  const b = (await ctx.db.query(
    `INSERT INTO booking(tenant_id,code,customer_id,status,starts_at,ends_at,hold_expires_at,total,quote,pricing_input,notes,created_by,confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [ctx.tenantId, placeholder, input.customerId, status, input.start, input.end, expires, qr.quote.total, JSON.stringify(qr.quote), JSON.stringify(qr.pricingInput),
      input.notes?.trim() || null, ctx.userId, status === 'CONFIRMED' ? new Date() : null])).rows[0];

  const lines: LineAlloc[] = [];
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i]!;
    const lineId = (await ctx.db.query(
      'INSERT INTO booking_line(tenant_id,booking_id,model_id,unit_id,qty,line_total) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [ctx.tenantId, b.id, l.modelId, l.unitId ?? null, l.qty, qr.quote.lines[i]!.total])).rows[0].id;
    lines.push({ lineId, modelId: l.modelId, qty: l.qty, unitId: l.unitId ?? null });
  }
  if (status !== 'QUOTE') await allocateLines(ctx, b.id, input.start, input.end, lines, status);

  // Cấp số đơn ở cuối để khóa bộ đếm được giữ ngắn nhất có thể
  const code = await nextBookingCode(ctx);
  await ctx.db.query('UPDATE booking SET code=$2 WHERE id=$1', [b.id, code]);
  await syncDepositRequirement(ctx, b.id);
  await logStatus(ctx, b.id, null, status);
  await audit(ctx, 'booking.create', 'booking', b.id, { code, status, total: qr.quote.total });
  if (status === 'CONFIRMED') await notifyConfirmed(ctx, b.id);
  await emitBookingEvent(ctx, 'booking.created', b.id);
  if (status === 'CONFIRMED') await emitBookingEvent(ctx, 'booking.confirmed', b.id);
  return { id: b.id, code };
}

// ===== Chuyển trạng thái =====
async function allocateExisting(ctx: ServiceCtx, b: Row, status: 'HOLD' | 'CONFIRMED') {
  const lines = (await ctx.db.query('SELECT id, model_id, qty, unit_id FROM booking_line WHERE booking_id=$1', [b.id])).rows;
  await allocateLines(ctx, b.id, b.starts_at, b.ends_at, lines.map((l) => ({ lineId: l.id, modelId: l.model_id, qty: l.qty, unitId: l.unit_id })), status);
}

function expiredMessage(b: Row): ValidationError | null {
  return b.status === 'CANCELLED' && b.cancel_reason === 'Hết hạn giữ chỗ' ? new ValidationError('Giữ chỗ đã hết hạn và được tự động hủy. Hãy tạo lại đơn.') : null;
}

export async function holdBooking(ctx: ServiceCtx, id: string, hours?: number): Promise<void> {
  guard(ctx, 'booking.create', FEATURE, { write: true });
  await releaseExpiredHolds(ctx);
  const b = await lockBooking(ctx, id);
  const exp = expiredMessage(b);
  if (exp) throw exp;
  assertBookingTransition(b.status, 'HOLD');
  await allocateExisting(ctx, b, 'HOLD');
  const h = hours ?? (await rawSettings(ctx)).holdHours ?? DEFAULT_HOLD_HOURS;
  await ctx.db.query(`UPDATE booking SET status='HOLD', hold_expires_at=$2 WHERE id=$1`, [id, holdExpiry(new Date(), h)]);
  await syncDepositRequirement(ctx, id);
  await logStatus(ctx, id, b.status, 'HOLD');
  await audit(ctx, 'booking.hold', 'booking', id);
}

export async function confirmBooking(ctx: ServiceCtx, id: string): Promise<void> {
  guard(ctx, 'booking.create', FEATURE, { write: true });
  await releaseExpiredHolds(ctx);
  const b = await lockBooking(ctx, id);
  const exp = expiredMessage(b);
  if (exp) throw exp;
  assertBookingTransition(b.status, 'CONFIRMED');
  if (b.status === 'QUOTE') await allocateExisting(ctx, b, 'CONFIRMED');
  else {
    await ctx.db.query(`UPDATE unit_allocation SET status='CONFIRMED' WHERE booking_id=$1 AND status='HOLD'`, [id]);
    await ctx.db.query(`UPDATE qty_allocation SET status='CONFIRMED' WHERE booking_id=$1 AND status='HOLD'`, [id]);
  }
  await ctx.db.query(`UPDATE booking SET status='CONFIRMED', hold_expires_at=NULL, confirmed_at=now() WHERE id=$1`, [id]);
  await syncDepositRequirement(ctx, id);
  await logStatus(ctx, id, b.status, 'CONFIRMED');
  await audit(ctx, 'booking.confirm', 'booking', id);
  await notifyConfirmed(ctx, id);
  await emitBookingEvent(ctx, 'booking.confirmed', id);
}

/** Báo cho extension (móc booking.afterConfirm) sau khi đơn được xác nhận. Lỗi extension được cô lập, không hủy việc xác nhận. */
async function notifyConfirmed(ctx: ServiceCtx, id: string): Promise<void> {
  if (!ctx.ext) return;
  const r = (await ctx.db.query('SELECT id, code, customer_id, starts_at, ends_at, total, status FROM booking WHERE id=$1', [id])).rows[0];
  await ctx.ext.afterBookingConfirm({ id: r.id, code: r.code, customerId: r.customer_id, start: r.starts_at, end: r.ends_at, total: Number(r.total), status: r.status });
}

export async function cancelBooking(ctx: ServiceCtx, id: string, reason: string): Promise<void> {
  guard(ctx, 'booking.cancel', FEATURE, { write: true });
  if (!reason.trim()) throw new ValidationError('Vui lòng nhập lý do hủy đơn.');
  const b = await lockBooking(ctx, id);
  assertBookingTransition(b.status, 'CANCELLED');
  await ctx.db.query(`UPDATE unit_allocation SET status='RELEASED' WHERE booking_id=$1`, [id]);
  await ctx.db.query(`UPDATE qty_allocation SET status='RELEASED' WHERE booking_id=$1`, [id]);
  await ctx.db.query(`UPDATE contract SET status='VOID', void_reason='Đơn bị hủy' WHERE booking_id=$1 AND status <> 'VOID'`, [id]);
  await ctx.db.query(`UPDATE booking SET status='CANCELLED', cancel_reason=$2, cancelled_at=now(), hold_expires_at=NULL WHERE id=$1`, [id, reason.trim()]);
  await logStatus(ctx, id, b.status, 'CANCELLED', reason.trim());
  await audit(ctx, 'booking.cancel', 'booking', id, { reason });
  await emitBookingEvent(ctx, 'booking.cancelled', id, { reason: reason.trim() });
}

// ===== Đổi lịch: dời, gia hạn, rút ngắn =====
async function conflictsFor(ctx: ServiceCtx, bookingId: string, start: Date, end: Date): Promise<string> {
  const { rows } = await ctx.db.query(
    `SELECT DISTINCT u.barcode, ob.code FROM unit_allocation a
       JOIN equipment_unit u ON u.id = a.unit_id JOIN equipment_model m ON m.id = u.model_id
       JOIN unit_allocation o ON o.unit_id = a.unit_id AND o.booking_id <> a.booking_id AND o.status = ANY($4::text[])
         AND o.period && tstzrange($2::timestamptz, $3::timestamptz + (m.buffer_minutes * interval '1 minute'), '[)')
       LEFT JOIN booking ob ON ob.id = o.booking_id
     WHERE a.booking_id = $1 AND a.status <> 'RELEASED'`, [bookingId, start, end, ACTIVE_ALLOC]);
  return rows.length ? rows.map((r) => `${r.barcode} (${r.code ?? 'bảo trì'})`).join(', ') : '';
}

/** Đổi khoảng thời gian của đơn và mọi phân bổ. Vi phạm lịch → báo rõ đơn nào đang chiếm. */
async function applyWindow(ctx: ServiceCtx, b: Row, start: Date, end: Date): Promise<void> {
  const involved = (await ctx.db.query(
    `SELECT u.model_id FROM unit_allocation a JOIN equipment_unit u ON u.id=a.unit_id WHERE a.booking_id=$1 AND a.status <> 'RELEASED'
     UNION SELECT model_id FROM qty_allocation WHERE booking_id=$1 AND status <> 'RELEASED'`, [b.id])).rows.map((r) => r.model_id as string);
  await lockModels(ctx, involved);
  const r = await attempt(ctx,
    `UPDATE unit_allocation a SET period = tstzrange($2::timestamptz, $3::timestamptz + (m.buffer_minutes * interval '1 minute'), '[)')
     FROM equipment_unit u JOIN equipment_model m ON m.id = u.model_id
     WHERE a.booking_id = $1 AND a.unit_id = u.id AND a.status <> 'RELEASED'`, [b.id, start, end]);
  if (!r.ok) {
    const who = await conflictsFor(ctx, b.id, start, end);
    throw new ValidationError(`Không đổi được lịch vì trùng với đơn khác${who ? `: ${who}` : ''}.`);
  }
  const qty = (await ctx.db.query(`SELECT q.id, q.qty, q.model_id FROM qty_allocation q WHERE q.booking_id=$1 AND q.status <> 'RELEASED'`, [b.id])).rows;
  const models = await loadModels(ctx, qty.map((q) => q.model_id));
  for (const q of qty) {
    const m = models.get(q.model_id)!;
    const occ = occupiedRange(start, end, m.buffer);
    const free = await qtyFreeFor(ctx, m, occ, b.id);
    if (q.qty > free) throw new ValidationError(`Không đủ "${m.name}" trong khoảng thời gian mới: cần ${q.qty}, chỉ còn ${free}.`);
    await ctx.db.query(`UPDATE qty_allocation SET period = tstzrange($2::timestamptz,$3::timestamptz,'[)') WHERE id=$1`, [q.id, ...range(occ)]);
  }
  await ctx.db.query('UPDATE booking SET starts_at=$2, ends_at=$3 WHERE id=$1', [b.id, start, end]);
}

function hydrateInput(b: Row, start: Date, end: Date): QuoteInput {
  const p = b.pricing_input as PricingInput | null;
  if (!p) throw new ValidationError('Đơn này không có dữ liệu giá để tính lại.');
  return { ...p, start, end, discount: p.discount ?? null };
}

async function saveQuote(ctx: ServiceCtx, b: Row, q: Quote): Promise<void> {
  await ctx.db.query('UPDATE booking SET total=$2, quote=$3 WHERE id=$1', [b.id, q.total, JSON.stringify(q)]);
}

export interface ChangeResult { oldTotal: number; newTotal: number; delta: number }

export async function extendBooking(ctx: ServiceCtx, id: string, newEnd: Date): Promise<ChangeResult> {
  guard(ctx, 'booking.create', FEATURE, { write: true });
  const b = await lockBooking(ctx, id);
  if (!canExtend(b.status)) throw new ValidationError('Chỉ gia hạn được đơn đang giữ chỗ, đã xác nhận hoặc đang thuê.');
  if (!(newEnd.getTime() > b.ends_at.getTime())) throw new ValidationError('Giờ kết thúc mới phải sau giờ kết thúc hiện tại. Muốn rút ngắn hãy dùng "Rút ngắn / trả sớm".');
  const input = hydrateInput(b, b.starts_at, b.ends_at);
  const r = repriceForNewEnd(input, newEnd);
  const after = applyPricingHook(r.after, ctx.pricingHook, input.config, { start: b.starts_at, end: newEnd });
  await applyWindow(ctx, b, b.starts_at, newEnd);
  await saveQuote(ctx, b, after);
  await syncDepositRequirement(ctx, id);
  await ctx.db.query('UPDATE booking SET extended_count = extended_count + 1 WHERE id=$1', [id]);
  await logStatus(ctx, id, b.status, b.status, `Gia hạn đến ${fmtTime(ctx)(newEnd)}`);
  await audit(ctx, 'booking.extend', 'booking', id, { newEnd, delta: after.total - Number(b.total) });
  return { oldTotal: Number(b.total), newTotal: after.total, delta: after.total - Number(b.total) };
}

/** Rút ngắn hoặc trả sớm. Đơn đang thuê tính theo chính sách trả sớm của cửa hàng; đơn chưa giao tính lại theo thời gian mới. */
export async function shortenBooking(ctx: ServiceCtx, id: string, newEnd: Date): Promise<ChangeResult> {
  guard(ctx, 'booking.create', FEATURE, { write: true });
  const b = await lockBooking(ctx, id);
  return shortenLocked(ctx, b, newEnd);
}

/** Phần lõi của rút ngắn, dùng khi đơn đã được khóa (cũng được gọi lúc nhận thiết bị về sớm). */
export async function shortenLocked(ctx: ServiceCtx, b: Row, newEnd: Date): Promise<ChangeResult> {
  const id = b.id as string;
  if (!canExtend(b.status)) throw new ValidationError('Chỉ rút ngắn được đơn đang giữ chỗ, đã xác nhận hoặc đang thuê.');
  if (!(newEnd.getTime() > b.starts_at.getTime())) throw new ValidationError('Giờ kết thúc mới phải sau giờ bắt đầu.');
  if (!(newEnd.getTime() < b.ends_at.getTime())) throw new ValidationError('Giờ kết thúc mới phải sớm hơn giờ kết thúc hiện tại.');
  const input = hydrateInput(b, b.starts_at, b.ends_at);
  let after: Quote;
  try {
    after = b.status === 'ACTIVE' ? earlyReturn(input, newEnd).after : quoteRental({ ...input, end: newEnd });
  } catch (e) {
    if (e instanceof PricingError) throw new ValidationError(e.message);
    throw e;
  }
  after = applyPricingHook(after, ctx.pricingHook, input.config, { start: b.starts_at, end: newEnd });
  await applyWindow(ctx, b, b.starts_at, newEnd);
  await saveQuote(ctx, b, after);
  await syncDepositRequirement(ctx, id);
  await logStatus(ctx, id, b.status, b.status, `Rút ngắn đến ${fmtTime(ctx)(newEnd)}`);
  await audit(ctx, 'booking.shorten', 'booking', id, { newEnd, delta: after.total - Number(b.total) });
  return { oldTotal: Number(b.total), newTotal: after.total, delta: after.total - Number(b.total) };
}

/** Dời cả đơn sang giờ bắt đầu mới, giữ nguyên thời lượng. Giá tính lại theo bảng giá đã chốt (ngày lịch có thể đổi). */
export async function moveBooking(ctx: ServiceCtx, id: string, newStart: Date): Promise<ChangeResult> {
  guard(ctx, 'booking.create', FEATURE, { write: true });
  await releaseExpiredHolds(ctx);
  const b = await lockBooking(ctx, id);
  if (!canReschedule(b.status)) throw new ValidationError('Chỉ dời được đơn chưa giao thiết bị.');
  const shift = newStart.getTime() - b.starts_at.getTime();
  if (shift === 0) return { oldTotal: Number(b.total), newTotal: Number(b.total), delta: 0 };
  const newEnd = new Date(b.ends_at.getTime() + shift);
  const input = hydrateInput(b, newStart, newEnd);
  let after: Quote;
  try {
    after = applyPricingHook(quoteRental(input), ctx.pricingHook, input.config, { start: newStart, end: newEnd });
  } catch (e) {
    if (e instanceof PricingError) throw new ValidationError(e.message);
    throw e;
  }
  if (b.status !== 'QUOTE') await applyWindow(ctx, b, newStart, newEnd);
  else await ctx.db.query('UPDATE booking SET starts_at=$2, ends_at=$3 WHERE id=$1', [id, newStart, newEnd]);
  await saveQuote(ctx, b, after);
  await syncDepositRequirement(ctx, id);
  await logStatus(ctx, id, b.status, b.status, `Dời lịch sang ${fmtTime(ctx)(newStart)}`);
  await audit(ctx, 'booking.move', 'booking', id, { newStart, newEnd });
  return { oldTotal: Number(b.total), newTotal: after.total, delta: after.total - Number(b.total) };
}

/** Đổi sang một chiếc khác cùng mẫu (VD lúc giao thấy chiếc đã chọn bị hỏng). */
export async function swapUnit(ctx: ServiceCtx, allocationId: string, newUnitId: string): Promise<void> {
  guard(ctx, 'booking.create', FEATURE, { write: true });
  const a = (await ctx.db.query(
    `SELECT a.id, a.booking_id, a.unit_id, a.status, u.model_id FROM unit_allocation a JOIN equipment_unit u ON u.id=a.unit_id WHERE a.id=$1 FOR UPDATE OF a`, [allocationId])).rows[0];
  if (!a) throw new NotFoundError('phân bổ thiết bị');
  const b = await lockBooking(ctx, a.booking_id);
  if (!canReschedule(b.status) || a.status === 'RELEASED') throw new ValidationError('Chỉ đổi được thiết bị của đơn chưa giao.');
  const nu = (await ctx.db.query('SELECT id, barcode, model_id, status FROM equipment_unit WHERE id=$1 AND deleted_at IS NULL', [newUnitId])).rows[0];
  if (!nu) throw new NotFoundError('thiết bị');
  if (nu.model_id !== a.model_id) throw new ValidationError('Chỉ đổi được sang thiết bị cùng mẫu.');
  if (['RETIRED', 'LOST', 'MAINTENANCE'].includes(nu.status)) throw new ValidationError(`Thiết bị ${nu.barcode} đang không sẵn sàng cho thuê.`);
  await lockModels(ctx, [a.model_id]);
  const r = await attempt(ctx, 'UPDATE unit_allocation SET unit_id=$2 WHERE id=$1', [allocationId, newUnitId]);
  if (!r.ok) {
    const m = (await loadModels(ctx, [a.model_id])).get(a.model_id)!;
    const occ = occupiedRange(b.starts_at, b.ends_at, m.buffer);
    const free = await freeUnits(ctx, m.id, occ, b.id);
    throw new ValidationError(`${nu.barcode}: ${conflictMessage({ freeUnitCodes: free.map((f) => f.barcode), nextStart: null, fmt: fmtTime(ctx) })}`);
  }
  await audit(ctx, 'booking.swap_unit', 'booking', b.id, { from: a.unit_id, to: newUnitId });
}
