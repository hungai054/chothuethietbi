/** Quy ước đặt tên và dọn bản sao lưu (thuần, có test). Tên: rentpro-YYYYMMDD-HHMMSS.dump (UTC), kèm .sha256 */
const RE = /^rentpro-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.dump$/;

export function backupFileName(at: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `rentpro-${p(at.getUTCFullYear(), 4)}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}.dump`;
}

export function parseBackupName(name: string): Date | null {
  const m = RE.exec(name);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Giữ `keep` bản mới nhất; các tệp khác tên chuẩn KHÔNG bao giờ bị chọn xóa (tránh xóa nhầm tệp lạ).
 * Luôn giữ ít nhất 1 bản dù `keep` nhập sai.
 */
export function selectBackupsToPrune(names: string[], keep: number): string[] {
  const n = Number.isFinite(keep) ? Math.max(1, Math.floor(keep)) : 14;
  const valid = names.filter((x) => parseBackupName(x)).sort((a, b) => parseBackupName(b)!.getTime() - parseBackupName(a)!.getTime());
  return valid.slice(n);
}

/** Tên cơ sở dữ liệu tạm cho kiểm tra khôi phục: chỉ chữ thường/số/gạch dưới để nhúng an toàn vào câu lệnh DDL */
export const verifyDbName = (at: Date): string => `rentpro_verify_${at.getTime().toString(36)}`;
export const isSafeDbName = (s: string): boolean => /^[a-z_][a-z0-9_]{0,62}$/.test(s);
