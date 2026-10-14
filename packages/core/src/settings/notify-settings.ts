import { z } from 'zod';
import { isValidClock } from '../notify/schedule';
import { NOTIFY_EVENTS, validateTemplate } from '../notify/template';

export const NOTIFY_SETTINGS_VERSION = 1;
export const CHANNELS = ['zalo', 'sms', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = { zalo: 'Zalo ZNS', sms: 'SMS', email: 'Email' };

const clock = z.string().refine(isValidClock, 'Giờ phải có dạng HH:MM (VD 21:00).');
const events = z.object({ BEFORE_DUE: z.boolean(), DUE: z.boolean(), OVERDUE: z.boolean(), DEBT: z.boolean(), HOLD_EXPIRING: z.boolean() });
const template = z.string().refine((s) => validateTemplate(s) === null, (s) => ({ message: validateTemplate(s) ?? '' }));

/** Chế độ gửi: console = chỉ ghi nhật ký (thử nghiệm); shared = dùng tài khoản chung của nền tảng, tính vào hạn mức tin nhắn của gói. */
export const NotifySettingsSchema = z
  .object({
    v: z.literal(NOTIFY_SETTINGS_VERSION).default(NOTIFY_SETTINGS_VERSION),
    channels: z.array(z.enum(CHANNELS)).max(3).default(['sms', 'email']),
    quietHours: z.object({ enabled: z.boolean(), start: clock, end: clock }).optional(),
    reminders: z
      .object({
        beforeDueHours: z.number().int().min(1).max(168), overdueEveryHours: z.number().int().min(1).max(168), overdueMax: z.number().int().min(0).max(30),
        holdWarnHours: z.number().int().min(1).max(72), debtAfterHours: z.number().int().min(1).max(720), events,
      })
      .optional(),
    templates: z.object(Object.fromEntries(NOTIFY_EVENTS.map((e) => [e, template.optional()])) as Record<(typeof NOTIFY_EVENTS)[number], z.ZodOptional<typeof template>>).partial().optional(),
    providers: z
      .object({
        email: z.object({ mode: z.enum(['console', 'smtp', 'shared']), host: z.string().trim().max(200).optional(), port: z.number().int().min(1).max(65535).optional(), secure: z.boolean().optional(), user: z.string().trim().max(200).optional(), passSealed: z.string().optional(), from: z.string().trim().max(200).optional() }).optional(),
        sms: z.object({ mode: z.enum(['console', 'esms', 'speedsms', 'shared']), apiKeySealed: z.string().optional(), secretSealed: z.string().optional(), brandname: z.string().trim().max(20).optional() }).optional(),
        zalo: z.object({ mode: z.enum(['console', 'zns', 'shared']), oaId: z.string().trim().max(60).optional(), accessTokenSealed: z.string().optional(), templateId: z.string().trim().max(60).optional() }).optional(),
      })
      .optional(),
  })
  .strict();
export type NotifySettings = z.infer<typeof NotifySettingsSchema>;

const EMPTY: NotifySettings = { v: NOTIFY_SETTINGS_VERSION, channels: ['sms', 'email'] };

export function upgradeNotifySettings(raw: unknown): NotifySettings {
  if (raw === null || raw === undefined || typeof raw !== 'object') return EMPTY;
  const p = NotifySettingsSchema.safeParse({ v: NOTIFY_SETTINGS_VERSION, ...(raw as object) });
  return p.success ? p.data : EMPTY;
}
