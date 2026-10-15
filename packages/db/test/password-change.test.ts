import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { mkTenant, runAs, type Opts } from './ctx';
import { changeOwnPassword, createTenant, loadUserAccess, resetOwnerPassword, setUserPassword, withTenantId } from '../src';
import { hashPassword, verifyPassword } from '@rentpro/core';
import { resolveFeatures } from '@rentpro/tenancy';
import { FEATURE_KEYS } from '@rentpro/tenancy';

let t: TestDb;
let actor: { id: string; email: string };
beforeAll(async () => {
  t = await startTestDb(54341);
  await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')");
  const u = await t.admin.query("INSERT INTO platform_user(email,password_hash,role) VALUES ('sa@x.vn','x','SUPER_ADMIN') RETURNING id");
  actor = { id: u.rows[0].id, email: 'sa@x.vn' };
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);
const features = resolveFeatures({ planFeatures: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])), overrides: {} });
const access = (tenantId: string, userId: string) => withTenantId(t.app, tenantId, (db) => loadUserAccess(db, userId, features));
const row = async (userId: string) => (await t.admin.query('SELECT password_hash, must_change_password FROM app_user WHERE id=$1', [userId])).rows[0];

async function shop(pw = 'Mat-khau-cu-12345') {
  const A = await mkTenant(t);
  const mk = async (email: string, role: string) =>
    (await t.admin.query('INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,$2,$2,$3,$4) RETURNING id', [A, email, await hashPassword(pw), role])).rows[0].id as string;
  return { A, owner: await mk(`o${Date.now()}@x.vn`, 'OWNER'), staff: await mk(`s${Date.now()}@x.vn`, 'STAFF'), pw };
}

describe('buộc đổi mật khẩu sau khi bị đặt lại hộ', () => {
  it('tài khoản hiện có không bị buộc; chủ/quản lý đặt hộ người khác thì người đó bị buộc đổi, đặt cho chính mình thì không', async () => {
    const s = await shop();
    expect((await access(s.A, s.staff))!.mustChangePassword).toBe(false);
    await as(s.A, { userId: s.owner }, (c) => setUserPassword(c, s.staff, 'Mat-khau-tam-12345'));
    expect((await access(s.A, s.staff))!.mustChangePassword).toBe(true);
    await as(s.A, { userId: s.owner }, (c) => setUserPassword(c, s.owner, 'Mat-khau-rieng-12345'));
    expect((await row(s.owner)).must_change_password).toBe(false);
  });

  it('quản trị đặt lại mật khẩu chủ thì chủ bị buộc đổi', async () => {
    const { tenantId } = await createTenant(t.platform, actor, { slug: 'pw-1', name: 'pw-1', planCode: 'p', ownerEmail: 'o@pw-1.vn', ownerName: 'Chủ' });
    const ownerId = (await t.admin.query('SELECT id FROM app_user WHERE tenant_id=$1', [tenantId])).rows[0].id as string;
    expect((await access(tenantId, ownerId))!.mustChangePassword).toBe(false);
    const r = await resetOwnerPassword(t.platform, actor, tenantId, { reason: 'Chủ quên mật khẩu, đã xác minh' });
    expect((await access(tenantId, ownerId))!.mustChangePassword).toBe(true);
    // đổi bằng chính mật khẩu tạm → hết bị buộc
    await as(tenantId, { userId: ownerId }, (c) => changeOwnPassword(c, r.tempPassword, 'Mat-khau-rieng-12345'));
    const after = await row(ownerId);
    expect(after.must_change_password).toBe(false);
    expect(await verifyPassword(after.password_hash, 'Mat-khau-rieng-12345')).toBe(true);
    expect(await verifyPassword(after.password_hash, r.tempPassword)).toBe(false);
  });
});

describe('tự đổi mật khẩu', () => {
  it('đổi thành công: băm mới, tắt cờ buộc đổi, ghi nhật ký không chứa mật khẩu', async () => {
    const s = await shop();
    await as(s.A, { userId: s.owner }, (c) => setUserPassword(c, s.staff, 'Mat-khau-tam-12345'));
    await as(s.A, { userId: s.staff, role: 'STAFF' }, (c) => changeOwnPassword(c, 'Mat-khau-tam-12345', 'Mat-khau-rieng-98765'));
    const u = await row(s.staff);
    expect(u.must_change_password).toBe(false);
    expect(await verifyPassword(u.password_hash, 'Mat-khau-rieng-98765')).toBe(true);
    const log = (await t.admin.query("SELECT data FROM audit_log WHERE action='user.password_change' AND entity_id=$1", [s.staff])).rows;
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain('Mat-khau');
  });

  it('đầu vào sai: mật khẩu hiện tại sai, mật khẩu mới yếu, trùng mật khẩu cũ; phiên hỗ trợ không đổi được', async () => {
    const s = await shop();
    const go = (cur: string, next: string, o: Opts = { userId: s.staff, role: 'STAFF' }) => as(s.A, o, (c) => changeOwnPassword(c, cur, next));
    await expect(go('sai-mat-khau-12345', 'Mat-khau-moi-12345')).rejects.toThrow(/hiện tại không đúng/);
    await expect(go(s.pw, 'yeu')).rejects.toThrow(/ít nhất 10 ký tự/);
    await expect(go(s.pw, s.pw)).rejects.toThrow(/khác mật khẩu hiện tại/);
    await expect(go(s.pw, 'Mat-khau-moi-12345', { userId: undefined })).rejects.toThrow(/Phiên hỗ trợ/);
    expect(await verifyPassword((await row(s.staff)).password_hash, s.pw)).toBe(true); // không có gì bị đổi
  });

  it('chặn dò mật khẩu hiện tại: sai 5 lần thì khóa, kể cả khi lần sau nhập đúng; người khác không bị ảnh hưởng', async () => {
    const s = await shop();
    const go = (user: string, cur: string) => as(s.A, { userId: user }, (c) => changeOwnPassword(c, cur, 'Mat-khau-moi-12345'));
    for (let i = 0; i < 5; i++) await expect(go(s.staff, 'sai-mat-khau-12345')).rejects.toThrow(/không đúng/);
    await expect(go(s.staff, s.pw)).rejects.toThrow(/quá nhiều lần/);
    await expect(go(s.owner, s.pw)).resolves.toBeUndefined();
  });

  it('cửa hàng ở chế độ chỉ đọc vẫn tự đổi được mật khẩu; người dùng cửa hàng khác không đổi được của mình', async () => {
    const s = await shop();
    await expect(as(s.A, { userId: s.staff, status: 'READ_ONLY' }, (c) => changeOwnPassword(c, s.pw, 'Mat-khau-moi-12345'))).resolves.toBeUndefined();
    const other = await shop();
    // userId của cửa hàng khác trong ngữ cảnh cửa hàng này: RLS không thấy dòng nào
    await expect(as(s.A, { userId: other.staff }, (c) => changeOwnPassword(c, other.pw, 'Mat-khau-moi-12345'))).rejects.toThrow(/Không tìm thấy/);
    expect(await verifyPassword((await row(other.staff)).password_hash, other.pw)).toBe(true);
  });
});
