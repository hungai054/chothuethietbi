import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { GIF, JPG, PNG, mkTenant, runAs, type Opts } from './ctx';
import {
  MemoryStorage, ReadOnlyError, addOrderPhotos, bookingLedger, cancelBooking, cancelOrder, chargeCustomer, createBooking, createCustomer, createMaintenancePlan, createModel, createOrder, createUnits,
  deliverBooking, disposeOrder, ensureDefaultPriceList, finishOrder, getOrder, getOrderPhoto, listInbox, listMaintenancePlans, listOrders, listRunnableTenants, listTechnicians, lookupForMaintenance,
  maintenanceSummary, markUnrepairable, planProgress, receiveBooking, runTenantJobs, scanMaintenance, setMaintenancePlanActive, setRule, startOrder, toggleChecklist, updateFinanceSettings, updateOrder,
  type OrderInput,
} from '../src';
import { findMaintenanceWindow, ForbiddenError, InvalidOrderTransitionError } from '@rentpro/core';
import { FEATURE_KEYS, FeatureDisabledError } from '@rentpro/tenancy';
import { ConsoleProvider } from '@rentpro/notifications';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb(54338);
  await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')");
  await t.admin.query("INSERT INTO plan(code,name,features,limits) VALUES ('full','Full',$1,'{}')", [JSON.stringify(Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])))]);
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);
const D = 86_400_000;
const H = 3_600_000;
const TZ = 'Asia/Ho_Chi_Minh';

async function shop(units = 2) {
  const A = await mkTenant(t, 'full');
  const cam = await as(A, {}, (c) => createModel(c, { name: 'Sony A7', barcodePrefix: 'CAM', compensationValue: 10_000_000 }));
  const us = await as(A, {}, (c) => createUnits(c, { modelId: cam, quantity: units }));
  const list = await as(A, {}, (c) => ensureDefaultPriceList(c));
  await as(A, {}, (c) => setRule(c, list, cam, { hour: 100_000, day: 500_000, week: 2_500_000, month: null, minHours: 0 }));
  const cust = await as(A, {}, (c) => createCustomer(c, { name: 'Nguyễn Văn An', phone: '0901234567' }));
  await t.admin.query("INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,'ky-thuat@x.vn','Kỹ thuật A','x','TECHNICIAN')", [A]);
  await as(A, {}, (c) => updateFinanceSettings(c, { handover: { requireContract: false, requireDeposit: false } }));
  return { A, cam, units: us, cust };
}
type Shop = Awaited<ReturnType<typeof shop>>;
let off = 0;
const book = (s: Shop, unit: string | undefined, start: Date, end: Date, status: 'CONFIRMED' | 'HOLD' = 'CONFIRMED') =>
  as(s.A, {}, (c) => createBooking(c, { customerId: s.cust, lines: [{ modelId: s.cam, qty: 1, unitId: unit }], start, end, status })).then((r) => r.id);
const status = async (id: string) => (await t.admin.query('SELECT status FROM equipment_unit WHERE id=$1', [id])).rows[0].status as string;
const orderOf = async (id: string) => (await t.admin.query('SELECT * FROM work_order WHERE id=$1', [id])).rows[0];
const alloc = async (woId: string) => (await t.admin.query('SELECT status, lower(period) s, upper(period) e FROM unit_allocation WHERE work_order_id=$1', [woId])).rows;
const mkOrder = (s: Shop, o: Partial<OrderInput> = {}, opts: Opts = {}) =>
  as(s.A, opts, (c) => createOrder(c, { unitId: s.units[0]!.id, kind: 'REPAIR', title: 'Thay màn hình', ...o }));
/** Một lượt thuê trọn vẹn trong quá khứ để có dữ liệu giờ/lượt thuê */
async function rental(s: Shop, unitId: string, o: { damaged?: string } = {}) {
  const start = new Date(Date.now() - (10 + ++off) * D), end = new Date(start.getTime() + 2 * D);
  const id = await book(s, unitId, start, end);
  await as(s.A, {}, (c) => deliverBooking(c, id, { items: [{ unitId, condition: 'GOOD' }] }));
  await t.admin.query('UPDATE booking SET delivered_at = starts_at WHERE id=$1', [id]);
  const r = await as(s.A, {}, (c) => receiveBooking(c, id, { returnedAt: end, items: [o.damaged ? { unitId, condition: 'DAMAGED', notes: o.damaged } : { unitId, condition: 'GOOD' }] }));
  return { id, r };
}

describe('kế hoạch định kỳ', () => {
  it('tạo kế hoạch theo ngày / giờ / lượt; kiểm tra đầu vào bằng tiếng Việt', async () => {
    const s = await shop();
    const mk = (o: Record<string, unknown>, opts: Opts = {}) => as(s.A, opts, (c) => createMaintenancePlan(c, { name: 'Vệ sinh', modelId: s.cam, ...o }));
    await expect(mk({})).rejects.toThrow(/ít nhất một điều kiện/);
    await expect(mk({ everyDays: 0 })).rejects.toThrow(/số nguyên dương/);
    await expect(mk({ name: ' ', everyDays: 30 })).rejects.toThrow(/tên kế hoạch/);
    await expect(mk({ everyDays: 30, durationHours: 0 })).rejects.toThrow(/Thời lượng/);
    await expect(mk({ everyHours: 100 }, { off: ['maintenance.usage_based'] })).rejects.toThrow(/nâng cấp gói/);
    await expect(mk({ everyDays: 30 }, { off: ['maintenance'] })).rejects.toThrow(FeatureDisabledError);
    await expect(mk({ everyDays: 30, unitId: (await as(s.A, {}, async (c) => createUnits(c, { modelId: (await createModel(c, { name: 'Khác' })), quantity: 1 })))[0]!.id })).rejects.toThrow(/không thuộc mẫu/);
    const qty = await as(s.A, {}, (c) => createModel(c, { name: 'Cáp', tracked: false, stockQty: 5 }));
    await expect(mk({ everyDays: 30, modelId: qty })).rejects.toThrow(/theo số lượng/);
    await mk({ everyDays: 90, everyHours: 100, everyRentals: 20, checklist: ['Vệ sinh cảm biến', ' ', 'Cập nhật firmware'] });
    await mk({ name: 'Riêng chiếc 1', everyDays: 30, unitId: s.units[0]!.id });
    const plans = await as(s.A, { role: 'STAFF' }, (c) => listMaintenancePlans(c));
    expect(plans).toHaveLength(2);
    expect(plans.find((p) => p.name === 'Vệ sinh')).toMatchObject({ everyDays: 90, everyHours: 100, everyRentals: 20, durationHours: 4, checklist: [{ text: 'Vệ sinh cảm biến', done: false }, { text: 'Cập nhật firmware', done: false }] });
  });

  it('phân quyền: nhân viên quầy chỉ xem; kỹ thuật viên quản lý; chỉ đọc bị chặn; cô lập tenant', async () => {
    const s = await shop();
    const B = await shop();
    await expect(as(s.A, { role: 'STAFF' }, (c) => createMaintenancePlan(c, { name: 'x', modelId: s.cam, everyDays: 30 }))).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, { status: 'READ_ONLY' }, (c) => createMaintenancePlan(c, { name: 'x', modelId: s.cam, everyDays: 30 }))).rejects.toThrow(ReadOnlyError);
    const id = await as(s.A, { role: 'TECHNICIAN' }, (c) => createMaintenancePlan(c, { name: 'x', modelId: s.cam, everyDays: 30 }));
    await expect(as(B.A, {}, (c) => setMaintenancePlanActive(c, id, false))).rejects.toThrow(/Không tìm thấy/);
    expect(await as(B.A, {}, (c) => listMaintenancePlans(c))).toEqual([]);
    await as(s.A, {}, (c) => setMaintenancePlanActive(c, id, false));
    expect((await as(s.A, {}, (c) => listMaintenancePlans(c)))[0]!.active).toBe(false);
  });

  it('tiến độ: tính số ngày, giờ đã cho thuê và lượt thuê kể từ lần bảo trì trước', async () => {
    const s = await shop();
    await rental(s, s.units[0]!.id); // 48 giờ, 1 lượt
    await rental(s, s.units[0]!.id);
    await t.admin.query("UPDATE equipment_unit SET created_at = now() - interval '30 days'");
    await as(s.A, {}, (c) => createMaintenancePlan(c, { name: 'Định kỳ', modelId: s.cam, everyDays: 100, everyHours: 200, everyRentals: 5 }));
    const rows = await as(s.A, { role: 'STAFF' }, (c) => planProgress(c));
    const r0 = rows.find((r) => r.unitId === s.units[0]!.id)!;
    expect(r0.usage.rentals).toBe(2);
    expect(r0.usage.hoursUsed).toBeCloseTo(96, 0);
    expect(r0.usage.daysSince).toBeCloseTo(30, 0);
    expect(r0.evaluation.due).toBe(false);
    expect(r0.evaluation.progress.rentals).toBeCloseTo(0.4, 5);
    const r1 = rows.find((r) => r.unitId === s.units[1]!.id)!;
    expect(r1.usage).toMatchObject({ rentals: 0, hoursUsed: 0 });
  });
});

describe('phiếu thủ công và lịch', () => {
  it('tạo phiếu: mã tăng dần, kiểm tra đầu vào, kỹ thuật viên phải tồn tại', async () => {
    const s = await shop();
    const a = await mkOrder(s);
    const b = await mkOrder(s, { title: 'Kiểm tra định kỳ', kind: 'INSPECTION' });
    expect((await orderOf(a)).code).toMatch(/^BT-\d{4}-00001$/);
    expect((await orderOf(b)).code).toMatch(/00002$/);
    await expect(mkOrder(s, { title: ' ' })).rejects.toThrow(/tiêu đề/);
    await expect(mkOrder(s, { kind: 'X' as never })).rejects.toThrow(/Loại phiếu/);
    await expect(mkOrder(s, { dueDate: '10/03/2027' })).rejects.toThrow(/Hạn hoàn thành/);
    await expect(mkOrder(s, { windowStart: new Date() })).rejects.toThrow(/cả giờ bắt đầu và giờ kết thúc/);
    await expect(mkOrder(s, { windowStart: new Date(Date.now() + D), windowEnd: new Date(Date.now()) })).rejects.toThrow(/sau giờ bắt đầu/);
    await expect(mkOrder(s, { technicianId: '00000000-0000-0000-0000-000000000001' })).rejects.toThrow(/Kỹ thuật viên không tồn tại/);
    await expect(mkOrder(s, { unitId: '00000000-0000-0000-0000-000000000001' })).rejects.toThrow(/Không tìm thấy/);
    await t.admin.query("UPDATE equipment_unit SET status='RETIRED' WHERE id=$1", [s.units[1]!.id]);
    await expect(mkOrder(s, { unitId: s.units[1]!.id })).rejects.toThrow(/đã thanh lý hoặc mất/);
    await expect(mkOrder(s, {}, { role: 'STAFF' })).rejects.toThrow(ForbiddenError);
    await expect(mkOrder(s, {}, { off: ['maintenance'] })).rejects.toThrow(FeatureDisabledError);
  });

  it('khung bảo trì chiếm lịch: đơn đặt sau đó bị chặn; hủy phiếu thì lịch trả lại', async () => {
    const s = await shop(1);
    const start = new Date(Date.now() + 5 * D), end = new Date(start.getTime() + 6 * H);
    const id = await mkOrder(s, { windowStart: start, windowEnd: end });
    expect(await alloc(id)).toMatchObject([{ status: 'MAINTENANCE' }]);
    const overlap = () => book(s, undefined, new Date(start.getTime() + H), new Date(start.getTime() + 3 * H));
    await expect(overlap()).rejects.toThrow(/không còn|đã được đặt|Không đủ|bảo trì|trống/i);
    await expect(book(s, undefined, new Date(end.getTime() + H), new Date(end.getTime() + 3 * H))).resolves.toBeDefined(); // ngoài khung thì đặt được
    await as(s.A, {}, (c) => cancelOrder(c, id, 'Đổi kế hoạch'));
    expect(await alloc(id)).toMatchObject([{ status: 'RELEASED' }]);
    await expect(overlap()).resolves.toBeDefined();
  });

  it('khung bảo trì trùng đơn đã đặt thì bị từ chối và nêu mã đơn; không để lại phiếu', async () => {
    const s = await shop(1);
    const start = new Date(Date.now() + 5 * D);
    const bid = await book(s, undefined, start, new Date(start.getTime() + 2 * D));
    const code = (await t.admin.query('SELECT code FROM booking WHERE id=$1', [bid])).rows[0].code;
    await expect(as(s.A, {}, async (c) => {
      try { return await createOrder(c, { unitId: s.units[0]!.id, kind: 'PERIODIC', title: 'Bảo trì', windowStart: new Date(start.getTime() + H), windowEnd: new Date(start.getTime() + 5 * H) }); }
      finally { /* giao dịch bị hủy khi lỗi */ }
    })).rejects.toThrow(new RegExp(`trùng lịch của đơn ${code}`));
    expect((await t.admin.query('SELECT count(*)::int n FROM work_order WHERE tenant_id=$1', [s.A])).rows[0].n).toBe(0);
    expect((await t.admin.query("SELECT count(*)::int n FROM unit_allocation WHERE tenant_id=$1 AND status='MAINTENANCE'", [s.A])).rows[0].n).toBe(0);
  });

  it('hai phiếu cùng khung trên một chiếc: chỉ một phiếu được chiếm lịch', async () => {
    const s = await shop(1);
    const start = new Date(Date.now() + 9 * D), end = new Date(start.getTime() + 4 * H);
    const res = await Promise.allSettled([1, 2, 3].map(() => mkOrder(s, { windowStart: start, windowEnd: end })));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of res) if (r.status === 'rejected') expect(String(r.reason.message)).toMatch(/trùng lịch/);
  });
});

describe('vòng đời phiếu', () => {
  it('chờ → đang làm → hoàn thành: chiếc sang Bảo trì rồi trở lại Rảnh, ghi nhật ký trạng thái', async () => {
    const s = await shop();
    const u = s.units[0]!.id;
    const id = await mkOrder(s, { checklist: ['Vệ sinh', 'Kiểm tra'] });
    expect((await as(s.A, {}, (c) => startOrder(c, id))).warnings).toEqual([]);
    expect(await status(u)).toBe('MAINTENANCE');
    expect((await orderOf(id)).status).toBe('IN_PROGRESS');
    await expect(as(s.A, {}, (c) => startOrder(c, id))).rejects.toThrow(InvalidOrderTransitionError);
    await expect(as(s.A, {}, (c) => finishOrder(c, id))).rejects.toThrow(/Còn 2 mục checklist chưa xong: Vệ sinh; Kiểm tra/);
    await as(s.A, { role: 'TECHNICIAN' }, (c) => toggleChecklist(c, id, 0, true));
    await as(s.A, {}, (c) => toggleChecklist(c, id, 1, true));
    await expect(as(s.A, {}, (c) => toggleChecklist(c, id, 5, true))).rejects.toThrow(/không tồn tại/);
    await as(s.A, {}, (c) => finishOrder(c, id));
    expect(await status(u)).toBe('AVAILABLE');
    const o = await orderOf(id);
    expect(o.status).toBe('DONE');
    expect(o.finished_at).not.toBeNull();
    const log = (await t.admin.query('SELECT to_status FROM unit_status_log WHERE unit_id=$1 ORDER BY id', [u])).rows.map((r) => r.to_status);
    expect(log.slice(-2)).toEqual(['MAINTENANCE', 'AVAILABLE']);
    await expect(as(s.A, {}, (c) => updateOrder(c, id, { title: 'x' }))).rejects.toThrow(/đang chờ hoặc đang làm/);
    await expect(as(s.A, {}, (c) => cancelOrder(c, id, 'x'))).rejects.toThrow(InvalidOrderTransitionError);
  });

  it('bỏ qua checklist phải ghi lý do; chiếc còn phiếu khác đang làm thì chưa trả về Rảnh', async () => {
    const s = await shop();
    const u = s.units[0]!.id;
    const a = await mkOrder(s, { checklist: ['Việc A'] });
    const b = await mkOrder(s, { title: 'Phiếu thứ hai' });
    await as(s.A, {}, (c) => startOrder(c, a));
    await as(s.A, {}, (c) => startOrder(c, b));
    await as(s.A, {}, (c) => finishOrder(c, a, { note: 'Việc A không áp dụng với máy này' }));
    expect((await orderOf(a)).close_note).toMatch(/không áp dụng/);
    expect(await status(u)).toBe('MAINTENANCE'); // phiếu b còn đang làm
    await as(s.A, {}, (c) => finishOrder(c, b));
    expect(await status(u)).toBe('AVAILABLE');
  });

  it('không bắt đầu được khi chiếc đang cho thuê; cảnh báo khi chiếc có đơn sắp tới', async () => {
    const s = await shop();
    const u = s.units[0]!.id;
    const id = await mkOrder(s);
    await t.admin.query("UPDATE equipment_unit SET status='RENTED' WHERE id=$1", [u]);
    await expect(as(s.A, {}, (c) => startOrder(c, id))).rejects.toThrow(/đang cho thuê hoặc đang được giao/);
    await t.admin.query("UPDATE equipment_unit SET status='AVAILABLE' WHERE id=$1", [u]);
    const start = new Date(Date.now() + 3 * D);
    const bid = await book(s, u, start, new Date(start.getTime() + D));
    const code = (await t.admin.query('SELECT code FROM booking WHERE id=$1', [bid])).rows[0].code;
    const r = await as(s.A, {}, (c) => startOrder(c, id));
    expect(r.warnings[0]).toContain(code);
    expect((await as(s.A, {}, (c) => getOrder(c, id))).conflicts.map((x) => x.code)).toEqual([code]);
  });

  it('không sửa được → thanh lý: chiếc thành "Đã thanh lý"; chặn nếu còn trong đơn sắp tới', async () => {
    const s = await shop();
    const u = s.units[0]!.id;
    const id = await mkOrder(s);
    await expect(as(s.A, {}, (c) => markUnrepairable(c, id, 'x'))).rejects.toThrow(InvalidOrderTransitionError); // chưa bắt đầu
    const start = new Date(Date.now() + 3 * D);
    const bid = await book(s, u, start, new Date(start.getTime() + D)); // đơn sắp tới đã đặt trước khi chiếc hỏng
    await as(s.A, {}, (c) => startOrder(c, id));
    await expect(as(s.A, {}, (c) => markUnrepairable(c, id, ' '))).rejects.toThrow(/lý do/);
    await as(s.A, {}, (c) => markUnrepairable(c, id, 'Vỡ bo mạch, hết linh kiện'));
    expect(await status(u)).toBe('MAINTENANCE');
    await expect(as(s.A, {}, (c) => disposeOrder(c, id, 'Thanh lý'))).rejects.toThrow(/còn trong đơn/);
    await as(s.A, {}, (c) => cancelBooking(c, bid, 'Đổi thiết bị'));
    await expect(as(s.A, { role: 'STAFF' }, (c) => disposeOrder(c, id, 'x'))).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, {}, (c) => disposeOrder(c, id, ' '))).rejects.toThrow(/lý do/);
    await as(s.A, {}, (c) => disposeOrder(c, id, 'Hết khấu hao'));
    expect(await status(u)).toBe('RETIRED');
    expect((await orderOf(id)).status).toBe('DISPOSED');
  });

  it('chi phí tính lại ở server; linh kiện và tiền sai bị từ chối; chỉ sửa phiếu còn mở', async () => {
    const s = await shop();
    const id = await mkOrder(s);
    await as(s.A, {}, (c) => updateOrder(c, id, { parts: [{ name: 'Màn hình', qty: 1, unitCost: 1_500_000 }, { name: 'Ốc', qty: 4, unitCost: 5000 }], laborCost: 200_000, vendor: 'Tiệm Sửa Máy', vendorCost: 100_000 }));
    expect(Number((await orderOf(id)).cost_total)).toBe(1_820_000);
    await as(s.A, {}, (c) => updateOrder(c, id, { laborCost: 0 }));
    expect(Number((await orderOf(id)).cost_total)).toBe(1_620_000);
    await expect(as(s.A, {}, (c) => updateOrder(c, id, { parts: [{ name: 'A', qty: 0, unitCost: 1 }] }))).rejects.toThrow(/số lượng/);
    await expect(as(s.A, {}, (c) => updateOrder(c, id, { laborCost: -5 }))).rejects.toThrow(/không âm/);
    await expect(as(s.A, {}, (c) => updateOrder(c, id, { laborCost: 1.5 }))).rejects.toThrow(/không âm/);
    await expect(as(s.A, {}, (c) => updateOrder(c, id, { title: ' ' }))).rejects.toThrow(/Tiêu đề/);
    const tech = (await as(s.A, {}, (c) => listTechnicians(c)))[0]!;
    await as(s.A, {}, (c) => updateOrder(c, id, { technicianId: tech.id, dueDate: '2027-05-01' }));
    expect(await as(s.A, {}, (c) => getOrder(c, id))).toMatchObject({ technicianId: tech.id, dueDate: '2027-05-01', costTotal: 1_620_000 });
  });

  it('ảnh trước/sau: lưu riêng tư, đúng định dạng, tối đa 10; thất bại không để lại file', async () => {
    const s = await shop();
    const id = await mkOrder(s);
    const st = new MemoryStorage();
    await as(s.A, { storage: st }, (c) => addOrderPhotos(c, id, 'before', [{ data: PNG }, { data: JPG }]));
    await as(s.A, { storage: st }, (c) => addOrderPhotos(c, id, 'after', [{ data: PNG }]));
    expect(st.files.size).toBe(3);
    await expect(as(s.A, { storage: st }, (c) => addOrderPhotos(c, id, 'after', [{ data: GIF }]))).rejects.toThrow(/JPG, PNG/);
    await expect(as(s.A, { storage: st }, (c) => addOrderPhotos(c, id, 'before', Array(9).fill({ data: PNG })))).rejects.toThrow(/tối đa 10/);
    await expect(as(s.A, { storage: st }, (c) => addOrderPhotos(c, id, 'before', []))).rejects.toThrow(/Chưa chọn ảnh/);
    expect(st.files.size).toBe(3);
    const p = await as(s.A, { storage: st, role: 'STAFF' }, (c) => getOrderPhoto(c, id, 'before', 1));
    expect(p.contentType).toBe('image/jpeg');
    await expect(as(s.A, { storage: st }, (c) => getOrderPhoto(c, id, 'after', 4))).rejects.toThrow(/Không tìm thấy/);
    const o = await as(s.A, {}, (c) => getOrder(c, id));
    expect([o.photosBefore, o.photosAfter]).toEqual([2, 1]);
    expect((await t.admin.query('SELECT photos_before p FROM work_order WHERE id=$1', [id])).rows[0].p[0]).toMatch(new RegExp(`^tenants/${s.A}/maint/`));
  });

  it('danh sách / bộ lọc / tóm tắt / quét mã', async () => {
    const s = await shop();
    const tech = (await as(s.A, {}, (c) => listTechnicians(c)))[0]!;
    const a = await mkOrder(s, { title: 'A', technicianId: tech.id, dueDate: '2020-01-01' });
    const b = await mkOrder(s, { unitId: s.units[1]!.id, title: 'B' });
    await as(s.A, {}, (c) => startOrder(c, b));
    expect((await as(s.A, {}, (c) => listOrders(c, { status: 'OPEN' }))).map((o) => o.id)).toEqual([b, a]); // đang làm đứng trước
    expect((await as(s.A, {}, (c) => listOrders(c, { technicianId: tech.id }))).map((o) => o.id)).toEqual([a]);
    expect((await as(s.A, {}, (c) => listOrders(c, { overdue: true }))).map((o) => o.id)).toEqual([a]);
    expect((await as(s.A, {}, (c) => listOrders(c, { status: 'DONE' })))).toEqual([]);
    expect(await as(s.A, {}, (c) => maintenanceSummary(c))).toMatchObject({ pending: 1, inProgress: 1, overdue: 1, unrepairable: 0 });
    const barcode = (await t.admin.query('SELECT barcode FROM equipment_unit WHERE id=$1', [s.units[0]!.id])).rows[0].barcode;
    expect(await as(s.A, {}, (c) => lookupForMaintenance(c, barcode.toLowerCase()))).toMatchObject({ unitId: s.units[0]!.id, openOrderId: a });
    expect(await as(s.A, {}, (c) => lookupForMaintenance(c, 'KHONG-CO'))).toBeNull();
    const B = await shop();
    expect(await as(B.A, {}, (c) => listOrders(c))).toEqual([]);
    await expect(as(B.A, {}, (c) => getOrder(c, a))).rejects.toThrow(/Không tìm thấy/);
    await expect(as(B.A, {}, (c) => startOrder(c, a))).rejects.toThrow(/Không tìm thấy/);
  });
});

describe('phiếu từ biên bản nhận hư hỏng', () => {
  it('nhận thiết bị hư hỏng tự tạo phiếu sửa chữa gắn đơn, báo quản lý; chuyển chi phí cho khách thành khoản phí', async () => {
    const s = await shop();
    const u = s.units[0]!.id;
    const { id: bid } = await rental(s, u, { damaged: 'Vỡ ống kính' });
    const o = (await t.admin.query("SELECT * FROM work_order WHERE booking_id=$1", [bid])).rows[0];
    expect(o).toMatchObject({ kind: 'REPAIR', source: 'DAMAGE', status: 'PENDING', unit_id: u, description: 'Vỡ ống kính' });
    expect(await status(u)).toBe('MAINTENANCE');
    const inbox = await as(s.A, { role: 'MANAGER', userId: '00000000-0000-0000-0000-0000000000aa' }, (c) => listInbox(c));
    expect(inbox.items.map((i) => i.title)).toEqual(expect.arrayContaining([expect.stringMatching(/hư hỏng khi trả/)]));
    // kỹ thuật viên làm việc rồi nhập chi phí
    await as(s.A, { role: 'TECHNICIAN' }, (c) => startOrder(c, o.id));
    await as(s.A, { role: 'TECHNICIAN' }, (c) => updateOrder(c, o.id, { parts: [{ name: 'Ống kính', qty: 1, unitCost: 800_000 }], laborCost: 150_000 }));
    await expect(as(s.A, { role: 'TECHNICIAN' }, (c) => chargeCustomer(c, o.id))).rejects.toThrow(ForbiddenError); // kỹ thuật viên không thấy tiền
    const fee = await as(s.A, { role: 'STAFF' }, (c) => chargeCustomer(c, o.id));
    const l = await as(s.A, {}, (c) => bookingLedger(c, bid));
    expect(l.fees.find((f) => f.id === fee)).toMatchObject({ kind: 'DAMAGE', amount: 950_000, unitId: u });
    expect((await orderOf(o.id)).charged_fee_id).toBe(fee);
    await expect(as(s.A, {}, (c) => chargeCustomer(c, o.id))).rejects.toThrow(/đã được tính phí/);
    await as(s.A, {}, (c) => finishOrder(c, o.id));
    expect(await status(u)).toBe('AVAILABLE');
  });

  it('phiếu không gắn đơn / chưa có chi phí thì không tính cho khách; gói không có bảo trì thì không tạo phiếu', async () => {
    const s = await shop();
    const manual = await mkOrder(s);
    await expect(as(s.A, {}, (c) => chargeCustomer(c, manual))).rejects.toThrow(/không gắn với đơn thuê/);
    const { id: bid } = await rental(s, s.units[1]!.id, { damaged: 'Trầy thân máy' });
    const o = (await t.admin.query('SELECT id FROM work_order WHERE booking_id=$1', [bid])).rows[0].id;
    await expect(as(s.A, {}, (c) => chargeCustomer(c, o))).rejects.toThrow(/Chưa có chi phí/);
    expect(await as(s.A, {}, (c) => chargeCustomer(c, o, { amount: 300_000, description: 'Phí trầy xước' }))).toBeDefined();
    // phí bị hủy thì tính lại được
    const feeId = (await orderOf(o)).charged_fee_id;
    await t.admin.query("UPDATE booking_fee SET voided_at=now(), void_reason='sai', voided_by=NULL WHERE id=$1", [feeId]);
    await expect(as(s.A, {}, (c) => chargeCustomer(c, o, { amount: 250_000 }))).resolves.toBeDefined();

    const s2 = await shop();
    const start = new Date(Date.now() - 20 * D), end = new Date(start.getTime() + 2 * D);
    const id = await book(s2, s2.units[0]!.id, start, end);
    await as(s2.A, {}, (c) => deliverBooking(c, id, { items: [{ unitId: s2.units[0]!.id, condition: 'GOOD' }] }));
    await t.admin.query('UPDATE booking SET delivered_at = starts_at WHERE id=$1', [id]);
    await as(s2.A, { off: ['maintenance'] }, (c) => receiveBooking(c, id, { returnedAt: end, items: [{ unitId: s2.units[0]!.id, condition: 'DAMAGED', notes: 'Hỏng' }] }));
    expect((await t.admin.query('SELECT count(*)::int n FROM work_order WHERE tenant_id=$1', [s2.A])).rows[0].n).toBe(0);
    expect(await status(s2.units[0]!.id)).toBe('MAINTENANCE'); // việc nhận hàng vẫn như cũ
  });
});

describe('quét bảo trì định kỳ', () => {
  const plan = (s: Shop, o: Record<string, unknown> = {}, opts: Opts = {}) => as(s.A, opts, (c) => createMaintenancePlan(c, { name: 'Bảo trì thân máy', modelId: s.cam, checklist: ['Vệ sinh', 'Kiểm tra'], ...o }));
  const scan = (s: Shop, now = new Date(), opts: Opts = {}) => as(s.A, opts, (c) => scanMaintenance(c, now));

  it('đến hạn theo ngày: tạo phiếu chờ có checklist, xếp khung 08:00 ngày kế tiếp; quét lại không tạo trùng', async () => {
    const s = await shop();
    await t.admin.query("UPDATE equipment_unit SET created_at = now() - interval '100 days' WHERE id=$1", [s.units[0]!.id]);
    await plan(s, { everyDays: 90, durationHours: 3 });
    const now = new Date();
    const r = await scan(s, now);
    expect(r).toMatchObject({ created: 1, scheduled: 1, unscheduled: 0 });
    const o = (await t.admin.query("SELECT * FROM work_order WHERE tenant_id=$1", [s.A])).rows[0];
    expect(o).toMatchObject({ kind: 'PERIODIC', source: 'PLAN', status: 'PENDING', unit_id: s.units[0]!.id });
    expect(o.checklist).toEqual([{ text: 'Vệ sinh', done: false }, { text: 'Kiểm tra', done: false }]);
    expect(o.description).toMatch(/đã (99|100) ngày/);
    const win = findMaintenanceWindow({ from: now, durationHours: 3, busy: [], timeZone: TZ })!;
    expect(o.scheduled_start.toISOString()).toBe(win.start.toISOString());
    expect((await alloc(o.id))[0]).toMatchObject({ status: 'MAINTENANCE' });
    expect(await scan(s, now)).toMatchObject({ created: 0 });
    expect(await scan(s, new Date(now.getTime() + H))).toMatchObject({ created: 0 });
    const inbox = await as(s.A, { role: 'MANAGER', userId: '00000000-0000-0000-0000-0000000000bb' }, (c) => listInbox(c));
    expect(inbox.items.find((i) => /đến hạn bảo trì/.test(i.title))?.body).toMatch(/Đã xếp lịch/);
    // chiếc còn lại chưa tới hạn
    expect((await t.admin.query('SELECT count(*)::int n FROM work_order WHERE tenant_id=$1', [s.A])).rows[0].n).toBe(1);
  });

  it('hoàn thành phiếu thì mốc tính lại từ lúc xong; chưa tới hạn thì không tạo phiếu mới', async () => {
    const s = await shop(1);
    await t.admin.query("UPDATE equipment_unit SET created_at = now() - interval '100 days'");
    await plan(s, { everyDays: 90 });
    await scan(s);
    const id = (await t.admin.query('SELECT id FROM work_order WHERE tenant_id=$1', [s.A])).rows[0].id;
    await as(s.A, {}, (c) => startOrder(c, id));
    await as(s.A, {}, (c) => finishOrder(c, id, { note: 'Bỏ qua checklist' }));
    expect(await scan(s)).toMatchObject({ created: 0 });
    const p = (await as(s.A, {}, (c) => planProgress(c)))[0]!;
    expect(p.usage.daysSince).toBeLessThan(1);
    expect(await scan(s, new Date(Date.now() + 91 * D))).toMatchObject({ created: 1 }); // 90 ngày sau lần bảo trì này lại đến hạn
  });

  it('theo số lượt thuê và số giờ cho thuê, điều kiện nào đến trước; gói không có tính năng theo mức dùng thì bỏ qua', async () => {
    const s = await shop();
    await rental(s, s.units[0]!.id);
    await rental(s, s.units[0]!.id);
    await t.admin.query("UPDATE equipment_unit SET created_at = now() - interval '60 days'");
    await plan(s, { name: 'Theo lượt', everyRentals: 2 });
    await plan(s, { name: 'Theo giờ', everyHours: 90 });
    await plan(s, { name: 'Theo ngày xa', everyDays: 3650 });
    const off = await scan(s, new Date(), { off: ['maintenance.usage_based'] });
    expect(off.created).toBe(0); // 2 lượt / 96 giờ nhưng gói không cho tính theo mức dùng
    const r = await scan(s);
    expect(r.created).toBe(2);
    const titles = (await t.admin.query('SELECT title, description FROM work_order WHERE tenant_id=$1 ORDER BY title', [s.A])).rows;
    expect(titles.map((x) => x.title)).toEqual([`Theo giờ — ${(await t.admin.query('SELECT barcode FROM equipment_unit WHERE id=$1', [s.units[0]!.id])).rows[0].barcode}`, expect.stringContaining('Theo lượt')]);
    expect(titles[0].description).toMatch(/96 giờ/);
    expect(titles[1].description).toMatch(/2 lượt thuê/);
  });

  it('kế hoạch riêng cho một chiếc, kế hoạch đã tắt, thiết bị đã thanh lý: chỉ đúng đối tượng', async () => {
    const s = await shop(3);
    await t.admin.query("UPDATE equipment_unit SET created_at = now() - interval '200 days'");
    await t.admin.query("UPDATE equipment_unit SET status='RETIRED' WHERE id=$1", [s.units[2]!.id]);
    const only = await plan(s, { name: 'Riêng chiếc 2', everyDays: 30, unitId: s.units[1]!.id });
    const off = await plan(s, { name: 'Đã tắt', everyDays: 30 });
    await as(s.A, {}, (c) => setMaintenancePlanActive(c, off, false));
    expect(await scan(s)).toMatchObject({ created: 1 });
    const rows = (await t.admin.query('SELECT unit_id, plan_id FROM work_order WHERE tenant_id=$1', [s.A])).rows;
    expect(rows).toEqual([{ unit_id: s.units[1]!.id, plan_id: only }]);
  });

  it('lịch kín: vẫn tạo phiếu nhưng chưa xếp khung và cảnh báo quản lý; tránh các khung đã bận', async () => {
    const s = await shop(1);
    await t.admin.query("UPDATE equipment_unit SET created_at = now() - interval '100 days'");
    await plan(s, { everyDays: 30, durationHours: 4 });
    const now = new Date();
    const first = findMaintenanceWindow({ from: now, durationHours: 4, busy: [], timeZone: TZ })!;
    // bận đúng khung đầu tiên → phiếu phải dời sang khung sau
    await book(s, undefined, new Date(first.start.getTime() - H), new Date(first.start.getTime() + 2 * H));
    const r1 = await scan(s, now);
    expect(r1).toMatchObject({ created: 1, scheduled: 1 });
    const o = (await t.admin.query('SELECT * FROM work_order WHERE tenant_id=$1', [s.A])).rows[0];
    expect(o.scheduled_start.getTime()).toBeGreaterThan(first.start.getTime());
    // lịch kín 20 ngày → không xếp được
    const s2 = await shop(1);
    await t.admin.query("UPDATE equipment_unit SET created_at = now() - interval '100 days'");
    await plan(s2, { everyDays: 30 });
    await book(s2, undefined, new Date(now.getTime() + H), new Date(now.getTime() + 20 * D));
    const r2 = await scan(s2, now);
    expect(r2).toMatchObject({ created: 1, scheduled: 0, unscheduled: 1 });
    const o2 = (await t.admin.query('SELECT id, scheduled_start FROM work_order WHERE tenant_id=$1', [s2.A])).rows[0];
    expect(o2.scheduled_start).toBeNull();
    expect((await as(s2.A, { role: 'MANAGER', userId: '00000000-0000-0000-0000-0000000000cc' }, (c) => listInbox(c))).items.find((i) => /đến hạn bảo trì/.test(i.title))?.body).toMatch(/CHƯA xếp được lịch/);
    // sắp xếp thủ công sau đó
    const later = new Date(now.getTime() + 25 * D);
    await as(s2.A, {}, (c) => cancelOrder(c, o2.id, 'Sẽ tạo lại thủ công'));
    await expect(as(s2.A, {}, (c) => createOrder(c, { unitId: s2.units[0]!.id, kind: 'PERIODIC', title: 'Thủ công', windowStart: later, windowEnd: new Date(later.getTime() + 4 * H) }))).resolves.toBeDefined();
  });

  it('cảnh báo phiếu quá hạn đúng một lần; hai lần quét đồng thời chỉ tạo một phiếu', async () => {
    const s = await shop(1);
    await t.admin.query("UPDATE equipment_unit SET created_at = now() - interval '100 days'");
    await plan(s, { everyDays: 30 });
    const stale = await mkOrder(s, { title: 'Quá hạn', dueDate: '2020-01-01' });
    const res = await Promise.all([1, 2, 3].map(() => scan(s)));
    expect(res.reduce((a, r) => a + r.created, 0)).toBe(1);
    expect(res.reduce((a, r) => a + r.overdueAlerts, 0)).toBe(1);
    expect(await scan(s)).toMatchObject({ overdueAlerts: 0 });
    expect((await t.admin.query("SELECT count(*)::int n FROM app_notification WHERE tenant_id=$1 AND dedupe_key=$2", [s.A, `maint:overdue:${stale}`])).rows[0].n).toBe(1);
    expect((await t.admin.query("SELECT count(*)::int n FROM work_order WHERE tenant_id=$1 AND source='PLAN'", [s.A])).rows[0].n).toBe(1);
  });

  it('quyền và gói: nhân viên quầy không quét được, gói không có bảo trì thì bị chặn', async () => {
    const s = await shop();
    await expect(scan(s, new Date(), { role: 'STAFF' })).rejects.toThrow(ForbiddenError);
    await expect(scan(s, new Date(), { off: ['maintenance'] })).rejects.toThrow(FeatureDisabledError);
    await expect(scan(s, new Date(), { status: 'READ_ONLY' })).rejects.toThrow(ReadOnlyError);
  });

  it('worker: bước bảo trì chạy trong vòng tác vụ nền, ghi nhật ký, và bỏ qua nếu vừa quét xong', async () => {
    const s = await shop(1);
    await t.admin.query("UPDATE equipment_unit SET created_at = now() - interval '100 days'");
    await plan(s, { everyDays: 30 });
    const tn = (await listRunnableTenants(t.platform)).find((x) => x.id === s.A)!;
    const deps = { appPool: t.app, adminPool: t.platform, notify: { build: (c: { channel: 'sms' | 'email' | 'zalo' }) => new ConsoleProvider(c.channel) } };
    const r1 = await runTenantJobs(deps as never, tn, new Date());
    expect(r1.errors).toEqual([]);
    expect(r1.maintenance).toMatchObject({ created: 1 });
    expect((await t.admin.query("SELECT ok FROM job_run WHERE tenant_id=$1 AND name='maintenance.scan'", [s.A])).rows).toEqual([{ ok: true }]);
    const r2 = await runTenantJobs(deps as never, tn, new Date());
    expect(r2.maintenance).toBeNull(); // 6 giờ qua đã quét
  });

  it('ràng buộc DB: lịch bảo trì phải thuộc phiếu, một phiếu mở cho mỗi (chiếc, kế hoạch)', async () => {
    const s = await shop(1);
    const pid = await plan(s, { everyDays: 30 });
    await expect(t.admin.query(`INSERT INTO unit_allocation(tenant_id,unit_id,period,status) VALUES ($1,$2,tstzrange(now(), now()+interval '1 hour','[)'),'MAINTENANCE')`, [s.A, s.units[0]!.id])).rejects.toThrow(/unit_allocation_owner/);
    await t.admin.query(`INSERT INTO work_order(tenant_id,code,unit_id,kind,source,plan_id,title) VALUES ($1,'X-1',$2,'PERIODIC','PLAN',$3,'a')`, [s.A, s.units[0]!.id, pid]);
    await expect(t.admin.query(`INSERT INTO work_order(tenant_id,code,unit_id,kind,source,plan_id,title) VALUES ($1,'X-2',$2,'PERIODIC','PLAN',$3,'b')`, [s.A, s.units[0]!.id, pid])).rejects.toThrow(/work_order_one_open_per_plan/);
    await expect(t.admin.query(`INSERT INTO work_order(tenant_id,code,unit_id,kind,source,title) VALUES ($1,'X-3',$2,'REPAIR','PLAN','c')`, [s.A, s.units[0]!.id])).rejects.toThrow(/work_order_plan_source/);
    await expect(t.admin.query(`UPDATE work_order SET status='DONE' WHERE code='X-1'`)).rejects.toThrow(/work_order_done_has_time/);
  });
});
