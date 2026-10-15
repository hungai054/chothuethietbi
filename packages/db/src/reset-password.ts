import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '@rentpro/core';
import { loadRootEnv } from './env';

/**
 * Hỗ trợ khẩn: đặt lại mật khẩu một người dùng của cửa hàng (mặc định là chủ cửa hàng) bằng role quản trị.
 *   pnpm db:reset-password <slug> [email]
 * Sinh mật khẩu tạm ngẫu nhiên, in ra MỘT lần, mở lại tài khoản nếu đang bị khóa và ghi `platform_audit`.
 * Không đổi trạng thái cửa hàng (nếu cửa hàng bị khóa/chỉ đọc thì xử lý riêng ở cổng quản trị).
 */
loadRootEnv();
const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('Thiếu DATABASE_ADMIN_URL (đặt trong .env ở gốc repo).');
const slug = process.argv[2]?.trim().toLowerCase();
const email = process.argv[3]?.trim().toLowerCase();
if (!slug) {
  console.error('Dùng: pnpm db:reset-password <slug-cửa-hàng> [email]');
  process.exit(1);
}

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const t = (await c.query('SELECT id, name, status, deleted_at FROM tenant WHERE slug=$1', [slug])).rows[0];
  if (!t) throw new Error(`Không có cửa hàng "${slug}".`);
  if (t.deleted_at) throw new Error(`Cửa hàng "${slug}" đã bị xóa mềm; hãy khôi phục ở cổng quản trị trước.`);
  const users = (await c.query(
    `SELECT id, email, name, role, active FROM app_user WHERE tenant_id=$1 AND ($2::text IS NULL AND role='OWNER' OR email=$2) ORDER BY created_at`, [t.id, email ?? null])).rows;
  if (users.length === 0) throw new Error(email ? `Cửa hàng "${slug}" không có người dùng ${email}.` : `Cửa hàng "${slug}" không có tài khoản chủ.`);
  if (users.length > 1) throw new Error(`Có ${users.length} tài khoản chủ (${users.map((u) => u.email).join(', ')}). Chỉ rõ email: pnpm db:reset-password ${slug} <email>`);
  const u = users[0];
  // 20 ký tự ngẫu nhiên + hậu tố bảo đảm có chữ hoa, chữ thường, số
  const temp = `${randomBytes(15).toString('base64url')}aA1`;
  await c.query('BEGIN');
  await c.query('UPDATE app_user SET password_hash=$2, active=true WHERE id=$1', [u.id, await hashPassword(temp)]);
  await c.query('INSERT INTO platform_audit(actor_id, tenant_id, action, reason, data) VALUES (NULL,$1,$2,$3,$4)', [
    t.id, 'user.password_reset_cli', 'Đặt lại mật khẩu khẩn cấp qua dòng lệnh', JSON.stringify({ user: u.email, role: u.role, wasInactive: !u.active }),
  ]);
  await c.query('COMMIT');
  console.log(`Cửa hàng: ${t.name} (${slug}) · trạng thái: ${t.status}`);
  console.log(`Tài khoản: ${u.email} (${u.role})${u.active ? '' : ' · đã mở lại (trước đó bị khóa)'}`);
  console.log(`Mật khẩu tạm: ${temp}`);
  console.log('Chỉ hiện một lần. Gửi cho khách qua kênh an toàn và dặn đổi mật khẩu ngay sau khi đăng nhập.');
  if (t.status !== 'ACTIVE' && t.status !== 'TRIAL') console.log(`Lưu ý: cửa hàng đang ở trạng thái ${t.status}, đăng nhập có thể bị giới hạn; kiểm tra ở cổng quản trị.`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => undefined);
  console.error(`LỖI: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  await c.end();
}
