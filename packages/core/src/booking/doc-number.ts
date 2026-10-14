/** Số chứng từ theo mẫu, VD `DT-{year}-{seq:5}` thành DT-2026-00001. Bộ đếm tăng nguyên tử ở DB, reset theo năm. */
export const DEFAULT_BOOKING_PATTERN = 'DT-{year}-{seq:5}';
const TOKEN = /\{(year|seq)(?::(\d{1,2}))?\}/g;

export function validateDocPattern(p: string): string | null {
  if (!p.includes('{seq')) return 'Mẫu số chứng từ phải chứa {seq:N}.';
  if (p.replace(TOKEN, '').match(/[{}]/)) return 'Mẫu chỉ dùng {year} và {seq:N}.';
  if (!/^[A-Za-z0-9\-_/{}:]+$/.test(p)) return 'Mẫu chỉ gồm chữ, số và các ký tự - _ /.';
  if (formatDocNumber(p, 2026, 1).length > 30) return 'Số chứng từ tối đa 30 ký tự.';
  return null;
}

export function formatDocNumber(pattern: string, year: number, seq: number): string {
  return pattern.replace(TOKEN, (_, name: string, w?: string) => (name === 'year' ? String(year) : String(seq).padStart(w ? Number(w) : 1, '0')));
}
