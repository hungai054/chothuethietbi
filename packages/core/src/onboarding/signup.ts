const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
import { validatePasswordStrength } from '../auth/password';

/** Tên miền con không cho đăng ký: trùng hạ tầng/đường dẫn hệ thống hoặc dễ gây nhầm lẫn thương hiệu. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'www', 'admin', 'api', 'app', 'mail', 'smtp', 'imap', 'ftp', 'demo', 'support', 'help', 'static', 'cdn', 'blog', 'status', 'billing',
  'dashboard', 'login', 'signup', 'rentpro', 'custom', 'assets', 'files', 'media', 'pay', 'docs', 'test', 'staging', 'dev', 'root', 'system',
]);

/** Gợi ý slug từ tên cửa hàng: bỏ dấu tiếng Việt, chữ thường, gạch ngang. */
export function suggestSlug(shopName: string): string {
  const s = shopName
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
  return s;
}

export function validateSlug(address: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(address)) return 'Địa chỉ cửa hàng gồm chữ thường, số, dấu gạch ngang (2–41 ký tự), bắt đầu bằng chữ hoặc số.';
  if (address.endsWith('-') || address.includes('--')) return 'Địa chỉ cửa hàng không được kết thúc bằng hoặc chứa hai dấu gạch ngang liên tiếp.';
  if (RESERVED_SLUGS.has(address)) return 'Địa chỉ này được hệ thống giữ riêng, vui lòng chọn địa chỉ khác.';
  return null;
}

export interface SignupInput { email: string; ownerName: string; shopName: string; slug: string; password: string; planCode?: string }

/** Kiểm tra đầu vào đăng ký; trả thông báo tiếng Việt đầu tiên gặp, hoặc null nếu hợp lệ. */
export function validateSignup(i: SignupInput): string | null {
  if (!isEmail(i.email.trim())) return 'Email không hợp lệ.';
  if (i.ownerName.trim().length < 2) return 'Vui lòng nhập họ tên chủ cửa hàng.';
  if (i.shopName.trim().length < 2 || i.shopName.trim().length > 80) return 'Tên cửa hàng từ 2 đến 80 ký tự.';
  const slugErr = validateSlug(i.slug);
  if (slugErr) return slugErr;
  return validatePasswordStrength(i.password);
}
