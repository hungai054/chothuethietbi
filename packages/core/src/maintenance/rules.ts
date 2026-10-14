import { localDateKey } from '../pricing/engine';
import { zonedTimeToUtc } from '../time';

// ===== Phiếu bảo trì / sửa chữa =====
export const ORDER_KINDS = ['PERIODIC', 'REPAIR', 'INSPECTION', 'OTHER'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];
export const ORDER_KIND_LABEL: Record<OrderKind, string> = { PERIODIC: 'Bảo trì định kỳ', REPAIR: 'Sửa chữa', INSPECTION: 'Kiểm tra', OTHER: 'Khác' };

export const ORDER_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE', 'UNREPAIRABLE', 'DISPOSED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: 'Chờ làm', IN_PROGRESS: 'Đang làm', DONE: 'Hoàn thành', UNREPAIRABLE: 'Không sửa được', DISPOSED: 'Đã thanh lý', CANCELLED: 'Đã hủy',
};
/** Phiếu còn mở: còn giữ thiết bị / còn cần xử lý. */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ['PENDING', 'IN_PROGRESS', 'UNREPAIRABLE'];

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['DONE', 'UNREPAIRABLE'],
  UNREPAIRABLE: ['DISPOSED'],
  DONE: [], DISPOSED: [], CANCELLED: [],
};

export class InvalidOrderTransitionError extends Error {
  constructor(public readonly from: OrderStatus, public readonly to: OrderStatus) {
    super(`Không thể chuyển phiếu từ "${ORDER_STATUS_LABEL[from]}" sang "${ORDER_STATUS_LABEL[to]}".`);
    this.name = 'InvalidOrderTransitionError';
  }
}
export const nextOrderStatuses = (s: OrderStatus): readonly OrderStatus[] => TRANSITIONS[s];
export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidOrderTransitionError(from, to);
}

// ===== Chi phí và checklist =====
export interface OrderPart { name: string; qty: number; unitCost: number }
export interface ChecklistItem { text: string; done: boolean }

export function partsCost(parts: OrderPart[]): number {
  return parts.reduce((a, p) => a + p.qty * p.unitCost, 0);
}
export const orderCost = (parts: OrderPart[], laborCost: number, vendorCost = 0) => partsCost(parts) + laborCost + vendorCost;

export function validateParts(parts: OrderPart[]): string | null {
  for (const p of parts) {
    if (!p.name.trim()) return 'Tên linh kiện không được để trống.';
    if (!Number.isInteger(p.qty) || p.qty <= 0 || p.qty > 10_000) return `Linh kiện "${p.name}": số lượng phải là số nguyên dương.`;
    if (!Number.isInteger(p.unitCost) || p.unitCost < 0 || p.unitCost > 1_000_000_000) return `Linh kiện "${p.name}": đơn giá phải là số nguyên không âm (VND).`;
  }
  return null;
}

export const pendingChecklist = (c: ChecklistItem[]) => c.filter((x) => !x.done).map((x) => x.text);

// ===== Kế hoạch bảo trì định kỳ =====
export interface PlanTriggers { everyDays?: number | null; everyHours?: number | null; everyRentals?: number | null }
export interface PlanUsage { daysSince: number; hoursUsed: number; rentals: number }

export function validatePlanTriggers(t: PlanTriggers, usageBased: boolean): string | null {
  const vals = [t.everyDays, t.everyHours, t.everyRentals];
  if (vals.every((v) => v === null || v === undefined)) return 'Chọn ít nhất một điều kiện: số ngày, số giờ đã cho thuê hoặc số lượt thuê.';
  for (const v of vals) if (v !== null && v !== undefined && (!Number.isInteger(v) || v <= 0 || v > 100_000)) return 'Điều kiện bảo trì phải là số nguyên dương.';
  if (!usageBased && (t.everyHours || t.everyRentals)) return 'Bảo trì theo số giờ hoặc số lượt thuê cần gói có tính năng này. Hãy nâng cấp gói hoặc chỉ dùng số ngày.';
  return null;
}

export interface PlanEvaluation {
  due: boolean;
  /** Điều kiện đã đạt (đến trước thì kích hoạt) */
  reasons: string[];
  /** Tỷ lệ tiến độ 0..n cho từng điều kiện đang bật (>=1 là đến hạn) */
  progress: { days?: number; hours?: number; rentals?: number };
}

/** Điều kiện nào đến trước thì kích hoạt. Số giờ/lượt thuê chỉ tính khi gói cho phép. */
export function evaluatePlan(t: PlanTriggers, u: PlanUsage, usageBased: boolean): PlanEvaluation {
  const reasons: string[] = [];
  const progress: PlanEvaluation['progress'] = {};
  if (t.everyDays) {
    progress.days = u.daysSince / t.everyDays;
    if (u.daysSince >= t.everyDays) reasons.push(`đã ${Math.floor(u.daysSince)} ngày kể từ lần bảo trì trước (định kỳ ${t.everyDays} ngày)`);
  }
  if (usageBased && t.everyHours) {
    progress.hours = u.hoursUsed / t.everyHours;
    if (u.hoursUsed >= t.everyHours) reasons.push(`đã cho thuê ${Math.floor(u.hoursUsed)} giờ (định kỳ ${t.everyHours} giờ)`);
  }
  if (usageBased && t.everyRentals) {
    progress.rentals = u.rentals / t.everyRentals;
    if (u.rentals >= t.everyRentals) reasons.push(`đã qua ${u.rentals} lượt thuê (định kỳ ${t.everyRentals} lượt)`);
  }
  return { due: reasons.length > 0, reasons, progress };
}

// ===== Cửa sổ bảo trì trong lịch =====
export interface BusyRange { start: Date; end: Date }

/**
 * Tìm khung giờ bảo trì sớm nhất không trùng lịch bận: thử bắt đầu `startHour` giờ địa phương mỗi ngày kể từ `from`.
 * Trả null nếu không có khung nào trong `maxDays` ngày tới (khi đó phiếu được tạo nhưng chưa xếp lịch, kèm cảnh báo).
 */
export function findMaintenanceWindow(args: { from: Date; durationHours: number; busy: BusyRange[]; timeZone: string; startHour?: number; maxDays?: number }): BusyRange | null {
  const { from, durationHours, busy, timeZone } = args;
  const hh = String(args.startHour ?? 8).padStart(2, '0');
  const dur = durationHours * 3_600_000;
  const day0 = Date.parse(`${localDateKey(from, timeZone)}T00:00:00Z`);
  for (let i = 0; i <= (args.maxDays ?? 14); i++) {
    const key = new Date(day0 + i * 86_400_000).toISOString().slice(0, 10);
    const s = zonedTimeToUtc(`${key}T${hh}:00`, timeZone);
    if (!s || s.getTime() < from.getTime()) continue;
    const e = new Date(s.getTime() + dur);
    if (!busy.some((b) => b.start.getTime() < e.getTime() && b.end.getTime() > s.getTime())) return { start: s, end: e };
  }
  return null;
}
