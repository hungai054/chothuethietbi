/**
 * Khoảng thời gian dạng nửa mở [start, end): hai khoảng liền kề (end của đơn này = start của đơn kia) KHÔNG trùng.
 * Khoảng chiếm dụng của một thiết bị = thời gian thuê + thời gian đệm sau khi trả (vệ sinh, kiểm tra).
 */
export interface Range { start: Date; end: Date }

const MIN = 60_000;

export class AvailabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvailabilityError';
  }
}

export function occupiedRange(start: Date, end: Date, bufferMinutes: number): Range {
  if (!(end.getTime() > start.getTime())) throw new AvailabilityError('Thời gian kết thúc phải sau thời gian bắt đầu.');
  if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0 || bufferMinutes > 7 * 24 * 60) throw new AvailabilityError('Thời gian đệm không hợp lệ.');
  return { start, end: new Date(end.getTime() + bufferMinutes * MIN) };
}

export const overlaps = (a: Range, b: Range) => a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();

/** Dạng chuỗi tstzrange của Postgres, nửa mở. */
export const toPgRange = (r: Range) => `[${r.start.toISOString()},${r.end.toISOString()})`;

/**
 * Tìm khung trống gần nhất (không sớm hơn `from`) đủ dài cho `durationMs` + đệm.
 * `busy` là các khoảng đã chiếm của MỘT thiết bị (đã gồm đệm). Trả về thời điểm bắt đầu sớm nhất khả dĩ.
 */
export function findFreeWindow(busy: Range[], from: Date, durationMs: number, bufferMs = 0): Date {
  const need = durationMs + bufferMs;
  const sorted = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  let cursor = from.getTime();
  for (const b of sorted) {
    if (b.end.getTime() <= cursor) continue;
    if (b.start.getTime() >= cursor + need) break; // đủ chỗ trước khoảng bận này
    cursor = Math.max(cursor, b.end.getTime());
  }
  return new Date(cursor);
}

/** Số lượng còn lại của hàng quản lý theo số lượng: tồn kho trừ đỉnh số lượng đang được đặt đồng thời trong khoảng muốn thuê. */
export function quantityFree(stock: number, bookings: { range: Range; qty: number }[], want: Range): number {
  const inWindow = bookings.filter((b) => overlaps(b.range, want));
  // Số lượng đồng thời chỉ tăng tại điểm bắt đầu của một đơn, nên xét các điểm đó (và đầu cửa sổ) là đủ để tìm đỉnh.
  const points = [want.start.getTime(), ...inWindow.map((b) => Math.max(b.range.start.getTime(), want.start.getTime()))];
  let peak = 0;
  for (const p of points) {
    const used = inWindow.filter((b) => b.range.start.getTime() <= p && p < b.range.end.getTime()).reduce((a, b) => a + b.qty, 0);
    peak = Math.max(peak, used);
  }
  return Math.max(0, stock - peak);
}

/**
 * Thời điểm sớm nhất (không sớm hơn `from`) mà có ít nhất `qty` thiết bị cùng rảnh trọn khoảng `durationMs` + đệm.
 * `unitsBusy[i]` là các khoảng bận của thiết bị thứ i. Ứng viên chỉ cần là `from` và các thời điểm một khoảng bận kết thúc.
 * Trả null nếu không có đủ thiết bị (VD yêu cầu nhiều hơn tổng số chiếc).
 */
export function earliestStartWithCapacity(unitsBusy: Range[][], from: Date, durationMs: number, bufferMs: number, qty: number): Date | null {
  if (qty > unitsBusy.length || qty < 1) return null;
  const candidates = new Set<number>([from.getTime()]);
  for (const busy of unitsBusy) for (const b of busy) if (b.end.getTime() > from.getTime()) candidates.add(b.end.getTime());
  for (const t of [...candidates].sort((a, b) => a - b)) {
    const freeCount = unitsBusy.filter((busy) => findFreeWindow(busy, new Date(t), durationMs, bufferMs).getTime() === t).length;
    if (freeCount >= qty) return new Date(t);
  }
  return null;
}

export function holdExpiry(now: Date, hours: number): Date {
  if (!(hours > 0 && hours <= 24 * 30)) throw new AvailabilityError('Thời gian giữ chỗ phải từ 1 giờ đến 30 ngày.');
  return new Date(now.getTime() + hours * 3_600_000);
}

export const isHoldExpired = (expiresAt: Date | null, now: Date) => expiresAt !== null && expiresAt.getTime() <= now.getTime();

/** Câu gợi ý cho người dùng khi bị trùng lịch. */
export function conflictMessage(opts: { freeUnitCodes: string[]; nextStart: Date | null; fmt: (d: Date) => string }): string {
  const parts = ['Thiết bị này đã được đặt hoặc đang bảo trì trong khoảng thời gian bạn chọn.'];
  if (opts.freeUnitCodes.length > 0) parts.push(`Còn rảnh cùng mẫu: ${opts.freeUnitCodes.slice(0, 5).join(', ')}${opts.freeUnitCodes.length > 5 ? '…' : ''}.`);
  if (opts.nextStart) parts.push(`Khung trống gần nhất của thiết bị này bắt đầu lúc ${opts.fmt(opts.nextStart)}.`);
  return parts.join(' ');
}
