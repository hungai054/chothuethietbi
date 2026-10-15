import pg from 'pg';
import { PlatformError, resetOwnerPassword } from './platform';
import { loadRootEnv } from './env';

/**
 * Hỗ trợ khẩn khi không vào được cổng quản trị: đặt lại mật khẩu CHỦ cửa hàng (hoặc một chủ cụ thể) bằng role quản trị.
 *   pnpm db:reset-password <slug> [email]
 * Dùng cùng hàm `resetOwnerPassword` với nút ở cổng quản trị: mật khẩu tạm in ra MỘT lần, mở lại tài khoản bị khóa, ghi nhật ký.
 */
loadRootEnv();
const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('Thiếu DATABASE_ADMIN_URL (đặt trong .env ở gốc repo).');
const slug = process.argv[2]?.trim().toLowerCase();
const email = process.argv[3]?.trim();
if (!slug) {
  console.error('Dùng: pnpm db:reset-password <slug-cửa-hàng> [email]');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
try {
  const t = (await pool.query('SELECT id, name, status, deleted_at FROM tenant WHERE slug=$1', [slug])).rows[0];
  if (!t) throw new PlatformError(`Không có cửa hàng "${slug}".`);
  const r = await resetOwnerPassword(pool, { id: '00000000-0000-0000-0000-000000000000', email: 'cli' }, t.id, { reason: 'Đặt lại mật khẩu khẩn cấp qua dòng lệnh', email });
  console.log(`Cửa hàng: ${t.name} (${slug}) · trạng thái: ${t.status}`);
  console.log(`Tài khoản: ${r.email} (OWNER)${r.wasInactive ? ' · đã mở lại (trước đó bị khóa)' : ''}`);
  console.log(`Mật khẩu tạm: ${r.tempPassword}`);
  console.log('Chỉ hiện một lần. Gửi cho khách qua kênh an toàn và dặn đổi mật khẩu ngay sau khi đăng nhập.');
  if (t.status !== 'ACTIVE' && t.status !== 'TRIAL') console.log(`Lưu ý: cửa hàng đang ở trạng thái ${t.status}, đăng nhập có thể bị giới hạn; kiểm tra ở cổng quản trị.`);
} catch (e) {
  console.error(`LỖI: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
