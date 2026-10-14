import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { mkTenant, runAs } from './ctx';
import { ForbiddenError, verifyPassword } from '@rentpro/core';
import {
  PlatformError, ReadOnlyError, ValidationError, applyIndustryTemplate, completeSignup, listIndustryTemplates, listModels, onboardingStatus, requestSignup,
  updateFinanceSettings, withTenantId,
} from '../src';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb(54332);
  await t.admin.query(`INSERT INTO plan(code,name,price_month,price_year,features,limits) VALUES ('p','Gói P',100000,1000000,'{}','{}'),('basic','Cơ bản',300000,3000000,'{}','{"users":3}')`);
  await t.admin.query(`INSERT INTO plan(code,name,price_month,price_year,is_custom) VALUES ('ent','Doanh nghiệp',0,0,true)`);
}, 120_000);
afterAll(async () => { await t?.stop(); });

let n = 0;
const input = (o: Partial<{ email: string; slug: string; planCode: string; password: string }> = {}) => {
  n++;
  return { email: `chu${n}@cuahang.vn`, ownerName: 'Nguyễn Văn An', shopName: `Cửa hàng ${n}`, slug: `shop-${Date.now().toString(36)}-${n}`, password: 'Mat-khau-1234', planCode: 'basic', ...o };
};
const tokenFrom = async (email: string) => {
  const m = (await t.platform.query("SELECT body FROM platform_email WHERE to_email=$1 AND kind='signup.verify' ORDER BY created_at DESC LIMIT 1", [email])).rows[0];
  return /token=([\w-]+)/.exec(m.body)![1]!;
};
const verifyUrl = (tok: string) => `http://localhost:3000/dang-ky/xac-thuc?token=${tok}`;
const NOW = new Date('2027-03-01T00:00:00Z');

describe('đăng ký tự phục vụ', () => {
  it('yêu cầu → thư xác thực có liên kết; token không lưu dạng rõ; chưa tạo tenant', async () => {
    const i = input();
    await requestSignup(t.platform, i, { verifyUrl, now: NOW });
    const tok = await tokenFrom(i.email);
    expect(tok.length).toBeGreaterThan(30);
    expect((await t.platform.query('SELECT 1 FROM signup_request WHERE token_hash=$1', [tok])).rowCount).toBe(0);
    expect((await t.platform.query('SELECT 1 FROM tenant WHERE slug=$1', [i.slug])).rowCount).toBe(0);
  });

  it('xác thực → tenant dùng thử đúng gói, chủ đăng nhập được bằng mật khẩu đã chọn, ghi lịch sử, thư chào; bấm lại không tạo trùng', async () => {
    const i = input();
    await requestSignup(t.platform, i, { verifyUrl, now: NOW });
    const tok = await tokenFrom(i.email);
    const r = await completeSignup(t.platform, tok, new Date(NOW.getTime() + 3600_000));
    expect(r.already).toBe(false);
    expect(r.slug).toBe(i.slug);
    const tenant = (await t.platform.query("SELECT t.status, p.code, t.trial_ends_at FROM tenant t JOIN plan p ON p.id=t.plan_id WHERE t.id=$1", [r.tenantId])).rows[0];
    expect(tenant).toMatchObject({ status: 'TRIAL', code: 'basic' });
    expect(tenant.trial_ends_at).not.toBeNull();
    const owner = (await withTenantId(t.app, r.tenantId, (db) => db.query('SELECT email, role, password_hash FROM app_user'))).rows[0];
    expect(owner).toMatchObject({ email: i.email, role: 'OWNER' });
    expect(await verifyPassword(owner.password_hash, i.password)).toBe(true);
    expect((await t.platform.query("SELECT 1 FROM subscription_event WHERE tenant_id=$1 AND kind='TRIAL_START'", [r.tenantId])).rowCount).toBe(1);
    expect((await t.platform.query("SELECT 1 FROM platform_email WHERE tenant_id=$1 AND kind='signup.welcome'", [r.tenantId])).rowCount).toBe(1);
    const again = await completeSignup(t.platform, tok, new Date(NOW.getTime() + 7200_000));
    expect(again).toMatchObject({ tenantId: r.tenantId, already: true });
    expect((await t.platform.query('SELECT count(*)::int AS n FROM tenant WHERE slug=$1', [i.slug])).rows[0].n).toBe(1);
  });

  it('hai lần bấm đồng thời chỉ tạo một cửa hàng', async () => {
    const i = input();
    await requestSignup(t.platform, i, { verifyUrl, now: NOW });
    const tok = await tokenFrom(i.email);
    const rs = await Promise.allSettled([completeSignup(t.platform, tok, NOW), completeSignup(t.platform, tok, NOW), completeSignup(t.platform, tok, NOW)]);
    expect(rs.some((r) => r.status === 'fulfilled')).toBe(true);
    expect((await t.platform.query('SELECT count(*)::int AS n FROM tenant WHERE slug=$1', [i.slug])).rows[0].n).toBe(1);
  });

  it('đầu vào sai bị từ chối bằng tiếng Việt, không để lại yêu cầu', async () => {
    const bad = [
      [input({ email: 'khong-hop-le' }), /Email/], [input({ password: 'ngan1' }), /10 ký tự/], [input({ slug: 'admin' }), /giữ riêng/], [input({ slug: 'A b' }), /chữ thường/],
    ] as const;
    for (const [i, re] of bad) await expect(requestSignup(t.platform, i, { verifyUrl, now: NOW })).rejects.toThrow(re);
    expect((await t.platform.query("SELECT 1 FROM signup_request WHERE email IN ('khong-hop-le')")).rowCount).toBe(0);
  });

  it('địa chỉ đã có cửa hàng hoặc đang được giữ cho email khác thì từ chối; cùng email đăng ký lại được và token cũ mất hiệu lực', async () => {
    const a = input();
    await requestSignup(t.platform, a, { verifyUrl, now: NOW });
    const other = input({ slug: a.slug });
    await expect(requestSignup(t.platform, other, { verifyUrl, now: NOW })).rejects.toThrow(/đang được giữ/);
    const oldTok = await tokenFrom(a.email);
    await requestSignup(t.platform, a, { verifyUrl, now: new Date(NOW.getTime() + 1000) });
    await expect(completeSignup(t.platform, oldTok, new Date(NOW.getTime() + 2000))).rejects.toThrow(/hết hạn/);
    const fresh = await tokenFrom(a.email);
    const r = await completeSignup(t.platform, fresh, new Date(NOW.getTime() + 3000));
    await expect(requestSignup(t.platform, input({ slug: a.slug }), { verifyUrl, now: NOW })).rejects.toThrow(/đã được dùng/);
    expect(r.slug).toBe(a.slug);
  });

  it('liên kết hết hạn, sai token, giới hạn số lần gửi theo email', async () => {
    const i = input();
    await requestSignup(t.platform, i, { verifyUrl, now: NOW });
    const tok = await tokenFrom(i.email);
    await expect(completeSignup(t.platform, tok, new Date(NOW.getTime() + 25 * 3600_000))).rejects.toThrow(/hết hạn/);
    await expect(completeSignup(t.platform, 'token-sai', NOW)).rejects.toThrow(PlatformError);
    const spam = input();
    for (let k = 0; k < 5; k++) await requestSignup(t.platform, { ...spam, slug: `${spam.slug}-${k}` }, { verifyUrl, now: NOW });
    await expect(requestSignup(t.platform, { ...spam, slug: `${spam.slug}-x` }, { verifyUrl, now: NOW })).rejects.toThrow(/quá nhiều/);
  });

  it('gói không hợp lệ hoặc báo giá riêng thì dùng gói rẻ nhất tự phục vụ', async () => {
    for (const planCode of ['ent', 'khong-co']) {
      const i = input({ planCode });
      await requestSignup(t.platform, i, { verifyUrl, now: NOW });
      expect((await t.platform.query('SELECT plan_code FROM signup_request WHERE email=$1', [i.email])).rows[0].plan_code).toBe('p');
    }
  });
});

describe('khởi tạo theo ngành', () => {
  it('nạp mẫu: danh mục, mẫu thiết bị và giá; chạy lại không tạo trùng', async () => {
    const id = await mkTenant(t, 'p');
    const r1 = await runAs(t, id, {}, (c) => applyIndustryTemplate(c, 'camera'));
    expect(r1.created).toBeGreaterThanOrEqual(4);
    expect(r1.priced).toBe(r1.created);
    const models = await runAs(t, id, {}, (c) => listModels(c));
    expect(models.length).toBe(r1.created);
    const r2 = await runAs(t, id, {}, (c) => applyIndustryTemplate(c, 'camera'));
    expect(r2).toEqual({ created: 0, skipped: r1.created, priced: 0 });
    expect((await t.admin.query('SELECT count(*)::int AS n FROM category WHERE tenant_id=$1', [id])).rows[0].n).toBeGreaterThanOrEqual(3);
    // nhiều ngành cộng dồn, danh mục trùng tên dùng lại
    const r3 = await runAs(t, id, {}, (c) => applyIndustryTemplate(c, 'event'));
    expect(r3.created).toBeGreaterThan(0);
  });

  it('mẫu theo số lượng không theo dõi từng chiếc; gói không có bảng giá vẫn nạp mẫu nhưng không đặt giá', async () => {
    const id = await mkTenant(t, 'p');
    const r = await runAs(t, id, { off: ['pricing'] }, (c) => applyIndustryTemplate(c, 'event'));
    expect(r.created).toBeGreaterThan(0);
    expect(r.priced).toBe(0);
    const rows = (await t.admin.query("SELECT tracked, stock_qty FROM equipment_model WHERE tenant_id=$1 AND name='Ghế sự kiện'", [id])).rows[0];
    expect(rows).toEqual({ tracked: false, stock_qty: 1 });
  });

  it('thiếu quyền, chỉ đọc, mẫu lạ, tính năng tắt: từ chối', async () => {
    const id = await mkTenant(t, 'p');
    await expect(runAs(t, id, { role: 'STAFF' }, (c) => applyIndustryTemplate(c, 'camera'))).rejects.toThrow(ForbiddenError);
    await expect(runAs(t, id, { status: 'READ_ONLY' }, (c) => applyIndustryTemplate(c, 'camera'))).rejects.toThrow(ReadOnlyError);
    await expect(runAs(t, id, {}, (c) => applyIndustryTemplate(c, 'khong-co'))).rejects.toThrow(ValidationError);
    await expect(runAs(t, id, { off: ['inventory'] }, (c) => applyIndustryTemplate(c, 'camera'))).rejects.toThrow(/không có trong gói/);
  });

  it('cô lập tenant: nạp mẫu cho A không xuất hiện ở B', async () => {
    const a = await mkTenant(t, 'p');
    const b = await mkTenant(t, 'p');
    await runAs(t, a, {}, (c) => applyIndustryTemplate(c, 'tools'));
    expect((await runAs(t, b, {}, (c) => listModels(c))).length).toBe(0);
  });

  it('danh sách ngành và danh sách việc cần làm theo dữ liệu thật', async () => {
    expect(listIndustryTemplates().map((x) => x.key)).toContain('camera');
    const id = await mkTenant(t, 'p');
    const s0 = await runAs(t, id, {}, (c) => onboardingStatus(c));
    expect(s0.steps.every((x) => !x.done)).toBe(true);
    expect(s0.complete).toBe(false);
    await runAs(t, id, {}, (c) => applyIndustryTemplate(c, 'outdoor'));
    await runAs(t, id, {}, (c) => updateFinanceSettings(c, { store: { name: 'Shop', phone: '0900000000', address: '1 Lê Lợi' }, bank: { bin: '970436', account: '0011004123456' } }));
    await t.admin.query("INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,'chu@x.vn','Chủ','x','OWNER'), ($1,'nv@x.vn','NV','x','STAFF')", [id]);
    await t.admin.query("INSERT INTO equipment_unit(tenant_id,model_id,barcode) SELECT tenant_id, id, 'OUT-000001' FROM equipment_model WHERE tenant_id=$1 LIMIT 1", [id]);
    const s1 = await runAs(t, id, {}, (c) => onboardingStatus(c));
    expect(Object.fromEntries(s1.steps.map((x) => [x.key, x.done]))).toEqual({ shop: true, bank: true, catalog: true, units: true, pricing: true, team: true });
    expect(s1.complete).toBe(true);
    await expect(runAs(t, id, { role: 'STAFF' }, (c) => onboardingStatus(c))).rejects.toThrow(ForbiddenError);
  });
});
