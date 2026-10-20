import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { mkTenant, runAs, type Opts } from './ctx';
import { ValidationError, createCustomer, exportAuditLog, listAuditFacets, listAuditLog } from '../src';
import { ForbiddenError } from '@rentpro/core';
import { FeatureDisabledError } from '@rentpro/tenancy';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb(54338);
  await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')");
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);

async function seed() {
  const id = await mkTenant(t);
  const u = (await t.admin.query("INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,$2,'Chị Hoa','x','OWNER') RETURNING id", [id, `u${Date.now()}@x.local`])).rows[0].id as string;
  await as(id, { userId: u }, (c) => createCustomer(c, { type: 'PERSON', name: 'Khách một', phone: '0901000001', trustLevel: 'NEW' }));
  await as(id, { userId: u }, (c) => createCustomer(c, { type: 'PERSON', name: 'Khách hai', phone: '0901000002', trustLevel: 'NEW' }));
  return { id, u };
}

describe('xem nhật ký (audit)', () => {
  it('liệt kê mới nhất trước, có tên người thao tác, lọc theo thao tác/người/từ khóa', async () => {
    const { id, u } = await seed();
    const all = await as(id, {}, (c) => listAuditLog(c));
    expect(all.total).toBe(2);
    expect(all.rows[0]).toMatchObject({ action: 'customer.create', userName: 'Chị Hoa', userId: u, entity: 'customer' });
    expect(all.rows[0]!.data).toMatchObject({ name: 'Khách hai' });
    expect((await as(id, {}, (c) => listAuditLog(c, { action: 'customer' }))).total).toBe(2); // tiền tố nhóm
    expect((await as(id, {}, (c) => listAuditLog(c, { action: 'booking' }))).total).toBe(0);
    expect((await as(id, {}, (c) => listAuditLog(c, { userId: u }))).total).toBe(2);
    expect((await as(id, {}, (c) => listAuditLog(c, { q: 'Khách một' }))).total).toBe(1);
    const page = await as(id, {}, (c) => listAuditLog(c, { pageSize: 1, page: 2 }));
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(2);
    const f = await as(id, {}, (c) => listAuditFacets(c));
    expect(f.actions).toEqual(['customer.create']);
    expect(f.users.map((x) => x.name)).toEqual(['Chị Hoa']);
  });

  it('lọc theo ngày theo múi giờ cửa hàng (gồm cả ngày cuối)', async () => {
    const { id } = await seed();
    const today = new Date().toISOString().slice(0, 10);
    expect((await as(id, { timezone: 'UTC' }, (c) => listAuditLog(c, { from: today, to: today }))).total).toBe(2);
    expect((await as(id, { timezone: 'UTC' }, (c) => listAuditLog(c, { from: '2000-01-01', to: '2000-01-02' }))).total).toBe(0);
  });

  it('cô lập tenant: tenant khác không thấy nhật ký', async () => {
    const A = await seed();
    const B = await seed();
    const r = await as(B.id, {}, (c) => listAuditLog(c, { q: 'Khách một' }));
    expect(r.rows.every((x) => x.userId === B.u)).toBe(true);
    expect((await as(A.id, {}, (c) => listAuditLog(c))).total).toBe(2);
  });

  it('thiếu quyền, tính năng tắt, đầu vào sai', async () => {
    const { id } = await seed();
    await expect(as(id, { role: 'STAFF' }, (c) => listAuditLog(c))).rejects.toThrow(ForbiddenError);
    await expect(as(id, { role: 'TECHNICIAN' }, (c) => listAuditFacets(c))).rejects.toThrow(ForbiddenError);
    await expect(as(id, { off: ['audit.log'] }, (c) => listAuditLog(c))).rejects.toThrow(FeatureDisabledError);
    await expect(as(id, {}, (c) => listAuditLog(c, { from: '01/02/2027' }))).rejects.toThrow(/YYYY-MM-DD/);
    await expect(as(id, {}, (c) => listAuditLog(c, { from: '2027-02-02', to: '2027-02-01' }))).rejects.toThrow(/Khoảng ngày/);
    await expect(as(id, {}, (c) => listAuditLog(c, { userId: 'abc' }))).rejects.toThrow(ValidationError);
    await expect(as(id, {}, (c) => listAuditLog(c, { q: 'x'.repeat(81) }))).rejects.toThrow(/tối đa 80/);
    await expect(as(id, {}, (c) => listAuditLog(c, { action: "x'; DROP TABLE audit_log; --" }))).resolves.toMatchObject({ total: 0 });
    // chỉ đọc vẫn xem được
    await expect(as(id, { status: 'READ_ONLY' }, (c) => listAuditLog(c))).resolves.toBeDefined();
  });

  it('xuất cần quyền data.export (quản lý không có) và tự ghi nhật ký', async () => {
    const { id } = await seed();
    await expect(as(id, { role: 'MANAGER' }, (c) => exportAuditLog(c))).rejects.toThrow(ForbiddenError);
    const r = await as(id, {}, (c) => exportAuditLog(c, { action: 'customer' }));
    expect(r.rows).toHaveLength(2);
    expect(r.truncated).toBe(false);
    const log = await as(id, {}, (c) => listAuditLog(c, { action: 'audit.export' }));
    expect(log.total).toBe(1);
    expect(log.rows[0]!.data).toMatchObject({ rows: 2 });
  });
});
