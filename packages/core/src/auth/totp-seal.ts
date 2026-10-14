import { decryptSecret, encryptSecret, type KeyRing } from '@rentpro/tenancy';

/**
 * Khóa TOTP của quản trị viên lưu mã hóa (AES-GCM, khóa MASTER_KEY) để đọc được bảng platform_user cũng không vượt được lớp 2FA.
 * Dữ liệu cũ lưu chữ thường (base32) vẫn đọc được và được đánh dấu `legacy` để mã hóa lại ngay lần dùng kế tiếp.
 */
export const sealTotpSecret = (plain: string, ring: KeyRing): string => encryptSecret(plain, ring);

export function openTotpSecret(stored: string, ring: KeyRing): { secret: string; legacy: boolean } {
  if (stored.startsWith('v1.')) return { secret: decryptSecret(stored, ring), legacy: false };
  if (/^[A-Z2-7]{16,}$/.test(stored)) return { secret: stored, legacy: true };
  throw new Error('Khóa TOTP không hợp lệ');
}
