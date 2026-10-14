import { searchableKeys } from './customization';
import { localDateKey, quantityFree, zonedTimeToUtc, type BookingStatus, type Range } from '@rentpro/core';
import { ACTIVE_ALLOC, releaseExpiredHolds, tzOf } from './booking';
import { NotFoundError, ValidationError, guard, type ServiceCtx } from './service';

const FEATURE = 'booking' as const;
type Row = Record<string, any>;

export interface BookingListRow {
  id: string; code: string; status: BookingStatus; customerId: string; customerName: string; startsAt: Date; endsAt: Date; total: number; holdExpiresAt: Date | null;
}

export interface BookingFilter { q?: string; status?: string; from?: Date; to?: Date; customerId?: string; page?: number; pageSize?: number }

export async function listBookings(ctx: ServiceCtx, f: BookingFilter = {}): Promise<{ rows: BookingListRow[]; total: number }> {
  guard(ctx, 'booking.view', FEATURE);
  await releaseExpiredHolds(ctx);
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 200);
  const offset = (Math.max(f.page ?? 1, 1) - 1) * pageSize;
  const q = f.q?.trim() || null;
  const digits = q ? q.replace(/\D/g, '') : '';
  const where = `b.deleted_at IS NULL
    AND ($1::text IS NULL OR b.code ILIKE '%' || $1 || '%' OR c.name ILIKE '%' || $1 || '%' OR ($2 <> '' AND c.phone LIKE '%' || $2 || '%')
         OR EXISTS (SELECT 1 FROM jsonb_each_text(b.custom_fields) e WHERE e.key = ANY($7::text[]) AND e.value ILIKE '%' || $1 || '%'))
    AND ($3::text IS NULL OR b.status = $3) AND ($4::timestamptz IS NULL OR b.ends_at >= $4) AND ($5::timestamptz IS NULL OR b.starts_at < $5)
    AND ($6::uuid IS NULL OR b.customer_id = $6)`;
  const args = [q, digits, f.status || null, f.from ?? null, f.to ?? null, f.customerId ?? null, await searchableKeys(ctx, 'BOOKING')];
  const total = (await ctx.db.query(`SELECT count(*)::int AS n FROM booking b JOIN customer c ON c.id=b.customer_id WHERE ${where}`, args)).rows[0].n;
  const { rows } = await ctx.db.query(
    `SELECT b.id, b.code, b.status, b.customer_id, c.name AS customer_name, b.starts_at, b.ends_at, b.total, b.hold_expires_at
     FROM booking b JOIN customer c ON c.id=b.customer_id WHERE ${where} ORDER BY b.starts_at DESC, b.code DESC LIMIT ${pageSize} OFFSET ${offset}`, args);
  return {
    total,
    rows: rows.map((r) => ({ id: r.id, code: r.code, status: r.status, customerId: r.customer_id, customerName: r.customer_name, startsAt: r.starts_at, endsAt: r.ends_at, total: Number(r.total), holdExpiresAt: r.hold_expires_at })),
  };
}

export async function getBooking(ctx: ServiceCtx, id: string) {
  guard(ctx, 'booking.view', FEATURE);
  await releaseExpiredHolds(ctx);
  const b = (await ctx.db.query(
    `SELECT b.*, c.name AS customer_name, c.phone AS customer_phone FROM booking b JOIN customer c ON c.id=b.customer_id WHERE b.id=$1 AND b.deleted_at IS NULL`, [id])).rows[0];
  if (!b) throw new NotFoundError('đơn thuê');
  const lines = (await ctx.db.query(
    `SELECT l.id, l.qty, l.line_total, l.unit_id, m.id AS model_id, m.name AS model_name, m.tracked FROM booking_line l JOIN equipment_model m ON m.id=l.model_id WHERE l.booking_id=$1 ORDER BY m.name`, [id])).rows;
  const units = (await ctx.db.query(
    `SELECT a.id, a.booking_line_id, a.status, a.unit_id, u.barcode, u.model_id, lower(a.period) AS s, upper(a.period) AS e
     FROM unit_allocation a JOIN equipment_unit u ON u.id=a.unit_id WHERE a.booking_id=$1 ORDER BY u.barcode`, [id])).rows;
  const history = (await ctx.db.query('SELECT from_status, to_status, reason, created_at FROM booking_status_log WHERE booking_id=$1 ORDER BY id DESC', [id])).rows;
  return {
    booking: {
      id: b.id, code: b.code, status: b.status as BookingStatus, customerId: b.customer_id, customerName: b.customer_name, customerPhone: b.customer_phone,
      startsAt: b.starts_at as Date, endsAt: b.ends_at as Date, total: Number(b.total), holdExpiresAt: b.hold_expires_at as Date | null, notes: b.notes as string | null,
      cancelReason: b.cancel_reason as string | null, extendedCount: b.extended_count as number, quote: b.quote as import('@rentpro/core').Quote | null, createdAt: b.created_at as Date,
    },
    lines: lines.map((l) => ({ id: l.id as string, modelId: l.model_id as string, modelName: l.model_name as string, qty: l.qty as number, lineTotal: Number(l.line_total), tracked: l.tracked as boolean, unitId: l.unit_id as string | null })),
    allocations: units.map((a) => ({ id: a.id as string, lineId: a.booking_line_id as string, unitId: a.unit_id as string, barcode: a.barcode as string, modelId: a.model_id as string, status: a.status as string })),
    history: history as { from_status: string | null; to_status: string; reason: string | null; created_at: Date }[],
  };
}

// ===== Tra cứu còn trống =====
export interface ModelAvailability {
  modelId: string; name: string; categoryName: string | null; tracked: boolean; total: number; free: number; freeUnits: { id: string; barcode: string }[];
}

/** Số chiếc còn rảnh theo từng mẫu trong khoảng [start, end), đã tính thời gian đệm của mẫu. */
export async function availability(ctx: ServiceCtx, start: Date, end: Date, opts: { categoryId?: string; modelId?: string } = {}): Promise<ModelAvailability[]> {
  guard(ctx, 'booking.view', FEATURE);
  if (!(end.getTime() > start.getTime())) throw new ValidationError('Thời gian kết thúc phải sau thời gian bắt đầu.');
  await releaseExpiredHolds(ctx);
  const models = (await ctx.db.query(
    `SELECT m.id, m.name, m.tracked, m.stock_qty, m.buffer_minutes, c.name AS category_name FROM equipment_model m LEFT JOIN category c ON c.id=m.category_id
     WHERE m.deleted_at IS NULL AND ($1::uuid IS NULL OR m.category_id=$1) AND ($2::uuid IS NULL OR m.id=$2) ORDER BY m.name`, [opts.categoryId ?? null, opts.modelId ?? null])).rows;
  const units = (await ctx.db.query(
    `SELECT u.id, u.barcode, u.model_id, u.status,
       EXISTS (SELECT 1 FROM unit_allocation a WHERE a.unit_id=u.id AND a.status = ANY($3::text[])
                 AND a.period && tstzrange($1::timestamptz, $2::timestamptz + (m.buffer_minutes * interval '1 minute'), '[)')) AS busy
     FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id
     WHERE u.deleted_at IS NULL AND m.deleted_at IS NULL AND u.status NOT IN ('RETIRED','LOST') ORDER BY u.barcode`, [start, end, ACTIVE_ALLOC])).rows;
  const qtyRows = (await ctx.db.query(
    `SELECT q.model_id, q.qty, lower(q.period) AS s, upper(q.period) AS e FROM qty_allocation q JOIN equipment_model m ON m.id=q.model_id
     WHERE q.status IN ('HOLD','CONFIRMED','ACTIVE') AND q.period && tstzrange($1::timestamptz, $2::timestamptz + (m.buffer_minutes * interval '1 minute'), '[)')`, [start, end])).rows;

  return models.map((m): ModelAvailability => {
    if (!m.tracked) {
      const want: Range = { start, end: new Date(end.getTime() + m.buffer_minutes * 60_000) };
      const used = qtyRows.filter((q) => q.model_id === m.id).map((q) => ({ qty: q.qty as number, range: { start: q.s as Date, end: q.e as Date } }));
      return { modelId: m.id, name: m.name, categoryName: m.category_name, tracked: false, total: m.stock_qty, free: quantityFree(m.stock_qty, used, want), freeUnits: [] };
    }
    const mine = units.filter((u) => u.model_id === m.id);
    const free = mine.filter((u) => !u.busy && u.status !== 'MAINTENANCE');
    return { modelId: m.id, name: m.name, categoryName: m.category_name, tracked: true, total: mine.length, free: free.length, freeUnits: free.map((u) => ({ id: u.id, barcode: u.barcode })) };
  });
}

// ===== Timeline =====
export interface TimelineBar { allocationId: string; bookingId: string | null; code: string | null; customer: string | null; status: string; start: Date; end: Date; rentalEnd: Date | null }
export interface TimelineRow { unitId: string; barcode: string; modelId: string; modelName: string; categoryName: string | null; unitStatus: string; bars: TimelineBar[] }

/** Dữ liệu cho lịch dạng Gantt: mỗi hàng một thiết bị, các thanh là phân bổ trong cửa sổ [from, to). Cần gói có `booking.timeline`. */
export async function timeline(ctx: ServiceCtx, from: Date, to: Date, opts: { categoryId?: string } = {}): Promise<TimelineRow[]> {
  guard(ctx, 'booking.view', 'booking.timeline');
  if (!(to.getTime() > from.getTime()) || to.getTime() - from.getTime() > 92 * 86_400_000) throw new ValidationError('Cửa sổ lịch phải từ 1 giờ đến 92 ngày.');
  await releaseExpiredHolds(ctx);
  const { rows } = await ctx.db.query(
    `SELECT u.id AS unit_id, u.barcode, u.status AS unit_status, m.id AS model_id, m.name AS model_name, c.name AS category_name,
            a.id AS alloc_id, a.status AS alloc_status, lower(a.period) AS s, upper(a.period) AS e,
            b.id AS booking_id, b.code, b.ends_at, cu.name AS customer
     FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id LEFT JOIN category c ON c.id=m.category_id
     LEFT JOIN unit_allocation a ON a.unit_id=u.id AND a.status = ANY($3::text[]) AND a.period && tstzrange($1::timestamptz,$2::timestamptz,'[)')
     LEFT JOIN booking b ON b.id=a.booking_id LEFT JOIN customer cu ON cu.id=b.customer_id
     WHERE u.deleted_at IS NULL AND m.deleted_at IS NULL AND u.status NOT IN ('RETIRED','LOST') AND ($4::uuid IS NULL OR m.category_id=$4)
     ORDER BY m.name, u.barcode, lower(a.period)`, [from, to, ACTIVE_ALLOC, opts.categoryId ?? null]);
  const out = new Map<string, TimelineRow>();
  for (const r of rows as Row[]) {
    let row = out.get(r.unit_id);
    if (!row) out.set(r.unit_id, (row = { unitId: r.unit_id, barcode: r.barcode, modelId: r.model_id, modelName: r.model_name, categoryName: r.category_name, unitStatus: r.unit_status, bars: [] }));
    if (r.alloc_id) row.bars.push({ allocationId: r.alloc_id, bookingId: r.booking_id, code: r.code, customer: r.customer, status: r.alloc_status, start: r.s, end: r.e, rentalEnd: r.ends_at ?? null });
  }
  return [...out.values()];
}

// ===== Bảng "Hôm nay" =====
export function dayBounds(now: Date, tz: string): { start: Date; end: Date } {
  const key = localDateKey(now, tz);
  const next = new Date(Date.parse(`${key}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { start: zonedTimeToUtc(`${key}T00:00`, tz)!, end: zonedTimeToUtc(`${next}T00:00`, tz)! };
}

export async function todayBoard(ctx: ServiceCtx, now = new Date()) {
  guard(ctx, 'booking.view', FEATURE);
  await releaseExpiredHolds(ctx);
  const { start, end } = dayBounds(now, tzOf(ctx));
  const q = async (where: string, args: unknown[]) => (await ctx.db.query(
    `SELECT b.id, b.code, b.status, b.starts_at, b.ends_at, b.hold_expires_at, c.name AS customer_name, c.phone FROM booking b JOIN customer c ON c.id=b.customer_id
     WHERE b.deleted_at IS NULL AND ${where} ORDER BY b.starts_at LIMIT 100`, args)).rows;
  return {
    toDeliver: await q(`b.status='CONFIRMED' AND b.starts_at >= $1 AND b.starts_at < $2`, [start, end]),
    toReceive: await q(`b.status='ACTIVE' AND b.ends_at >= $1 AND b.ends_at < $2`, [start, end]),
    overdue: await q(`b.status='ACTIVE' AND b.ends_at < $1`, [now]),
    lateDelivery: await q(`b.status='CONFIRMED' AND b.starts_at < $1`, [start]),
    holdsExpiring: await q(`b.status='HOLD' AND b.hold_expires_at < $1`, [new Date(now.getTime() + 6 * 3_600_000)]),
  };
}
