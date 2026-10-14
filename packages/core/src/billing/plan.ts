/** Logic thuần của thuê bao: chu kỳ, mã giảm giá, tính tỷ lệ khi đổi gói, giai đoạn hết hạn, lịch nhắc. Không phụ thuộc DB. */

export type Cycle = 'MONTH' | 'YEAR';
export const CYCLES: readonly Cycle[] = ['MONTH', 'YEAR'];
export const isCycle = (s: string): s is Cycle => s === 'MONTH' || s === 'YEAR';

const DAY = 86_400_000;

/** Cộng chu kỳ theo lịch (UTC); ngày 31 + 1 tháng về cuối tháng sau, không tràn sang tháng kế. */
export function addCycle(from: Date, cycle: Cycle, count = 1): Date {
  const months = (cycle === 'YEAR' ? 12 : 1) * count;
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = new Date(from.getTime());
  d.setUTCDate(1);
  d.setUTCFullYear(y, m, Math.min(from.getUTCDate(), lastDay));
  return d;
}

export const planPrice = (plan: { price_month: number; price_year: number }, cycle: Cycle): number =>
  cycle === 'YEAR' ? plan.price_year : plan.price_month;

/** Doanh thu định kỳ hằng tháng (MRR) của một khoản thuê bao đã trả. */
export const mrrOf = (price: number, cycle: Cycle): number => (cycle === 'YEAR' ? Math.round(price / 12) : price);

export interface CouponRule { percentOff?: number | null; amountOff?: number | null }

export class CouponError extends Error {
  constructor(message: string) { super(message); this.name = 'CouponError'; }
}

export interface CouponState extends CouponRule {
  code: string; active: boolean; validUntil?: Date | null; maxRedemptions?: number | null; redeemed: number; planCodes?: string[] | null;
}

/** Kiểm tra mã còn dùng được cho gói này không; ném CouponError với thông báo tiếng Việt. */
export function assertCouponUsable(c: CouponState, planCode: string, now: Date): void {
  if (!c.active) throw new CouponError('Mã giảm giá đã bị tắt.');
  if (c.validUntil && c.validUntil.getTime() < now.getTime()) throw new CouponError('Mã giảm giá đã hết hạn.');
  if (c.maxRedemptions != null && c.redeemed >= c.maxRedemptions) throw new CouponError('Mã giảm giá đã hết lượt dùng.');
  if (c.planCodes && c.planCodes.length > 0 && !c.planCodes.includes(planCode)) throw new CouponError('Mã giảm giá không áp dụng cho gói này.');
}

export function applyCoupon(subtotal: number, rule: CouponRule | null): { discount: number; total: number } {
  if (!rule) return { discount: 0, total: subtotal };
  let discount = 0;
  if (rule.percentOff) discount = Math.round((subtotal * rule.percentOff) / 100);
  else if (rule.amountOff) discount = rule.amountOff;
  discount = Math.min(Math.max(discount, 0), subtotal);
  return { discount, total: subtotal - discount };
}

export interface Proration {
  totalDays: number; daysLeft: number;
  /** Giá trị chưa dùng của gói cũ */
  credit: number;
  /** Giá gói mới cho phần kỳ còn lại */
  cost: number;
  /** Số phải trả thêm (≥ 0) */
  amountDue: number;
  /** Phần dư khi hạ gói (≥ 0), cộng vào kỳ sau/hoàn theo thỏa thuận */
  creditLeft: number;
}

/** Đổi gói giữa kỳ: tính theo tỷ lệ ngày còn lại của kỳ hiện tại (làm tròn số nguyên VND). */
export function prorateChange(i: { oldPrice: number; newPrice: number; periodStart: Date; periodEnd: Date; now: Date }): Proration {
  const totalDays = Math.max(1, Math.round((i.periodEnd.getTime() - i.periodStart.getTime()) / DAY));
  const left = Math.min(totalDays, Math.max(0, Math.ceil((i.periodEnd.getTime() - i.now.getTime()) / DAY)));
  const credit = Math.round((i.oldPrice * left) / totalDays);
  const cost = Math.round((i.newPrice * left) / totalDays);
  return { totalDays, daysLeft: left, credit, cost, amountDue: Math.max(0, cost - credit), creditLeft: Math.max(0, credit - cost) };
}

export type Phase = 'ACTIVE' | 'GRACE' | 'READ_ONLY' | 'SUSPENDED';
export interface LifecycleConfig { graceDays: number; lockDays: number }
export const DEFAULT_LIFECYCLE: LifecycleConfig = { graceDays: 3, lockDays: 30 };

/**
 * Hết hạn → ân hạn (dùng đầy đủ, có cảnh báo) → chỉ đọc → khóa. Không bao giờ xóa dữ liệu.
 * `endsAt` null = hợp đồng không thời hạn (luôn ACTIVE).
 */
export function subscriptionPhase(now: Date, endsAt: Date | null, c: LifecycleConfig = DEFAULT_LIFECYCLE): { phase: Phase; readOnlyAt: Date | null; suspendAt: Date | null } {
  if (!endsAt) return { phase: 'ACTIVE', readOnlyAt: null, suspendAt: null };
  const readOnlyAt = new Date(endsAt.getTime() + c.graceDays * DAY);
  const suspendAt = new Date(readOnlyAt.getTime() + c.lockDays * DAY);
  const t = now.getTime();
  const phase: Phase = t <= endsAt.getTime() ? 'ACTIVE' : t <= readOnlyAt.getTime() ? 'GRACE' : t <= suspendAt.getTime() ? 'READ_ONLY' : 'SUSPENDED';
  return { phase, readOnlyAt, suspendAt };
}

/** Trạng thái tenant mà giai đoạn này yêu cầu, hoặc null nếu giữ nguyên (ACTIVE/GRACE không ép trạng thái). */
export function statusForPhase(phase: Phase): 'READ_ONLY' | 'SUSPENDED' | null {
  return phase === 'READ_ONLY' ? 'READ_ONLY' : phase === 'SUSPENDED' ? 'SUSPENDED' : null;
}

export const RENEWAL_REMINDER_DAYS = [7, 1] as const;

/**
 * Mốc nhắc gia hạn mới nhất đã tới hạn mà chưa gửi: 7 ngày trước, 1 ngày trước, hoặc 0 (đã hết hạn).
 * Chỉ trả MỐC MỚI NHẤT nên tạm ngưng lâu không dồn tin cũ.
 */
export function dueRenewalReminder(now: Date, endsAt: Date | null, sent: readonly number[]): number | null {
  if (!endsAt) return null;
  const msLeft = endsAt.getTime() - now.getTime();
  const slots: number[] = [];
  if (msLeft <= 7 * DAY) slots.push(7);
  if (msLeft <= 1 * DAY) slots.push(1);
  if (msLeft <= 0) slots.push(0);
  const latest = slots[slots.length - 1];
  if (latest === undefined) return null;
  return sent.includes(latest) ? null : latest;
}

/** Mã nội dung chuyển khoản dễ nhập, không dấu, tránh ký tự dễ nhầm (0/O, 1/I). */
export function newPayCode(random: (n: number) => Uint8Array): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = random(8);
  let s = 'RP';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}
