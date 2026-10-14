import { z } from 'zod';

export const BOOKING_SETTINGS_VERSION = 1;
export const DEFAULT_HOLD_HOURS = 24;

/** Cấu hình đặt lịch của cửa hàng (tenant.settings.booking). Chỉ lưu phần khác mặc định. */
export const BookingSettingsSchema = z
  .object({
    v: z.literal(BOOKING_SETTINGS_VERSION).default(BOOKING_SETTINGS_VERSION),
    holdHours: z.number().int().min(1).max(24 * 30).optional(),
    codePattern: z.string().min(3).max(40).optional(),
  })
  .strict();
export type BookingSettings = z.infer<typeof BookingSettingsSchema>;

export function upgradeBookingSettings(raw: unknown): BookingSettings {
  if (raw === null || raw === undefined || typeof raw !== 'object') return { v: BOOKING_SETTINGS_VERSION };
  const p = BookingSettingsSchema.safeParse({ v: BOOKING_SETTINGS_VERSION, ...(raw as object) });
  return p.success ? p.data : { v: BOOKING_SETTINGS_VERSION };
}
