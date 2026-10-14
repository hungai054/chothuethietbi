import { defineExtension } from '@rentpro/extension-sdk';
import { z } from 'zod';

/**
 * Extension "__NAME__" (__CODE__).
 * Đọc docs/CUSTOMIZATION.md trước: chỉ viết extension khi cấu hình, cờ tính năng và tùy biến không-code không đáp ứng được.
 * Chỉ import từ '@rentpro/extension-sdk' (không import packages/* khác).
 */
export const configSchema = z.object({
  /** Ví dụ: phần trăm phụ thu, chỉnh riêng cho từng cửa hàng trong cổng quản trị */
  uplift: z.number().min(0).max(100).default(10),
}).strict();

export default defineExtension({
  manifest: {
    code: '__CODE__',
    name: '__NAME__',
    version: '1.0.0',
    sdk: '^1.0',
    description: 'Mô tả ngắn: extension này làm gì cho khách hàng nào.',
    hooks: ['pricing.adjust'],
  },
  configSchema,
  hooks: {
    // Móc giá: chỉ THÊM dòng điều chỉnh (có nhãn rõ ràng). Móc đồng bộ nên nhanh và thuần (không gọi DB/mạng).
    'pricing.adjust': (ctx, quote) => [
      { label: `Phụ thu ${ctx.config.uplift as number}%`, amount: Math.round((quote.subtotal * (ctx.config.uplift as number)) / 100), source: 'extension' },
    ],
  },
  // Báo cáo riêng: dùng ctx.read.query (chỉ SELECT, chỉ dữ liệu của cửa hàng) hoặc ctx.store.
  // reports: [{ key: 'bao-cao-mau', title: 'Báo cáo mẫu', description: '…', run: async (ctx) => ({ key: 'bao-cao-mau', title: 'Báo cáo mẫu', period: '', sections: [] }) }],
});
