// ===== Nhãn và thuật ngữ =====
// Tenant đổi tên gọi (VD "Thiết bị" → "Sản phẩm", "Đơn thuê" → "Booking"). Chỉ đổi chữ hiển thị, không đổi dữ liệu hay quyền.

export const LABEL_DEFAULTS = {
  unit: 'Thiết bị',
  model: 'Mẫu thiết bị',
  customer: 'Khách hàng',
  booking: 'Đơn thuê',
  contract: 'Hợp đồng',
  deposit: 'Tiền cọc',
  maintenance: 'Bảo trì',
  pricing: 'Bảng giá',
  reports: 'Báo cáo',
  timeline: 'Lịch',
} as const;
export type LabelKey = keyof typeof LABEL_DEFAULTS;
export const LABEL_KEYS = Object.keys(LABEL_DEFAULTS) as LabelKey[];
export type Labels = Record<LabelKey, string>;

export const LABEL_MAX = 30;

export function validateLabel(v: string): string | null {
  const s = v.trim();
  if (s.length > LABEL_MAX) return `Nhãn tối đa ${LABEL_MAX} ký tự.`;
  if (/[<>{}]/.test(s)) return 'Nhãn không được chứa ký tự < > { }.';
  return null;
}

/** Ghép nhãn tùy biến lên mặc định; nhãn trống hoặc không hợp lệ thì dùng mặc định (không bao giờ làm hỏng giao diện). */
export function resolveLabels(overrides: unknown): Labels {
  const out = { ...LABEL_DEFAULTS } as Labels;
  if (overrides && typeof overrides === 'object') {
    for (const k of LABEL_KEYS) {
      const v = (overrides as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim() && validateLabel(v) === null) out[k] = v.trim();
    }
  }
  return out;
}

/** Chỉ giữ nhãn khác mặc định để cấu hình lưu gọn. Ném lỗi nếu có nhãn sai. */
export function cleanLabels(input: Record<string, string>): Partial<Labels> {
  const out: Partial<Labels> = {};
  for (const [k, raw] of Object.entries(input)) {
    if (!LABEL_KEYS.includes(k as LabelKey)) throw new Error(`Nhãn "${k}" không tồn tại.`);
    const err = validateLabel(raw);
    if (err) throw new Error(`${LABEL_DEFAULTS[k as LabelKey]}: ${err}`);
    const v = raw.trim();
    if (v && v !== LABEL_DEFAULTS[k as LabelKey]) out[k as LabelKey] = v;
  }
  return out;
}
