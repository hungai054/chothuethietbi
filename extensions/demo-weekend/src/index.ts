import { defineExtension } from '@rentpro/extension-sdk';
import { z } from 'zod';

/** Số giờ nằm trong thứ Bảy/Chủ nhật (theo múi giờ cửa hàng) của khoảng [start, end). Duyệt theo giờ nên đúng cả khi thuê vắt qua nhiều tuần. */
export function weekendHours(start: Date, end: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  let n = 0;
  for (let t = Math.floor(start.getTime() / 3_600_000) * 3_600_000; t < end.getTime(); t += 3_600_000) {
    const from = Math.max(t, start.getTime());
    const to = Math.min(t + 3_600_000, end.getTime());
    if (to <= from) continue;
    const day = fmt.formatToParts(new Date(from)).find((p) => p.type === 'weekday')!.value;
    if (day === 'Sat' || day === 'Sun') n += (to - from) / 3_600_000;
  }
  return n;
}

export const configSchema = z.object({
  /** Phụ thu % trên phần tiền thuê rơi vào cuối tuần */
  uplift: z.number().min(0).max(100).default(20),
  label: z.string().trim().min(1).max(60).default('Phụ thu cuối tuần'),
}).strict();

/**
 * Extension mẫu: khách hàng tính phụ thu cuối tuần (+20% mặc định, theo tỷ lệ số giờ rơi vào Thứ Bảy/Chủ nhật)
 * và có báo cáo riêng về doanh thu theo thứ trong tuần, một trang giải thích cách tính, một tác vụ nền hằng ngày.
 */
export default defineExtension({
  manifest: {
    code: 'demo-weekend',
    name: 'Phụ thu cuối tuần (mẫu)',
    version: '1.0.0',
    sdk: '^1.0',
    description: 'Phụ thu theo tỷ lệ giờ thuê rơi vào cuối tuần; báo cáo doanh thu theo thứ trong tuần.',
    hooks: ['pricing.adjust'],
  },
  configSchema,
  hooks: {
    'pricing.adjust': (ctx, quote, info) => {
      const total = (info.end.getTime() - info.start.getTime()) / 3_600_000;
      if (!(total > 0)) return [];
      const share = weekendHours(info.start, info.end, ctx.timezone) / total;
      const amount = Math.round((quote.subtotal * share * (ctx.config.uplift as number)) / 100 / 1000) * 1000; // làm tròn 1.000 đ cho dễ thu
      return amount > 0 ? [{ label: `${ctx.config.label as string} (${ctx.config.uplift as number}% × ${Math.round(share * 100)}% thời gian)`, amount, source: 'extension' }] : [];
    },
  },
  reports: [{
    key: 'doanh-thu-thu-trong-tuan',
    title: 'Doanh thu theo thứ trong tuần',
    description: 'Số đơn và tiền thuê theo ngày giao (thứ Hai … Chủ nhật), để thấy cuối tuần đóng góp bao nhiêu.',
    permission: 'reports.finance',
    range: 'snapshot',
    run: async (ctx) => {
      const rows = await ctx.read.query<{ dow: number; n: number; total: string }>(
        `SELECT extract(isodow FROM (coalesce(delivered_at, starts_at) AT TIME ZONE $1))::int AS dow, count(*)::int AS n, coalesce(sum(total),0)::text AS total
         FROM booking WHERE deleted_at IS NULL AND status IN ('ACTIVE','RETURNED','CLOSED') GROUP BY 1 ORDER BY 1`, [ctx.timezone]);
      const names = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ nhật'];
      const data = names.map((d, i) => { const r = rows.find((x) => x.dow === i + 1); return { day: d, n: r?.n ?? 0, total: Number(r?.total ?? 0) }; });
      const all = data.reduce((a, r) => a + r.total, 0);
      const weekend = data[5]!.total + data[6]!.total;
      return {
        key: 'doanh-thu-thu-trong-tuan', title: 'Doanh thu theo thứ trong tuần', period: 'toàn bộ lịch sử',
        cards: [{ label: 'Tỷ trọng cuối tuần', value: all > 0 ? weekend / all : 0, type: 'percent' }, { label: 'Tiền thuê cuối tuần', value: weekend, type: 'money' }],
        sections: [{
          title: 'Theo thứ', columns: [{ key: 'day', label: 'Thứ', type: 'text' }, { key: 'n', label: 'Số đơn', type: 'int' }, { key: 'total', label: 'Tiền thuê', type: 'money' }],
          rows: data, totals: { day: 'Tổng', n: data.reduce((a, r) => a + r.n, 0), total: all }, chart: { type: 'bar', labelKey: 'day', series: [{ key: 'total', label: 'Tiền thuê' }] },
        }],
        notes: ['Tính theo ngày giao thiết bị (hoặc ngày bắt đầu nếu chưa có), múi giờ cửa hàng.'],
      };
    },
  }],
  pages: [{
    path: 'cach-tinh',
    title: 'Phụ thu cuối tuần',
    permission: 'booking.view',
    render: async (ctx) => ({
      key: 'cach-tinh', title: 'Phụ thu cuối tuần: cách tính', period: '',
      cards: [{ label: 'Mức phụ thu', value: `${ctx.config.uplift as number}%`, type: 'text' }, { label: 'Nhãn trên hóa đơn', value: String(ctx.config.label), type: 'text' }],
      sections: [], notes: ['Phụ thu = tiền thuê × tỷ lệ thời gian rơi vào Thứ Bảy/Chủ nhật × mức phụ thu, làm tròn 1.000 đ.', 'Đơn đã chốt giá giữ nguyên mức phụ thu lúc đặt; đổi cấu hình chỉ áp dụng cho đơn mới và khi gia hạn/dời lịch.'],
    }),
  }],
  jobs: [{
    name: 'ghi-nhan-ngay',
    schedule: { dailyAt: '06:00' },
    handler: async (ctx) => { await ctx.store.set('lan-chay-cuoi', new Date().toISOString()); },
  }],
});
