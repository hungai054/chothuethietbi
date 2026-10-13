import { z } from 'zod';
import { DEFAULT_PRICING_CONFIG, type PricingConfig } from '../pricing/engine';

/**
 * Cấu hình giá của một cửa hàng, lưu trong tenant.settings.pricing.
 * Tenant chỉ lưu phần khác mặc định; giá trị thiếu lấy từ DEFAULT_PRICING_CONFIG.
 * `v` là phiên bản schema để nâng cấp khi lõi thay đổi.
 */
export const PRICING_SETTINGS_VERSION = 1;

export const PricingSettingsSchema = z
  .object({
    v: z.literal(PRICING_SETTINGS_VERSION).default(PRICING_SETTINGS_VERSION),
    dayMode: z.enum(['ROLLING_24H', 'CALENDAR']).optional(),
    graceMinutes: z.number().int().min(0).max(24 * 60).optional(),
    lateFee: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('PER_HOUR'), amount: z.number().int().min(0).max(100_000_000) }),
        z.object({ mode: z.literal('PERCENT_OF_DAY'), percent: z.number().min(0).max(1000) }),
      ])
      .optional(),
    vatEnabled: z.boolean().optional(),
    vatPercent: z.number().min(0).max(100).optional(),
    earlyReturn: z.enum(['REFUND_UNUSED', 'NO_REFUND']).optional(),
  })
  .strict();
export type PricingSettings = z.infer<typeof PricingSettingsSchema>;

/** Nâng cấp cấu hình cũ lên phiên bản hiện tại (hiện mới có v1). Dữ liệu không hợp lệ bị bỏ, không làm hỏng báo giá. */
export function upgradePricingSettings(raw: unknown): PricingSettings {
  if (raw === null || raw === undefined || typeof raw !== 'object') return { v: PRICING_SETTINGS_VERSION };
  const parsed = PricingSettingsSchema.safeParse({ v: PRICING_SETTINGS_VERSION, ...(raw as object) });
  return parsed.success ? parsed.data : { v: PRICING_SETTINGS_VERSION };
}

export function resolvePricingConfig(raw: unknown, timezone: string): PricingConfig {
  const s = upgradePricingSettings(raw);
  return {
    ...DEFAULT_PRICING_CONFIG,
    timezone,
    ...(s.dayMode ? { dayMode: s.dayMode } : {}),
    ...(s.graceMinutes !== undefined ? { graceMinutes: s.graceMinutes } : {}),
    ...(s.lateFee ? { lateFee: s.lateFee } : {}),
    ...(s.vatEnabled !== undefined ? { vatEnabled: s.vatEnabled } : {}),
    ...(s.vatPercent !== undefined ? { vatPercent: s.vatPercent } : {}),
    ...(s.earlyReturn ? { earlyReturn: s.earlyReturn } : {}),
  };
}
