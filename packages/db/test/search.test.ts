import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { mkTenant, runAs, type Opts } from './ctx';
import { ValidationError, createCustomer, createModel, createUnits, globalSearch } from '../src';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb(54337);
  await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')");
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);

async function seed(name: string) {
  const id = await mkTenant(t);
  const m = await as(id, {}, (c) => createModel(c, { name: `Máy ảnh ${name}`, barcodePrefix: 'CAM', brand: 'Sony' }));
  await as(id, {}, (c) => createUnits(c, { modelId: m, quantity: 1 }));
  await as(id, {}, (c) => createCustomer(c, { type: 'PERSON', name: `Khách ${name}`, phone: '0901234567', trustLevel: 'NEW' }));
  return id;
}

describe('tìm nhanh (Ctrl+K)', () => {
  it('tìm ra mẫu, thiết bị, khách; số điện thoại bị che', async () => {
    const A = await seed('Alpha');
    const r = await as(A, {}, (c) => globalSearch(c, 'alpha'));
    expect(r.models.map((x) => x.title)).toEqual(['Máy ảnh Alpha']);
    expect(r.customers).toHaveLength(1);
    expect(r.customers[0]!.subtitle).toBe('•••4567');
    expect(JSON.stringify(r)).not.toContain('0901234567');
    const u = await as(A, {}, (c) => globalSearch(c, 'CAM-'));
    expect(u.units.length).toBe(1);
  });

  it('cô lập tenant: không thấy dữ liệu của cửa hàng khác', async () => {
    const A = await seed('Bravo');
    const B = await seed('Charlie');
    const r = await as(B, {}, (c) => globalSearch(c, 'Bravo'));
    expect(r).toEqual({ models: [], units: [], customers: [], bookings: [] });
    expect((await as(A, {}, (c) => globalSearch(c, 'Bravo'))).models).toHaveLength(1);
  });

  it('thiếu quyền hoặc tính năng tắt thì nhóm đó rỗng, nhóm khác vẫn chạy', async () => {
    const A = await seed('Delta');
    const tech = await as(A, { role: 'TECHNICIAN' }, (c) => globalSearch(c, 'Delta')); // không có customer.view
    expect(tech.customers).toEqual([]);
    expect(tech.models).toHaveLength(1);
    const noInv = await as(A, { off: ['inventory'] }, (c) => globalSearch(c, 'Delta'));
    expect(noInv.models).toEqual([]);
    expect(noInv.units).toEqual([]);
    expect(noInv.customers).toHaveLength(1);
    const noCust = await as(A, { off: ['customers'] }, (c) => globalSearch(c, 'Delta'));
    expect(noCust.customers).toEqual([]);
    const none = await as(A, { perms: [] }, (c) => globalSearch(c, 'Delta'));
    expect(none).toEqual({ models: [], units: [], customers: [], bookings: [] });
  });

  it('đầu vào: ngắn hơn 2 ký tự → rỗng, quá dài → báo lỗi tiếng Việt, ký tự đặc biệt không làm hỏng truy vấn', async () => {
    const A = await seed('Echo');
    expect((await as(A, {}, (c) => globalSearch(c, ' e '))).models).toEqual([]);
    await expect(as(A, {}, (c) => globalSearch(c, 'x'.repeat(81)))).rejects.toThrow(ValidationError);
    await expect(as(A, {}, (c) => globalSearch(c, "%'; DROP TABLE customer; --"))).resolves.toBeDefined();
  });

  it('cửa hàng chỉ đọc vẫn tìm được', async () => {
    const A = await seed('Foxtrot');
    expect((await as(A, { status: 'READ_ONLY' }, (c) => globalSearch(c, 'Foxtrot'))).models).toHaveLength(1);
  });
});
