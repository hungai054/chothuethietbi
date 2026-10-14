// ===== Phép tính thuần cho báo cáo =====

export const AGING_BUCKETS = ['0–7 ngày', '8–30 ngày', 'Trên 30 ngày'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Tuổi nợ theo số ngày kể từ lúc nhận lại thiết bị. Âm (chưa tới) coi như 0. */
export function agingBucket(days: number): AgingBucket {
  const d = Math.max(0, Math.floor(days));
  return d <= 7 ? AGING_BUCKETS[0] : d <= 30 ? AGING_BUCKETS[1] : AGING_BUCKETS[2];
}

/** Tỷ lệ thời gian được thuê trên tổng thời gian có thể thuê, giới hạn trong 0..1. */
export function utilization(busyHours: number, capacityHours: number): number {
  if (!(capacityHours > 0)) return 0;
  return Math.min(1, Math.max(0, busyHours / capacityHours));
}

export interface UtilizationInput { modelUtilization: number; unitUtilization: number; unitAgeDays: number }
export const HIGH_UTILIZATION = 0.8;
export const LOW_UTILIZATION = 0.1;
export const MIN_AGE_FOR_DISPOSAL_DAYS = 90;

/** Gợi ý dựa trên mức sử dụng: kinh nghiệm đơn giản, chỉ để cửa hàng tham khảo. */
export function utilizationHint(i: UtilizationInput): string | null {
  if (i.unitAgeDays >= MIN_AGE_FOR_DISPOSAL_DAYS && i.unitUtilization < LOW_UTILIZATION) return 'Ít được thuê: cân nhắc thanh lý hoặc giảm giá để tăng lượt thuê';
  if (i.modelUtilization >= HIGH_UTILIZATION) return 'Thường hết hàng: cân nhắc mua thêm';
  return null;
}

export interface RoiInput { revenue: number; cost: number; purchasePrice: number | null }
export interface RoiResult { net: number; roi: number | null; paidBack: boolean | null; remaining: number | null }

/** Hoàn vốn = (doanh thu − chi phí bảo trì) so với giá nhập. Không có giá nhập thì không tính được tỷ lệ. */
export function roi(i: RoiInput): RoiResult {
  const net = i.revenue - i.cost;
  if (!i.purchasePrice || i.purchasePrice <= 0) return { net, roi: null, paidBack: null, remaining: null };
  return { net, roi: net / i.purchasePrice, paidBack: net >= i.purchasePrice, remaining: Math.max(0, i.purchasePrice - net) };
}

/** Tỷ lệ (0..1) an toàn khi mẫu số bằng 0. */
export const ratio = (a: number, b: number): number => (b > 0 ? a / b : 0);
