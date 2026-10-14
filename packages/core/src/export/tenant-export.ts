import ExcelJS from 'exceljs';

/** Xuất toàn bộ dữ liệu cửa hàng: lọc cột nhạy cảm, ẩn bí mật trong cấu hình, gom đường dẫn file đính kèm, dựng Excel. Logic thuần, có test. */

/** Cột không bao giờ ra khỏi hệ thống: băm mật khẩu, khóa 2 lớp, số giấy tờ đã mã hóa và chỉ mục mù. */
const DROP_COLUMNS = new Set(['password_hash', 'totp_secret', 'number_enc', 'number_hash', 'token_hash']);

export function exportableRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!DROP_COLUMNS.has(k)) out[k] = v;
  return out;
}

const SECRET_KEY = /secret|token|password|passwd|^pass$|api[_-]?key|private|credential|sealed|enc$/i;

/** Thay giá trị của mọi khóa trông như bí mật bằng "[đã ẩn]" (đệ quy). Cấu hình nhà cung cấp lưu bản đã mã hóa nhưng vẫn không nên xuất. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) && v !== null && v !== undefined && v !== '' ? '[đã ẩn]' : redactSecrets(v)]));
  }
  return value;
}

/** Mọi đường dẫn file riêng tư của đúng tenant xuất hiện trong dữ liệu (cột text, mảng, jsonb lồng nhau). */
export function collectStoragePaths(tenantId: string, value: unknown, into: Set<string> = new Set()): Set<string> {
  const prefix = `tenants/${tenantId}/`;
  if (typeof value === 'string') {
    if (value.startsWith(prefix) && !value.includes('..') && !value.includes('\\') && !value.includes('//') && value.length < 300) into.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStoragePaths(tenantId, v, into);
  } else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const v of Object.values(value as Record<string, unknown>)) collectStoragePaths(tenantId, v, into);
  }
  return into;
}

export interface SheetData { name: string; rows: Record<string, unknown>[] }

const cell = (v: unknown): string | number | boolean | Date | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number(v);
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  // Ô chữ bắt đầu bằng = + - @ bị Excel hiểu là công thức: dữ liệu khách nhập có thể chứa công thức độc hại
  return s.length > 0 && '=+-@\t\r'.includes(s[0]!) ? `'${s}` : s.length > 32_000 ? `${s.slice(0, 32_000)}…` : s;
};

/** Một sổ Excel, mỗi bảng một trang tính (cột lấy theo hợp các khóa của các dòng). */
export async function tablesToXlsx(sheets: SheetData[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31).replace(/[\\/?*[\]:]/g, '-'));
    const keys = [...new Set(s.rows.flatMap((r) => Object.keys(r)))];
    ws.columns = keys.map((k) => ({ header: k, key: k, width: Math.min(40, Math.max(12, k.length + 2)) }));
    ws.getRow(1).font = { bold: true };
    for (const r of s.rows) ws.addRow(Object.fromEntries(keys.map((k) => [k, cell(r[k])])));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const EXPORT_SHEETS: Record<string, string> = {
  equipment_model: 'Mẫu thiết bị', equipment_unit: 'Thiết bị', customer: 'Khách hàng', booking: 'Đơn thuê', payment: 'Thanh toán', contract: 'Hợp đồng', maintenance_order: 'Bảo trì',
};

export function exportReadme(i: { tenantName: string; slug: string; exportedAt: Date; tables: number; rows: number; files: number; missingFiles: number; truncated: string[] }): string {
  return [
    `Dữ liệu cửa hàng "${i.tenantName}" (${i.slug})`,
    `Xuất lúc: ${i.exportedAt.toISOString()}`,
    '',
    `- data/*.json: toàn bộ dòng của ${i.tables} bảng (${i.rows} dòng), thời gian ở dạng UTC (ISO 8601), tiền là số nguyên đồng.`,
    '- tong-hop.xlsx: các bảng chính (thiết bị, khách hàng, đơn thuê, thanh toán…) để mở bằng Excel.',
    `- files/: ${i.files} file đính kèm (ảnh giấy tờ, chữ ký, biên bản, logo)${i.missingFiles ? `; ${i.missingFiles} file có trong dữ liệu nhưng không đọc được từ kho lưu trữ` : ''}.`,
    '',
    'Không có trong gói xuất: mật khẩu (băm), khóa xác thực 2 lớp, số giấy tờ tùy thân đã mã hóa và bí mật nhà cung cấp (SMS/Zalo/SMTP).',
    ...(i.truncated.length ? ['', `CẢNH BÁO: các bảng sau bị cắt bớt vì quá lớn: ${i.truncated.join(', ')}.`] : []),
  ].join('\n');
}
