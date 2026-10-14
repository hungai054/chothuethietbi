/** Danh mục mẫu theo ngành cho trình khởi tạo: danh mục + mẫu thiết bị + giá gợi ý. Giá chỉ là gợi ý, cửa hàng sửa sau. Tiền là số nguyên VND. */

export interface TemplateModel {
  name: string; brand?: string; category: string; prefix: string;
  /** Giá thuê: giờ / ngày / tuần / tháng (null = không áp dụng) */
  price: { hour: number | null; day: number | null; week: number | null; month: number | null; minHours: number };
  compensation: number;
  /** Mẫu không theo dõi từng chiếc (tính theo số lượng) */
  tracked?: boolean;
  bufferMinutes?: number;
}

export interface IndustryTemplate { key: string; name: string; description: string; models: TemplateModel[] }

const p = (hour: number | null, day: number, week: number, month: number, minHours = 3) => ({ hour, day, week, month, minHours });

export const INDUSTRY_TEMPLATES: readonly IndustryTemplate[] = [
  {
    key: 'camera', name: 'Máy ảnh và quay phim', description: 'Máy ảnh, ống kính, âm thanh, ánh sáng.',
    models: [
      { name: 'Máy ảnh mirrorless full-frame', category: 'Máy ảnh', prefix: 'CAM', price: p(150_000, 700_000, 3_500_000, 11_000_000), compensation: 50_000_000, bufferMinutes: 120 },
      { name: 'Ống kính zoom 24-70mm f/2.8', category: 'Ống kính', prefix: 'LEN', price: p(90_000, 400_000, 2_000_000, 6_000_000), compensation: 35_000_000, bufferMinutes: 120 },
      { name: 'Micro không dây', category: 'Âm thanh', prefix: 'MIC', price: p(40_000, 150_000, 750_000, 2_400_000), compensation: 8_000_000 },
      { name: 'Đèn LED quay phim 60W', category: 'Ánh sáng', prefix: 'LGT', price: p(50_000, 200_000, 1_000_000, 3_200_000), compensation: 5_000_000 },
      { name: 'Gimbal chống rung', category: 'Phụ kiện', prefix: 'GMB', price: p(60_000, 250_000, 1_250_000, 4_000_000), compensation: 9_000_000 },
    ],
  },
  {
    key: 'event', name: 'Sự kiện, âm thanh, ánh sáng', description: 'Loa, mixer, đèn sân khấu, màn LED, bàn ghế.',
    models: [
      { name: 'Loa kéo di động', category: 'Âm thanh', prefix: 'SPK', price: p(null, 300_000, 1_500_000, 4_500_000, 4), compensation: 6_000_000 },
      { name: 'Bộ mixer + loa sân khấu', category: 'Âm thanh', prefix: 'MIX', price: p(null, 1_500_000, 7_500_000, 22_000_000, 4), compensation: 40_000_000 },
      { name: 'Đèn par LED sân khấu', category: 'Ánh sáng', prefix: 'PAR', price: p(null, 120_000, 600_000, 1_800_000, 4), compensation: 3_000_000 },
      { name: 'Màn hình LED P3 (m²)', category: 'Màn hình', prefix: 'LED', price: p(null, 600_000, 3_000_000, 9_000_000, 4), compensation: 15_000_000 },
      { name: 'Ghế sự kiện', category: 'Bàn ghế', prefix: 'CHR', price: p(null, 8_000, 40_000, 120_000, 4), compensation: 350_000, tracked: false },
      { name: 'Bàn tiệc', category: 'Bàn ghế', prefix: 'TBL', price: p(null, 30_000, 150_000, 450_000, 4), compensation: 900_000, tracked: false },
    ],
  },
  {
    key: 'tools', name: 'Dụng cụ và máy xây dựng', description: 'Máy khoan, máy cắt, giàn giáo, máy phát điện.',
    models: [
      { name: 'Máy khoan bê tông', category: 'Dụng cụ điện', prefix: 'DRL', price: p(null, 150_000, 750_000, 2_400_000, 4), compensation: 4_000_000 },
      { name: 'Máy cắt sắt', category: 'Dụng cụ điện', prefix: 'CUT', price: p(null, 120_000, 600_000, 1_900_000, 4), compensation: 3_000_000 },
      { name: 'Máy phát điện 5kW', category: 'Máy phát điện', prefix: 'GEN', price: p(null, 500_000, 2_500_000, 8_000_000, 4), compensation: 18_000_000 },
      { name: 'Giàn giáo (bộ)', category: 'Giàn giáo', prefix: 'SCF', price: p(null, 25_000, 120_000, 350_000, 4), compensation: 700_000, tracked: false },
      { name: 'Máy đầm dùi', category: 'Máy xây dựng', prefix: 'VIB', price: p(null, 200_000, 1_000_000, 3_200_000, 4), compensation: 5_000_000 },
    ],
  },
  {
    key: 'outdoor', name: 'Cắm trại và dã ngoại', description: 'Lều, túi ngủ, bếp, đồ leo núi.',
    models: [
      { name: 'Lều 4 người', category: 'Lều', prefix: 'TNT', price: p(null, 150_000, 700_000, 2_000_000, 6), compensation: 2_500_000 },
      { name: 'Túi ngủ', category: 'Đồ ngủ', prefix: 'SLP', price: p(null, 50_000, 250_000, 700_000, 6), compensation: 800_000, tracked: false },
      { name: 'Bếp dã chiến', category: 'Nấu ăn', prefix: 'STV', price: p(null, 40_000, 200_000, 600_000, 6), compensation: 600_000 },
      { name: 'Ba lô leo núi 50L', category: 'Ba lô', prefix: 'BPK', price: p(null, 70_000, 350_000, 1_000_000, 6), compensation: 1_800_000 },
    ],
  },
] as const;

export const templateByKey = (key: string): IndustryTemplate | undefined => INDUSTRY_TEMPLATES.find((t) => t.key === key);

/** Tiền tố mã vạch phải duy nhất trong một mẫu ngành (tránh hai mẫu dùng chung bộ đếm mã). */
export function validateTemplates(list: readonly IndustryTemplate[] = INDUSTRY_TEMPLATES): string[] {
  const errors: string[] = [];
  for (const t of list) {
    const seen = new Set<string>();
    for (const m of t.models) {
      if (m.tracked !== false) {
        if (seen.has(m.prefix)) errors.push(`${t.key}: trùng tiền tố ${m.prefix}`);
        seen.add(m.prefix);
      }
      if (!/^[A-Z0-9]{1,8}$/.test(m.prefix)) errors.push(`${t.key}/${m.name}: tiền tố sai`);
      const { hour, day, week, month } = m.price;
      if (![hour, day, week, month].some((x) => x !== null && x > 0)) errors.push(`${t.key}/${m.name}: thiếu giá`);
      if (day !== null && week !== null && week > day * 7) errors.push(`${t.key}/${m.name}: giá tuần cao hơn 7 ngày`);
    }
  }
  return errors;
}
