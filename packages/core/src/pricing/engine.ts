/**
 * Động cơ tính giá thuê: hàm thuần, tiền là số nguyên VND.
 *
 * Quy ước (đã chốt, có test):
 * - Thời lượng tính tròn LÊN theo giờ; không thấp hơn `minHours`.
 * - Chọn tổ hợp đơn vị (tháng/tuần/ngày/giờ) RẺ NHẤT cho khách mà vẫn đủ phủ thời lượng.
 *   Nếu có nhiều tổ hợp cùng giá thì lấy tổ hợp ít đơn vị hơn.
 * - Chế độ ngày: ROLLING_24H (mốc 24 giờ kể từ lúc nhận) hoặc CALENDAR (mỗi ngày lịch chạm tới tính một ngày).
 * - Trễ hạn: trong thời gian ân hạn không tính phí; quá ân hạn thì tính trên phần trễ KỂ TỪ SAU ân hạn (làm tròn lên giờ).
 */

export type RentalUnit = 'hour' | 'day' | 'week' | 'month';
export interface PriceRule { hour: number | null; day: number | null; week: number | null; month: number | null; minHours: number }

export interface PricingConfig {
  dayMode: 'ROLLING_24H' | 'CALENDAR';
  timezone: string;
  graceMinutes: number;
  lateFee: { mode: 'PER_HOUR'; amount: number } | { mode: 'PERCENT_OF_DAY'; percent: number };
  vatEnabled: boolean;
  vatPercent: number;
  /** Trả sớm: hoàn phần chưa dùng hay không. */
  earlyReturn: 'REFUND_UNUSED' | 'NO_REFUND';
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  dayMode: 'ROLLING_24H', timezone: 'Asia/Ho_Chi_Minh', graceMinutes: 30,
  lateFee: { mode: 'PER_HOUR', amount: 0 }, vatEnabled: false, vatPercent: 10, earlyReturn: 'REFUND_UNUSED',
};

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

export interface QuoteLineInput { modelId: string; name: string; qty: number; rule: PriceRule }
export type Discount = { type: 'PERCENT'; value: number; label?: string } | { type: 'AMOUNT'; value: number; label?: string };
export interface Adjustment { label: string; amount: number; source: 'discount' | 'delivery' | 'extension' | 'manual' }

export interface Part { unit: RentalUnit; count: number; unitPrice: number; amount: number }
export interface QuoteLine { modelId: string; name: string; qty: number; parts: Part[]; unitTotal: number; total: number }

export interface Quote {
  durationHours: number;
  /** Số ngày được tính (chế độ lịch) hoặc null */
  calendarDays: number | null;
  lines: QuoteLine[];
  subtotal: number;
  discount: Adjustment | null;
  delivery: number;
  adjustments: Adjustment[];
  vatRate: number;
  vatBase: number;
  vat: number;
  total: number;
  warnings: string[];
}

export interface QuoteInput {
  lines: QuoteLineInput[];
  start: Date;
  end: Date;
  config: PricingConfig;
  discount?: Discount | null;
  deliveryFee?: number;
}

const HOUR_MS = 3_600_000;
const MAX_HOURS = 366 * 24;
const SIZE_ROLLING: Record<RentalUnit, number> = { hour: 1, day: 24, week: 168, month: 720 };
const SIZE_CALENDAR: Record<RentalUnit, number> = { hour: 1, day: 1, week: 7, month: 30 };
const ORDER: RentalUnit[] = ['month', 'week', 'day', 'hour'];

const isMoney = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

export function validateRule(r: PriceRule): string | null {
  for (const u of ORDER) if (r[u] !== null && !isMoney(r[u])) return `Giá theo ${u} phải là số nguyên không âm.`;
  if (ORDER.every((u) => r[u] === null)) return 'Cần ít nhất một mức giá (giờ, ngày, tuần hoặc tháng).';
  if (!Number.isInteger(r.minHours) || r.minHours < 0 || r.minHours > 24 * 30) return 'Số giờ tối thiểu không hợp lệ.';
  return null;
}

/**
 * Phủ `need` (tính bằng đơn vị nhỏ nhất của chế độ) bằng tổ hợp rẻ nhất.
 * Các đơn vị lớn thử mọi số lượng; đơn vị nhỏ nhất đang có giá được dùng cho phần dư (làm tròn lên).
 */
export function cheapestCover(need: number, rule: PriceRule, size: Record<RentalUnit, number>, units: RentalUnit[] = ORDER): { parts: Part[]; cost: number } {
  const avail = units.filter((u) => rule[u] !== null);
  if (avail.length === 0) throw new PricingError('Mẫu này chưa có bảng giá.');
  const state: { best: { parts: Part[]; cost: number; n: number } | null } = { best: null };

  const consider = (parts: Part[], cost: number) => {
    const n = parts.reduce((a, p) => a + p.count, 0);
    const b = state.best;
    if (!b || cost < b.cost || (cost === b.cost && n < b.n)) state.best = { parts, cost, n };
  };

  const walk = (i: number, remaining: number, parts: Part[], cost: number) => {
    const u = avail[i]!;
    const price = rule[u]!;
    const isLast = i === avail.length - 1;
    const most = Math.ceil(remaining / size[u]);
    for (let c = isLast ? most : 0; c <= most; c++) {
      const nextParts = c > 0 ? [...parts, { unit: u, count: c, unitPrice: price, amount: c * price }] : parts;
      const nextCost = cost + c * price;
      const left = remaining - c * size[u];
      if (isLast || left <= 0) consider(nextParts, nextCost);
      else walk(i + 1, left, nextParts, nextCost);
    }
  };
  walk(0, need, [], 0);
  const best = state.best!;
  return { parts: best.parts, cost: best.cost };
}

/** Ngày (yyyy-mm-dd) theo múi giờ; dùng để đếm số ngày lịch chạm tới. */
export function localDateKey(d: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p; // en-CA cho dạng yyyy-mm-dd
}

export function calendarDaysTouched(start: Date, end: Date, timeZone: string): number {
  const a = Date.parse(localDateKey(start, timeZone) + 'T00:00:00Z');
  // trừ 1ms: kết thúc đúng 00:00 không tính sang ngày mới
  const b = Date.parse(localDateKey(new Date(end.getTime() - 1), timeZone) + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000) + 1;
}

export function durationHours(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  if (!(ms > 0)) throw new PricingError('Thời gian kết thúc phải sau thời gian bắt đầu.');
  const h = Math.ceil(ms / HOUR_MS - 1e-9);
  if (h > MAX_HOURS) throw new PricingError('Thời gian thuê tối đa là 366 ngày.');
  return h;
}

function priceLine(l: QuoteLineInput, hours: number, days: number | null, cfg: PricingConfig, sameLocalDay: boolean): QuoteLine {
  const bad = validateRule(l.rule);
  if (bad) throw new PricingError(`${l.name}: ${bad}`);
  if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 1000) throw new PricingError(`${l.name}: số lượng không hợp lệ.`);

  let parts: Part[];
  let cost: number;
  const rolling = () => {
    const h = Math.max(hours, l.rule.minHours);
    return cheapestCover(h, l.rule, SIZE_ROLLING);
  };
  const noCalendarUnits = l.rule.day === null && l.rule.week === null && l.rule.month === null;
  if (cfg.dayMode === 'ROLLING_24H' || noCalendarUnits) {
    ({ parts, cost } = rolling());
  } else if (sameLocalDay && l.rule.hour !== null) {
    // Trong cùng một ngày lịch: tính theo giờ nhưng không vượt giá một ngày
    const r = rolling();
    const dayCost = l.rule.day;
    if (dayCost !== null && r.cost > dayCost) ({ parts, cost } = { parts: [{ unit: 'day', count: 1, unitPrice: dayCost, amount: dayCost }], cost: dayCost });
    else ({ parts, cost } = r);
  } else {
    ({ parts, cost } = cheapestCover(days!, l.rule, SIZE_CALENDAR, ['month', 'week', 'day']));
  }
  return { modelId: l.modelId, name: l.name, qty: l.qty, parts, unitTotal: cost, total: cost * l.qty };
}

/** Tính lại các tổng từ các thành phần; dùng chung cho báo giá gốc và sau khi áp hook extension. */
function finalize(q: Omit<Quote, 'subtotal' | 'vatBase' | 'vat' | 'total'>, cfg: PricingConfig): Quote {
  const subtotal = q.lines.reduce((a, l) => a + l.total, 0);
  const adj = q.adjustments.reduce((a, x) => a + x.amount, 0);
  const base = Math.max(0, subtotal - (q.discount?.amount ?? 0) + q.delivery + adj);
  const vat = cfg.vatEnabled ? Math.round((base * cfg.vatPercent) / 100) : 0;
  return { ...q, subtotal, vatBase: base, vat, total: base + vat };
}

export function quoteRental(input: QuoteInput): Quote {
  const { config: cfg } = input;
  if (input.lines.length === 0) throw new PricingError('Đơn thuê cần ít nhất một thiết bị.');
  const hours = durationHours(input.start, input.end);
  const days = cfg.dayMode === 'CALENDAR' ? calendarDaysTouched(input.start, input.end, cfg.timezone) : null;
  const sameDay = days === 1;
  const lines = input.lines.map((l) => priceLine(l, hours, days, cfg, sameDay));
  const subtotal = lines.reduce((a, l) => a + l.total, 0);

  let discount: Adjustment | null = null;
  if (input.discount) {
    const d = input.discount;
    if (!Number.isFinite(d.value) || d.value < 0) throw new PricingError('Giảm giá không hợp lệ.');
    if (d.type === 'PERCENT' && d.value > 100) throw new PricingError('Giảm giá theo phần trăm tối đa 100%.');
    const amount = d.type === 'PERCENT' ? Math.round((subtotal * d.value) / 100) : Math.round(d.value);
    discount = { label: d.label ?? (d.type === 'PERCENT' ? `Giảm ${d.value}%` : 'Giảm giá'), amount: Math.min(amount, subtotal), source: 'discount' };
  }
  const delivery = input.deliveryFee ?? 0;
  if (!isMoney(delivery)) throw new PricingError('Phí giao nhận không hợp lệ.');
  return finalize({ durationHours: hours, calendarDays: days, lines, discount, delivery, adjustments: [], vatRate: cfg.vatEnabled ? cfg.vatPercent : 0, warnings: [] }, cfg);
}

export type PricingHook = (quote: Quote) => Adjustment[];

/**
 * Chạy hook điều chỉnh giá của extension ở bước cuối. Hook chỉ được THÊM dòng điều chỉnh (có nhãn rõ ràng);
 * không sửa các dòng gốc. Lỗi hoặc kết quả sai định dạng thì bỏ qua và ghi cảnh báo, không làm hỏng báo giá.
 */
export function applyPricingHook(quote: Quote, hook: PricingHook | undefined, cfg: PricingConfig): Quote {
  if (!hook) return quote;
  let out: Adjustment[];
  try {
    out = hook(structuredClone(quote));
  } catch (e) {
    return { ...quote, warnings: [...quote.warnings, `Quy tắc giá riêng bị lỗi và được bỏ qua: ${(e as Error).message}`] };
  }
  const limit = Math.max(quote.subtotal, 1) * 10;
  const valid = Array.isArray(out) && out.every((a) => a && typeof a.label === 'string' && a.label.trim() !== '' && Number.isInteger(a.amount) && Math.abs(a.amount) <= limit);
  if (!valid) return { ...quote, warnings: [...quote.warnings, 'Quy tắc giá riêng trả về dữ liệu không hợp lệ và được bỏ qua.'] };
  const adjustments = out.map((a) => ({ label: a.label.trim(), amount: a.amount, source: 'extension' as const }));
  return finalize({ ...quote, adjustments: [...quote.adjustments, ...adjustments] }, cfg);
}

// ===== Trễ hạn =====
export interface LateFeeResult { lateMinutes: number; billedHours: number; amount: number; withinGrace: boolean }

export function lateFee(args: { scheduledEnd: Date; returnedAt: Date; lines: QuoteLineInput[]; config: PricingConfig }): LateFeeResult {
  const { config: cfg } = args;
  const lateMs = args.returnedAt.getTime() - args.scheduledEnd.getTime();
  const lateMinutes = Math.max(0, Math.ceil(lateMs / 60_000));
  if (lateMinutes <= cfg.graceMinutes) return { lateMinutes, billedHours: 0, amount: 0, withinGrace: lateMinutes > 0 };
  const billedHours = Math.ceil((lateMinutes - cfg.graceMinutes) / 60);
  let amount = 0;
  for (const l of args.lines) {
    if (cfg.lateFee.mode === 'PER_HOUR') amount += cfg.lateFee.amount * billedHours * l.qty;
    else {
      const dayPrice = l.rule.day ?? (l.rule.hour !== null ? l.rule.hour * 24 : null);
      if (dayPrice === null) throw new PricingError(`${l.name}: cần giá theo ngày để tính phí trễ theo phần trăm.`);
      amount += Math.round((dayPrice * (cfg.lateFee.percent / 100) * billedHours) / 24) * l.qty;
    }
  }
  return { lateMinutes, billedHours, amount, withinGrace: false };
}

// ===== Gia hạn / trả sớm =====
export interface RepriceResult { before: Quote; after: Quote; delta: number }

/** Gia hạn hoặc đổi giờ kết thúc: tính lại toàn bộ và trả về chênh lệch (dương = khách trả thêm). */
export function repriceForNewEnd(input: QuoteInput, newEnd: Date): RepriceResult {
  const before = quoteRental(input);
  const after = quoteRental({ ...input, end: newEnd });
  return { before, after, delta: after.total - before.total };
}

/** Trả sớm. REFUND_UNUSED: tính lại theo thời gian thực dùng (không bao giờ cao hơn giá gốc). NO_REFUND: giữ nguyên. */
export function earlyReturn(input: QuoteInput, returnedAt: Date): RepriceResult {
  const before = quoteRental(input);
  if (input.config.earlyReturn === 'NO_REFUND' || returnedAt >= input.end) return { before, after: before, delta: 0 };
  if (returnedAt <= input.start) throw new PricingError('Giờ trả phải sau giờ bắt đầu.');
  const after = quoteRental({ ...input, end: returnedAt });
  const capped = after.total > before.total ? before : after;
  return { before, after: capped, delta: capped.total - before.total };
}
