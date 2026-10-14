// ===== Trường tùy chỉnh (custom fields) =====
// Tenant tự thêm trường cho thiết bị / khách hàng / đơn thuê / hợp đồng. Giá trị lưu trong cột jsonb `custom_fields` của bản ghi.

export const FIELD_ENTITIES = ['UNIT', 'CUSTOMER', 'BOOKING', 'CONTRACT'] as const;
export type FieldEntity = (typeof FIELD_ENTITIES)[number];
export const FIELD_ENTITY_LABEL: Record<FieldEntity, string> = { UNIT: 'Thiết bị', CUSTOMER: 'Khách hàng', BOOKING: 'Đơn thuê', CONTRACT: 'Hợp đồng' };

export const FIELD_KINDS = ['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN', 'FILE'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export const FIELD_KIND_LABEL: Record<FieldKind, string> = { TEXT: 'Văn bản', NUMBER: 'Số', DATE: 'Ngày', SELECT: 'Chọn một', BOOLEAN: 'Có / không', FILE: 'Tệp đính kèm' };

export interface FieldDef {
  entity: FieldEntity;
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  options: string[];
  showInList: boolean;
  searchable: boolean;
  inContract: boolean;
  sort: number;
  active: boolean;
}

export interface FileValue { path: string; name: string }
export type FieldValue = string | number | boolean | FileValue;

export class FieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldError';
  }
}

const KEY_RE = /^[a-z][a-z0-9_]{1,30}$/;
/** Khóa trùng tên cột/biến hệ thống sẽ gây nhầm lẫn khi chèn vào mẫu tài liệu. */
const RESERVED = new Set(['id', 'name', 'type', 'status', 'code', 'cf']);
export const MAX_TEXT = 500;
export const MAX_OPTIONS = 30;
export const MAX_FIELDS_PER_ENTITY = 30;

/** "Số khung máy" → "so_khung_may" */
export function slugifyKey(label: string): string {
  const s = label.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(s) ? `f_${s}` : s;
}

/** Trả thông báo lỗi tiếng Việt, hoặc null nếu định nghĩa hợp lệ. */
export function validateFieldDef(d: FieldDef): string | null {
  if (!(FIELD_ENTITIES as readonly string[]).includes(d.entity)) return 'Đối tượng áp dụng không hợp lệ.';
  if (!(FIELD_KINDS as readonly string[]).includes(d.kind)) return 'Kiểu dữ liệu không hợp lệ.';
  if (!KEY_RE.test(d.key)) return 'Mã trường gồm chữ thường không dấu, số, gạch dưới; bắt đầu bằng chữ; 2–31 ký tự.';
  if (RESERVED.has(d.key)) return `Mã trường "${d.key}" trùng tên hệ thống, hãy chọn mã khác.`;
  const label = d.label.trim();
  if (label.length < 1 || label.length > 60) return 'Tên trường phải từ 1 đến 60 ký tự.';
  if (/[<>]/.test(label)) return 'Tên trường không được chứa ký tự < hoặc >.';
  if (d.kind === 'SELECT') {
    const o = d.options.map((x) => x.trim());
    if (o.length < 2) return 'Trường kiểu "Chọn một" cần ít nhất 2 lựa chọn.';
    if (o.length > MAX_OPTIONS) return `Tối đa ${MAX_OPTIONS} lựa chọn.`;
    if (o.some((x) => x.length < 1 || x.length > 60)) return 'Mỗi lựa chọn từ 1 đến 60 ký tự.';
    if (new Set(o.map((x) => x.toLowerCase())).size !== o.length) return 'Các lựa chọn không được trùng nhau.';
  } else if (d.options.length > 0) return 'Chỉ trường kiểu "Chọn một" mới có danh sách lựa chọn.';
  if (d.kind === 'FILE' && (d.searchable || d.inContract || d.showInList)) return 'Trường tệp đính kèm không dùng được để tìm kiếm, hiện trong danh sách hoặc chèn vào hợp đồng.';
  if (d.searchable && !['TEXT', 'SELECT', 'NUMBER'].includes(d.kind)) return 'Chỉ trường văn bản, số hoặc chọn một mới tìm kiếm được.';
  if (d.inContract && d.entity === 'UNIT') return 'Trường của thiết bị chưa chèn vào hợp đồng được (một đơn có nhiều thiết bị). Hãy dùng trường của đơn thuê hoặc khách hàng.';
  return null;
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Đổi dữ liệu nhập tay thành giá trị đã chuẩn hóa; null = để trống. Ném FieldError tiếng Việt nếu sai. */
export function coerceValue(d: Pick<FieldDef, 'label' | 'kind' | 'options'>, raw: unknown): FieldValue | null {
  if (blank(raw)) return null;
  switch (d.kind) {
    case 'TEXT': {
      const s = String(raw).trim();
      if (s.length > MAX_TEXT) throw new FieldError(`"${d.label}" tối đa ${MAX_TEXT} ký tự.`);
      return s;
    }
    case 'NUMBER': {
      const s = String(raw).trim().replace(/\s/g, '');
      // 1.234,5 (kiểu Việt) hoặc 1234.5 (kiểu máy)
      const n = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s.replace(',', '.'));
      if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw new FieldError(`"${d.label}" phải là một số.`);
      return n;
    }
    case 'DATE': {
      const s = String(raw).trim();
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
      if (!ok) throw new FieldError(`"${d.label}" phải là ngày hợp lệ (yyyy-mm-dd).`);
      return s;
    }
    case 'SELECT': {
      const s = String(raw).trim();
      if (!d.options.includes(s)) throw new FieldError(`"${d.label}": "${s}" không nằm trong danh sách lựa chọn.`);
      return s;
    }
    case 'BOOLEAN': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).trim().toLowerCase();
      if (['true', 'on', '1', 'có', 'co', 'yes'].includes(s)) return true;
      if (['false', 'off', '0', 'không', 'khong', 'no'].includes(s)) return false;
      throw new FieldError(`"${d.label}" chỉ nhận Có hoặc Không.`);
    }
    case 'FILE': {
      const v = raw as Partial<FileValue>;
      if (!v || typeof v !== 'object' || typeof v.path !== 'string' || typeof v.name !== 'string' || !v.path || v.name.length > 200) throw new FieldError(`"${d.label}": tệp đính kèm không hợp lệ.`);
      return { path: v.path, name: v.name };
    }
  }
}

export interface ValidatedValues { clean: Record<string, FieldValue>; errors: string[] }

/**
 * Kiểm tra bộ giá trị theo các định nghĩa đang hoạt động.
 * `creating`: tạo mới thì mọi trường bắt buộc phải có giá trị; sửa một phần thì chỉ cấm xóa trắng trường bắt buộc đang được gửi lên.
 * Khóa lạ bị từ chối (không để rác chui vào jsonb). Trường đã tắt không nhận giá trị mới.
 */
export function validateCustomValues(defs: FieldDef[], values: Record<string, unknown>, creating: boolean): ValidatedValues {
  const errors: string[] = [];
  const clean: Record<string, FieldValue> = {};
  const active = new Map(defs.filter((d) => d.active).map((d) => [d.key, d]));
  for (const k of Object.keys(values)) if (!active.has(k)) errors.push(`Trường "${k}" không tồn tại hoặc đã bị tắt.`);
  for (const d of active.values()) {
    const sent = Object.prototype.hasOwnProperty.call(values, d.key);
    if (!sent) {
      if (creating && d.required) errors.push(`Vui lòng nhập "${d.label}".`);
      continue;
    }
    try {
      const v = coerceValue(d, values[d.key]);
      if (v === null) {
        if (d.required) errors.push(`Vui lòng nhập "${d.label}".`);
      } else clean[d.key] = v;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { clean, errors };
}

const nf = new Intl.NumberFormat('vi-VN');
export function formatFieldValue(d: Pick<FieldDef, 'kind'>, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  switch (d.kind) {
    case 'BOOLEAN': return v === true ? 'Có' : 'Không';
    case 'DATE': return typeof v === 'string' ? v.split('-').reverse().join('/') : String(v);
    case 'NUMBER': return typeof v === 'number' ? nf.format(v) : String(v);
    case 'FILE': return typeof v === 'object' && v !== null && 'name' in v ? String((v as FileValue).name) : '';
    default: return String(v);
  }
}

/** Các cặp "nhãn: giá trị" của những trường được chèn vào hợp đồng (bỏ trường trống). */
export function contractExtras(defs: FieldDef[], values: Record<string, unknown>): { label: string; value: string }[] {
  return defs.filter((d) => d.active && d.inContract).sort((a, b) => a.sort - b.sort)
    .map((d) => ({ label: d.label, value: formatFieldValue(d, values[d.key]) })).filter((x) => x.value !== '');
}
