import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestDb, type TestDb } from './helpers';
import { mkTenant, runAs, type Opts } from './ctx';
import {
  addDepositAsset, addFee, cancelBooking, createBooking, createCustomer, createModel, createOrder, createUnits, deliverBooking, ensureDefaultPriceList, finishOrder, listReports, receiveBooking,
  recordPayment, registerReport, reportDef, runReport, setRule, startOrder, updateFinanceSettings, updateOrder, voidFee,
} from '../src';
import { ForbiddenError, ReportFilterError, localDateKey, reportToXlsx, resolveRange, type ReportResult } from '@rentpro/core';
import { FEATURE_KEYS, FeatureDisabledError } from '@rentpro/tenancy';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb(54339);
  await t.admin.query("INSERT INTO plan(code,name,features,limits) VALUES ('full','Full',$1,'{}')", [JSON.stringify(Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])))]);
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);
const D = 86_400_000;
const H = 3_600_000;
const TZ = 'Asia/Ho_Chi_Minh';
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * D);
const FILTER = { from: localDateKey(ago(40), TZ), to: localDateKey(NOW, TZ) };
const RANGE = resolveRange(FILTER, TZ, NOW);
const find = (r: ReportResult, title: string) => r.sections.find((s) => s.title === title)!;
const card = (r: ReportResult, label: string) => r.cards!.find((c) => c.label === label)!.value;

interface World { A: string; cam: string; units: string[]; custA: string; custB: string; staffId: string; branch: string; ids: Record<string, string>; orderId: string }
let W: World;

async function rental(A: string, p: { unit: string; cust: string; startAgo: number; days: number; model: string; deliver: boolean; returnAfterH?: number; createdBy?: string }) {
  const start = ago(p.startAgo), end = new Date(start.getTime() + p.days * D);
  const { id } = await as(A, {}, (c) => createBooking(c, { customerId: p.cust, lines: [{ modelId: p.model, qty: 1, unitId: p.unit }], start, end, status: 'CONFIRMED' }));
  if (p.createdBy) await t.admin.query('UPDATE booking SET created_by=$2 WHERE id=$1', [id, p.createdBy]);
  if (!p.deliver) return id;
  await as(A, {}, (c) => deliverBooking(c, id, { items: [{ unitId: p.unit, condition: 'GOOD' }] }));
  await t.admin.query('UPDATE booking SET delivered_at = starts_at WHERE id=$1', [id]);
  if (p.returnAfterH !== undefined)
    await as(A, {}, (c) => receiveBooking(c, id, { returnedAt: new Date(end.getTime() + p.returnAfterH! * H), items: [{ unitId: p.unit, condition: 'GOOD' }] }));
  return id;
}

beforeAll(async () => {
  const A = await mkTenant(t, 'full');
  const cam = await as(A, {}, (c) => createModel(c, { name: 'Sony A7', barcodePrefix: 'CAM' }));
  await t.admin.query('UPDATE equipment_model SET buffer_minutes = 0 WHERE id=$1', [cam]);
  const units = (await as(A, {}, (c) => createUnits(c, { modelId: cam, quantity: 3 }))).map((u) => u.id);
  const list = await as(A, {}, (c) => ensureDefaultPriceList(c));
  await as(A, {}, (c) => setRule(c, list, cam, { hour: 100_000, day: 500_000, week: 2_500_000, month: null, minHours: 0 }));
  const custA = await as(A, {}, (c) => createCustomer(c, { name: 'Khách A', phone: '0901000001' }));
  const custB = await as(A, {}, (c) => createCustomer(c, { name: 'Khách B', phone: '0901000002' }));
  await as(A, {}, (c) => updateFinanceSettings(c, { handover: { requireContract: false, requireDeposit: false } }));
  const staffId = (await t.admin.query("INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,'a@x.vn','Nhân viên A','x','STAFF') RETURNING id", [A])).rows[0].id as string;
  const branch = (await t.admin.query("INSERT INTO branch(tenant_id,name) VALUES ($1,'Chi nhánh Q1') RETURNING id", [A])).rows[0].id as string;
  await t.admin.query("UPDATE equipment_unit SET created_at = now() - interval '100 days' WHERE tenant_id=$1", [A]);
  await t.admin.query('UPDATE equipment_unit SET purchase_price = 20000000 WHERE id=$1', [units[0]]);
  await t.admin.query('UPDATE equipment_unit SET branch_id = $2 WHERE id=$1', [units[2], branch]);

  const ids: Record<string, string> = {};
  ids.b1 = await rental(A, { unit: units[0]!, cust: custA, startAgo: 30, days: 2, model: cam, deliver: true, returnAfterH: 0, createdBy: staffId }); // 1.000.000
  ids.b2 = await rental(A, { unit: units[0]!, cust: custA, startAgo: 20, days: 1, model: cam, deliver: true, returnAfterH: 3, createdBy: staffId }); // 500.000, trả trễ 3 giờ
  ids.b3 = await rental(A, { unit: units[1]!, cust: custB, startAgo: 10, days: 1, model: cam, deliver: false });
  await as(A, {}, (c) => cancelBooking(c, ids.b3!, 'Khách hủy')); // không tính
  ids.b4 = await rental(A, { unit: units[1]!, cust: custA, startAgo: 5, days: 2, model: cam, deliver: true }); // đang thuê, đã quá hạn 3 ngày; 1.000.000
  ids.b5 = await rental(A, { unit: units[2]!, cust: custB, startAgo: 15, days: 1, model: cam, deliver: true, returnAfterH: 0 }); // 500.000 chưa thanh toán
  // phí, thanh toán, cọc, tài sản
  await as(A, {}, (c) => addFee(c, ids.b2!, { kind: 'DAMAGE', description: 'Trầy máy', amount: 300_000, unitId: units[0]! }));
  const voided = await as(A, {}, (c) => addFee(c, ids.b2!, { kind: 'OTHER', description: 'Nhập nhầm', amount: 999_000 }));
  await as(A, {}, (c) => voidFee(c, voided, 'Nhập nhầm'));
  const pay = (b: string, kind: 'RENT' | 'FEE' | 'DEPOSIT', amount: number) => as(A, {}, (c) => recordPayment(c, { bookingId: b, kind, method: 'CASH', amount }));
  await pay(ids.b1!, 'RENT', 1_000_000);
  await pay(ids.b2!, 'RENT', 500_000);
  await pay(ids.b2!, 'FEE', 300_000);
  await pay(ids.b4!, 'DEPOSIT', 300_000);
  await t.admin.query("UPDATE payment SET paid_at = $2 WHERE booking_id=$1 AND kind='RENT'", [ids.b1, ago(29)]);
  await t.admin.query("UPDATE payment SET paid_at = $2 WHERE booking_id=$1 AND kind='RENT'", [ids.b2, ago(19)]);
  await as(A, {}, (c) => addDepositAsset(c, ids.b4!, { description: 'CCCD gốc', estimatedValue: 50_000 }));
  // bảo trì: một phiếu xong có chi phí, một phiếu quá hạn
  const wo = await as(A, {}, (c) => createOrder(c, { unitId: units[0]!, kind: 'REPAIR', title: 'Thay ngàm', dueDate: '2099-01-01' }));
  await as(A, {}, (c) => startOrder(c, wo));
  await as(A, {}, (c) => updateOrder(c, wo, { parts: [{ name: 'Ngàm', qty: 1, unitCost: 200_000 }], laborCost: 50_000 }));
  await as(A, {}, (c) => finishOrder(c, wo));
  await as(A, {}, (c) => createOrder(c, { unitId: units[2]!, kind: 'INSPECTION', title: 'Kiểm tra quá hạn', dueDate: '2020-01-01' }));
  W = { A, cam, units, custA, custB, staffId, branch, ids, orderId: wo };
}, 120_000);

const run = (key: string, f: Record<string, unknown> = {}, o: Opts = {}) => as(W.A, o, (c) => runReport(c, key, f as never, NOW));

describe('doanh thu', () => {
  it('theo ngày: tổng ghi nhận = tiền thuê đơn đã giao + phí còn hiệu lực; đơn hủy và phí đã hủy không tính', async () => {
    const r = await run('revenue', { ...FILTER, groupBy: 'day' });
    const s = find(r, 'Doanh thu ghi nhận');
    expect(s.totals).toMatchObject({ bookings: 4, rent: 3_000_000, fee_DAMAGE: 300_000, fee_OTHER: 0, total: 3_300_000 });
    expect(s.rows).toHaveLength(RANGE.days); // mốc liên tục, kể cả ngày không có đơn
    const day = s.rows.find((x) => x.g === localDateKey(ago(30), TZ).split('-').reverse().join('/'))!;
    expect(day).toMatchObject({ bookings: 1, rent: 1_000_000, total: 1_000_000 });
    expect(card(r, 'Doanh thu ghi nhận')).toBe(3_300_000);
    expect(card(r, 'Số đơn')).toBe(4);
  });

  it('thực thu: dòng tiền theo loại khoản trong kỳ; xóa nợ không phải tiền thu', async () => {
    const r = await run('revenue', { ...FILTER, groupBy: 'month' });
    const s = find(r, 'Thực thu (dòng tiền)');
    expect(s.totals).toMatchObject({ RENT: 1_500_000, FEE: 300_000, DEPOSIT: 300_000, REFUND: 0, net: 2_100_000 });
    expect(card(r, 'Tiền ròng thu về')).toBe(2_100_000);
    // ngoài kỳ thì không tính
    const old = await run('revenue', { from: localDateKey(ago(25), TZ), to: localDateKey(ago(22), TZ) });
    expect(find(old, 'Thực thu (dòng tiền)').totals).toMatchObject({ RENT: 0, net: 0 });
    expect(find(old, 'Doanh thu ghi nhận').totals).toMatchObject({ bookings: 0, total: 0 });
  });

  it('theo tháng gộp đúng; theo mẫu / danh mục / chi nhánh / nhân viên chia tiền thuê theo dòng đơn', async () => {
    const m = find(await run('revenue', { ...FILTER, groupBy: 'month' }), 'Doanh thu ghi nhận');
    expect(m.totals!.total).toBe(3_300_000);
    expect(m.rows.reduce((a, x) => a + Number(x.total), 0)).toBe(3_300_000);
    const model = find(await run('revenue', { ...FILTER, groupBy: 'model' }), 'Doanh thu ghi nhận');
    expect(model.rows.find((x) => x.g === 'Sony A7')).toMatchObject({ bookings: 4, rent: 3_000_000, fee_DAMAGE: 300_000 });
    expect(model.rows.find((x) => x.g === '(Phí không gắn thiết bị)')).toBeUndefined(); // phí còn lại đã hủy
    const cat = find(await run('revenue', { ...FILTER, groupBy: 'category' }), 'Doanh thu ghi nhận');
    expect(cat.rows.map((x) => x.g)).toEqual(['(Chưa phân loại)']);
    const br = find(await run('revenue', { ...FILTER, groupBy: 'branch' }), 'Doanh thu ghi nhận');
    expect(br.rows.find((x) => x.g === 'Chi nhánh Q1')).toMatchObject({ rent: 500_000, bookings: 1 });
    expect(br.rows.find((x) => x.g === '(Không rõ chi nhánh)')).toMatchObject({ rent: 2_500_000, bookings: 3 });
    const staff = find(await run('revenue', { ...FILTER, groupBy: 'staff' }), 'Doanh thu ghi nhận');
    expect(staff.rows.find((x) => x.g === 'Nhân viên A')).toMatchObject({ bookings: 2, rent: 1_500_000, fee_DAMAGE: 300_000, total: 1_800_000 });
    expect(staff.rows.find((x) => x.g === '(Không rõ)')).toMatchObject({ bookings: 2, rent: 1_500_000 });
  });

  it('lọc theo chi nhánh giữ các đơn có chiếc thuộc chi nhánh đó', async () => {
    const r = await run('revenue', { ...FILTER, groupBy: 'day', branchId: W.branch });
    expect(find(r, 'Doanh thu ghi nhận').totals).toMatchObject({ bookings: 1, rent: 500_000, total: 500_000 });
    const none = await run('revenue', { ...FILTER, groupBy: 'day', branchId: '00000000-0000-0000-0000-000000000000' });
    expect(find(none, 'Doanh thu ghi nhận').totals).toMatchObject({ bookings: 0, total: 0 });
  });

  it('bộ lọc sai báo lỗi tiếng Việt', async () => {
    await expect(run('revenue', { from: '2027-13-01' })).rejects.toThrow(/Ngày bắt đầu không hợp lệ/);
    await expect(run('revenue', { from: '2027-03-10', to: '2027-03-01' })).rejects.toThrow(ReportFilterError);
    await expect(run('revenue', { branchId: "1'; DROP TABLE booking;--" })).rejects.toThrow(/Chi nhánh không hợp lệ/);
    await expect(run('revenue', { groupBy: 'sql' })).rejects.toThrow(/Cách nhóm không hợp lệ/);
    await expect(run('khong-co')).rejects.toThrow(/Báo cáo không tồn tại/);
  });
});

describe('quá hạn, công nợ, cọc', () => {
  it('đơn quá hạn chưa trả và công nợ theo tuổi nợ', async () => {
    const r = await run('debts');
    const over = find(r, 'Đơn quá hạn chưa trả');
    expect(over.rows).toHaveLength(1);
    expect(over.rows[0]).toMatchObject({ name: 'Khách A' });
    expect(Number(over.rows[0]!.hours)).toBeGreaterThan(60);
    const det = find(r, 'Chi tiết công nợ');
    expect(det.rows).toHaveLength(1);
    expect(det.rows[0]).toMatchObject({ name: 'Khách B', owed: 500_000, bucket: '8–30 ngày' });
    expect(find(r, 'Tuổi nợ').rows).toEqual([{ b: '0–7 ngày', count: 0, owed: 0 }, { b: '8–30 ngày', count: 1, owed: 500_000 }, { b: 'Trên 30 ngày', count: 0, owed: 0 }]);
    expect(card(r, 'Tổng công nợ')).toBe(500_000);
    // thu đủ thì hết nợ
    await t.admin.query("INSERT INTO payment(tenant_id,booking_id,kind,method,amount) VALUES ($1,$2,'RENT','CASH',500000)", [W.A, W.ids.b5]);
    expect(card(await run('debts'), 'Tổng công nợ')).toBe(0);
    await t.admin.query("DELETE FROM payment WHERE booking_id=$1", [W.ids.b5]);
  });

  it('tiền cọc và tài sản thế chấp đang giữ', async () => {
    const r = await run('deposits');
    expect(card(r, 'Tiền cọc đang giữ')).toBe(300_000);
    expect(card(r, 'Giá trị tài sản thế chấp')).toBe(50_000);
    expect(card(r, 'Đơn cần quyết toán cọc')).toBe(0);
    expect(r.sections[0]!.rows).toHaveLength(1);
    expect(r.sections[0]!.rows[0]).toMatchObject({ name: 'Khách A', held: 300_000, assets: 'CCCD gốc', av: 50_000, status: 'Đang thuê' });
  });
});

describe('hiệu suất, hoàn vốn, bảo trì, khách hàng, tồn kho', () => {
  it('hiệu suất sử dụng: giờ được thuê / giờ có thể thuê; gợi ý thanh lý cho thiết bị ít thuê', async () => {
    const r = await run('utilization', FILTER);
    const cap = (RANGE.to.getTime() - RANGE.from.getTime()) / H;
    const model = find(r, 'Theo mẫu thiết bị').rows[0]!;
    expect(model).toMatchObject({ name: 'Sony A7', units: 3, rentals: 4 });
    expect(Number(model.busy)).toBe(144); // 72 + 48 + 24 giờ
    expect(Number(model.cap)).toBeCloseTo(cap * 3, 0);
    expect(Number(model.util)).toBeCloseTo(144 / (cap * 3), 3);
    const units = find(r, 'Từng thiết bị (ít được thuê nhất lên đầu)').rows;
    expect(units.map((u) => u.barcode)).toHaveLength(3);
    expect(Number(units[0]!.util)).toBeLessThanOrEqual(Number(units[2]!.util)); // sắp tăng dần
    expect(units.every((u) => String(u.hint).includes('thanh lý'))).toBe(true); // cả ba dưới 10%, thiết bị đã 100 ngày
    expect(card(r, 'Gợi ý thanh lý')).toBe(3);
    const b = await run('utilization', { ...FILTER, branchId: W.branch });
    expect(find(b, 'Theo mẫu thiết bị').rows[0]).toMatchObject({ units: 1, rentals: 1 });
  });

  it('thiết bị mới thêm chỉ tính từ ngày tạo; kỳ không có đơn thì mức sử dụng 0', async () => {
    const r = await run('utilization', { from: localDateKey(ago(2), TZ), to: localDateKey(ago(1), TZ) });
    expect(Number(find(r, 'Theo mẫu thiết bị').rows[0]!.util)).toBe(0);
    await t.admin.query("UPDATE equipment_unit SET created_at = now() - interval '12 hours' WHERE id=$1", [W.units[2]]);
    const r2 = await run('utilization', FILTER);
    const u3 = find(r2, 'Từng thiết bị (ít được thuê nhất lên đầu)').rows.find((u) => u.branch === 'Chi nhánh Q1')!;
    expect(Number(u3.busy)).toBe(0); // đơn B5 từ trước ngày tạo (dữ liệu giả lập) nằm ngoài khoảng tính
    await t.admin.query("UPDATE equipment_unit SET created_at = now() - interval '100 days' WHERE id=$1", [W.units[2]]);
  });

  it('hoàn vốn: doanh thu + phí gắn chiếc − chi phí bảo trì so với giá nhập', async () => {
    const r = await run('roi');
    const rows = r.sections[0]!.rows;
    const u1 = rows.find((x) => x.price === 20_000_000)!;
    expect(u1).toMatchObject({ rev: 1_800_000, cost: 250_000, net: 1_550_000, state: expect.stringContaining('Còn thiếu 18.450.000') });
    expect(Number(u1.roi)).toBeCloseTo(0.0775, 4);
    expect(rows.filter((x) => x.price === null).every((x) => x.roi === null && x.state === 'Chưa có giá nhập')).toBe(true);
    expect(r.sections[0]!.totals).toMatchObject({ rev: 3_300_000, cost: 250_000 });
    expect(card(r, 'Đã hoàn vốn')).toBe(0);
    await t.admin.query('UPDATE equipment_unit SET purchase_price = 1000000 WHERE id=$1', [W.units[0]]);
    expect(card(await run('roi'), 'Đã hoàn vốn')).toBe(1);
    await t.admin.query('UPDATE equipment_unit SET purchase_price = 20000000 WHERE id=$1', [W.units[0]]);
  });

  it('bảo trì: chi phí, lần sửa, thời gian chết, phiếu quá hạn', async () => {
    const r = await run('maintenance', FILTER);
    expect(find(r, 'Theo mẫu thiết bị').rows[0]).toMatchObject({ name: 'Sony A7', orders: 2, repairs: 1, cost: 250_000 });
    expect(card(r, 'Chi phí bảo trì')).toBe(250_000);
    expect(card(r, 'Phiếu quá hạn')).toBe(1);
    expect(find(r, 'Phiếu quá hạn').rows[0]).toMatchObject({ title: 'Kiểm tra quá hạn', due: '01/01/2020' });
    expect(Number(find(r, 'Chi phí theo tháng').rows.reduce((a, x) => a + Number(x.cost), 0))).toBe(250_000);
    expect(Number(card(r, 'Thời gian chết'))).toBeGreaterThanOrEqual(0);
  });

  it('khách hàng: nhiều nhất, khách mới, hay trả trễ', async () => {
    const r = await run('customers');
    const top = find(r, 'Khách thuê nhiều nhất (theo doanh thu)').rows;
    expect(top[0]).toMatchObject({ name: 'Khách A', rentals: 3, revenue: 2_500_000, late: 2 });
    expect(top[1]).toMatchObject({ name: 'Khách B', rentals: 1, revenue: 500_000, late: 0 });
    const risky = find(r, 'Khách hay trả trễ (từ 2 đơn trễ, trễ từ một nửa số đơn)').rows;
    expect(risky.map((x) => x.name)).toEqual(['Khách A']);
    expect(Number(risky[0]!.hours)).toBeGreaterThan(30);
    expect(card(r, 'Khách mới')).toBe(2);
    expect(Number(card(r, 'Tỷ lệ đơn trả trễ'))).toBeCloseTo(2 / 4, 5);
  });

  it('tồn kho: theo danh mục × trạng thái, hàng theo số lượng', async () => {
    const qty = await as(W.A, {}, (c) => createModel(c, { name: 'Cáp HDMI', tracked: false, stockQty: 10 }));
    expect(qty).toBeDefined();
    const r = await run('inventory');
    const s = r.sections[0]!;
    expect(s.totals).toMatchObject({ total: 3, RENTED: 1, AVAILABLE: 2 });
    expect(find(r, 'Hàng theo số lượng').rows[0]).toMatchObject({ name: 'Cáp HDMI', stock: 10, used: 0, free: 10 });
    expect(card(r, 'Tổng số thiết bị')).toBe(3);
  });
});

describe('tổng quan', () => {
  it('thẻ tóm tắt và việc hôm nay; người không có quyền xem tiền không thấy thẻ tiền', async () => {
    const r = await run('dashboard');
    expect(card(r, 'Doanh thu hôm nay')).toBe(300_000); // chỉ phí hư hỏng tạo hôm nay
    expect(card(r, 'Thực thu hôm nay')).toBe(600_000); // phí 300.000 + cọc 300.000
    expect(card(r, 'Đơn đang thuê')).toBe(1);
    expect(card(r, 'Đơn quá hạn')).toBe(1);
    expect(card(r, 'Tiền cọc đang giữ')).toBe(300_000);
    expect(find(r, 'Thiết bị theo trạng thái').totals).toMatchObject({ n: 3 });
    expect(find(r, 'Việc hôm nay: cần nhận thiết bị về (kể cả đã quá hạn)').rows).toHaveLength(1);
    expect(find(r, 'Phiếu bảo trì đến hạn').rows.map((x) => x.title)).toEqual(['Kiểm tra quá hạn']);
    const staff = await run('dashboard', {}, { role: 'STAFF' });
    expect(staff.cards!.map((c) => c.label)).toEqual(['Đơn đang thuê', 'Đơn quá hạn']);
  });
});

describe('quyền, gói, cô lập, đăng ký', () => {
  it('phân quyền theo báo cáo; kỹ thuật viên không xem báo cáo', async () => {
    await expect(run('revenue', {}, { role: 'STAFF' })).rejects.toThrow(ForbiddenError);
    await expect(run('maintenance', {}, { role: 'STAFF' })).rejects.toThrow(ForbiddenError);
    await expect(run('utilization', FILTER, { role: 'STAFF' })).resolves.toBeDefined();
    await expect(run('dashboard', {}, { role: 'TECHNICIAN' })).rejects.toThrow(ForbiddenError);
    await expect(run('revenue', {}, { role: 'MANAGER' })).resolves.toBeDefined();
  });

  it('báo cáo nâng cao và ROI bị chặn theo gói; danh sách báo cáo phản ánh đúng', async () => {
    await expect(run('utilization', FILTER, { off: ['reports.advanced'] })).rejects.toThrow(FeatureDisabledError);
    await expect(run('roi', {}, { off: ['reports.roi'] })).rejects.toThrow(FeatureDisabledError);
    await expect(run('revenue', FILTER, { off: ['reports.advanced', 'reports.roi'] })).resolves.toBeDefined();
    const keys = (o: Opts) => as(W.A, o, async (c) => listReports(c).map((d) => d.key));
    expect(await keys({})).toEqual(expect.arrayContaining(['dashboard', 'revenue', 'roi', 'maintenance']));
    expect(await keys({ off: ['reports.advanced', 'reports.roi'] })).toEqual(['dashboard', 'revenue', 'debts', 'deposits', 'inventory']);
    expect(await keys({ role: 'STAFF' })).toEqual(['dashboard', 'inventory', 'utilization']);
    expect(await keys({ role: 'TECHNICIAN' })).toEqual([]);
  });

  it('cô lập tenant: tenant khác không thấy số liệu', async () => {
    const B = await mkTenant(t, 'full');
    const r = await as(B, {}, (c) => runReport(c, 'revenue', FILTER, NOW));
    expect(find(r, 'Doanh thu ghi nhận').totals).toMatchObject({ bookings: 0, total: 0 });
    expect(card(await as(B, {}, (c) => runReport(c, 'deposits', {}, NOW)), 'Tiền cọc đang giữ')).toBe(0);
    expect(find(await as(B, {}, (c) => runReport(c, 'customers', {}, NOW)), 'Khách thuê nhiều nhất (theo doanh thu)').rows).toEqual([]);
  });

  it('đăng ký báo cáo riêng (extension): xuất hiện trong danh sách, chạy qua cùng cổng kiểm tra; không đăng ký trùng', async () => {
    registerReport({
      key: 'ext-demo', title: 'Báo cáo riêng', description: 'x', feature: 'reports.basic', permission: 'reports.view', range: 'snapshot',
      run: async () => ({ key: 'ext-demo', title: 'Báo cáo riêng', period: '', sections: [{ title: 'S', columns: [{ key: 'a', label: 'A', type: 'int' }], rows: [{ a: 1 }] }] }),
    });
    expect(reportDef('ext-demo')).toBeDefined();
    expect((await run('ext-demo')).sections[0]!.rows).toEqual([{ a: 1 }]);
    await expect(run('ext-demo', {}, { role: 'TECHNICIAN' })).rejects.toThrow(ForbiddenError);
    expect(() => registerReport(reportDef('ext-demo')!)).toThrow(/đã được đăng ký/);
  });

  it('mọi báo cáo xuất được ra Excel hợp lệ', async () => {
    for (const key of ['dashboard', 'revenue', 'debts', 'deposits', 'utilization', 'roi', 'maintenance', 'customers', 'inventory']) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await reportToXlsx(await run(key, FILTER)) as never);
      expect(wb.worksheets.length, key).toBeGreaterThan(0);
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await reportToXlsx(await run('revenue', { ...FILTER, groupBy: 'month' })) as never);
    expect(wb.getWorksheet('Tổng quan')!.getCell('B5').value).toBe(3_300_000);
  });
});
