import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  UNIT_STATUSES, canTransition, assertTransition, nextStatuses, InvalidTransitionError,
  formatBarcode, validateBarcodePattern, isValidBarcode, normalizeScan, DEFAULT_BARCODE_PATTERN,
  diffStocktake, type StocktakeUnit,
  buildTemplate, readWorkbook, validateImportRows, IMPORT_COLUMNS, type RawRow,
  renderLabelSheet, validateLabelOptions, DEFAULT_LABEL,
} from '../src';

describe('máy trạng thái thiết bị', () => {
  it('luồng thuê chuẩn hợp lệ', () => {
    const path = ['AVAILABLE', 'RESERVED', 'RENTED', 'INSPECTING', 'AVAILABLE'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });
  it('không cho nhảy cóc: đang thuê không về thẳng AVAILABLE', () => {
    expect(canTransition('RENTED', 'AVAILABLE')).toBe(false);
    expect(() => assertTransition('RENTED', 'AVAILABLE')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('AVAILABLE', 'RENTED')).toThrow(InvalidTransitionError);
  });
  it('RETIRED là điểm cuối', () => {
    expect(nextStatuses('RETIRED')).toEqual([]);
    for (const s of UNIT_STATUSES) if (s !== 'RETIRED') expect(canTransition('RETIRED', s)).toBe(false);
  });
  it('trạng thái do hệ thống đặt thì người dùng không đổi tay được, hệ thống thì được', () => {
    expect(() => assertTransition('AVAILABLE', 'RESERVED')).toThrow(/hệ thống/);
    expect(() => assertTransition('AVAILABLE', 'RESERVED', { system: true })).not.toThrow();
    expect(() => assertTransition('AVAILABLE', 'MAINTENANCE')).not.toThrow();
  });
  it('mất rồi tìm thấy thì về rảnh; bảo trì xong về rảnh', () => {
    expect(canTransition('LOST', 'AVAILABLE')).toBe(true);
    expect(canTransition('MAINTENANCE', 'AVAILABLE')).toBe(true);
  });
  it('thông báo lỗi bằng tiếng Việt, có tên trạng thái', () => {
    expect(() => assertTransition('RENTED', 'AVAILABLE')).toThrow(/Đang thuê.*Rảnh/);
  });
});

describe('mã vạch', () => {
  it('định dạng theo mẫu', () => {
    expect(formatBarcode(DEFAULT_BARCODE_PATTERN, 'CAM', 123)).toBe('CAM-000123');
    expect(formatBarcode('{prefix}{seq:3}', 'A', 7)).toBe('A007');
    expect(formatBarcode('{prefix}-{seq:2}', 'X', 12345)).toBe('X-12345'); // vượt độ rộng thì không cắt
  });
  it('kiểm tra mẫu', () => {
    expect(validateBarcodePattern(DEFAULT_BARCODE_PATTERN)).toBeNull();
    expect(validateBarcodePattern('{prefix}')).toMatch(/seq/);
    expect(validateBarcodePattern('{foo}-{seq:4}')).toMatch(/chỉ dùng/);
    expect(validateBarcodePattern('Mã {seq:4}')).toMatch(/không hợp lệ/); // có khoảng trắng và dấu
  });
  it('mã hợp lệ và chuẩn hóa dữ liệu máy quét', () => {
    expect(isValidBarcode('CAM-000123')).toBe(true);
    expect(isValidBarcode('có dấu')).toBe(false);
    expect(isValidBarcode('a'.repeat(41))).toBe(false);
    expect(normalizeScan(' cam-000123\r\n')).toBe('CAM-000123');
  });
});

describe('kiểm kê', () => {
  const u = (id: string, branchId: string | null, status = 'AVAILABLE'): StocktakeUnit => ({ id, barcode: id, name: id, branchId, status });
  const all = [u('a', 'b1'), u('b', 'b1'), u('c', 'b1', 'RENTED'), u('d', 'b2'), u('e', 'b1', 'LOST'), u('f', 'b1', 'RETIRED')];
  it('báo thiếu, bỏ qua thiết bị đang thuê/mất/thanh lý', () => {
    const r = diffStocktake(all, new Set(['a']), 'b1');
    expect(r.matched.map((x) => x.id)).toEqual(['a']);
    expect(r.missing.map((x) => x.id)).toEqual(['b']);
  });
  it('báo sai chi nhánh khi quét thiết bị thuộc chi nhánh khác', () => {
    const r = diffStocktake(all, new Set(['a', 'b', 'd']), 'b1');
    expect(r.wrongBranch.map((x) => x.id)).toEqual(['d']);
    expect(r.missing).toEqual([]);
  });
  it('báo bất thường khi quét thấy thiết bị hệ thống ghi đang thuê/mất', () => {
    const r = diffStocktake(all, new Set(['a', 'b', 'c', 'e']), 'b1');
    expect(r.unexpected.map((x) => x.id).sort()).toEqual(['c', 'e']);
  });
  it('kiểm kê toàn bộ (không chọn chi nhánh) thì thiếu tính trên mọi chi nhánh', () => {
    const r = diffStocktake(all, new Set(['a']), null);
    expect(r.missing.map((x) => x.id).sort()).toEqual(['b', 'd']);
  });
});

describe('nhập/xuất Excel', () => {
  const ctx = { branchNames: new Set(['chi nhánh chính']), existingBarcodes: new Set(['CAM-000001']), existingSerials: new Set(['sony a7|sn1']) };
  const blank = Object.fromEntries(IMPORT_COLUMNS.map((c) => [c.key, ''])) as RawRow;
  const row = (n: number, over: Partial<RawRow>) => ({ row: n, data: { ...blank, model: 'Sony A7', ...over } });

  it('dòng hợp lệ được chuẩn hóa', () => {
    const r = validateImportRows([row(2, { condition: 'Mới', purchasePrice: '32.000.000', barcode: ' cam-000009 ', branch: 'Chi nhánh chính', purchaseDate: '2025-01-15' })], ctx);
    expect(r.errors).toEqual([]);
    expect(r.items[0]!.item).toMatchObject({ condition: 'NEW', purchasePrice: 32000000, barcode: 'CAM-000009' });
  });
  it('báo lỗi theo dòng và cột, dòng sai không lọt vào danh sách hợp lệ', () => {
    const r = validateImportRows([
      row(2, { model: '' }),
      row(3, { barcode: 'CAM-000001' }),
      row(4, { serial: 'SN1' }),
      row(5, { branch: 'Kho lạ' }),
      row(6, { purchaseDate: '15/01/2025' }),
      row(7, { purchasePrice: '-5' }),
      row(8, { condition: 'Hỏng' }),
      row(9, {}),
    ], ctx);
    const by = (n: number) => r.errors.filter((e) => e.row === n).map((e) => e.field);
    expect(by(2)).toEqual(['Tên mẫu']);
    expect(by(3)).toEqual(['Mã vạch']);
    expect(by(4)).toEqual(['Serial']);
    expect(by(5)).toEqual(['Chi nhánh']);
    expect(by(6)).toEqual(['Ngày mua']);
    expect(by(7)).toEqual(['Giá nhập']);
    expect(by(8)).toEqual(['Tình trạng']);
    expect(r.items.map((i) => i.row)).toEqual([9]);
  });
  it('phát hiện trùng mã vạch và serial ngay trong file', () => {
    const r = validateImportRows([row(2, { barcode: 'X1', serial: 'S' }), row(3, { barcode: 'x1', serial: 's' })], ctx);
    expect(r.errors.map((e) => `${e.row}:${e.field}`)).toEqual(['3:Mã vạch', '3:Serial']);
  });
  it('file mẫu đọc lại được và dòng ví dụ hợp lệ', async () => {
    const buf = await buildTemplate();
    const { rows, error } = await readWorkbook(buf);
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(validateImportRows(rows, ctx).errors).toEqual([]);
  });
  it('đọc theo tiêu đề cột, không phụ thuộc thứ tự cột', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Bat ky');
    ws.addRow(['Serial', 'Tên mẫu (*)']);
    ws.addRow(['S9', 'Canon R5']);
    const { rows } = await readWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(rows[0]!.data).toMatchObject({ model: 'Canon R5', serial: 'S9' });
  });
  it('file hỏng hoặc thiếu cột bắt buộc cho thông báo rõ ràng', async () => {
    expect((await readWorkbook(Buffer.from('không phải excel'))).error).toMatch(/Không đọc được/);
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('x').addRow(['Cột lạ']);
    expect((await readWorkbook(Buffer.from(await wb.xlsx.writeBuffer()))).error).toMatch(/Thiếu cột/);
  });
});

describe('in tem', () => {
  it('sinh Code128 và QR cho từng tem, escape HTML trong tên', () => {
    const html = renderLabelSheet([{ barcode: 'CAM-000001', name: 'Sony <A7> & "III"', subtitle: 'SN1' }, { barcode: 'CAM-000002', name: 'B' }]);
    expect((html.match(/<svg/g) ?? []).length).toBe(4); // 2 tem x (Code128 + QR)
    expect(html).toContain('Sony &lt;A7&gt; &amp; &quot;III&quot;');
    expect(html).not.toContain('<A7>');
    expect(html).toContain('width:50mm');
  });
  it('tắt QR và đổi khổ tem', () => {
    const html = renderLabelSheet([{ barcode: 'A1', name: 'x' }], { ...DEFAULT_LABEL, showQr: false, widthMm: 70, heightMm: 40, columns: 2 });
    expect((html.match(/<svg/g) ?? []).length).toBe(1);
    expect(html).toContain('repeat(2,70mm)');
  });
  it('từ chối khổ tem không hợp lệ', () => {
    expect(validateLabelOptions({ ...DEFAULT_LABEL, widthMm: 5 })).not.toBeNull();
    expect(validateLabelOptions({ ...DEFAULT_LABEL, columns: 0 })).not.toBeNull();
    expect(() => renderLabelSheet([], { ...DEFAULT_LABEL, columns: 99 })).toThrow();
  });
});
