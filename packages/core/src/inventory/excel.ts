import ExcelJS from 'exceljs';
import { isValidBarcode, normalizeScan } from './barcode';

export const IMPORT_SHEET = 'Thiết bị';
export const IMPORT_COLUMNS = [
  { key: 'category', header: 'Danh mục', width: 20 },
  { key: 'model', header: 'Tên mẫu (*)', width: 28 },
  { key: 'brand', header: 'Hãng', width: 14 },
  { key: 'serial', header: 'Serial', width: 20 },
  { key: 'barcode', header: 'Mã vạch (để trống = tự sinh)', width: 24 },
  { key: 'branch', header: 'Chi nhánh', width: 18 },
  { key: 'purchaseDate', header: 'Ngày mua (yyyy-mm-dd)', width: 20 },
  { key: 'purchasePrice', header: 'Giá nhập (VND)', width: 16 },
  { key: 'compensation', header: 'Giá trị bồi thường (VND)', width: 22 },
  { key: 'condition', header: 'Tình trạng (Mới/Tốt/Khá/Kém)', width: 24 },
  { key: 'notes', header: 'Ghi chú', width: 30 },
] as const;

export type RawRow = Record<(typeof IMPORT_COLUMNS)[number]['key'], string>;

export interface ImportItem {
  category: string | null;
  model: string;
  brand: string | null;
  serial: string | null;
  barcode: string | null;
  branch: string | null;
  purchaseDate: string | null;
  purchasePrice: number | null;
  compensation: number | null;
  condition: 'NEW' | 'GOOD' | 'FAIR' | 'POOR';
  notes: string | null;
}

export interface RowError { row: number; field: string; message: string }
export interface ValidationContext {
  branchNames: ReadonlySet<string>;
  existingBarcodes: ReadonlySet<string>;
  /** `${model}|${serial}` đã có trong hệ thống (chữ thường) */
  existingSerials: ReadonlySet<string>;
}
export interface ValidationResult { items: { row: number; item: ImportItem }[]; errors: RowError[] }

const CONDITIONS: Record<string, ImportItem['condition']> = {
  'mới': 'NEW', moi: 'NEW', new: 'NEW', 'tốt': 'GOOD', tot: 'GOOD', good: 'GOOD',
  'khá': 'FAIR', kha: 'FAIR', fair: 'FAIR', 'kém': 'POOR', kem: 'POOR', poor: 'POOR',
};

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
  }
  return String(v).trim();
}

export async function buildTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(IMPORT_SHEET);
  ws.columns = IMPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.addRow({ category: 'Máy ảnh', model: 'Sony A7 III', brand: 'Sony', serial: 'SN123456', barcode: '', branch: 'Chi nhánh chính',
    purchaseDate: '2025-01-15', purchasePrice: '32000000', compensation: '30000000', condition: 'Tốt', notes: 'Dòng ví dụ, xóa trước khi nhập' });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Đọc sheet đầu tiên; ánh xạ cột theo tiêu đề (không phụ thuộc thứ tự cột). */
export async function readWorkbook(data: Buffer | ArrayBuffer): Promise<{ rows: { row: number; data: RawRow }[]; error?: string }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as ArrayBuffer);
  } catch {
    return { rows: [], error: 'Không đọc được file. Hãy dùng file Excel .xlsx theo mẫu.' };
  }
  const ws = wb.getWorksheet(IMPORT_SHEET) ?? wb.worksheets[0];
  if (!ws) return { rows: [], error: 'File không có bảng tính nào.' };
  const headerRow = ws.getRow(1);
  const colOf = new Map<string, number>();
  headerRow.eachCell((cell, col) => {
    const h = cellText(cell.value).toLowerCase();
    const def = IMPORT_COLUMNS.find((c) => c.header.toLowerCase() === h);
    if (def) colOf.set(def.key, col);
  });
  if (!colOf.has('model')) return { rows: [], error: 'Thiếu cột "Tên mẫu (*)". Hãy dùng file mẫu.' };
  const rows: { row: number; data: RawRow }[] = [];
  ws.eachRow((r, n) => {
    if (n === 1) return;
    const data = {} as RawRow;
    for (const c of IMPORT_COLUMNS) data[c.key] = colOf.has(c.key) ? cellText(r.getCell(colOf.get(c.key)!).value) : '';
    if (Object.values(data).some((v) => v !== '')) rows.push({ row: n, data });
  });
  return { rows };
}

function money(v: string): number | null | 'bad' {
  if (v === '') return null;
  const n = Number(v.replace(/[.,\s]/g, ''));
  return Number.isInteger(n) && n >= 0 ? n : 'bad';
}

/** Kiểm tra từng dòng, trả lỗi theo dòng/cột bằng tiếng Việt. Không ghi DB. */
export function validateImportRows(rows: { row: number; data: RawRow }[], ctx: ValidationContext): ValidationResult {
  const errors: RowError[] = [];
  const items: ValidationResult['items'] = [];
  const seenBarcodes = new Set<string>();
  const seenSerials = new Set<string>();
  for (const { row, data: d } of rows) {
    const err = (field: string, message: string) => errors.push({ row, field, message });
    const before = errors.length;
    if (d.model === '') err('Tên mẫu', 'Bắt buộc nhập tên mẫu.');
    const barcode = d.barcode === '' ? null : normalizeScan(d.barcode);
    if (barcode) {
      if (!isValidBarcode(barcode)) err('Mã vạch', 'Mã vạch không hợp lệ (ASCII, tối đa 40 ký tự, không khoảng trắng).');
      else if (ctx.existingBarcodes.has(barcode)) err('Mã vạch', `Mã vạch "${barcode}" đã tồn tại.`);
      else if (seenBarcodes.has(barcode)) err('Mã vạch', `Mã vạch "${barcode}" bị lặp trong file.`);
      seenBarcodes.add(barcode);
    }
    if (d.serial !== '') {
      const k = `${d.model.toLowerCase()}|${d.serial.toLowerCase()}`;
      if (ctx.existingSerials.has(k) || seenSerials.has(k)) err('Serial', `Serial "${d.serial}" của mẫu này đã tồn tại.`);
      seenSerials.add(k);
    }
    if (d.branch !== '' && !ctx.branchNames.has(d.branch.toLowerCase())) err('Chi nhánh', `Không có chi nhánh "${d.branch}".`);
    if (d.purchaseDate !== '' && !(/^\d{4}-\d{2}-\d{2}$/.test(d.purchaseDate) && !Number.isNaN(Date.parse(d.purchaseDate))))
      err('Ngày mua', 'Ngày mua phải có dạng yyyy-mm-dd.');
    const price = money(d.purchasePrice);
    if (price === 'bad') err('Giá nhập', 'Giá nhập phải là số nguyên không âm.');
    const comp = money(d.compensation);
    if (comp === 'bad') err('Giá trị bồi thường', 'Giá trị bồi thường phải là số nguyên không âm.');
    const cond = d.condition === '' ? 'GOOD' : CONDITIONS[d.condition.toLowerCase()];
    if (!cond) err('Tình trạng', 'Tình trạng phải là Mới, Tốt, Khá hoặc Kém.');
    if (errors.length === before) {
      items.push({
        row,
        item: {
          category: d.category || null, model: d.model, brand: d.brand || null, serial: d.serial || null, barcode,
          branch: d.branch || null, purchaseDate: d.purchaseDate || null,
          purchasePrice: price as number | null, compensation: comp as number | null, condition: cond!, notes: d.notes || null,
        },
      });
    }
  }
  return { items, errors };
}

export async function buildUnitsExport(rows: Record<string, string | number | null>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Thiết bị');
  ws.columns = [
    { header: 'Mã vạch', key: 'barcode', width: 18 }, { header: 'Mẫu', key: 'model', width: 28 },
    { header: 'Danh mục', key: 'category', width: 20 }, { header: 'Serial', key: 'serial', width: 20 },
    { header: 'Trạng thái', key: 'status', width: 16 }, { header: 'Chi nhánh', key: 'branch', width: 18 },
    { header: 'Giá nhập', key: 'price', width: 16 }, { header: 'Ngày mua', key: 'purchaseDate', width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
