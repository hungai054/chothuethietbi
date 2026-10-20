import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import {
  withTenantId, createTenant, changePlan, setFeatureOverrides, setLimitOverrides, setTenantStatus,
  startImpersonation, endImpersonation, resetOwnerPassword, listTenantOwners, listTenants, platformStats, listAudit, PlatformError, type Actor,
} from '../src';
import { verifyPassword } from '@rentpro/core';

let t: TestDb;
let actor: Actor;

beforeAll(async () => {
  t = await startTestDb(54330);
  await t.admin.query("INSERT INTO plan(code,name,price_month) VALUES ('basic','Cơ bản',300000),('pro','Chuyên nghiệp',800000)");
  const u = await t.admin.query("INSERT INTO platform_user(email,password_hash,role) VALUES ('sa@x.vn','x','SUPER_ADMIN') RETURNING id");
  actor = { id: u.rows[0].id, email: 'sa@x.vn' };
}, 120_000);
afterAll(async () => { await t?.stop(); });

const mk = (slug: string, plan = 'basic') =>
  createTenant(t.platform, actor, { slug, name: slug, planCode: plan, ownerEmail: `o@${slug}.vn`, ownerName: 'Chủ' });

describe('quản trị khách hàng', () => {
  it('tạo tenant: có chủ cửa hàng đăng nhập được bằng mật khẩu tạm, chi nhánh, trạng thái TRIAL', async () => {
    const { tenantId, tempPassword } = await mk('shop-1');
    const user = (await withTenantId(t.app, tenantId, (db) => db.query('SELECT * FROM app_user'))).rows[0];
    expect(user.role).toBe('OWNER');
    expect(await verifyPassword(user.password_hash, tempPassword)).toBe(true);
    const [row] = (await listTenants(t.platform, { q: 'shop-1' }));
    expect(row!.status).toBe('TRIAL');
    expect(row!.trial_ends_at).not.toBeNull();
    expect((await withTenantId(t.app, tenantId, (db) => db.query('SELECT 1 FROM branch'))).rowCount).toBe(1);
  });

  it('slug trùng hoặc sai định dạng cho thông báo tiếng Việt, không để lại dữ liệu dở dang', async () => {
    await mk('shop-dup');
    await expect(mk('shop-dup')).rejects.toThrow(/đã được dùng/);
    await expect(mk('Bad Slug')).rejects.toThrow(/Slug chỉ gồm/);
    await expect(mk('shop-nogoi', 'khong-co')).rejects.toThrow(PlatformError);
    expect((await listTenants(t.platform, { q: 'shop-nogoi' })).length).toBe(0);
  });

  it('đổi gói và ghi audit', async () => {
    const { tenantId } = await mk('shop-plan');
    await changePlan(t.platform, actor, tenantId, 'pro');
    expect((await listTenants(t.platform, { q: 'shop-plan' }))[0]!.plan_code).toBe('pro');
    const a = await listAudit(t.platform, tenantId);
    expect(a.some((r) => r.action === 'tenant.change_plan' && r.data.from === 'basic' && r.data.to === 'pro')).toBe(true);
  });

  it('ghi đè cờ tính năng: kiểm tra khóa, null = bỏ ghi đè', async () => {
    const { tenantId } = await mk('shop-flag');
    await setFeatureOverrides(t.platform, actor, tenantId, { 'booking.timeline': true, api: false });
    expect((await listTenants(t.platform, { q: 'shop-flag' }))[0]!.feature_overrides).toEqual({ 'booking.timeline': true, api: false });
    await setFeatureOverrides(t.platform, actor, tenantId, { api: null });
    expect((await listTenants(t.platform, { q: 'shop-flag' }))[0]!.feature_overrides).toEqual({});
    await expect(setFeatureOverrides(t.platform, actor, tenantId, { khong_co: true })).rejects.toThrow(/không hợp lệ/);
  });

  it('ghi đè giới hạn: null = không giới hạn, số âm bị từ chối', async () => {
    const { tenantId } = await mk('shop-lim');
    await setLimitOverrides(t.platform, actor, tenantId, { equipment: 5000, users: null });
    expect((await listTenants(t.platform, { q: 'shop-lim' }))[0]!.limit_overrides).toEqual({ equipment: 5000, users: null });
    await expect(setLimitOverrides(t.platform, actor, tenantId, { equipment: -1 })).rejects.toThrow();
  });

  it('khóa tenant và chặn trạng thái DELETED qua đường này', async () => {
    const { tenantId } = await mk('shop-lock');
    await setTenantStatus(t.platform, actor, tenantId, 'SUSPENDED', 'chậm thanh toán');
    expect((await listTenants(t.platform, { status: 'SUSPENDED' })).some((x) => x.id === tenantId)).toBe(true);
    await expect(setTenantStatus(t.platform, actor, tenantId, 'DELETED')).rejects.toThrow(/không hợp lệ/);
    const a = await listAudit(t.platform, tenantId);
    expect(a.find((r) => r.action === 'tenant.status')!.reason).toBe('chậm thanh toán');
  });

  it('số liệu: MRR chỉ tính tenant ACTIVE', async () => {
    const { tenantId } = await mk('shop-mrr', 'pro');
    const before = Number((await platformStats(t.platform)).mrr);
    await setTenantStatus(t.platform, actor, tenantId, 'ACTIVE');
    expect(Number((await platformStats(t.platform)).mrr) - before).toBe(800000);
  });
});

describe('đăng nhập thay (hỗ trợ)', () => {
  it('bắt buộc lý do hợp lệ và thời hạn trong giới hạn', async () => {
    const { tenantId } = await mk('shop-imp0');
    await expect(startImpersonation(t.platform, actor, tenantId, '  ', 30)).rejects.toThrow(/Lý do/);
    await expect(startImpersonation(t.platform, actor, tenantId, 'khách báo lỗi', 1000)).rejects.toThrow(/Thời hạn/);
  });

  it('ghi audit nền tảng + nhật ký của tenant; tenant xem được lịch sử, tenant khác thì không', async () => {
    const A = (await mk('shop-impa')).tenantId;
    const B = (await mk('shop-impb')).tenantId;
    const { id } = await startImpersonation(t.platform, actor, A, 'khách báo lỗi không in được hợp đồng', 30);
    const own = await withTenantId(t.app, A, (db) => db.query('SELECT * FROM support_access'));
    expect(own.rows.map((r) => r.id)).toEqual([id]);
    expect(own.rows[0].platform_user_email).toBe('sa@x.vn');
    expect((await withTenantId(t.app, B, (db) => db.query('SELECT * FROM support_access'))).rowCount).toBe(0);
    const log = await withTenantId(t.app, A, (db) => db.query("SELECT * FROM audit_log WHERE action='support.access'"));
    expect(log.rowCount).toBe(1);
    expect((await listAudit(t.platform, A)).some((r) => r.action === 'tenant.impersonate.start')).toBe(true);
  });

  it('tenant không tự tạo/sửa/xóa được phiên hỗ trợ', async () => {
    const A = (await mk('shop-impc')).tenantId;
    const { id } = await startImpersonation(t.platform, actor, A, 'kiểm tra quyền', 30);
    await expect(withTenantId(t.app, A, (db) => db.query('UPDATE support_access SET ended_at=now()'))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, A, (db) => db.query('DELETE FROM support_access'))).rejects.toThrow(/permission denied/);
    await endImpersonation(t.platform, actor, id);
    const r = await withTenantId(t.app, A, (db) => db.query('SELECT ended_at FROM support_access WHERE id=$1', [id]));
    expect(r.rows[0].ended_at).not.toBeNull();
  });
});

describe('ranh giới role', () => {
  it('app role không gọi được dữ liệu nền tảng; admin role bypass RLS', async () => {
    await expect(t.app.query('SELECT * FROM platform_user')).rejects.toThrow(/permission denied/);
    expect((await t.platform.query('SELECT count(*)::int AS n FROM app_user')).rows[0].n).toBeGreaterThan(1);
  });
});

describe('đặt lại mật khẩu chủ cửa hàng', () => {
  const loginHash = async (tenantId: string, email: string) =>
    (await withTenantId(t.app, tenantId, (db) => db.query('SELECT password_hash, active FROM app_user WHERE email=$1', [email]))).rows[0];

  it('mật khẩu cũ mất hiệu lực, mật khẩu tạm dùng được, mở lại tài khoản bị khóa, ghi nhật ký quản trị và nhật ký của cửa hàng', async () => {
    const { tenantId, tempPassword: oldPw } = await mk('reset-1');
    await t.admin.query("UPDATE app_user SET active=false WHERE tenant_id=$1", [tenantId]);
    const r = await resetOwnerPassword(t.platform, actor, tenantId, { reason: 'Chủ cửa hàng quên mật khẩu, đã gọi điện xác minh' });
    expect(r).toMatchObject({ email: 'o@reset-1.vn', wasInactive: true });
    expect(r.tempPassword.length).toBeGreaterThanOrEqual(20);
    const u = await loginHash(tenantId, r.email);
    expect(u.active).toBe(true);
    expect(await verifyPassword(u.password_hash, r.tempPassword)).toBe(true);
    expect(await verifyPassword(u.password_hash, oldPw)).toBe(false);
    const a = (await listAudit(t.platform, tenantId)).find((x) => x.action === 'tenant.owner_password_reset')!;
    expect(a.reason).toContain('quên mật khẩu');
    expect(JSON.stringify(a.data)).not.toContain(r.tempPassword);
    const own = (await withTenantId(t.app, tenantId, (db) => db.query("SELECT data FROM audit_log WHERE action='support.password_reset'"))).rows;
    expect(own).toHaveLength(1);
    expect(JSON.stringify(own[0].data)).not.toContain(r.tempPassword);
    // mỗi lần đặt lại cho mật khẩu khác nhau
    const r2 = await resetOwnerPassword(t.platform, actor, tenantId, { reason: 'Khách chưa nhận được, cấp lại' });
    expect(r2.tempPassword).not.toBe(r.tempPassword);
    expect(r2.wasInactive).toBe(false);
  });

  it('bắt buộc có lý do; tenant lạ hoặc đã xóa mềm bị từ chối; không đụng người dùng không phải chủ', async () => {
    const { tenantId } = await mk('reset-2');
    await t.admin.query("INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,'nv@reset-2.vn','NV','giu-nguyen','STAFF')", [tenantId]);
    await expect(resetOwnerPassword(t.platform, actor, tenantId, { reason: ' ab ' })).rejects.toThrow(/lý do/);
    await expect(resetOwnerPassword(t.platform, actor, tenantId, { reason: 'x'.repeat(301) })).rejects.toThrow(/tối đa 300/);
    await expect(resetOwnerPassword(t.platform, actor, '00000000-0000-0000-0000-0000000000ff', { reason: 'quên mật khẩu' })).rejects.toThrow(PlatformError);
    await expect(resetOwnerPassword(t.platform, actor, tenantId, { reason: 'quên mật khẩu', email: 'nv@reset-2.vn' })).rejects.toThrow(/không có chủ với email/);
    expect((await loginHash(tenantId, 'nv@reset-2.vn')).password_hash).toBe('giu-nguyen');
    await t.admin.query("UPDATE tenant SET status='DELETED', deleted_at=now() WHERE id=$1", [tenantId]);
    await expect(resetOwnerPassword(t.platform, actor, tenantId, { reason: 'quên mật khẩu' })).rejects.toThrow(/xóa mềm/);
  });

  it('nhiều tài khoản chủ: phải chỉ rõ email; chỉ đổi đúng người đó; cách ly giữa các cửa hàng', async () => {
    const A = await mk('reset-3');
    const B = await mk('reset-4');
    await t.admin.query("INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,'chu2@reset-3.vn','Chủ 2','cu','OWNER')", [A.tenantId]);
    const owners = await listTenantOwners(t.platform, A.tenantId);
    expect(owners.map((o) => o.email)).toEqual(['o@reset-3.vn', 'chu2@reset-3.vn']);
    await expect(resetOwnerPassword(t.platform, actor, A.tenantId, { reason: 'quên mật khẩu' })).rejects.toThrow(/2 tài khoản chủ/);
    const r = await resetOwnerPassword(t.platform, actor, A.tenantId, { reason: 'quên mật khẩu', email: ' CHU2@reset-3.vn ' });
    expect(r.email).toBe('chu2@reset-3.vn');
    expect(await verifyPassword((await loginHash(A.tenantId, 'chu2@reset-3.vn')).password_hash, r.tempPassword)).toBe(true);
    expect(await verifyPassword((await loginHash(A.tenantId, 'o@reset-3.vn')).password_hash, A.tempPassword)).toBe(true); // chủ kia không đổi
    expect(await verifyPassword((await loginHash(B.tenantId, 'o@reset-4.vn')).password_hash, B.tempPassword)).toBe(true); // cửa hàng khác không đổi
    // email của cửa hàng khác không dùng được để đặt lại ở cửa hàng này
    await expect(resetOwnerPassword(t.platform, actor, A.tenantId, { reason: 'quên mật khẩu', email: 'o@reset-4.vn' })).rejects.toThrow(/không có chủ/);
  });
});
