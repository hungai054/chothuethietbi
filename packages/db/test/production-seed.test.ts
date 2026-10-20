import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { startTestDb, type TestDb } from './helpers';
import { applyRolePasswords, setRolePasswords } from '../src/migrate';
import { platformAdminFromEnv, seed } from '../src/seed';
import { verifyPassword } from '@rentpro/core';

let t: TestDb;
beforeAll(async () => { t = await startTestDb(54342); }, 120_000);
afterAll(async () => { await t?.stop(); });
const adminUrl = () => (t.admin as unknown as { options: { connectionString: string } }).options.connectionString;
const saved = { ...process.env };
afterEach(() => { for (const k of ['SEED_DEMO', 'PLATFORM_ADMIN_EMAIL', 'PLATFORM_ADMIN_PASSWORD']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('seed triển khai thật', () => {
  it('platformAdminFromEnv: bắt buộc email hợp lệ, mật khẩu ≥ 12 ký tự có chữ và số, không dùng mật khẩu mẫu', () => {
    expect(() => platformAdminFromEnv({})).toThrow(/PLATFORM_ADMIN_EMAIL/);
    expect(() => platformAdminFromEnv({ PLATFORM_ADMIN_EMAIL: 'khong-phai-email', PLATFORM_ADMIN_PASSWORD: 'Mat-khau-dai-12345' })).toThrow(/PLATFORM_ADMIN_EMAIL/);
    expect(() => platformAdminFromEnv({ PLATFORM_ADMIN_EMAIL: 'a@b.vn', PLATFORM_ADMIN_PASSWORD: 'ngan1' })).toThrow(/12 ký tự/);
    expect(() => platformAdminFromEnv({ PLATFORM_ADMIN_EMAIL: 'a@b.vn', PLATFORM_ADMIN_PASSWORD: 'chi-co-chu-khong-so' })).toThrow(/chữ và số/);
    expect(() => platformAdminFromEnv({ PLATFORM_ADMIN_EMAIL: 'a@b.vn', PLATFORM_ADMIN_PASSWORD: 'Demo@12345678' })).toThrow(/mật khẩu mẫu/);
    expect(platformAdminFromEnv({ PLATFORM_ADMIN_EMAIL: ' Admin@Cua-Hang.VN ', PLATFORM_ADMIN_PASSWORD: 'Mat-khau-dai-12345' })).toEqual({ email: 'admin@cua-hang.vn', password: 'Mat-khau-dai-12345' });
  });

  it('thiếu thông tin quản trị thì báo lỗi và KHÔNG tạo gì; đủ thì chỉ có gói + quản trị viên, không có demo', async () => {
    process.env.SEED_DEMO = 'false';
    delete process.env.PLATFORM_ADMIN_EMAIL; delete process.env.PLATFORM_ADMIN_PASSWORD;
    await expect(seed(adminUrl())).rejects.toThrow(/PLATFORM_ADMIN_EMAIL/);
    expect((await t.admin.query('SELECT count(*)::int AS n FROM plan')).rows[0].n).toBe(0);

    process.env.PLATFORM_ADMIN_EMAIL = 'chu@cua-hang.vn';
    process.env.PLATFORM_ADMIN_PASSWORD = 'Mat-khau-that-98765';
    await seed(adminUrl());
    const q = async (sql: string) => (await t.admin.query(sql)).rows;
    expect((await q('SELECT code FROM plan ORDER BY code')).map((r) => r.code)).toEqual(['basic', 'enterprise', 'pro']);
    const admins = await q('SELECT email, password_hash, role FROM platform_user');
    expect(admins).toHaveLength(1);
    expect(admins[0]).toMatchObject({ email: 'chu@cua-hang.vn', role: 'SUPER_ADMIN' });
    expect(await verifyPassword(admins[0].password_hash, 'Mat-khau-that-98765')).toBe(true);
    expect(await verifyPassword(admins[0].password_hash, 'Demo@12345678')).toBe(false);
    expect((await q('SELECT count(*)::int AS n FROM tenant'))[0].n).toBe(0);
    expect((await q('SELECT count(*)::int AS n FROM app_user'))[0].n).toBe(0);
    expect((await q("SELECT count(*)::int AS n FROM platform_user WHERE email='admin@rentpro.local'"))[0].n).toBe(0);
    // chạy lại không nhân đôi, không đổi mật khẩu quản trị đã có
    await seed(adminUrl());
    expect((await q('SELECT count(*)::int AS n FROM platform_user'))[0].n).toBe(1);
  });
});

describe('mật khẩu role cơ sở dữ liệu', () => {
  const asRole = (role: string, pw: string) => {
    const u = new URL(adminUrl()); u.username = role; u.password = pw;
    return new pg.Client({ connectionString: u.toString() });
  };

  it('không đặt biến thì không đổi gì; mật khẩu ngắn hoặc chứa mật khẩu mặc định bị từ chối', async () => {
    expect(await applyRolePasswords(adminUrl(), {})).toEqual([]);
    await expect(applyRolePasswords(adminUrl(), { APP_DB_PASSWORD: 'ngan' })).rejects.toThrow(/ít nhất 16 ký tự/);
    await expect(applyRolePasswords(adminUrl(), { PLATFORM_DB_PASSWORD: 'xxxx-rentpro_admin-xxxxxxxx' })).rejects.toThrow(/mật khẩu mặc định/);
  });

  it('đổi mật khẩu: mật khẩu cũ ngừng hoạt động, mật khẩu mới dùng được (kể cả ký tự nháy đặc biệt); mục trống bị bỏ qua', async () => {
    // Role là của CẢ máy chủ và các file test khác đang chạy song song bằng rentpro_app/rentpro_admin, nên thử trên role tạm riêng
    const role = `tmp_pw_${Date.now().toString(36)}`;
    const c = new pg.Client({ connectionString: adminUrl() }); await c.connect();
    await c.query(`CREATE ROLE ${role} LOGIN PASSWORD 'mat-khau-cu-khong-dung-nua'`);
    try {
      const pw = "Mat-khau-moi-'quote\"-12345";
      const hashOf = async () => (await c.query('SELECT rolpassword FROM pg_authid WHERE rolname=$1', [role])).rows[0].rolpassword as string;
      const before = await hashOf();
      // Máy thử có thể dùng xác thực `trust` (không kiểm mật khẩu): khi đó chỉ kiểm được băm trong catalog, còn CI (md5/scram) kiểm cả đăng nhập
      const probe = asRole(role, 'sai-mat-khau-hoan-toan');
      const enforced = await probe.connect().then(() => false, () => true);
      if (!enforced) await probe.end(); // nếu lỡ kết nối được thì phải đóng, kẻo bị cắt lúc xóa database và ném lỗi không bắt được
      expect(await setRolePasswords(adminUrl(), [[role, pw], ['role-khac', undefined], ['role-khac-nua', '']])).toEqual([role]);
      const after = await hashOf();
      expect(after).not.toBe(before);
      expect(after).toMatch(/^SCRAM-SHA-256\$/);
      if (enforced) {
        const old = asRole(role, 'mat-khau-cu-khong-dung-nua');
        await expect(old.connect()).rejects.toThrow(/authentication/i);
        const ok = asRole(role, pw);
        await ok.connect(); expect((await ok.query('SELECT 1 AS ok')).rows[0].ok).toBe(1); await ok.end();
      }
    } finally {
      await c.query(`DROP ROLE IF EXISTS ${role}`); await c.end();
    }
  });
});
