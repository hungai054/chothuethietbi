import ExcelJS from 'exceljs';
import type { ColumnType, ReportResult, ReportSection } from './types';

const FORMAT: Partial<Record<ColumnType, string>> = { money: '#,##0', int: '#,##0', percent: '0.0%', hours: '#,##0.0' };

/** Tên sheet Excel: tối đa 31 ký tự, không chứa : \ / ? * [ ] và không trùng nhau. */
export function sheetName(title: string, used: Set<string>): string {
  const base = (title.replace(/[:\\/?*[\]]/g, ' ').trim() || 'Sheet').slice(0, 31);
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
  used.add(name.toLowerCase());
  return name;
}

function addSection(wb: ExcelJS.Workbook, r: ReportResult, s: ReportSection, used: Set<string>) {
  const ws = wb.addWorksheet(sheetName(s.title, used));
  ws.addRow([r.title]).font = { bold: true, size: 14 };
  ws.addRow([`Kỳ: ${r.period}`]);
  ws.addRow([s.title]).font = { italic: true };
  if (s.note) ws.addRow([s.note]);
  ws.addRow([]);
  const head = ws.addRow(s.columns.map((c) => c.label));
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  s.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(12, Math.min(40, c.label.length + 4));
    if (FORMAT[c.type]) col.numFmt = FORMAT[c.type]!;
  });
  // Ô văn bản bắt đầu bằng = + - @ bị Excel hiểu là công thức: thêm dấu nháy để luôn là chữ (chống chèn công thức từ dữ liệu khách).
  const safe = (v: string | number | null, t: ColumnType) => (typeof v === 'string' && t === 'text' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
  for (const row of s.rows) ws.addRow(s.columns.map((c) => safe(row[c.key] ?? null, c.type)));
  if (s.totals) {
    const t = ws.addRow(s.columns.map((c) => s.totals![c.key] ?? null));
    t.font = { bold: true };
  }
  ws.views = [{ state: 'frozen', ySplit: 5 + (s.note ? 1 : 0) }];
}

/** Xuất báo cáo ra .xlsx: thẻ tóm tắt ở sheet đầu, mỗi phần là một sheet. Số giữ nguyên là số để lọc/cộng được trong Excel. */
export async function reportToXlsx(r: ReportResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RentPro';
  wb.created = new Date();
  const used = new Set<string>();
  if (r.cards?.length) {
    const ws = wb.addWorksheet(sheetName('Tổng quan', used));
    ws.addRow([r.title]).font = { bold: true, size: 14 };
    ws.addRow([`Kỳ: ${r.period}`]);
    ws.addRow([]);
    ws.addRow(['Chỉ số', 'Giá trị', 'Ghi chú']).font = { bold: true };
    for (const c of r.cards) {
      const row = ws.addRow([c.label, c.value, c.hint ?? '']);
      if (FORMAT[c.type]) row.getCell(2).numFmt = FORMAT[c.type]!;
    }
    ws.getColumn(1).width = 34; ws.getColumn(2).width = 20; ws.getColumn(3).width = 50;
  }
  for (const s of r.sections) addSection(wb, r, s, used);
  if (r.notes?.length) {
    const ws = wb.addWorksheet(sheetName('Ghi chú', used));
    for (const n of r.notes) ws.addRow([n]);
    ws.getColumn(1).width = 100;
  }
  if (wb.worksheets.length === 0) wb.addWorksheet('Trống').addRow(['Không có dữ liệu']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
