export const LIMIT_KEYS = ['branches', 'users', 'equipment', 'messages_per_month', 'storage_mb'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
/** null = không giới hạn */
export type Limits = Record<LimitKey, number | null>;

export function resolveLimits(plan: Partial<Limits>, overrides: Partial<Limits>): Limits {
  const out = {} as Limits;
  for (const k of LIMIT_KEYS) {
    out[k] = k in overrides ? (overrides[k] ?? null) : (plan[k] ?? null);
  }
  return out;
}

export class LimitExceededError extends Error {
  constructor(public readonly key: LimitKey, public readonly limit: number) {
    super(`Đã đạt giới hạn gói (${limit}) cho "${key}". Vui lòng nâng cấp gói.`);
    this.name = 'LimitExceededError';
  }
}

export function assertWithinLimit(limits: Limits, key: LimitKey, current: number, adding = 1): void {
  const max = limits[key];
  if (max !== null && current + adding > max) throw new LimitExceededError(key, max);
}

/** true khi đã dùng từ 80% trở lên */
export function nearLimit(limits: Limits, key: LimitKey, current: number, ratio = 0.8): boolean {
  const max = limits[key];
  return max !== null && max > 0 && current / max >= ratio;
}
