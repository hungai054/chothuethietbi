import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { GIF, PNG, mkTenant, runAs, type Opts } from './ctx';
import {
  MemoryStorage, ReadOnlyError, addDomain, createBooking, createContract, createCustomRole, createCustomer, createFieldDef, createModel, createUnits, createUser, customValuesFor, deleteCustomRole,
  ensureDefaultPriceList, getBranding, getCustomFile, getDocTemplates, getLabels, getContract, listBookings, listCustomRoles, listCustomers, listDomains, listFieldDefs, listUnits, listUsers,
  loadUserAccess, previewContract, readBrandAsset, removeDomain, resolveTenant, searchableKeys, setCustomFile, setCustomValues, setUserPassword, setRule, updateBranding, updateCustomRole,
  updateDocTemplates, updateFieldDef, updateLabels, updateUser, validateFieldValues, verifyDomain, withTenantId, confirmBooking,
  type FieldDefInput,
} from '../src';
import { DEFAULT_ROLE_PERMISSIONS, ForbiddenError, LABEL_DEFAULTS, type DnsResolver } from '@rentpro/core';
import { FEATURE_KEYS, FeatureDisabledError, LimitExceededError, resolveFeatures } from '@rentpro/tenancy';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb(54340);
  await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')");
  await t.admin.query("INSERT INTO plan(code,name,features,limits) VALUES ('full','Full',$1,'{}')", [JSON.stringify(Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])))]);
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);
const D = 86_400_000;
const field = (over: Partial<FieldDefInput> = {}): FieldDefInput => ({ entity: 'CUSTOMER', key: 'bien_so', label: 'Biển số xe', kind: 'TEXT', ...over });

async function shop() {
  const A = await mkTenant(t, 'full');
  const cam = await as(A, {}, (c) => createModel(c, { name: 'Sony A7', barcodePrefix: 'CAM' }));
  const units = await as(A, {}, (c) => createUnits(c, { modelId: cam, quantity: 2 }));
  const list = await as(A, {}, (c) => ensureDefaultPriceList(c));
  await as(A, {}, (c) => setRule(c, list, cam, { hour: 100_000, day: 500_000, week: 2_500_000, month: null, minHours: 0 }));
  const cust = await as(A, {}, (c) => createCustomer(c, { name: 'Nguyễn Văn An', phone: '0901234567' }));
  return { A, cam, units, cust };
}
type Shop = Awaited<ReturnType<typeof shop>>;
const owner = async (A: string) => (await t.admin.query("INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,$2,'Chủ','x','OWNER') RETURNING id", [A, `chu${Math.random()}@x.vn`])).rows[0].id as string;

describe('trường tùy chỉnh: định nghĩa', () => {
  it('tạo trường, kiểm tra đầu vào, trùng mã, giới hạn số trường', async () => {
    const s = await shop();
    const mk = (o: Partial<FieldDefInput>, opts: Opts = {}) => as(s.A, opts, (c) => createFieldDef(c, field(o)));
    const id = await mk({ searchable: true });
    expect(id).toBeDefined();
    await expect(mk({})).rejects.toThrow(/đã tồn tại ở khách hàng/);
    await mk({ entity: 'UNIT' }); // cùng mã ở đối tượng khác là hợp lệ
    await expect(mk({ key: 'Bad Key' })).rejects.toThrow(/Mã trường/);
    await expect(mk({ key: 'x2', kind: 'SELECT', options: ['A'] })).rejects.toThrow(/ít nhất 2 lựa chọn/);
    await expect(mk({ key: 'x3', kind: 'FILE', searchable: true })).rejects.toThrow(/tệp đính kèm/);
    await expect(mk({ key: 'x4' }, { role: 'STAFF' })).rejects.toThrow(ForbiddenError);
    await expect(mk({ key: 'x5' }, { status: 'READ_ONLY' })).rejects.toThrow(ReadOnlyError);
    await expect(mk({ key: 'x6' }, { off: ['custom_fields'] })).rejects.toThrow(FeatureDisabledError);
    for (let i = 0; i < 28; i++) await mk({ key: `f${i}`, label: `F${i}`, entity: 'BOOKING' });
    await mk({ key: 'f28', label: 'F28', entity: 'BOOKING' });
    await mk({ key: 'f29', label: 'F29', entity: 'BOOKING' });
    await expect(mk({ key: 'f30', label: 'F30', entity: 'BOOKING' })).rejects.toThrow(/tối đa 30 trường/);
  });

  it('sửa: đổi nhãn/bắt buộc/lựa chọn/tắt; không đổi được mã và kiểu; gói không có tính năng thì không thấy trường', async () => {
    const s = await shop();
    const id = await as(s.A, {}, (c) => createFieldDef(c, field({ key: 'mau', label: 'Màu', kind: 'SELECT', options: ['Đỏ', 'Xanh'], entity: 'UNIT', showInList: true })));
    await as(s.A, {}, (c) => updateFieldDef(c, id, { label: 'Màu sắc', required: true, options: ['Đỏ', 'Xanh', 'Vàng'] }));
    const d = (await as(s.A, {}, (c) => listFieldDefs(c, 'UNIT')))[0]!;
    expect(d).toMatchObject({ key: 'mau', kind: 'SELECT', label: 'Màu sắc', required: true, options: ['Đỏ', 'Xanh', 'Vàng'], showInList: true });
    await expect(as(s.A, {}, (c) => updateFieldDef(c, id, { options: ['Chỉ một'] }))).rejects.toThrow(/ít nhất 2 lựa chọn/);
    await as(s.A, {}, (c) => updateFieldDef(c, id, { active: false }));
    expect(await as(s.A, {}, (c) => listFieldDefs(c, 'UNIT'))).toHaveLength(0);
    expect(await as(s.A, {}, (c) => listFieldDefs(c, 'UNIT', { includeInactive: true }))).toHaveLength(1);
    expect(await as(s.A, { off: ['custom_fields'] }, (c) => listFieldDefs(c, 'UNIT', { includeInactive: true }))).toEqual([]);
    await expect(t.admin.query("UPDATE custom_field_def SET kind='FILE', searchable=true WHERE id=$1", [id])).rejects.toThrow(/custom_field_file_flags|custom_field_select_options/);
  });

  it('cô lập tenant', async () => {
    const s = await shop();
    const B = await shop();
    const id = await as(s.A, {}, (c) => createFieldDef(c, field()));
    expect(await as(B.A, {}, (c) => listFieldDefs(c))).toEqual([]);
    await expect(as(B.A, {}, (c) => updateFieldDef(c, id, { label: 'x' }))).rejects.toThrow(/Không tìm thấy/);
  });
});

describe('trường tùy chỉnh: giá trị', () => {
  it('bắt buộc khi tạo (cùng giao dịch: lỗi thì không tạo khách), ghi, sửa một phần, xóa giá trị', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => createFieldDef(c, field({ required: true })));
    await as(s.A, {}, (c) => createFieldDef(c, field({ key: 'nam_sinh', label: 'Năm sinh', kind: 'NUMBER' })));
    const create = (values: Record<string, unknown>) => as(s.A, {}, async (c) => {
      const id = await createCustomer(c, { name: 'Khách mới', phone: `09${Math.floor(10000000 + Math.random() * 89999999)}` });
      await setCustomValues(c, 'CUSTOMER', id, values, true);
      return id;
    });
    const before = (await t.admin.query('SELECT count(*)::int n FROM customer WHERE tenant_id=$1', [s.A])).rows[0].n;
    await expect(create({})).rejects.toThrow(/Vui lòng nhập "Biển số xe"/);
    await expect(create({ bien_so: '51A-123', nam_sinh: 'abc' })).rejects.toThrow(/phải là một số/);
    await expect(create({ bien_so: '51A-123', la: 1 })).rejects.toThrow(/không tồn tại/);
    expect((await t.admin.query('SELECT count(*)::int n FROM customer WHERE tenant_id=$1', [s.A])).rows[0].n).toBe(before); // giao dịch hủy toàn bộ
    const id = await create({ bien_so: ' 51A-123 ', nam_sinh: '1.990' });
    expect((await as(s.A, {}, (c) => customValuesFor(c, 'CUSTOMER', [id]))).get(id)).toEqual({ bien_so: '51A-123', nam_sinh: 1990 });
    await as(s.A, {}, (c) => setCustomValues(c, 'CUSTOMER', id, { nam_sinh: '1991' }));
    expect((await as(s.A, {}, (c) => customValuesFor(c, 'CUSTOMER', [id]))).get(id)).toEqual({ bien_so: '51A-123', nam_sinh: 1991 });
    await expect(as(s.A, {}, (c) => setCustomValues(c, 'CUSTOMER', id, { bien_so: '' }))).rejects.toThrow(/Vui lòng nhập/);
    await as(s.A, {}, (c) => setCustomValues(c, 'CUSTOMER', id, { nam_sinh: '' }));
    expect((await as(s.A, {}, (c) => customValuesFor(c, 'CUSTOMER', [id]))).get(id)).toEqual({ bien_so: '51A-123' });
    expect(await as(s.A, {}, (c) => validateFieldValues(c, 'CUSTOMER', { bien_so: 'x' }, true))).toEqual({ bien_so: 'x' });
  });

  it('phân quyền theo đối tượng, chỉ đọc, gói tắt tính năng, bản ghi tenant khác', async () => {
    const s = await shop();
    const B = await shop();
    await as(s.A, {}, (c) => createFieldDef(c, field()));
    await as(s.A, {}, (c) => createFieldDef(c, field({ entity: 'UNIT', key: 'ghi_chu_kho', label: 'Ghi chú kho' })));
    await expect(as(s.A, { role: 'TECHNICIAN' }, (c) => setCustomValues(c, 'CUSTOMER', s.cust, { bien_so: 'x' }))).rejects.toThrow(ForbiddenError); // kỹ thuật viên không quản lý khách
    await as(s.A, { role: 'TECHNICIAN' }, (c) => setCustomValues(c, 'UNIT', s.units[0]!.id, { ghi_chu_kho: 'kệ A' })); // nhưng quản lý được thiết bị
    await expect(as(s.A, { role: 'STAFF' }, (c) => setCustomValues(c, 'UNIT', s.units[0]!.id, { ghi_chu_kho: 'x' }))).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, { status: 'READ_ONLY' }, (c) => setCustomValues(c, 'CUSTOMER', s.cust, { bien_so: 'x' }))).rejects.toThrow(ReadOnlyError);
    await expect(as(s.A, { off: ['custom_fields'] }, (c) => setCustomValues(c, 'CUSTOMER', s.cust, { bien_so: 'x' }))).rejects.toThrow(FeatureDisabledError);
    await as(B.A, {}, (c) => createFieldDef(c, field()));
    await expect(as(B.A, {}, (c) => setCustomValues(c, 'CUSTOMER', s.cust, { bien_so: 'x' }))).rejects.toThrow(/Không tìm thấy/);
    expect(await as(B.A, {}, (c) => customValuesFor(c, 'CUSTOMER', [s.cust]))).toEqual(new Map());
  });

  it('tệp đính kèm: chỉ ảnh hợp lệ, thay tệp thì xóa tệp cũ, đọc lại theo quyền, không dùng đường dẫn bịa', async () => {
    const s = await shop();
    const st = new MemoryStorage();
    await as(s.A, {}, (c) => createFieldDef(c, field({ entity: 'BOOKING', key: 'anh_xe', label: 'Ảnh xe', kind: 'FILE' })));
    const { id: bid } = await as(s.A, {}, (c) => createBooking(c, { customerId: s.cust, lines: [{ modelId: s.cam, qty: 1 }], start: new Date(Date.now() + 5 * D), end: new Date(Date.now() + 6 * D) }));
    await as(s.A, { storage: st }, (c) => setCustomFile(c, 'BOOKING', bid, 'anh_xe', { data: PNG, name: 'xe<1>.png' }));
    expect(st.files.size).toBe(1);
    const val = (await t.admin.query('SELECT custom_fields FROM booking WHERE id=$1', [bid])).rows[0].custom_fields.anh_xe;
    expect(val.name).toBe('xe1.png');
    expect(val.path).toMatch(new RegExp(`^tenants/${s.A}/field/`));
    await expect(as(s.A, { storage: st }, (c) => setCustomFile(c, 'BOOKING', bid, 'anh_xe', { data: GIF, name: 'a.gif' }))).rejects.toThrow(/JPG, PNG/);
    expect(st.files.size).toBe(1);
    await as(s.A, { storage: st }, (c) => setCustomFile(c, 'BOOKING', bid, 'anh_xe', { data: PNG, name: 'moi.png' }));
    expect(st.files.size).toBe(1); // tệp cũ đã bị xóa
    expect((await as(s.A, { storage: st, role: 'STAFF' }, (c) => getCustomFile(c, 'BOOKING', bid, 'anh_xe'))).contentType).toBe('image/png');
    await expect(as(s.A, { storage: st, role: 'TECHNICIAN' }, (c) => getCustomFile(c, 'BOOKING', bid, 'anh_xe'))).resolves.toBeDefined(); // xem đơn thuê được
    await expect(as(s.A, { storage: st }, (c) => setCustomFile(c, 'BOOKING', bid, 'khong_co', { data: PNG, name: 'a.png' }))).rejects.toThrow(/không tồn tại/);
    // giá trị tệp không thể bị ghi đè bằng đường dẫn tự nhập qua setCustomValues
    await as(s.A, { storage: st }, (c) => setCustomValues(c, 'BOOKING', bid, { anh_xe: { path: 'tenants/khac/x.png', name: 'x' } }));
    expect((await t.admin.query('SELECT custom_fields FROM booking WHERE id=$1', [bid])).rows[0].custom_fields.anh_xe.name).toBe('moi.png');
    await as(s.A, { storage: st }, (c) => setCustomFile(c, 'BOOKING', bid, 'anh_xe', null));
    expect(st.files.size).toBe(0);
    await expect(as(s.A, { storage: st }, (c) => getCustomFile(c, 'BOOKING', bid, 'anh_xe'))).rejects.toThrow(/Không tìm thấy/);
  });

  it('tìm kiếm theo trường tùy chỉnh trong danh sách khách, thiết bị, đơn thuê; trường không bật tìm kiếm thì không khớp', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => createFieldDef(c, field({ searchable: true })));
    await as(s.A, {}, (c) => createFieldDef(c, field({ key: 'ghi_chu', label: 'Ghi chú nội bộ' })));
    await as(s.A, {}, (c) => createFieldDef(c, field({ entity: 'UNIT', key: 'vi_tri', label: 'Vị trí', searchable: true })));
    await as(s.A, {}, (c) => createFieldDef(c, field({ entity: 'BOOKING', key: 'dia_diem', label: 'Địa điểm', searchable: true })));
    await as(s.A, {}, (c) => setCustomValues(c, 'CUSTOMER', s.cust, { bien_so: '59X1-99999', ghi_chu: 'KHÁCH-VIP-ZZ' }));
    await as(s.A, {}, (c) => setCustomValues(c, 'UNIT', s.units[1]!.id, { vi_tri: 'Tủ-KÍNH-7' }));
    const { id: bid } = await as(s.A, {}, (c) => createBooking(c, { customerId: s.cust, lines: [{ modelId: s.cam, qty: 1 }], start: new Date(Date.now() + 5 * D), end: new Date(Date.now() + 6 * D) }));
    await as(s.A, {}, (c) => setCustomValues(c, 'BOOKING', bid, { dia_diem: 'Resort Đà Lạt' }));
    expect((await as(s.A, {}, (c) => listCustomers(c, { q: '99999' }))).total).toBe(1);
    expect((await as(s.A, {}, (c) => listCustomers(c, { q: 'vip-zz' }))).total).toBe(0); // không bật tìm kiếm
    expect((await as(s.A, {}, (c) => listUnits(c, { q: 'tủ-kính' }))).rows.map((u) => u.id)).toEqual([s.units[1]!.id]);
    expect((await as(s.A, {}, (c) => listBookings(c, { q: 'đà lạt' }))).rows.map((b) => b.id)).toEqual([bid]);
    expect((await as(s.A, {}, (c) => listBookings(c, { q: 'khong-co-gi' }))).total).toBe(0);
    expect(await as(s.A, {}, (c) => searchableKeys(c, 'CUSTOMER'))).toEqual(['bien_so']);
    expect(await as(s.A, { off: ['custom_fields'] }, (c) => searchableKeys(c, 'CUSTOMER'))).toEqual([]);
  });
});

describe('mẫu tài liệu và hợp đồng', () => {
  it('lưu mẫu, kiểm tra biến và số điều khoản, quay về mặc định', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => createFieldDef(c, field({ entity: 'BOOKING', key: 'dia_diem', label: 'Địa điểm' })));
    const up = (i: Parameters<typeof updateDocTemplates>[1], o: Opts = {}) => as(s.A, o, (c) => updateDocTemplates(c, i));
    await expect(up({ contract: { title: 'HỢP ĐỒNG', terms: ['Điều khoản với {biến_lạ}'.replace('biến_lạ', 'xyz')] } })).rejects.toThrow(/Điều khoản 1: Biến không hợp lệ: \{xyz\}/);
    await expect(up({ contract: { title: 'HỢP ĐỒNG', terms: [] } })).rejects.toThrow(/ít nhất một điều khoản/);
    await expect(up({ contract: { title: ' ', terms: ['a'] } })).rejects.toThrow();
    await expect(up({ contract: { title: 'H', terms: Array(31).fill('a') } })).rejects.toThrow(/Tối đa 30/);
    await expect(up({ receipt: { title: 'PHIẾU', footer: 'Cảm ơn {khong_co}' } })).rejects.toThrow(/Chân trang phiếu thu/);
    await expect(up({ contract: { title: 'H', terms: ['a'] } }, { role: 'STAFF' })).rejects.toThrow(ForbiddenError);
    await up({ contract: { title: 'HỢP ĐỒNG THUÊ MÁY', terms: ['{ten_khach} thuê tại {cf.dia_diem}.', 'Điều khoản hai.'] }, receipt: { title: 'BIÊN LAI', footer: 'Hotline 0909' } });
    const t1 = (await as(s.A, {}, (c) => getDocTemplates(c))).resolved;
    expect(t1.contract.title).toBe('HỢP ĐỒNG THUÊ MÁY');
    expect(t1.receipt).toEqual({ title: 'BIÊN LAI', footer: 'Hotline 0909' });
    expect(t1.handover.title).toBe('BIÊN BẢN GIAO NHẬN THIẾT BỊ');
    await up({ contract: null, receipt: null });
    expect((await as(s.A, {}, (c) => getDocTemplates(c))).custom).toEqual({});
  });

  it('hợp đồng dùng mẫu của cửa hàng: thay biến, chèn trường tùy chỉnh, và đã lập thì không đổi theo mẫu mới', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => createFieldDef(c, field({ inContract: true })));                                     // khách: biển số
    await as(s.A, {}, (c) => createFieldDef(c, field({ entity: 'BOOKING', key: 'dia_diem', label: 'Địa điểm', inContract: true })));
    await as(s.A, {}, (c) => createFieldDef(c, field({ entity: 'CONTRACT', key: 'nguoi_bao_lanh', label: 'Người bảo lãnh', required: true, inContract: true })));
    await as(s.A, {}, (c) => setCustomValues(c, 'CUSTOMER', s.cust, { bien_so: '51A-123.45' }));
    await as(s.A, {}, (c) => updateDocTemplates(c, { contract: { title: 'HỢP ĐỒNG THUÊ MÁY ẢNH', terms: ['Bên B ({ten_khach}, xe {cf.bien_so}) thuê đơn {ma_don} từ {ngay_bat_dau} đến {ngay_ket_thuc}, tổng {tong_tien}, cọc {tien_coc}, bảo lãnh {cf.nguoi_bao_lanh}.', 'Điều khoản cố định.'] } }));
    const { id: bid } = await as(s.A, {}, (c) => createBooking(c, { customerId: s.cust, lines: [{ modelId: s.cam, qty: 1 }], start: new Date(Date.now() + 5 * D), end: new Date(Date.now() + 6 * D), status: 'CONFIRMED' }));
    await as(s.A, {}, (c) => setCustomValues(c, 'BOOKING', bid, { dia_diem: 'Resort Đà Lạt' }));
    await expect(as(s.A, {}, (c) => createContract(c, bid))).rejects.toThrow(/Vui lòng nhập "Người bảo lãnh"/);
    await expect(as(s.A, {}, (c) => createContract(c, bid, { nguoi_bao_lanh: 'Lê Văn B', khong_co: 1 }))).rejects.toThrow(/không tồn tại/);
    const cid = await as(s.A, {}, (c) => createContract(c, bid, { nguoi_bao_lanh: 'Lê Văn B' }));
    const content = (await as(s.A, {}, (c) => getContract(c, bid))).active!.content;
    expect(content.title).toBe('HỢP ĐỒNG THUÊ MÁY ẢNH');
    expect(content.terms).toHaveLength(2);
    expect(content.terms[0]).toMatch(/^Bên B \(Nguyễn Văn An, xe 51A-123\.45\) thuê đơn .+ từ \d{2}\/\d{2}\/\d{4} đến \d{2}\/\d{2}\/\d{4}, tổng 500\.000 đ, cọc 0 đ, bảo lãnh Lê Văn B\.$/);
    expect(content.terms[1]).toBe('Điều khoản cố định.');
    expect(content.extras).toEqual([{ label: 'Biển số xe', value: '51A-123.45' }, { label: 'Địa điểm', value: 'Resort Đà Lạt' }, { label: 'Người bảo lãnh', value: 'Lê Văn B' }]);
    expect((await t.admin.query('SELECT custom_fields FROM contract WHERE id=$1', [cid])).rows[0].custom_fields).toEqual({ nguoi_bao_lanh: 'Lê Văn B' });
    // đổi mẫu và dữ liệu sau đó: hợp đồng đã lập không đổi
    await as(s.A, {}, (c) => updateDocTemplates(c, { contract: { title: 'MẪU MỚI', terms: ['Mới'] } }));
    await t.admin.query("UPDATE customer SET custom_fields='{\"bien_so\":\"KHAC\"}' WHERE id=$1", [s.cust]);
    expect((await as(s.A, {}, (c) => getContract(c, bid))).active!.content).toEqual(content);
  });

  it('hợp đồng không tùy biến vẫn dùng đúng nội dung mặc định; xem trước theo bản nháp mà không lưu', async () => {
    const s = await shop();
    const { id: bid } = await as(s.A, {}, (c) => createBooking(c, { customerId: s.cust, lines: [{ modelId: s.cam, qty: 1 }], start: new Date(Date.now() + 5 * D), end: new Date(Date.now() + 6 * D), status: 'CONFIRMED' }));
    await as(s.A, {}, (c) => createContract(c, bid));
    const c0 = (await as(s.A, {}, (c) => getContract(c, bid))).active!.content;
    expect(c0.title).toBe('HỢP ĐỒNG CHO THUÊ THIẾT BỊ');
    expect(c0.terms).toHaveLength(8);
    expect(c0.extras).toBeUndefined();
    const pv = await as(s.A, {}, (c) => previewContract(c, { title: 'XEM THỬ', terms: ['Xin chào {ten_khach}, đơn {ma_don}.'] }));
    expect(pv.title).toBe('XEM THỬ');
    expect(pv.terms).toEqual(['Xin chào Nguyễn Văn A, đơn DT-XXXX-00001.']);
    await expect(as(s.A, {}, (c) => previewContract(c, { title: 'X', terms: ['{xyz}'] }))).rejects.toThrow(/Biến không hợp lệ/);
    expect((await as(s.A, {}, (c) => getDocTemplates(c))).custom).toEqual({});
    void confirmBooking;
  });
});

describe('nhãn và thương hiệu', () => {
  it('nhãn: lưu gọn, đọc lại, báo lỗi, quay về mặc định', async () => {
    const s = await shop();
    expect((await as(s.A, {}, (c) => getLabels(c))).labels).toEqual(LABEL_DEFAULTS);
    await as(s.A, {}, (c) => updateLabels(c, { unit: 'Sản phẩm', booking: 'Booking', customer: 'Khách hàng' }));
    const l = await as(s.A, {}, (c) => getLabels(c));
    expect(l.labels).toMatchObject({ unit: 'Sản phẩm', booking: 'Booking', customer: 'Khách hàng' });
    expect(l.custom).toEqual({ unit: 'Sản phẩm', booking: 'Booking' });
    await expect(as(s.A, {}, (c) => updateLabels(c, { unit: 'x'.repeat(40) }))).rejects.toThrow(/tối đa 30/);
    await expect(as(s.A, {}, (c) => updateLabels(c, { khong: 'x' }))).rejects.toThrow(/không tồn tại/);
    await expect(as(s.A, { role: 'STAFF' }, (c) => updateLabels(c, { unit: 'x' }))).rejects.toThrow(ForbiddenError);
    await as(s.A, {}, (c) => updateLabels(c, { unit: 'Thiết bị', booking: '' }));
    expect((await as(s.A, {}, (c) => getLabels(c))).custom).toEqual({});
  });

  it('thương hiệu: cần white-label; lưu logo/favicon riêng tư; thay thì xóa file cũ; ảnh/màu sai bị từ chối không để lại file', async () => {
    const s = await shop();
    const st = new MemoryStorage();
    const up = (i: Parameters<typeof updateBranding>[1], o: Opts = {}) => as(s.A, { storage: st, ...o }, (c) => updateBranding(c, i));
    await expect(up({ displayName: 'X' }, { off: ['white_label'] })).rejects.toThrow(FeatureDisabledError);
    await expect(up({ displayName: 'X' }, { role: 'STAFF' })).rejects.toThrow(ForbiddenError);
    await up({ displayName: 'Cửa hàng Sáng', primaryColor: '#e11d48', footerText: 'Hotline 0909', hideProductBrand: true, logo: PNG, favicon: PNG });
    expect(st.files.size).toBe(2);
    const b = await as(s.A, { storage: st }, (c) => getBranding(c));
    expect(b.resolved).toMatchObject({ displayName: 'Cửa hàng Sáng', primaryColor: '#e11d48', textOnPrimary: '#ffffff', hasLogo: true, hasFavicon: true, hideProductBrand: true, footerText: 'Hotline 0909' });
    expect(b.raw.logoPath).toMatch(new RegExp(`^tenants/${s.A}/brand/`));
    const old = b.raw.logoPath!;
    await up({ logo: PNG });
    expect(st.files.size).toBe(2);
    expect(st.files.has(old)).toBe(false);
    await expect(up({ primaryColor: 'đỏ' })).rejects.toThrow(/#RRGGBB/);
    await expect(up({ logo: GIF })).rejects.toThrow(/JPG, PNG hoặc WebP/);
    await expect(up({ logo: new Uint8Array(1024 * 1024 + 1).fill(1) })).rejects.toThrow(/quá lớn/);
    await expect(up({ favicon: new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x3e]) })).rejects.toThrow(/JPG, PNG hoặc WebP/); // không nhận SVG
    expect(st.files.size).toBe(2);
    await up({ logo: null, hideProductBrand: false, footerText: '' });
    expect(st.files.size).toBe(1);
    expect((await as(s.A, { storage: st }, (c) => getBranding(c))).resolved).toMatchObject({ hasLogo: false, hideProductBrand: false, footerText: null, displayName: 'Cửa hàng Sáng' });
    // hạ gói: thương hiệu không còn hiệu lực dù dữ liệu còn
    expect((await as(s.A, { storage: st, off: ['white_label'] }, (c) => getBranding(c))).resolved).toMatchObject({ displayName: null, primaryColor: '#0f172a' });
  });

  it('đọc ảnh thương hiệu cho trang công khai: chỉ khi có white-label và đúng tenant', async () => {
    const s = await shop();
    const B = await shop();
    const st = new MemoryStorage();
    await as(s.A, { storage: st }, (c) => updateBranding(c, { logo: PNG }));
    const read = (A: string, off: boolean) => withTenantId(t.app, A, (db) => readBrandAsset({ db, tenantId: A, storage: st, features: resolveFeatures({ planFeatures: Object.fromEntries(FEATURE_KEYS.map((k) => [k, !(off && k === 'white_label')])), overrides: {} }) }, 'logo'));
    expect((await read(s.A, false))?.contentType).toBe('image/png');
    expect(await read(s.A, true)).toBeNull();
    expect(await read(B.A, false)).toBeNull();
    expect(await withTenantId(t.app, s.A, (db) => readBrandAsset({ db, tenantId: s.A, storage: st, features: resolveFeatures({ planFeatures: { white_label: true }, overrides: {} }) }, 'favicon'))).toBeNull();
  });
});

describe('người dùng và vai trò tùy chỉnh', () => {
  const mkUser = (s: Shop, o: Partial<Parameters<typeof createUser>[1]> = {}, opts: Opts = {}) =>
    as(s.A, opts, (c) => createUser(c, { email: `u${Math.random().toString(36).slice(2)}@x.vn`, name: 'Nhân viên', password: 'Mat-khau-12345', role: 'STAFF', ...o }));

  it('tạo người dùng: kiểm tra email/tên/mật khẩu, trùng email, hạn mức gói, quyền', async () => {
    const s = await shop();
    await expect(mkUser(s, { email: 'khong-hop-le' })).rejects.toThrow(/Email không hợp lệ/);
    await expect(mkUser(s, { name: 'A' })).rejects.toThrow(/Họ tên/);
    await expect(mkUser(s, { password: '12345' })).rejects.toThrow(/ít nhất 10 ký tự/);
    await expect(mkUser(s, { role: 'KHAC' as never })).rejects.toThrow(/Vai trò không hợp lệ/);
    await expect(mkUser(s, {}, { role: 'STAFF' })).rejects.toThrow(ForbiddenError);
    await expect(mkUser(s, {}, { status: 'READ_ONLY' })).rejects.toThrow(ReadOnlyError);
    await mkUser(s, { email: 'trung@x.vn' });
    await expect(mkUser(s, { email: 'TRUNG@x.vn' })).rejects.toThrow(/đã có tài khoản/);
    const hash = (await t.admin.query("SELECT password_hash FROM app_user WHERE email='trung@x.vn' AND tenant_id=$1", [s.A])).rows[0].password_hash;
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('Mat-khau');
    // hạn mức: tenant có 1 người dùng, giới hạn 2 → người thứ hai được, người thứ ba bị chặn
    const s2 = await shop();
    await mkUser(s2, {}, { limits: { users: 2 } });
    await mkUser(s2, {}, { limits: { users: 2 } });
    await expect(mkUser(s2, {}, { limits: { users: 2 } })).rejects.toThrow(LimitExceededError);
  });

  it('chỉ chủ cửa hàng gán/sửa vai trò Chủ; quản lý sửa được nhân viên nhưng không sửa được chủ', async () => {
    const s = await shop();
    const ownerId = await owner(s.A);
    await expect(mkUser(s, { role: 'OWNER' }, { role: 'MANAGER' })).rejects.toThrow(ForbiddenError);
    const staff = await mkUser(s);
    await as(s.A, { role: 'MANAGER' }, (c) => updateUser(c, staff, { name: 'Tên mới', role: 'TECHNICIAN' }));
    expect((await t.admin.query('SELECT name, role FROM app_user WHERE id=$1', [staff])).rows[0]).toEqual({ name: 'Tên mới', role: 'TECHNICIAN' });
    await expect(as(s.A, { role: 'MANAGER' }, (c) => updateUser(c, ownerId, { active: false }))).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, { role: 'MANAGER' }, (c) => setUserPassword(c, ownerId, 'Mat-khau-moi-123'))).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, { role: 'MANAGER' }, (c) => updateUser(c, staff, { role: 'OWNER' }))).rejects.toThrow(ForbiddenError);
  });

  it('không thể mất hết chủ cửa hàng, không tự khóa mình, khóa rồi mở lại tính vào hạn mức', async () => {
    const s = await shop();
    const o1 = await owner(s.A);
    const o2 = await owner(s.A);
    await as(s.A, { userId: o1 }, (c) => updateUser(c, o2, { active: false })); // còn o1
    await expect(as(s.A, { userId: o2 }, (c) => updateUser(c, o1, { role: 'MANAGER' }))).rejects.toThrow(/ít nhất một chủ cửa hàng/);
    await expect(as(s.A, { userId: o1 }, (c) => updateUser(c, o1, { active: false }))).rejects.toThrow(/tự khóa/);
    await expect(as(s.A, { userId: o1 }, (c) => updateUser(c, o1, { role: 'MANAGER' }))).rejects.toThrow(/tự đổi vai trò/);
    await as(s.A, { userId: o1, limits: { users: 5 } }, (c) => updateUser(c, o2, { active: true }));
    const u3 = await mkUser(s, {}, { limits: { users: 5 } });
    await as(s.A, { userId: o1 }, (c) => updateUser(c, u3, { active: false }));
    await expect(as(s.A, { userId: o1, limits: { users: 2 } }, (c) => updateUser(c, u3, { active: true }))).rejects.toThrow(LimitExceededError);
    await as(s.A, { userId: o1 }, (c) => setUserPassword(c, u3, 'Mat-khau-moi-123'));
    await expect(as(s.A, { userId: o1 }, (c) => setUserPassword(c, u3, 'yeu'))).rejects.toThrow(/ít nhất 10 ký tự/);
    expect((await as(s.A, {}, (c) => listUsers(c))).find((u) => u.id === u3)).toMatchObject({ active: false, role: 'STAFF' });
  });

  it('vai trò tùy chỉnh: chỉ chủ + đúng gói, kéo theo quyền xem, không có quyền dành riêng cho chủ', async () => {
    const s = await shop();
    const mk = (perms: string[], o: Opts = {}) => as(s.A, o, (c) => createCustomRole(c, 'Thu ngân', perms));
    await expect(mk(['payment.create'], { role: 'MANAGER' })).rejects.toThrow(ForbiddenError); // quản lý không có roles.manage
    await expect(mk(['payment.create'], { off: ['custom_roles'] })).rejects.toThrow(FeatureDisabledError);
    await expect(mk(['billing.manage'])).rejects.toThrow(/chỉ dành cho chủ cửa hàng/);
    await expect(mk(['xyz'])).rejects.toThrow(/không tồn tại/);
    await expect(mk([])).rejects.toThrow(/ít nhất một quyền/);
    const r = await mk(['payment.create', 'deposit.collect']);
    expect(r.added.sort()).toEqual(['deposit.view', 'payment.view']);
    await expect(mk(['payment.create'])).rejects.toThrow(/Đã có vai trò tên "Thu ngân"/);
    const list = await as(s.A, {}, (c) => listCustomRoles(c));
    expect(list).toHaveLength(1);
    expect(list[0]!.permissions).toEqual(['payment.view', 'payment.create', 'deposit.view', 'deposit.collect']);
    await as(s.A, {}, (c) => updateCustomRole(c, r.id, 'Thu ngân quầy', ['payment.create', 'booking.view']));
    expect((await as(s.A, {}, (c) => listCustomRoles(c)))[0]).toMatchObject({ name: 'Thu ngân quầy', users: 0 });
    await expect(as(s.A, {}, (c) => updateCustomRole(c, '00000000-0000-0000-0000-000000000000', 'Ai đó', ['booking.view']))).rejects.toThrow(/Không tìm thấy/);
  });

  it('quyền hiệu lực: vai trò tùy chỉnh thay quyền mặc định; hạ gói hoặc khóa tài khoản thì mất hiệu lực; xóa vai trò đang dùng bị chặn', async () => {
    const s = await shop();
    const role = (await as(s.A, {}, (c) => createCustomRole(c, 'Chỉ xem đơn', ['booking.view', 'customer.view']))).id;
    const uid = await mkUser(s, { role: 'STAFF', customRoleId: role });
    const access = (features: Record<string, boolean>) => withTenantId(t.app, s.A, (db) => loadUserAccess(db, uid, resolveFeatures({ planFeatures: features, overrides: {} })));
    const on = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
    const a1 = (await access(on))!;
    expect([...a1.permissions].sort()).toEqual(['booking.view', 'customer.view']);
    expect(a1.permissions.has('booking.create')).toBe(false); // nhân viên mặc định có, vai trò tùy chỉnh thì không
    const a2 = (await access({ ...on, custom_roles: false }))!;
    expect([...a2.permissions].sort()).toEqual([...DEFAULT_ROLE_PERMISSIONS.STAFF].sort()); // hạ gói: về quyền mặc định của vai trò nền
    await t.admin.query('UPDATE app_user SET active=false WHERE id=$1', [uid]);
    const a3 = (await access(on))!;
    expect(a3.active).toBe(false);
    expect(a3.permissions.size).toBe(0);
    await t.admin.query('UPDATE app_user SET active=true WHERE id=$1', [uid]);
    await expect(as(s.A, {}, (c) => deleteCustomRole(c, role))).rejects.toThrow(/Còn 1 người dùng/);
    await as(s.A, {}, (c) => updateUser(c, uid, { customRoleId: null }));
    await as(s.A, {}, (c) => deleteCustomRole(c, role));
    expect(await withTenantId(t.app, s.A, (db) => loadUserAccess(db, '00000000-0000-0000-0000-000000000000', resolveFeatures({ planFeatures: on, overrides: {} })))).toBeNull();
    // quyền bị sửa tay trong DB (chứa quyền dành riêng cho chủ) vẫn bị loại khi đọc
    const r2 = (await as(s.A, {}, (c) => createCustomRole(c, 'Khác', ['booking.view']))).id;
    await t.admin.query("UPDATE custom_role SET permissions = ARRAY['booking.view','billing.manage','data.delete','khong.co'] WHERE id=$1", [r2]);
    await t.admin.query('UPDATE app_user SET custom_role_id=$2 WHERE id=$1', [uid, r2]);
    expect([...(await access(on))!.permissions]).toEqual(['booking.view']);
  });

  it('không gắn vai trò tùy chỉnh cho chủ cửa hàng hoặc khi gói không có tính năng; cô lập tenant', async () => {
    const s = await shop();
    const B = await shop();
    const role = (await as(s.A, {}, (c) => createCustomRole(c, 'Vai A', ['booking.view']))).id;
    await expect(mkUser(s, { role: 'OWNER', customRoleId: role })).rejects.toThrow(/luôn có đủ quyền/);
    await expect(mkUser(s, { customRoleId: role }, { off: ['custom_roles'] })).rejects.toThrow(/không có vai trò tùy chỉnh/);
    await expect(mkUser(B, { customRoleId: role })).rejects.toThrow(/Không tìm thấy/); // vai trò của tenant khác không dùng được
    expect(await as(B.A, {}, (c) => listCustomRoles(c))).toEqual([]);
    expect(await as(B.A, {}, (c) => listUsers(c))).toEqual([]);
  });
});

describe('tên miền riêng', () => {
  const dnsOk = (token: string, cname = 'custom.rentpro.vn'): DnsResolver => ({ resolveTxt: async () => [[token]], resolveCname: async () => [cname] });
  const dnsNone: DnsResolver = { resolveTxt: async () => { throw new Error('ENODATA'); }, resolveCname: async () => { throw new Error('ENODATA'); } };
  const OPTS = { platformBase: 'rentpro.vn', cnameTarget: 'custom.rentpro.vn' };

  it('thêm, xác minh qua TXT, tra cứu tenant theo tên miền, gỡ', async () => {
    const s = await shop();
    const id = await as(s.A, {}, (c) => addDomain(c, ' HTTPS://Thue-May.VN/ ', OPTS));
    const d = (await as(s.A, {}, (c) => listDomains(c)))[0]!;
    expect(d).toMatchObject({ domain: 'thue-may.vn', verified: false, txtName: '_rentpro-verify.thue-may.vn' });
    expect(d.verifyToken).toMatch(/^rentpro-/);
    expect(await resolveTenant(t.app, '', 'thue-may.vn')).toBeNull(); // chưa xác minh thì chưa trỏ được
    expect((await as(s.A, {}, (c) => verifyDomain(c, id, dnsNone, OPTS)))).toMatchObject({ ok: false });
    expect((await as(s.A, {}, (c) => verifyDomain(c, id, dnsOk('rentpro-sai'), OPTS))).ok).toBe(false);
    expect(await as(s.A, {}, (c) => verifyDomain(c, id, dnsOk(d.verifyToken!), OPTS))).toEqual({ ok: true, message: 'Đã xác minh tên miền.' });
    expect((await resolveTenant(t.app, '', 'thue-may.vn'))?.id).toBe(s.A);
    expect((await t.app.query('SELECT domain_is_verified($1) v', ['THUE-MAY.vn'])).rows[0].v).toBe(true);
    expect((await t.app.query('SELECT domain_is_verified($1) v', ['khac.vn'])).rows[0].v).toBe(false);
    expect((await as(s.A, {}, (c) => listDomains(c)))[0]).toMatchObject({ verified: true, verifyToken: null });
    await as(s.A, {}, (c) => removeDomain(c, id));
    expect(await resolveTenant(t.app, '', 'thue-may.vn')).toBeNull();
    await expect(as(s.A, {}, (c) => removeDomain(c, id))).rejects.toThrow(/Không tìm thấy/);
  });

  it('CNAME chưa đúng chỉ cảnh báo; tên miền sai, của nền tảng, quá số lượng, sai quyền/gói đều bị từ chối', async () => {
    const s = await shop();
    const id = await as(s.A, {}, (c) => addDomain(c, 'cua-hang.com', OPTS));
    const tok = (await as(s.A, {}, (c) => listDomains(c)))[0]!.verifyToken!;
    const r = await as(s.A, {}, (c) => verifyDomain(c, id, dnsOk(tok, 'noi-khac.com'), OPTS));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/chưa trỏ CNAME/);
    await expect(as(s.A, {}, (c) => addDomain(c, 'abc.rentpro.vn', OPTS))).rejects.toThrow(/thuộc rentpro\.vn/);
    await expect(as(s.A, {}, (c) => addDomain(c, '192.168.0.1', OPTS))).rejects.toThrow(/địa chỉ IP/);
    await expect(as(s.A, {}, (c) => addDomain(c, 'cua-hang.com', OPTS))).rejects.toThrow(/đã được thêm/);
    await as(s.A, {}, (c) => addDomain(c, 'b.com', OPTS));
    await as(s.A, {}, (c) => addDomain(c, 'c.com', OPTS));
    await expect(as(s.A, {}, (c) => addDomain(c, 'd.com', OPTS))).rejects.toThrow(/tối đa 3/);
    await expect(as(s.A, { role: 'STAFF' }, (c) => addDomain(c, 'e.com', OPTS))).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, { off: ['custom_domain'] }, (c) => addDomain(c, 'e.com', OPTS))).rejects.toThrow(FeatureDisabledError);
    await expect(as(s.A, { status: 'READ_ONLY' }, (c) => addDomain(c, 'e.com', OPTS))).rejects.toThrow(ReadOnlyError);
  });

  it('nhiều cửa hàng cùng khai báo một tên miền: ai xác minh trước được; không ai chiếm chỗ bằng cách khai báo trước; cô lập tenant', async () => {
    const s = await shop();
    const B = await shop();
    const ida = await as(s.A, {}, (c) => addDomain(c, 'tranh-chap.vn', OPTS));
    const idb = await as(B.A, {}, (c) => addDomain(c, 'tranh-chap.vn', OPTS));
    const ta = (await as(s.A, {}, (c) => listDomains(c)))[0]!.verifyToken!;
    const tb = (await as(B.A, {}, (c) => listDomains(c)))[0]!.verifyToken!;
    expect(ta).not.toBe(tb);
    expect((await as(s.A, {}, (c) => verifyDomain(c, ida, dnsOk(ta), OPTS))).ok).toBe(true);
    const lose = await as(B.A, {}, (c) => verifyDomain(c, idb, dnsOk(tb), OPTS));
    expect(lose).toEqual({ ok: false, message: 'tranh-chap.vn đã được một cửa hàng khác xác minh trước.' });
    expect((await resolveTenant(t.app, '', 'tranh-chap.vn'))?.id).toBe(s.A);
    await expect(as(B.A, {}, (c) => verifyDomain(c, ida, dnsOk(ta), OPTS))).rejects.toThrow(/Không tìm thấy/); // không đụng được tên miền của tenant khác
    await expect(as(B.A, {}, (c) => removeDomain(c, ida))).rejects.toThrow(/Không tìm thấy/);
  });

  it('tenant bị tạm khóa không còn được cấp chứng chỉ', async () => {
    const s = await shop();
    const id = await as(s.A, {}, (c) => addDomain(c, 'tam-khoa.vn', OPTS));
    const tok = (await as(s.A, {}, (c) => listDomains(c)))[0]!.verifyToken!;
    await as(s.A, {}, (c) => verifyDomain(c, id, dnsOk(tok), OPTS));
    expect((await t.app.query('SELECT domain_is_verified($1) v', ['tam-khoa.vn'])).rows[0].v).toBe(true);
    await t.admin.query("UPDATE tenant SET status='SUSPENDED' WHERE id=$1", [s.A]);
    expect((await t.app.query('SELECT domain_is_verified($1) v', ['tam-khoa.vn'])).rows[0].v).toBe(false);
  });
});
