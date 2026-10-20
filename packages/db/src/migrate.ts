import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const DEFAULT_ROLE_PASSWORD_WARNING =
  'CẢNH BÁO: role rentpro_app / rentpro_admin đang dùng mật khẩu MẶC ĐỊNH (công khai trong mã nguồn). Đặt APP_DB_PASSWORD và PLATFORM_DB_PASSWORD (ít nhất 16 ký tự) rồi chạy lại migrate.';

/**
 * Đặt mật khẩu cho hai role ứng dụng từ biến môi trường (APP_DB_PASSWORD → rentpro_app, PLATFORM_DB_PASSWORD → rentpro_admin). Migration tạo role với mật khẩu
 * mẫu (công khai trong mã nguồn) nên khi triển khai thật PHẢI đặt lại. Chạy lại bao nhiêu lần cũng được. Nhớ cập nhật DATABASE_URL / DATABASE_PLATFORM_URL
 * cho khớp. Trả về các role đã đổi mật khẩu.
 */
export async function applyRolePasswords(adminUrl: string, env: Record<string, string | undefined> = process.env): Promise<string[]> {
  return setRolePasswords(adminUrl, [['rentpro_app', env.APP_DB_PASSWORD], ['rentpro_admin', env.PLATFORM_DB_PASSWORD]]);
}

/** Phần lõi của `applyRolePasswords`: bỏ qua mục trống, kiểm tra độ dài, rồi ALTER ROLE từng role. */
export async function setRolePasswords(adminUrl: string, entries: [role: string, password: string | undefined][]): Promise<string[]> {
  const todo = entries.filter(([, v]) => v !== undefined && v !== '') as [string, string][];
  for (const [role, pw] of todo) {
    if (pw.length < 16) throw new Error(`Mật khẩu của ${role} phải có ít nhất 16 ký tự.`);
    if (/rentpro_(app|admin)/i.test(pw)) throw new Error(`Mật khẩu của ${role} không được chứa mật khẩu mặc định.`);
  }
  if (todo.length === 0) return [];
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    // ALTER ROLE không nhận tham số $n, nên nhúng bằng escapeLiteral/escapeIdentifier của driver
    for (const [role, pw] of todo) await c.query(`ALTER ROLE ${c.escapeIdentifier(role)} PASSWORD ${c.escapeLiteral(pw)}`);
  } finally {
    await c.end();
  }
  return todo.map(([role]) => role);
}

/** Chạy các file migrations/*.sql chưa áp dụng, theo thứ tự tên, mỗi file một transaction. */
export async function migrate(adminUrl: string): Promise<string[]> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  const applied: string[] = [];
  try {
    await c.query('CREATE TABLE IF NOT EXISTS _migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM _migration')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('INSERT INTO _migration(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${f} lỗi: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.end();
  }
  const changed = await applyRolePasswords(adminUrl);
  if (changed.length) console.log(`migrate: đã đặt mật khẩu riêng cho ${changed.join(', ')}`);
  else if (process.env.NODE_ENV === 'production') console.warn(DEFAULT_ROLE_PASSWORD_WARNING);
  return applied;
}
