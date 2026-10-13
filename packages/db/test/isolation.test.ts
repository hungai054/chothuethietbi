import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { withTenantId, resolveTenant, translateDbError, BookingConflictError } from '../src';

let t: TestDb;
let A: string, B: string;
let unitA: string, custA: string;

beforeAll(async () => {
  t = await startTestDb();
  const plan = (await t.admin.query("INSERT INTO plan(code,name) VALUES ('basic','Cơ bản') RETURNING id")).rows[0].id;
  const mk = async (slug: string) =>
    (await t.admin.query('INSERT INTO tenant(slug,name,plan_id) VALUES ($1,$1,$2) RETURNING id', [slug, plan])).rows[0].id as string;
  A = await mk('cua-hang-a');
  B = await mk('cua-hang-b');
  for (const [id, tag] of [[A, 'a'], [B, 'b']] as const) {
    const m = (await t.admin.query("INSERT INTO equipment_model(tenant_id,name) VALUES ($1,'Sony A7') RETURNING id", [id])).rows[0].id;
    const u = (await t.admin.query("INSERT INTO equipment_unit(tenant_id,model_id,barcode) VALUES ($1,$2,'CAM-000001') RETURNING id", [id, m])).rows[0].id;
    const c = (await t.admin.query('INSERT INTO customer(tenant_id,name,phone) VALUES ($1,$2,$3) RETURNING id', [id, 'Khách ' + tag, '0900000001'])).rows[0].id;
    if (id === A) { unitA = u; custA = c; }
  }
}, 120_000);

afterAll(async () => { await t?.stop(); });

describe('cách ly tenant bằng RLS', () => {
  it('không có ngữ cảnh tenant thì không thấy dòng nào', async () => {
    for (const table of ['equipment_unit', 'customer', 'equipment_model', 'booking', 'audit_log']) {
      expect((await t.app.query(`SELECT * FROM ${table}`)).rowCount, table).toBe(0);
    }
  });

  it('tenant A chỉ thấy dữ liệu của A', async () => {
    const rows = await withTenantId(t.app, A, (db) => db.query('SELECT tenant_id FROM equipment_unit'));
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].tenant_id).toBe(A);
  });

  it('A không đọc được bản ghi của B kể cả khi biết id', async () => {
    const idB = (await t.admin.query('SELECT id FROM customer WHERE tenant_id=$1', [B])).rows[0].id;
    const r = await withTenantId(t.app, A, (db) => db.query('SELECT * FROM customer WHERE id=$1', [idB]));
    expect(r.rowCount).toBe(0);
  });

  it('A không ghi được dòng mang tenant_id của B', async () => {
    await expect(
      withTenantId(t.app, A, (db) => db.query("INSERT INTO customer(tenant_id,name,phone) VALUES ($1,'x','0911')", [B])),
    ).rejects.toThrow(/row-level security/);
  });

  it('A không sửa/xóa được dữ liệu B (0 dòng bị ảnh hưởng)', async () => {
    const u = await withTenantId(t.app, A, (db) => db.query("UPDATE customer SET name='hack' WHERE tenant_id=$1", [B]));
    const d = await withTenantId(t.app, A, (db) => db.query('DELETE FROM equipment_unit WHERE tenant_id=$1', [B]));
    expect(u.rowCount).toBe(0);
    expect(d.rowCount).toBe(0);
    expect((await t.admin.query("SELECT 1 FROM customer WHERE name='hack'")).rowCount).toBe(0);
  });

  it('ngữ cảnh không rò sang transaction sau (SET LOCAL)', async () => {
    await withTenantId(t.app, A, (db) => db.query('SELECT 1'));
    expect((await t.app.query('SELECT * FROM customer')).rowCount).toBe(0);
  });

  it('app role không tự đọc được bảng nền tảng nhạy cảm', async () => {
    await expect(t.app.query('SELECT * FROM platform_user')).rejects.toThrow(/permission denied/);
    await expect(t.app.query('SELECT * FROM platform_audit')).rejects.toThrow(/permission denied/);
  });

  it('bảng tenant: A chỉ thấy chính mình, không sửa được', async () => {
    const r = await withTenantId(t.app, A, (db) => db.query('SELECT id FROM tenant'));
    expect(r.rows.map((x) => x.id)).toEqual([A]);
    await expect(withTenantId(t.app, A, (db) => db.query("UPDATE tenant SET status='ACTIVE'"))).rejects.toThrow(/permission denied/);
  });

  it('tenantId sai định dạng bị từ chối trước khi chạm DB', async () => {
    await expect(withTenantId(t.app, "x'; DROP TABLE tenant;--", async () => 1)).rejects.toThrow();
  });

  it('phân giải tenant theo slug', async () => {
    expect((await resolveTenant(t.app, 'cua-hang-a'))?.id).toBe(A);
    expect(await resolveTenant(t.app, 'khong-ton-tai')).toBeNull();
  });
});

describe('chống trùng lịch (exclusion constraint)', () => {
  const insertBooking = (tenant: string, code: string) =>
    withTenantId(t.app, tenant, async (db) =>
      (await db.query(
        "INSERT INTO booking(tenant_id,code,customer_id,starts_at,ends_at) VALUES ($1,$2,$3,'2026-11-01','2026-11-03') RETURNING id",
        [tenant, code, custA],
      )).rows[0].id as string);

  const alloc = (bookingId: string, range: string, status = 'CONFIRMED') =>
    withTenantId(t.app, A, (db) =>
      db.query('INSERT INTO unit_allocation(tenant_id,booking_id,unit_id,period,status) VALUES ($1,$2,$3,$4,$5)',
        [A, bookingId, unitA, range, status]),
    ).catch((e) => { throw translateDbError(e); });

  it('khoảng giao nhau bị chặn, liền kề thì được', async () => {
    const b1 = await insertBooking(A, 'HD-1');
    await alloc(b1, '[2026-11-01 08:00+00,2026-11-03 08:00+00)');
    await expect(alloc(b1, '[2026-11-02 08:00+00,2026-11-04 08:00+00)')).rejects.toBeInstanceOf(BookingConflictError);
    await expect(alloc(b1, '[2026-11-03 08:00+00,2026-11-04 08:00+00)')).resolves.toBeDefined();
  });

  it('đặt đồng thời cùng thiết bị: chỉ một thành công', async () => {
    const b = await insertBooking(A, 'HD-2');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => alloc(b, '[2027-01-01 08:00+00,2027-01-02 08:00+00)', 'HOLD')),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(BookingConflictError);
  });

  it('lịch đã RELEASED không còn chiếm chỗ', async () => {
    const b = await insertBooking(A, 'HD-3');
    await alloc(b, '[2027-02-01 08:00+00,2027-02-02 08:00+00)', 'RELEASED');
    await expect(alloc(b, '[2027-02-01 08:00+00,2027-02-02 08:00+00)', 'CONFIRMED')).resolves.toBeDefined();
  });
});
