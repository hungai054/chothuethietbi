import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { GIF, JPG, PNG, mkTenant, ring, runAs, storage, type Opts } from './ctx';
import {
  addIdDocument, anonymizeCustomer, assertCustomerCanRent, createCustomer, createGroup, deleteIdDocument, getCustomer, getIdImage, listCustomers,
  listGroups, listIdAccessLog, revealIdNumber, setBlacklist, updateCustomer, withTenantId, ReadOnlyError, ValidationError, MemoryStorage,
} from '../src';
import { ForbiddenError } from '@rentpro/core';
import { FeatureDisabledError } from '@rentpro/tenancy';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb(54332);
  await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')");
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);
const person = (over: Record<string, unknown> = {}) => ({ name: 'Nguyễn Văn An', phone: '0901 234 567', ...over });

describe('khách hàng', () => {
  it('chuẩn hóa số điện thoại và chặn trùng trong tenant, cho phép trùng ở tenant khác', async () => {
    const A = await mkTenant(t);
    const B = await mkTenant(t);
    const id = await as(A, {}, (c) => createCustomer(c, person({ phone: '+84 901-234-567' })));
    expect((await as(A, {}, (c) => getCustomer(c, id))).customer.phone).toBe('0901234567');
    await expect(as(A, {}, (c) => createCustomer(c, person({ name: 'Người khác', phone: '84901234567' })))).rejects.toThrow(/đã thuộc về một khách/);
    await expect(as(B, {}, (c) => createCustomer(c, person()))).resolves.toBeDefined();
  });

  it('kiểm tra đầu vào bằng tiếng Việt: SĐT sai, email sai, doanh nghiệp thiếu MST', async () => {
    const A = await mkTenant(t);
    await expect(as(A, {}, (c) => createCustomer(c, person({ phone: '12345' })))).rejects.toThrow(/Số điện thoại không hợp lệ/);
    await expect(as(A, {}, (c) => createCustomer(c, person({ email: 'sai' })))).rejects.toThrow(/Email không hợp lệ/);
    await expect(as(A, {}, (c) => createCustomer(c, person({ name: 'A' })))).rejects.toThrow(/ít nhất 2 ký tự/);
    await expect(as(A, {}, (c) => createCustomer(c, person({ type: 'COMPANY' })))).rejects.toThrow(/tên công ty.*mã số thuế/);
    await expect(as(A, {}, (c) => createCustomer(c, person({ type: 'COMPANY', companyName: 'Cty X', taxCode: '0312345678', phone: '0912345678' })))).resolves.toBeDefined();
    await expect(as(A, {}, (c) => createCustomer(c, person({ phone: '0987654321', email: '', address: '  ' })))).resolves.toBeDefined(); // chuỗi rỗng = bỏ trống
  });

  it('cập nhật giữ ràng buộc trùng SĐT; tìm kiếm theo tên/SĐT một phần, phân trang', async () => {
    const A = await mkTenant(t);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await as(A, {}, (c) => createCustomer(c, { name: `Khách số ${i}`, phone: `09012345${10 + i}` })));
    await expect(as(A, {}, (c) => updateCustomer(c, ids[0]!, { name: 'Khách số 0', phone: '0901234511' }))).rejects.toThrow(/đã thuộc về/);
    await as(A, {}, (c) => updateCustomer(c, ids[0]!, { name: 'Trần Thị Bình', phone: '0901234510', email: 'BINH@Example.com' }));
    expect((await as(A, {}, (c) => listCustomers(c, { q: 'bình' }))).rows.map((r) => r.email)).toEqual(['binh@example.com']);
    expect((await as(A, {}, (c) => listCustomers(c, { q: '0901 2345 13' }))).rows.map((r) => r.name)).toEqual(['Khách số 3']);
    const p = await as(A, {}, (c) => listCustomers(c, { pageSize: 3, page: 3 }));
    expect([p.total, p.rows.length]).toEqual([7, 1]);
    await expect(as(A, {}, (c) => listCustomers(c, { q: "'; DROP TABLE customer;--" }))).resolves.toMatchObject({ total: 0 });
  });

  it('danh sách đen cần lý do; khách trong danh sách đen không được thuê', async () => {
    const A = await mkTenant(t);
    const id = await as(A, {}, (c) => createCustomer(c, person()));
    await expect(as(A, {}, (c) => setBlacklist(c, id, true, '  '))).rejects.toThrow(/lý do/);
    await as(A, {}, (c) => setBlacklist(c, id, true, 'Làm mất thiết bị'));
    await expect(as(A, {}, (c) => assertCustomerCanRent(c, id))).rejects.toThrow(/danh sách đen: Làm mất thiết bị/);
    expect((await as(A, {}, (c) => listCustomers(c, { blacklisted: true }))).total).toBe(1);
    await as(A, {}, (c) => setBlacklist(c, id, false));
    await expect(as(A, {}, (c) => assertCustomerCanRent(c, id))).resolves.toMatchObject({ id });
  });

  it('nhóm khách: giảm giá 0–100, tên không trùng', async () => {
    const A = await mkTenant(t);
    await as(A, {}, (c) => createGroup(c, { name: 'Đối tác', discountPercent: 15 }));
    await expect(as(A, {}, (c) => createGroup(c, { name: 'Đối tác' }))).rejects.toThrow(/trùng tên/);
    await expect(as(A, {}, (c) => createGroup(c, { name: 'X', discountPercent: 101 }))).rejects.toThrow(/0 đến 100/);
    expect((await as(A, {}, (c) => listGroups(c)))[0]).toMatchObject({ name: 'Đối tác', discountPercent: 15 });
  });

  it('phân quyền, gói và chỉ đọc; cô lập tenant', async () => {
    const A = await mkTenant(t);
    const B = await mkTenant(t);
    const id = await as(A, {}, (c) => createCustomer(c, person()));
    await expect(as(A, { role: 'TECHNICIAN' }, (c) => listCustomers(c))).rejects.toThrow(ForbiddenError);
    await expect(as(A, { role: 'STAFF' }, (c) => listCustomers(c))).resolves.toMatchObject({ total: 1 });
    await expect(as(A, { off: ['customers'] }, (c) => listCustomers(c))).rejects.toThrow(FeatureDisabledError);
    await expect(as(A, { status: 'READ_ONLY' }, (c) => createCustomer(c, person({ phone: '0911111111' })))).rejects.toThrow(ReadOnlyError);
    await expect(as(A, { status: 'READ_ONLY' }, (c) => listCustomers(c))).resolves.toBeDefined();
    expect((await as(B, {}, (c) => listCustomers(c))).total).toBe(0);
    await expect(as(B, {}, (c) => getCustomer(c, id))).rejects.toThrow(/Không tìm thấy/);
    await expect(as(B, {}, (c) => updateCustomer(c, id, person({ name: 'Hack' })))).rejects.toThrow(/Không tìm thấy/);
  });
});

describe('giấy tờ tùy thân', () => {
  const doc = (over: Record<string, unknown> = {}) => ({ type: 'CCCD' as const, number: '001 099 123 456', consent: true, issuedDate: '2021-05-10', issuedPlace: 'Cục CSQLHC', front: { data: PNG }, back: { data: JPG }, ...over });

  async function setup() {
    const A = await mkTenant(t);
    const cust = await as(A, {}, (c) => createCustomer(c, person()));
    return { A, cust };
  }

  it('lưu số giấy tờ ở dạng mã hóa (không có số thật trong DB), chỉ hiển thị 4 số cuối', async () => {
    const { A, cust } = await setup();
    const id = await as(A, {}, (c) => addIdDocument(c, cust, doc()));
    const raw = (await t.admin.query('SELECT * FROM id_document WHERE id=$1', [id])).rows[0];
    expect(JSON.stringify(raw)).not.toContain('001099123456');
    expect(raw.number_enc).toMatch(/^v1\.k1\./);
    expect(raw.number_last4).toBe('3456');
    expect(raw.consent_version).toMatch(/^\d{4}-\d{2}-v\d+$/);
    expect(raw.front_path).toMatch(new RegExp(`^tenants/${A}/id/[0-9a-f]{32}\\.png$`));
    const { documents } = await as(A, {}, (c) => getCustomer(c, cust));
    expect(documents[0]).toMatchObject({ last4: '3456', hasFront: true, hasBack: true });
    expect(JSON.stringify(documents)).not.toContain('001099');
  });

  it('bắt buộc có xác nhận đồng ý xử lý dữ liệu cá nhân; số giấy tờ phải hợp lệ', async () => {
    const { A, cust } = await setup();
    await expect(as(A, {}, (c) => addIdDocument(c, cust, doc({ consent: false })))).rejects.toThrow(/Nghị định 13/);
    await expect(as(A, {}, (c) => addIdDocument(c, cust, doc({ number: '12345' })))).rejects.toThrow(/Số giấy tờ không hợp lệ/);
    await expect(as(A, {}, (c) => addIdDocument(c, cust, doc({ issuedDate: '10/05/2021' })))).rejects.toThrow(/yyyy-mm-dd/);
    expect((await as(A, {}, (c) => getCustomer(c, cust))).documents).toHaveLength(0);
  });

  it('chỉ nhận ảnh JPG/PNG/WebP thật (kiểm tra chữ ký file), tối đa 5 MB', async () => {
    const { A, cust } = await setup();
    await expect(as(A, {}, (c) => addIdDocument(c, cust, doc({ front: { data: GIF } })))).rejects.toThrow(/JPG, PNG hoặc WebP/);
    await expect(as(A, {}, (c) => addIdDocument(c, cust, doc({ front: { data: new TextEncoder().encode('<script>alert(1)</script>') } })))).rejects.toThrow(/JPG, PNG/);
    const big = new Uint8Array(5 * 1024 * 1024 + 1); big.set(PNG);
    await expect(as(A, {}, (c) => addIdDocument(c, cust, doc({ front: { data: big } })))).rejects.toThrow(/quá lớn/);
  });

  it('không để ảnh mồ côi khi ghi DB thất bại', async () => {
    const { A, cust } = await setup();
    const st = new MemoryStorage();
    await expect(as(A, { storage: st }, (c) => addIdDocument(c, cust, doc({ issuedDate: '2026-13-45' })))).rejects.toThrow();
    expect(st.files.size).toBe(0);
  });

  it('một giấy tờ chỉ thuộc một khách hàng (phát hiện trùng bằng chỉ mục mù)', async () => {
    const { A, cust } = await setup();
    const other = await as(A, {}, (c) => createCustomer(c, person({ name: 'Người thứ hai', phone: '0912222222' })));
    await as(A, {}, (c) => addIdDocument(c, cust, doc()));
    await expect(as(A, {}, (c) => addIdDocument(c, other, doc({ number: '001099123456' })))).rejects.toThrow(/đã được đăng ký cho khách "Nguyễn Văn An"/);
    await expect(as(A, {}, (c) => addIdDocument(c, other, doc({ type: 'DRIVER_LICENSE', number: '001099123456' })))).resolves.toBeDefined(); // khác loại
  });

  it('xem số đầy đủ: cần quyền riêng, ghi nhật ký; nhân viên quầy và phiên hỗ trợ bị chặn', async () => {
    const { A, cust } = await setup();
    const id = await as(A, {}, (c) => addIdDocument(c, cust, doc()));
    await expect(as(A, { role: 'STAFF' }, (c) => revealIdNumber(c, id))).rejects.toThrow(ForbiddenError);
    await expect(as(A, { role: 'TECHNICIAN' }, (c) => revealIdNumber(c, id))).rejects.toThrow(ForbiddenError);
    await expect(as(A, { support: true }, (c) => revealIdNumber(c, id))).rejects.toThrow(ForbiddenError);
    await expect(as(A, { support: true }, (c) => getIdImage(c, id, 'front'))).rejects.toThrow(ForbiddenError);
    expect(await as(A, { role: 'MANAGER' }, (c) => revealIdNumber(c, id))).toBe('001099123456');
    await as(A, { role: 'MANAGER' }, (c) => getIdImage(c, id, 'front'));
    const log = await as(A, {}, (c) => listIdAccessLog(c, id));
    expect(log.map((l) => l.action).sort()).toEqual(['VIEW_FRONT', 'VIEW_NUMBER']);
  });

  it('nhật ký truy cập chỉ thêm: app role không sửa/xóa được', async () => {
    const { A } = await setup();
    await expect(withTenantId(t.app, A, (db) => db.query('UPDATE id_document_access_log SET action=$1', ['VIEW_NUMBER']))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, A, (db) => db.query('DELETE FROM id_document_access_log'))).rejects.toThrow(/permission denied/);
  });

  it('ảnh: trả đúng nội dung; tenant khác không đọc được; đường dẫn bị sửa sang tenant khác bị chặn', async () => {
    const { A, cust } = await setup();
    const B = await mkTenant(t);
    const id = await as(A, {}, (c) => addIdDocument(c, cust, doc()));
    const img = await as(A, {}, (c) => getIdImage(c, id, 'front'));
    expect([...img.data]).toEqual([...PNG]);
    expect(img.contentType).toBe('image/png');
    await expect(as(B, {}, (c) => getIdImage(c, id, 'front'))).rejects.toThrow(/Không tìm thấy/);
    await expect(as(B, {}, (c) => revealIdNumber(c, id))).rejects.toThrow(/Không tìm thấy/);
    // dữ liệu bị sửa trực tiếp trỏ sang file của tenant khác
    await t.admin.query('UPDATE id_document SET front_path=$2 WHERE id=$1', [id, `tenants/${B}/id/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png`]);
    await expect(as(A, {}, (c) => getIdImage(c, id, 'front'))).rejects.toThrow(/không thuộc cửa hàng/);
    await t.admin.query('UPDATE id_document SET front_path=$2 WHERE id=$1', [id, `tenants/${A}/../${B}/x.png`]);
    await expect(as(A, {}, (c) => getIdImage(c, id, 'front'))).rejects.toThrow(/không thuộc cửa hàng/);
  });

  it('xóa giấy tờ: xóa file và xóa sạch số, vẫn giữ nhật ký truy cập', async () => {
    const { A, cust } = await setup();
    const st = new MemoryStorage();
    const id = await as(A, { storage: st }, (c) => addIdDocument(c, cust, doc()));
    await as(A, {}, (c) => revealIdNumber(c, id));
    expect(st.files.size).toBe(2);
    await as(A, { storage: st }, (c) => deleteIdDocument(c, id));
    expect(st.files.size).toBe(0);
    const raw = (await t.admin.query('SELECT number_enc, number_hash, front_path, deleted_at FROM id_document WHERE id=$1', [id])).rows[0];
    expect(raw).toMatchObject({ number_enc: '', number_hash: '', front_path: null });
    expect(raw.deleted_at).not.toBeNull();
    expect((await t.admin.query('SELECT 1 FROM id_document_access_log WHERE document_id=$1', [id])).rowCount).toBe(1);
    await expect(as(A, {}, (c) => revealIdNumber(c, id))).rejects.toThrow(/Không tìm thấy/);
  });

  it('khóa mã hóa sai thì không giải mã được (không lộ dữ liệu)', async () => {
    const { A, cust } = await setup();
    const id = await as(A, {}, (c) => addIdDocument(c, cust, doc()));
    const wrong = { current: 'k1', keys: { k1: Buffer.alloc(32, 7) } };
    await expect(as(A, { ring: wrong }, (c) => revealIdNumber(c, id))).rejects.toThrow();
  });

  it('xoay khóa: dữ liệu cũ vẫn giải mã được khi giữ khóa cũ', async () => {
    const { A, cust } = await setup();
    const id = await as(A, {}, (c) => addIdDocument(c, cust, doc()));
    const rotated = { current: 'k2', keys: { k1: ring.keys.k1!, k2: Buffer.alloc(32, 9) } };
    expect(await as(A, { ring: rotated }, (c) => revealIdNumber(c, id))).toBe('001099123456');
  });
});

describe('ẩn danh khách hàng', () => {
  it('xóa thông tin cá nhân, giấy tờ và file; giải phóng SĐT; giữ dòng khách để đối soát', async () => {
    const A = await mkTenant(t);
    const st = new MemoryStorage();
    const cust = await as(A, {}, (c) => createCustomer(c, person({ email: 'an@example.com', address: '1 Lê Lợi', notes: 'VIP' })));
    await as(A, { storage: st }, (c) => addIdDocument(c, cust, { type: 'CCCD', number: '001099123456', consent: true, front: { data: PNG } }));
    await expect(as(A, { role: 'STAFF' }, (c) => anonymizeCustomer(c, cust))).rejects.toThrow(ForbiddenError);
    await as(A, { storage: st }, (c) => anonymizeCustomer(c, cust));
    const row = (await t.admin.query('SELECT * FROM customer WHERE id=$1', [cust])).rows[0];
    expect(row).toMatchObject({ name: 'Khách đã ẩn danh', email: null, address: null, notes: null });
    expect(row.phone).toBe(`anon-${cust}`);
    expect(row.anonymized_at).not.toBeNull();
    expect(st.files.size).toBe(0);
    expect((await as(A, {}, (c) => listCustomers(c))).total).toBe(0);
    await expect(as(A, {}, (c) => assertCustomerCanRent(c, cust))).rejects.toThrow(/ẩn danh/);
    await expect(as(A, {}, (c) => updateCustomer(c, cust, person()))).rejects.toThrow(/Không tìm thấy/);
    await expect(as(A, {}, (c) => createCustomer(c, person()))).resolves.toBeDefined(); // SĐT dùng lại được
  });

  it('từ chối khi khách còn đơn chưa hoàn tất', async () => {
    const A = await mkTenant(t);
    const cust = await as(A, {}, (c) => createCustomer(c, person()));
    await t.admin.query("INSERT INTO booking(tenant_id,code,customer_id,status,starts_at,ends_at) VALUES ($1,'B1',$2,'CONFIRMED','2030-01-01','2030-01-02')", [A, cust]);
    await expect(as(A, {}, (c) => anonymizeCustomer(c, cust))).rejects.toThrow(/còn đơn chưa hoàn tất/);
    await t.admin.query("UPDATE booking SET status='CLOSED'");
    await expect(as(A, {}, (c) => anonymizeCustomer(c, cust))).resolves.toBeUndefined();
  });
});

it('ValidationError là lỗi hiển thị được cho người dùng', () => {
  expect(new ValidationError('x').name).toBe('ValidationError');
});
