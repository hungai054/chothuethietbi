import { z } from 'zod';
import { DepositRuleSchema } from '../finance/deposit';

export const FINANCE_SETTINGS_VERSION = 1;

/**
 * Cấu hình tiền bạc và hợp đồng của cửa hàng (tenant.settings.finance): tài khoản nhận tiền (VietQR),
 * quy tắc cọc, điều kiện giao thiết bị, mẫu số hợp đồng, thông tin cửa hàng in trên hợp đồng.
 */
export const FinanceSettingsSchema = z
  .object({
    v: z.literal(FINANCE_SETTINGS_VERSION).default(FINANCE_SETTINGS_VERSION),
    bank: z.object({ bin: z.string().regex(/^\d{6}$/, 'Mã ngân hàng (BIN) gồm đúng 6 chữ số.'), account: z.string().regex(/^\d{6,19}$/, 'Số tài khoản gồm 6 đến 19 chữ số.'), accountName: z.string().trim().max(60).optional() }).optional(),
    deposit: DepositRuleSchema.optional(),
    handover: z.object({ requireContract: z.boolean(), requireDeposit: z.boolean() }).optional(),
    contractPattern: z.string().min(3).max(40).optional(),
    store: z
      .object({
        name: z.string().trim().max(120).optional(), address: z.string().trim().max(250).optional(), phone: z.string().trim().max(30).optional(),
        taxCode: z.string().trim().max(20).optional(), representative: z.string().trim().max(120).optional(),
      })
      .optional(),
  })
  .strict();
export type FinanceSettings = z.infer<typeof FinanceSettingsSchema>;

export const DEFAULT_HANDOVER = { requireContract: true, requireDeposit: true } as const;

export function upgradeFinanceSettings(raw: unknown): FinanceSettings {
  if (raw === null || raw === undefined || typeof raw !== 'object') return { v: FINANCE_SETTINGS_VERSION };
  const p = FinanceSettingsSchema.safeParse({ v: FINANCE_SETTINGS_VERSION, ...(raw as object) });
  return p.success ? p.data : { v: FINANCE_SETTINGS_VERSION };
}
