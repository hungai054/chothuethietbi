/**
 * Mẫu mã vạch: `{prefix}-{seq:6}` → CAM-000123. Chỉ hỗ trợ hai biến để dễ kiểm soát.
 * Mã phải nằm trong ASCII in được (Code128) và dài tối đa 40 ký tự.
 */
export const DEFAULT_BARCODE_PATTERN = '{prefix}-{seq:6}';

const TOKEN = /\{(prefix|seq)(?::(\d{1,2}))?\}/g;

export function validateBarcodePattern(pattern: string): string | null {
  if (!pattern.includes('{seq')) return 'Mẫu mã vạch phải chứa {seq:N} để mã không trùng.';
  const unknown = pattern.replace(TOKEN, '').match(/[{}]/);
  if (unknown) return 'Mẫu mã vạch chỉ dùng {prefix} và {seq:N}.';
  if (!isValidBarcode(formatBarcode(pattern, 'ABC', 1))) return 'Mẫu tạo ra mã không hợp lệ (chỉ dùng ký tự ASCII, tối đa 40 ký tự).';
  return null;
}

export function formatBarcode(pattern: string, prefix: string, seq: number): string {
  return pattern.replace(TOKEN, (_, name: string, width?: string) =>
    name === 'prefix' ? prefix : String(seq).padStart(width ? Number(width) : 1, '0'),
  );
}

export const isValidBarcode = (code: string) => /^[\x21-\x7E]{1,40}$/.test(code);

/** Chuẩn hóa chuỗi từ máy quét: cắt khoảng trắng, ký tự điều khiển; không phân biệt hoa thường. */
export const normalizeScan = (raw: string) => raw.replace(/[\r\n\t]/g, '').trim().toUpperCase();
