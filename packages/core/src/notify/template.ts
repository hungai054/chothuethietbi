export const NOTIFY_EVENTS = ['BEFORE_DUE', 'DUE', 'OVERDUE', 'DEBT', 'HOLD_EXPIRING'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];
export const NOTIFY_EVENT_LABEL: Record<NotifyEvent, string> = {
  BEFORE_DUE: 'Sắp đến hạn trả', DUE: 'Đến hạn trả', OVERDUE: 'Quá hạn chưa trả', DEBT: 'Còn công nợ sau khi nhận lại', HOLD_EXPIRING: 'Giữ chỗ sắp hết hạn',
};

export const TEMPLATE_VARIABLES = ['ten_khach', 'ma_don', 'thiet_bi', 'han_tra', 'so_tien', 'link_thanh_toan', 'ten_cua_hang'] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export const TEMPLATE_MAX = 500;

export const DEFAULT_TEMPLATES: Record<NotifyEvent, string> = {
  BEFORE_DUE: 'Chào {ten_khach}, đơn thuê {ma_don} ({thiet_bi}) sẽ đến hạn trả lúc {han_tra}. Vui lòng trả đúng hạn. {ten_cua_hang}',
  DUE: 'Chào {ten_khach}, đơn thuê {ma_don} ({thiet_bi}) đã đến hạn trả ({han_tra}). Vui lòng mang thiết bị đến trả. {ten_cua_hang}',
  OVERDUE: 'Chào {ten_khach}, đơn thuê {ma_don} ({thiet_bi}) đã quá hạn trả từ {han_tra}. Phí trễ hạn đang phát sinh, vui lòng liên hệ cửa hàng ngay. {ten_cua_hang}',
  DEBT: 'Chào {ten_khach}, đơn {ma_don} còn {so_tien} chưa thanh toán. Thanh toán nhanh tại {link_thanh_toan}. {ten_cua_hang}',
  HOLD_EXPIRING: 'Chào {ten_khach}, phiếu giữ chỗ {ma_don} ({thiet_bi}) sẽ hết hạn lúc {han_tra}. Vui lòng xác nhận trước thời điểm này. {ten_cua_hang}',
};

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

const VAR_RE = /\{([a-z_]+)\}/g;

/** Biến không có trong danh sách cho phép (để báo lỗi khi cửa hàng sửa mẫu). */
export function unknownVariables(body: string): string[] {
  const known = new Set<string>(TEMPLATE_VARIABLES);
  return [...new Set([...body.matchAll(VAR_RE)].map((m) => m[1]!).filter((v) => !known.has(v)))];
}

export function validateTemplate(body: string): string | null {
  if (body.trim().length === 0) return 'Mẫu tin không được để trống.';
  if (body.length > TEMPLATE_MAX) return `Mẫu tin tối đa ${TEMPLATE_MAX} ký tự.`;
  const bad = unknownVariables(body);
  if (bad.length) return `Biến không hợp lệ: ${bad.map((b) => `{${b}}`).join(', ')}. Biến dùng được: ${TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(', ')}.`;
  return null;
}

/** Thay biến; biến không có giá trị thành chuỗi rỗng. Dọn khoảng trắng thừa. */
export function renderTemplate(body: string, vars: Partial<Record<TemplateVariable, string>>): string {
  const err = validateTemplate(body);
  if (err) throw new TemplateError(err);
  return body.replace(VAR_RE, (_, k: TemplateVariable) => vars[k] ?? '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,])/g, '$1').trim();
}
