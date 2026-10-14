import { z } from 'zod';

/**
 * Gợi ý mức cọc theo quy tắc cấu hình của cửa hàng. Cửa hàng/extension có thể ghi đè bằng hook `deposit.suggest`.
 *  - NONE: không yêu cầu cọc
 *  - FIXED: số tiền cố định mỗi đơn
 *  - PERCENT_OF_VALUE: % tổng giá trị bồi thường của thiết bị trong đơn
 *  - PERCENT_OF_RENT: % tổng tiền thuê
 */
export const DEPOSIT_MODES = ['NONE', 'FIXED', 'PERCENT_OF_VALUE', 'PERCENT_OF_RENT'] as const;
export type DepositMode = (typeof DEPOSIT_MODES)[number];
export const DEPOSIT_MODE_LABEL: Record<DepositMode, string> = {
  NONE: 'Không yêu cầu cọc', FIXED: 'Số tiền cố định mỗi đơn', PERCENT_OF_VALUE: '% giá trị thiết bị', PERCENT_OF_RENT: '% tiền thuê',
};

export const DepositRuleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('NONE') }),
  z.object({ mode: z.literal('FIXED'), value: z.number().int().min(0).max(1_000_000_000) }),
  z.object({ mode: z.literal('PERCENT_OF_VALUE'), value: z.number().min(0).max(100) }),
  z.object({ mode: z.literal('PERCENT_OF_RENT'), value: z.number().min(0).max(300) }),
]);
export type DepositRule = z.infer<typeof DepositRuleSchema>;
export const DEFAULT_DEPOSIT_RULE: DepositRule = { mode: 'NONE' };

export interface DepositContext {
  rentTotal: number;
  /** Tổng (giá trị bồi thường × số lượng) của các thiết bị trong đơn */
  equipmentValue: number;
}

/** Làm tròn lên bội số 1.000 đ cho dễ thu. */
const roundUp1000 = (n: number) => Math.ceil(n / 1000) * 1000;

export function suggestDeposit(rule: DepositRule, c: DepositContext): number {
  switch (rule.mode) {
    case 'NONE': return 0;
    case 'FIXED': return rule.value;
    case 'PERCENT_OF_VALUE': return roundUp1000((c.equipmentValue * rule.value) / 100);
    case 'PERCENT_OF_RENT': return roundUp1000((c.rentTotal * rule.value) / 100);
  }
}

export type DepositHook = (ctx: DepositContext & { suggested: number }) => number;

/** Hook của extension có thể đổi mức cọc; lỗi hoặc kết quả sai thì dùng mức gợi ý gốc. */
export function applyDepositHook(base: number, c: DepositContext, hook?: DepositHook): { amount: number; warning?: string } {
  if (!hook) return { amount: base };
  try {
    const v = hook({ ...c, suggested: base });
    if (!Number.isInteger(v) || v < 0 || v > 1_000_000_000_000) return { amount: base, warning: 'Quy tắc cọc riêng trả về giá trị không hợp lệ và được bỏ qua.' };
    return { amount: v };
  } catch (e) {
    return { amount: base, warning: `Quy tắc cọc riêng bị lỗi và được bỏ qua: ${(e as Error).message}` };
  }
}
