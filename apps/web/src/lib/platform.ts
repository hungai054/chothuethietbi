import { providersFromEnv } from '@rentpro/billing';
import { createPool } from '@rentpro/db';
import { PlatformError } from '@rentpro/db';

type Pool = ReturnType<typeof createPool>;
const g = globalThis as unknown as { __platformPool?: Pool };

/**
 * Kết nối role quản trị CHỈ cho các luồng thương mại không thuộc một tenant có sẵn: đăng ký, hóa đơn/thanh toán thuê bao, xuất dữ liệu.
 * Mọi hàm gọi vào đây phải lấy tenantId từ phiên đã kiểm quyền (hoặc từ chữ ký webhook), không bao giờ từ đầu vào của người dùng.
 */
export function platformPool(): Pool {
  const url = process.env.DATABASE_PLATFORM_URL;
  if (!url) throw new PlatformError('Hệ thống chưa cấu hình thanh toán thuê bao (thiếu DATABASE_PLATFORM_URL).');
  return (g.__platformPool ??= createPool(url));
}

export const billingProviders = () => providersFromEnv(process.env);

/** Chế độ triển khai riêng (dedicated) ẩn đăng ký/landing. */
export const isShared = () => process.env.DEPLOY_MODE !== 'dedicated';
