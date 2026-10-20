/** CSV an toàn cho Excel: ô bắt đầu bằng = + - @ (hoặc tab/CR) thêm dấu nháy để không thành công thức; luôn bọc nháy kép; có BOM để Excel đọc đúng tiếng Việt. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
