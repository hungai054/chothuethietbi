import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { GIF, JPG, PNG, SIGNATURE, mkTenant, runAs, type Opts } from './ctx';
import {
  addDepositAsset, addFee, addIdDocument, bookingLedger, cancelBooking, closeBooking, confirmBooking, createBooking, createContract, createCustomer, createModel, createUnits,
  deliverBooking, ensureDefaultPriceList, getContract, getContractSignature, getHandoverPhoto, getHandovers, receiveBooking, recordPayment, returnDepositAsset, setRule, signContract,
  transitionUnit, updateFinanceSettings, updatePricingSettings, voidContract, voidPayment, ReadOnlyError, withTenantId, MemoryStorage, type HandoverItemInput,
} from '../src';
import { ForbiddenError, type PriceRule } from '@rentpro/core';
import { FeatureDisabledError } from '@rentpro/tenancy';

let t: TestDb;
beforeAll(async () => { t = await startTestDb(54336); await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')"); }, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);
const D = 86_400_000;
const H = 3_600_000;
const NOW = Date.now();
const RULE: PriceRule = { hour: 100_000, day: 500_000, week: 2_500_000, month: null, minHours: 0 };

async function shop(o: { late?: boolean } = { late: true }) {
  const A = await mkTenant(t);
  const cam = await as(A, {}, (c) => createModel(c, { name: 'Sony A7', barcodePrefix: 'CAM', compensationValue: 10_000_000 }));
  const units = await as(A, {}, (c) => createUnits(c, { modelId: cam, quantity: 3 }));
  const cable = await as(A, {}, (c) => createModel(c, { name: 'Cáp HDMI', tracked: false, stockQty: 10 }));
  const list = await as(A, {}, (c) => ensureDefaultPriceList(c));
  await as(A, {}, (c) => setRule(c, list, cam, RULE));
  await as(A, {}, (c) => setRule(c, list, cable, { hour: null, day: 50_000, week: null, month: null, minHours: 0 }));
  const cust = await as(A, {}, (c) => createCustomer(c, { name: 'Nguyễn Văn An', phone: '0901234567' }));
  if (o.late) await as(A, {}, (c) => updatePricingSettings(c, { graceMinutes: 30, lateFee: { mode: 'PER_HOUR', amount: 50_000 } }));
  return { A, cam, cable, units, cust };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const future = { start: new Date(NOW + 2 * D), end: new Date(NOW + 3 * D) };
const past = { start: new Date(NOW - 3 * D), end: new Date(NOW - 1 * D) }; // 2 ngày = 1.000.000

const mk = (s: Shop, over: Record<string, unknown> = {}, o: Opts = {}) =>
  as(s.A, o, (c) => createBooking(c, { customerId: s.cust, lines: [{ modelId: s.cam, qty: 1 }], ...future, status: 'CONFIRMED', ...over })).then((r) => r.id);

const unitsOf = async (id: string) => (await t.admin.query("SELECT a.unit_id, u.barcode FROM unit_allocation a JOIN equipment_unit u ON u.id=a.unit_id WHERE a.booking_id=$1 AND a.status <> 'RELEASED' ORDER BY u.barcode", [id])).rows;
const items = async (id: string, condition: HandoverItemInput['condition'] = 'GOOD', over: Partial<HandoverItemInput> = {}): Promise<HandoverItemInput[]> =>
  (await unitsOf(id)).map((u) => ({ unitId: u.unit_id, condition, ...over }));

const signedContract = async (s: Shop, id: string, o: Opts = {}) => {
  const cid = await as(s.A, o, (c) => createContract(c, id));
  await as(s.A, o, (c) => signContract(c, cid, { mode: 'PAPER' }));
  return cid;
};
const deliver = async (s: Shop, id: string, o: Opts = {}, input?: Parameters<typeof deliverBooking>[2]) => {
  return as(s.A, o, async (c) => deliverBooking(c, id, input ?? { items: await items(id) }));
};
/** Đơn đã giao, khung thời gian trong quá khứ (để thử nhận lại, trả trễ…) */
async function delivered(s: Shop, over: Record<string, unknown> = {}) {
  const id = await mk(s, { ...past, ...over });
  await signedContract(s, id);
  await deliver(s, id);
  await t.admin.query('UPDATE booking SET delivered_at = starts_at WHERE id=$1', [id]);
  return id;
}
const receive = (s: Shop, id: string, input: Partial<Parameters<typeof receiveBooking>[2]> = {}, o: Opts = {}) =>
  as(s.A, o, async (c) => receiveBooking(c, id, { items: await items(id), ...input }));
const bk = async (id: string) => (await t.admin.query('SELECT status, delivered_at, returned_at, closed_at, total, ends_at FROM booking WHERE id=$1', [id])).rows[0];
const unitStatus = async (id: string) => (await t.admin.query('SELECT status FROM equipment_unit WHERE id=$1', [id])).rows[0].status as string;
const pay = (s: Shop, id: string, kind: 'RENT' | 'DEPOSIT' | 'FEE' | 'REFUND', amount: number, o: Opts = {}) =>
  as(s.A, o, (c) => recordPayment(c, { bookingId: id, kind, method: 'CASH', amount }));

describe('hợp đồng', () => {
  it('chỉ lập cho đơn đã xác nhận; số hợp đồng tăng dần; mỗi đơn một hợp đồng còn hiệu lực', async () => {
    const s = await shop();
    const q = await mk(s, {}, {}).then(async () => mk(s, { start: new Date(NOW + 10 * D), end: new Date(NOW + 11 * D), status: 'HOLD' }));
    await expect(as(s.A, {}, (c) => createContract(c, q))).rejects.toThrow(/đã xác nhận/);
    const a = await mk(s, { start: new Date(NOW + 20 * D), end: new Date(NOW + 21 * D) });
    const b = await mk(s, { start: new Date(NOW + 30 * D), end: new Date(NOW + 31 * D) });
    await as(s.A, {}, (c) => createContract(c, a));
    await as(s.A, {}, (c) => createContract(c, b));
    expect((await as(s.A, {}, (c) => getContract(c, a))).active!.number).toMatch(/^HD-\d{4}-00001$/);
    expect((await as(s.A, {}, (c) => getContract(c, b))).active!.number).toMatch(/^HD-\d{4}-00002$/);
    await expect(as(s.A, {}, (c) => createContract(c, a))).rejects.toThrow(/đã có hợp đồng/);
  });

  it('chụp nội dung: thiết bị, chủ cửa hàng, giấy tờ chỉ 4 số cuối, số tiền bằng chữ', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateFinanceSettings(c, { store: { name: 'Cửa hàng Ánh Sáng', address: '1 Lê Lợi', phone: '0909000111', taxCode: '0312345678' }, deposit: { mode: 'FIXED', value: 2_000_000 } }));
    await as(s.A, {}, (c) => addIdDocument(c, s.cust, { type: 'CCCD', number: '001099123456', consent: true }));
    const id = await mk(s, { lines: [{ modelId: s.cam, qty: 2 }, { modelId: s.cable, qty: 4 }] });
    const cid = await as(s.A, {}, (c) => createContract(c, id));
    const { active } = await as(s.A, {}, (c) => getContract(c, id));
    expect(active!.id).toBe(cid);
    const c = active!.content;
    expect(c.store).toMatchObject({ name: 'Cửa hàng Ánh Sáng', taxCode: '0312345678' });
    expect(c.customer.idDocument).toEqual({ label: 'CCCD', last4: '3456' });
    expect(JSON.stringify(c)).not.toContain('001099123456');
    expect(c.items.map((i) => [i.name, i.qty])).toEqual([['Cáp HDMI', 4], ['Sony A7', 2]]);
    expect(c.items.find((i) => i.name === 'Sony A7')!.units).toHaveLength(2);
    expect(c.money).toMatchObject({ rentTotal: 1_200_000, rentWords: 'Một triệu hai trăm nghìn đồng', depositRequired: 2_000_000, depositWords: 'Hai triệu đồng' });
    expect(c.terms.length).toBeGreaterThanOrEqual(6);
  });

  it('nội dung đã chụp không đổi khi dữ liệu thay đổi sau đó', async () => {
    const s = await shop();
    const id = await mk(s);
    await as(s.A, {}, (c) => createContract(c, id));
    await t.admin.query("UPDATE customer SET name='Tên mới' WHERE id=$1", [s.cust]);
    expect((await as(s.A, {}, (c) => getContract(c, id))).active!.content.customer.name).toBe('Nguyễn Văn An');
  });

  it('ký giấy; ký hai lần bị từ chối', async () => {
    const s = await shop();
    const id = await mk(s);
    const cid = await as(s.A, {}, (c) => createContract(c, id));
    await as(s.A, { role: 'STAFF' }, (c) => signContract(c, cid, { mode: 'PAPER', customerName: 'Nguyễn Văn An' }));
    const a = (await as(s.A, {}, (c) => getContract(c, id))).active!;
    expect(a).toMatchObject({ status: 'SIGNED', signMode: 'PAPER', hasCustomerSignature: false, signedCustomerName: 'Nguyễn Văn An' });
    await expect(as(s.A, {}, (c) => signContract(c, cid, { mode: 'PAPER' }))).rejects.toThrow(/đã được ký/);
  });

  it('ký điện tử: cần gói có tính năng, đủ hai chữ ký PNG có nét; lưu ảnh riêng tư và đọc lại được', async () => {
    const s = await shop();
    const id = await mk(s);
    const cid = await as(s.A, {}, (c) => createContract(c, id));
    const st = new MemoryStorage();
    await expect(as(s.A, { off: ['contract.e_signature'], storage: st }, (c) => signContract(c, cid, { mode: 'ESIGN', customerSignature: SIGNATURE, staffSignature: SIGNATURE }))).rejects.toThrow(FeatureDisabledError);
    await expect(as(s.A, { storage: st }, (c) => signContract(c, cid, { mode: 'ESIGN', customerSignature: SIGNATURE }))).rejects.toThrow(/Thiếu chữ ký của nhân viên/);
    await expect(as(s.A, { storage: st }, (c) => signContract(c, cid, { mode: 'ESIGN', customerSignature: PNG, staffSignature: SIGNATURE }))).rejects.toThrow(/đang trống/);
    await expect(as(s.A, { storage: st }, (c) => signContract(c, cid, { mode: 'ESIGN', customerSignature: JPG, staffSignature: SIGNATURE }))).rejects.toThrow(/không hợp lệ/);
    await expect(as(s.A, { storage: st }, (c) => signContract(c, cid, { mode: 'ESIGN', customerSignature: GIF, staffSignature: SIGNATURE }))).rejects.toThrow(/không hợp lệ/);
    await expect(as(s.A, { storage: st }, (c) => signContract(c, cid, { mode: 'ESIGN', customerSignature: new Uint8Array(400 * 1024).fill(1), staffSignature: SIGNATURE }))).rejects.toThrow(/quá lớn|không hợp lệ/);
    expect(st.files.size).toBe(0); // thất bại không để lại file mồ côi
    await as(s.A, { storage: st }, (c) => signContract(c, cid, { mode: 'ESIGN', customerName: 'An', customerSignature: SIGNATURE, staffSignature: SIGNATURE }));
    expect(st.files.size).toBe(2);
    const a = (await as(s.A, { storage: st }, (c) => getContract(c, id))).active!;
    expect(a).toMatchObject({ status: 'SIGNED', signMode: 'ESIGN', hasCustomerSignature: true, hasStaffSignature: true });
    const sig = await as(s.A, { storage: st }, (c) => getContractSignature(c, cid, 'customer'));
    expect([...sig.data]).toEqual([...SIGNATURE]);
    // đường dẫn lưu thuộc đúng tenant
    expect((await t.admin.query('SELECT customer_signature_path p FROM contract WHERE id=$1', [cid])).rows[0].p).toMatch(new RegExp(`^tenants/${s.A}/sign/`));
  });

  it('hủy hợp đồng cần lý do và cho lập lại (số mới); đơn đang thuê không hủy được; hủy đơn thì hợp đồng tự hủy', async () => {
    const s = await shop();
    const id = await mk(s);
    const c1 = await as(s.A, {}, (c) => createContract(c, id));
    await expect(as(s.A, {}, (c) => voidContract(c, c1, ' '))).rejects.toThrow(/lý do/);
    await as(s.A, {}, (c) => voidContract(c, c1, 'Sai thông tin khách'));
    const c2 = await as(s.A, {}, (c) => createContract(c, id));
    const got = await as(s.A, {}, (c) => getContract(c, id));
    expect([got.active!.id, got.voided[0]!.id]).toEqual([c2, c1]);
    expect(got.active!.number).toMatch(/00002$/);
    await as(s.A, {}, (c) => cancelBooking(c, id, 'Khách hủy'));
    expect((await t.admin.query('SELECT status, void_reason FROM contract WHERE id=$1', [c2])).rows[0]).toEqual({ status: 'VOID', void_reason: 'Đơn bị hủy' });
    const id2 = await mk(s, { start: new Date(NOW + 50 * D), end: new Date(NOW + 51 * D) });
    const c3 = await signedContract(s, id2);
    await deliver(s, id2);
    await expect(as(s.A, {}, (c) => voidContract(c, c3, 'x'))).rejects.toThrow(/đang thuê/);
  });

  it('phân quyền, chỉ đọc, cô lập tenant; DB chỉ cho một hợp đồng hiệu lực mỗi đơn', async () => {
    const s = await shop();
    const B = await mkTenant(t);
    const id = await mk(s);
    await expect(as(s.A, { role: 'TECHNICIAN' }, (c) => createContract(c, id))).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, { status: 'READ_ONLY' }, (c) => createContract(c, id))).rejects.toThrow(ReadOnlyError);
    await expect(as(s.A, { off: ['contract'] }, (c) => createContract(c, id))).rejects.toThrow(FeatureDisabledError);
    const cid = await as(s.A, { role: 'STAFF' }, (c) => createContract(c, id));
    await expect(as(B, {}, (c) => signContract(c, cid, { mode: 'PAPER' }))).rejects.toThrow(/Không tìm thấy/);
    expect((await as(B, {}, (c) => getContract(c, id))).active).toBeNull();
    await expect(withTenantId(t.app, s.A, (db) => db.query(
      `INSERT INTO contract(tenant_id,booking_id,number,content) VALUES ($1,$2,'HD-X','{}')`, [s.A, id]))).rejects.toThrow(/contract_one_active_per_booking/);
  });
});

describe('giao thiết bị', () => {
  it('phải có hợp đồng đã ký trước khi giao (nếu cửa hàng yêu cầu)', async () => {
    const s = await shop();
    const id = await mk(s);
    await expect(deliver(s, id)).rejects.toThrow(/Chưa có hợp đồng/);
    const cid = await as(s.A, {}, (c) => createContract(c, id));
    await expect(deliver(s, id)).rejects.toThrow(/chưa được ký/);
    await as(s.A, {}, (c) => signContract(c, cid, { mode: 'PAPER' }));
    await expect(deliver(s, id)).resolves.toBeDefined();
  });

  it('cửa hàng tắt yêu cầu hợp đồng, hoặc gói không có hợp đồng: giao được không cần hợp đồng', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateFinanceSettings(c, { handover: { requireContract: false, requireDeposit: false } }));
    const id = await mk(s);
    await expect(deliver(s, id)).resolves.toBeDefined();
    const s2 = await shop();
    const id2 = await mk(s2);
    await expect(deliver(s2, id2, { off: ['contract'] })).resolves.toBeDefined();
  });

  it('phải đủ tiền cọc: tiền, tài sản, hoặc kết hợp; thông báo nói rõ còn thiếu bao nhiêu', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateFinanceSettings(c, { deposit: { mode: 'FIXED', value: 1_000_000 } }));
    const id = await mk(s);
    await signedContract(s, id);
    await expect(deliver(s, id)).rejects.toThrow(/Chưa đủ tiền cọc: cần 1\.000\.000 đ, hiện có 0 đ \(thiếu 1\.000\.000 đ\)/);
    await pay(s, id, 'DEPOSIT', 600_000);
    await expect(deliver(s, id)).rejects.toThrow(/thiếu 400\.000 đ/);
    await as(s.A, {}, (c) => addDepositAsset(c, id, { description: 'CCCD gốc', estimatedValue: 400_000 }));
    await expect(deliver(s, id)).resolves.toBeDefined(); // 600k tiền + 400k tài sản
  });

  it('cửa hàng không yêu cầu cọc khi giao thì giao được dù chưa cọc', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateFinanceSettings(c, { deposit: { mode: 'FIXED', value: 1_000_000 }, handover: { requireContract: true, requireDeposit: false } }));
    const id = await mk(s);
    await signedContract(s, id);
    await expect(deliver(s, id)).resolves.toBeDefined();
  });

  it('danh sách thiết bị phải khớp đúng đơn: thiếu, thừa, trùng, mất, hỏng không ghi chú', async () => {
    const s = await shop();
    const id = await mk(s, { lines: [{ modelId: s.cam, qty: 2 }] });
    await signedContract(s, id);
    const [u1, u2] = await unitsOf(id);
    await expect(deliver(s, id, {}, { items: [{ unitId: u1!.unit_id, condition: 'GOOD' }] })).rejects.toThrow(new RegExp(`Chưa quét/ghi nhận: ${u2!.barcode}`));
    await expect(deliver(s, id, {}, { items: [] })).rejects.toThrow(/Chưa quét/);
    await expect(deliver(s, id, {}, { items: [{ unitId: u1!.unit_id, condition: 'GOOD' }, { unitId: u1!.unit_id, condition: 'GOOD' }, { unitId: u2!.unit_id, condition: 'GOOD' }] })).rejects.toThrow(/bị ghi hai lần/);
    const other = s.units.find((u) => ![u1!.unit_id, u2!.unit_id].includes(u.id))!;
    await expect(deliver(s, id, {}, { items: [{ unitId: u1!.unit_id, condition: 'GOOD' }, { unitId: u2!.unit_id, condition: 'GOOD' }, { unitId: other.id, condition: 'GOOD' }] })).rejects.toThrow(/không thuộc đơn này/);
    await expect(deliver(s, id, {}, { items: [{ unitId: u1!.unit_id, condition: 'MISSING' }, { unitId: u2!.unit_id, condition: 'GOOD' }] })).rejects.toThrow(/tình trạng "mất"/);
    await expect(deliver(s, id, {}, { items: [{ unitId: u1!.unit_id, condition: 'DAMAGED' }, { unitId: u2!.unit_id, condition: 'GOOD' }] })).rejects.toThrow(/cần ghi chú/);
    await expect(deliver(s, id, {}, { items: [{ unitId: u1!.unit_id, condition: 'WEIRD' as never }, { unitId: u2!.unit_id, condition: 'GOOD' }] })).rejects.toThrow(/Tình trạng/);
    expect((await bk(id)).status).toBe('CONFIRMED'); // lỗi thì đơn không đổi gì
    expect(await unitStatus(u1!.unit_id)).toBe('AVAILABLE');
  });

  it('giao thành công: đơn đang thuê, thiết bị đang cho thuê, lịch chuyển sang đang thuê, có biên bản + nhật ký', async () => {
    const s = await shop();
    const id = await mk(s, { lines: [{ modelId: s.cam, qty: 2 }] });
    await signedContract(s, id);
    const st = new MemoryStorage();
    const us = await items(id, 'GOOD', { accessories: [{ name: 'Pin', expected: 2, actual: 2 }], photos: [{ data: PNG }] });
    us[1]!.condition = 'FAIR';
    us[1]!.notes = 'Xước nhẹ thân máy';
    const { handoverId } = await as(s.A, { role: 'STAFF', storage: st }, (c) => deliverBooking(c, id, { items: us, notes: 'Giao tại quầy' }));
    const b = await bk(id);
    expect(b.status).toBe('ACTIVE');
    expect(b.delivered_at).not.toBeNull();
    for (const u of await unitsOf(id)) expect(await unitStatus(u.unit_id)).toBe('RENTED');
    expect((await t.admin.query("SELECT DISTINCT status FROM unit_allocation WHERE booking_id=$1", [id])).rows).toEqual([{ status: 'ACTIVE' }]);
    const log = (await t.admin.query("SELECT from_status, to_status FROM unit_status_log WHERE unit_id=$1 ORDER BY id", [us[0]!.unitId])).rows.map((r) => `${r.from_status}>${r.to_status}`);
    expect(log.slice(-2)).toEqual(['AVAILABLE>RESERVED', 'RESERVED>RENTED']);
    expect(st.files.size).toBe(2); // mỗi chiếc một ảnh
    const h = await as(s.A, {}, (c) => getHandovers(c, id));
    expect(h.delivery!.id).toBe(handoverId);
    expect(h.delivery!.notes).toBe('Giao tại quầy');
    expect(h.delivery!.items.map((i) => i.conditionLabel).sort()).toEqual(['Khá', 'Tốt']);
    expect(h.delivery!.items[0]!.accessories).toEqual([{ name: 'Pin', expected: 2, actual: 2 }]);
    expect(h.ret).toBeNull();
    const photo = await as(s.A, { storage: st }, (c) => getHandoverPhoto(c, h.delivery!.items[0]!.id, 0));
    expect(photo.contentType).toBe('image/png');
    await expect(as(s.A, { storage: st }, (c) => getHandoverPhoto(c, h.delivery!.items[0]!.id, 5))).rejects.toThrow(/Không tìm thấy/);
  });

  it('ảnh sai định dạng: hủy toàn bộ giao, không để lại file', async () => {
    const s = await shop();
    const id = await mk(s);
    await signedContract(s, id);
    const st = new MemoryStorage();
    const it1 = await items(id, 'GOOD', { photos: [{ data: PNG }, { data: GIF }] });
    await expect(as(s.A, { storage: st }, (c) => deliverBooking(c, id, { items: it1 }))).rejects.toThrow(/JPG, PNG/);
    expect(st.files.size).toBe(0);
    expect((await bk(id)).status).toBe('CONFIRMED');
    expect(await unitStatus((await unitsOf(id))[0]!.unit_id)).toBe('AVAILABLE');
    await expect(as(s.A, {}, async (c) => deliverBooking(c, id, { items: await items(id, 'GOOD', { photos: Array(6).fill({ data: PNG }) }) }))).rejects.toThrow(/Tối đa 5 ảnh/);
  });

  it('thiết bị không sẵn sàng (bảo trì) thì không giao được và báo tên chiếc', async () => {
    const s = await shop();
    const id = await mk(s);
    await signedContract(s, id);
    const u = (await unitsOf(id))[0]!;
    await as(s.A, {}, (c) => transitionUnit(c, u.unit_id, 'MAINTENANCE', { reason: 'Hỏng đột xuất' }));
    await expect(deliver(s, id)).rejects.toThrow(new RegExp(`${u.barcode} \\(MAINTENANCE\\)`));
    expect((await bk(id)).status).toBe('CONFIRMED');
  });

  it('chỉ giao đơn đã xác nhận, giao một lần; bốn người bấm giao cùng lúc: đúng một người thành công', async () => {
    const s = await shop();
    const q = await mk(s, { status: 'HOLD', start: new Date(NOW + 40 * D), end: new Date(NOW + 41 * D) });
    await expect(deliver(s, q, {}, { items: [] })).rejects.toThrow(/Chỉ giao được đơn đã xác nhận.*Giữ chỗ/);
    const id = await mk(s);
    await signedContract(s, id);
    const its = await items(id);
    const res = await Promise.allSettled(Array.from({ length: 4 }, () => as(s.A, {}, (c) => deliverBooking(c, id, { items: its }))));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of res) if (r.status === 'rejected') expect(r.reason.message).toMatch(/đã được giao/);
    expect((await t.admin.query("SELECT count(*)::int n FROM handover WHERE booking_id=$1 AND kind='DELIVERY'", [id])).rows[0].n).toBe(1);
    const log = (await t.admin.query("SELECT count(*)::int n FROM unit_status_log WHERE unit_id=$1 AND to_status='RENTED'", [its[0]!.unitId])).rows[0].n;
    expect(log).toBe(1);
  });

  it('hàng theo số lượng tự có dòng trong biên bản', async () => {
    const s = await shop();
    const id = await mk(s, { lines: [{ modelId: s.cam, qty: 1 }, { modelId: s.cable, qty: 4 }] });
    await signedContract(s, id);
    await deliver(s, id);
    const h = await as(s.A, {}, (c) => getHandovers(c, id));
    expect(h.delivery!.items.map((i) => i.label)).toEqual(expect.arrayContaining(['Cáp HDMI × 4']));
    expect((await t.admin.query("SELECT status FROM qty_allocation WHERE booking_id=$1", [id])).rows).toEqual([{ status: 'ACTIVE' }]);
  });

  it('phân quyền, chỉ đọc, cô lập tenant', async () => {
    const s = await shop();
    const B = await mkTenant(t);
    const id = await mk(s);
    await signedContract(s, id);
    await expect(deliver(s, id, { role: 'TECHNICIAN' })).rejects.toThrow(ForbiddenError);
    await expect(deliver(s, id, { status: 'READ_ONLY' })).rejects.toThrow(ReadOnlyError);
    await expect(as(B, {}, (c) => deliverBooking(c, id, { items: [] }))).rejects.toThrow(/Không tìm thấy/);
    await expect(deliver(s, id, { role: 'STAFF' })).resolves.toBeDefined();
  });
});

describe('nhận thiết bị về', () => {
  it('đúng hạn, tình trạng tốt: thiết bị rảnh lại sau khi kiểm tra, trả lịch, không phát sinh phí', async () => {
    const s = await shop();
    const id = await delivered(s);
    const us = await unitsOf(id);
    const r = await receive(s, id, { returnedAt: past.end });
    expect(r.late).toMatchObject({ amount: 0, withinGrace: false });
    expect(r.fees).toEqual([]);
    expect(r.issues).toEqual([]);
    expect((await bk(id)).status).toBe('RETURNED');
    expect(await unitStatus(us[0]!.unit_id)).toBe('AVAILABLE');
    const log = (await t.admin.query("SELECT to_status FROM unit_status_log WHERE unit_id=$1 ORDER BY id DESC LIMIT 2", [us[0]!.unit_id])).rows.map((x) => x.to_status);
    expect(log).toEqual(['AVAILABLE', 'INSPECTING']);
    expect((await t.admin.query("SELECT DISTINCT status FROM unit_allocation WHERE booking_id=$1", [id])).rows).toEqual([{ status: 'RELEASED' }]);
    expect((await as(s.A, {}, (c) => getHandovers(c, id))).ret).not.toBeNull();
    // chiếc đó đặt lại được ngay
    await expect(mk(s, { ...future, lines: [{ modelId: s.cam, qty: 3 }] })).resolves.toBeDefined();
  });

  it('trả trễ: trong ân hạn không phí; ngoài ân hạn tính từ sau ân hạn, làm tròn lên giờ', async () => {
    const s = await shop();
    const a = await delivered(s);
    expect((await receive(s, a, { returnedAt: new Date(past.end.getTime() + 20 * 60_000) })).late).toMatchObject({ amount: 0, withinGrace: true });
    const s2 = await shop();
    const b = await delivered(s2);
    const r = await receive(s2, b, { returnedAt: new Date(past.end.getTime() + 130 * 60_000) }); // (130 − 30) phút = 2 giờ
    expect(r.late).toMatchObject({ billedHours: 2, amount: 100_000 });
    expect(r.fees).toEqual([{ kind: 'LATE', description: 'Trả trễ 2 giờ (đã trừ ân hạn)', amount: 100_000 }]);
    expect(r.settlement).toMatchObject({ charges: 1_100_000, balanceOwed: 1_100_000 });
  });

  it('phí trễ theo % giá ngày và theo số lượng thiết bị', async () => {
    const s = await shop({ late: false });
    await as(s.A, {}, (c) => updatePricingSettings(c, { graceMinutes: 0, lateFee: { mode: 'PERCENT_OF_DAY', percent: 100 } }));
    const id = await delivered(s, { lines: [{ modelId: s.cam, qty: 2 }] });
    const r = await receive(s, id, { returnedAt: new Date(past.end.getTime() + 12 * H) });
    expect(r.late.amount).toBe(2 * 250_000); // mỗi chiếc 12/24 x 500.000, nhân 2 chiếc
  });

  it('trả sớm: tính lại tiền thuê theo chính sách hoàn phần chưa dùng; lịch được trả ngay', async () => {
    const s = await shop();
    const start = new Date(NOW - 2 * D);
    const id = await delivered(s, { start, end: new Date(NOW + 5 * D) }); // 7 ngày = 1 tuần = 2.500.000
    expect((await bk(id)).total).toBe('2500000');
    const returnedAt = new Date(NOW);
    const r = await receive(s, id, { returnedAt });
    expect(r.late.amount).toBe(0);
    const b = await bk(id);
    expect(Number(b.total)).toBe(1_000_000); // dùng 48 giờ = 2 ngày
    expect(b.ends_at.getTime()).toBe(returnedAt.getTime());
    expect(r.settlement.rentTotal).toBe(1_000_000);
  });

  it('hư hỏng: thiết bị sang bảo trì, tính phí nếu có chi phí, cảnh báo nếu chưa có', async () => {
    const s = await shop();
    const id = await delivered(s, { lines: [{ modelId: s.cam, qty: 2 }] });
    const [u1, u2] = await unitsOf(id);
    const r = await receive(s, id, {
      returnedAt: past.end,
      items: [{ unitId: u1!.unit_id, condition: 'DAMAGED', notes: 'Vỡ màn hình', damageFee: 300_000 }, { unitId: u2!.unit_id, condition: 'DAMAGED', notes: 'Kẹt nút bấm' }],
    });
    expect(await unitStatus(u1!.unit_id)).toBe('MAINTENANCE');
    expect(await unitStatus(u2!.unit_id)).toBe('MAINTENANCE');
    expect(r.fees).toEqual([{ kind: 'DAMAGE', description: `Hư hỏng ${u1!.barcode}: Vỡ màn hình`, amount: 300_000 }]);
    expect(r.warnings).toEqual([expect.stringContaining(u2!.barcode)]);
    expect(r.issues.map((i) => i.kind)).toEqual(['WORSE_CONDITION', 'WORSE_CONDITION']);
    const log = (await t.admin.query("SELECT to_status, reason FROM unit_status_log WHERE unit_id=$1 ORDER BY id DESC LIMIT 1", [u1!.unit_id])).rows[0];
    expect(log).toMatchObject({ to_status: 'MAINTENANCE', reason: 'Hư hỏng khi trả: Vỡ màn hình' });
    const s3 = await shop();
    const id3 = await delivered(s3);
    await expect(receive(s3, id3, { items: [{ unitId: (await unitsOf(id3))[0]!.unit_id, condition: 'DAMAGED' }] })).rejects.toThrow(/cần ghi chú/);
  });

  it('mất thiết bị: chuyển sang "mất", tự tính phí bồi thường theo giá trị niêm yết; chưa có giá trị thì cảnh báo', async () => {
    const s = await shop();
    const id = await delivered(s, { lines: [{ modelId: s.cam, qty: 2 }] });
    const [u1, u2] = await unitsOf(id);
    await t.admin.query('UPDATE equipment_unit SET compensation_value = 12000000 WHERE id=$1', [u1!.unit_id]); // giá riêng của chiếc này
    const r = await receive(s, id, { returnedAt: past.end, items: [{ unitId: u1!.unit_id, condition: 'MISSING' }, { unitId: u2!.unit_id, condition: 'GOOD' }] });
    expect(await unitStatus(u1!.unit_id)).toBe('LOST');
    expect(await unitStatus(u2!.unit_id)).toBe('AVAILABLE');
    expect(r.fees).toEqual([{ kind: 'LOSS', description: `Mất ${u1!.barcode} (Sony A7)`, amount: 12_000_000 }]);
    expect(r.issues.map((i) => i.kind)).toEqual(['MISSING_ITEM']);

    const s2 = await shop();
    await t.admin.query('UPDATE equipment_model SET compensation_value = NULL WHERE tenant_id=$1', [s2.A]);
    await t.admin.query('UPDATE equipment_unit SET compensation_value = NULL, purchase_price = NULL WHERE tenant_id=$1', [s2.A]);
    const id2 = await delivered(s2);
    const r2 = await receive(s2, id2, { returnedAt: past.end, items: [{ unitId: (await unitsOf(id2))[0]!.unit_id, condition: 'MISSING' }] });
    expect(r2.fees).toEqual([]);
    expect(r2.warnings[0]).toMatch(/chưa có giá trị bồi thường/);
  });

  it('phát hiện thiếu phụ kiện so với biên bản giao; phí khác do nhân viên nhập', async () => {
    const s = await shop();
    const id = await mk(s, past);
    await signedContract(s, id);
    await deliver(s, id, {}, { items: await items(id, 'GOOD', { accessories: [{ name: 'Pin', expected: 2, actual: 2 }, { name: 'Dây đeo', expected: 1, actual: 1 }] }) });
    await t.admin.query('UPDATE booking SET delivered_at = starts_at WHERE id=$1', [id]);
    const r = await receive(s, id, {
      returnedAt: past.end,
      items: await items(id, 'GOOD', { accessories: [{ name: 'Pin', expected: 2, actual: 1 }, { name: 'Dây đeo', expected: 1, actual: 1 }] }),
      extraFees: [{ kind: 'OTHER', description: 'Thiếu 1 pin', amount: 400_000 }],
    });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ kind: 'ACCESSORY_SHORT' });
    expect(r.issues[0]!.detail).toContain('Pin');
    expect(r.fees).toEqual([{ kind: 'OTHER', description: 'Thiếu 1 pin', amount: 400_000 }]);
  });

  it('điều kiện nhận: chỉ đơn đang thuê, danh sách đủ, giờ hợp lý, phí hợp lệ, nhận một lần', async () => {
    const s = await shop();
    const notYet = await mk(s);
    await expect(receive(s, notYet, { items: [] })).rejects.toThrow(/Chỉ nhận lại được đơn đang thuê.*Đã xác nhận/);
    const id = await delivered(s, { lines: [{ modelId: s.cam, qty: 2 }] });
    const [u1] = await unitsOf(id);
    await expect(receive(s, id, { items: [{ unitId: u1!.unit_id, condition: 'GOOD' }] })).rejects.toThrow(/Chưa quét\/ghi nhận/);
    await expect(receive(s, id, { returnedAt: new Date(NOW + 2 * H) })).rejects.toThrow(/tương lai/);
    await expect(receive(s, id, { returnedAt: new Date(past.start.getTime() - H) })).rejects.toThrow(/trước giờ giao/);
    await expect(receive(s, id, { extraFees: [{ kind: 'OTHER', description: ' ', amount: 10 }] })).rejects.toThrow(/mô tả/);
    await expect(receive(s, id, { extraFees: [{ kind: 'OTHER', description: 'x', amount: 0 }] })).rejects.toThrow(/số nguyên dương/);
    await expect(receive(s, id, { items: (await items(id)).map((i) => ({ ...i, damageFee: -5 })) })).rejects.toThrow(/không âm/);
    expect((await bk(id)).status).toBe('ACTIVE'); // mọi lỗi đều không làm đổi dữ liệu
    await receive(s, id, { returnedAt: past.end });
    await expect(receive(s, id)).rejects.toThrow(/đã nhận lại thiết bị/);
  });

  it('phân quyền, chỉ đọc; kỹ thuật viên không nhận thiết bị', async () => {
    const s = await shop();
    const id = await delivered(s);
    await expect(receive(s, id, { returnedAt: past.end }, { role: 'TECHNICIAN' })).rejects.toThrow(ForbiddenError);
    await expect(receive(s, id, { returnedAt: past.end }, { status: 'READ_ONLY' })).rejects.toThrow(ReadOnlyError);
    await expect(receive(s, id, { returnedAt: past.end }, { role: 'STAFF' })).resolves.toBeDefined();
  });
});

describe('quyết toán và đóng đơn: luồng trọn vẹn', () => {
  it('cọc + thuê, trả trễ có hư hỏng: trừ cọc, hoàn phần dư, đóng đơn; sau đó sổ bị khóa', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateFinanceSettings(c, { deposit: { mode: 'FIXED', value: 2_000_000 } }));
    const id = await mk(s, past);
    await signedContract(s, id);
    await pay(s, id, 'DEPOSIT', 2_000_000);
    await pay(s, id, 'RENT', 1_000_000);
    await deliver(s, id);
    await t.admin.query('UPDATE booking SET delivered_at = starts_at WHERE id=$1', [id]);
    const u = (await unitsOf(id))[0]!;
    const r = await receive(s, id, { returnedAt: new Date(past.end.getTime() + 130 * 60_000), items: [{ unitId: u.unit_id, condition: 'DAMAGED', notes: 'Trầy ống kính', damageFee: 300_000 }] });
    expect(r.settlement).toMatchObject({ charges: 1_400_000, depositApplied: 400_000, refundDue: 1_600_000, balanceOwed: 0 }); // 1tr thuê + 100k trễ + 300k hỏng
    await expect(as(s.A, {}, (c) => closeBooking(c, id))).rejects.toThrow(/cần hoàn lại cho khách 1\.600\.000 đ/);
    await pay(s, id, 'REFUND', 1_600_000);
    await as(s.A, { role: 'STAFF' }, (c) => closeBooking(c, id));
    const b = await bk(id);
    expect(b.status).toBe('CLOSED');
    expect(b.closed_at).not.toBeNull();
    const l = await as(s.A, {}, (c) => bookingLedger(c, id));
    expect(l.settlement).toMatchObject({ settled: true, refundDue: 0, balanceOwed: 0 });
    expect(l.paymentStatus).toBe('PAID');
    await expect(pay(s, id, 'RENT', 1000)).rejects.toThrow(/Đơn đã đóng/);
    await expect(as(s.A, {}, (c) => addFee(c, id, { kind: 'OTHER', description: 'x', amount: 1000 }))).rejects.toThrow(/đang thuê hoặc đã nhận lại/);
    const pid = l.payments.find((p) => p.kind === 'REFUND')!.id;
    await expect(as(s.A, {}, (c) => voidPayment(c, pid, 'x'))).rejects.toThrow(/Đơn đã đóng/);
    await expect(as(s.A, {}, (c) => closeBooking(c, id))).rejects.toThrow(/đã được đóng/);
  });

  it('chưa đóng được khi khách còn nợ; thu đủ hoặc quản lý xóa nợ thì đóng được', async () => {
    const s = await shop();
    const id = await delivered(s);
    await receive(s, id, { returnedAt: new Date(past.end.getTime() + 130 * 60_000) }); // phải thu 1.100.000
    await expect(as(s.A, {}, (c) => closeBooking(c, id))).rejects.toThrow(/khách còn nợ 1\.100\.000 đ/);
    await pay(s, id, 'RENT', 1_000_000);
    await expect(as(s.A, {}, (c) => closeBooking(c, id))).rejects.toThrow(/còn nợ 100\.000 đ/);
    await expect(as(s.A, { role: 'STAFF' }, (c) => recordPayment(c, { bookingId: id, kind: 'WRITE_OFF', method: 'OTHER', amount: 100_000, note: 'Khách quen' }))).rejects.toThrow(ForbiddenError);
    await as(s.A, { role: 'MANAGER' }, (c) => recordPayment(c, { bookingId: id, kind: 'WRITE_OFF', method: 'OTHER', amount: 100_000, note: 'Khách quen, miễn phí trễ' }));
    await as(s.A, {}, (c) => closeBooking(c, id));
    expect((await bk(id)).status).toBe('CLOSED');
  });

  it('còn giữ tài sản thế chấp thì chưa đóng được; trả tài sản rồi đóng được', async () => {
    const s = await shop();
    const id = await delivered(s);
    const a = await as(s.A, {}, (c) => addDepositAsset(c, id, { description: 'CCCD gốc', estimatedValue: 0 }));
    await receive(s, id, { returnedAt: past.end });
    await pay(s, id, 'RENT', 1_000_000);
    await expect(as(s.A, {}, (c) => closeBooking(c, id))).rejects.toThrow(/còn giữ tài sản thế chấp: CCCD gốc/);
    await as(s.A, { role: 'STAFF' }, (c) => returnDepositAsset(c, a, 'Đã trả khách'));
    await as(s.A, {}, (c) => closeBooking(c, id));
    expect((await bk(id)).status).toBe('CLOSED');
  });

  it('không đóng được đơn chưa nhận lại thiết bị; hai người đóng cùng lúc chỉ một thành công', async () => {
    const s = await shop();
    const act = await delivered(s);
    await expect(as(s.A, {}, (c) => closeBooking(c, act))).rejects.toThrow(/Chỉ đóng được đơn đã nhận lại thiết bị/);
    await receive(s, act, { returnedAt: past.end });
    await pay(s, act, 'RENT', 1_000_000);
    const res = await Promise.allSettled([1, 2, 3].map(() => as(s.A, {}, (c) => closeBooking(c, act))));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await t.admin.query("SELECT count(*)::int n FROM booking_status_log WHERE booking_id=$1 AND to_status='CLOSED'", [act])).rows[0].n).toBe(1);
  });

  it('đơn hủy sau khi đã cọc: hợp đồng hủy, hoàn cọc, sổ cân bằng', async () => {
    const s = await shop();
    const id = await mk(s);
    await signedContract(s, id);
    await pay(s, id, 'DEPOSIT', 800_000);
    await as(s.A, {}, (c) => cancelBooking(c, id, 'Khách đổi lịch'));
    expect((await as(s.A, {}, (c) => getContract(c, id))).active).toBeNull();
    await pay(s, id, 'REFUND', 800_000);
    expect((await as(s.A, {}, (c) => bookingLedger(c, id))).settlement).toMatchObject({ settled: true, charges: 0 });
  });

  it('trả sớm có hoàn tiền: tiền thuê đã thu thừa thì cửa hàng phải hoàn phần dư', async () => {
    const s = await shop();
    const id = await delivered(s, { start: new Date(NOW - 2 * D), end: new Date(NOW + 5 * D) });
    await pay(s, id, 'RENT', 2_500_000);
    const r = await receive(s, id, { returnedAt: new Date(NOW) });
    expect(r.settlement).toMatchObject({ rentTotal: 1_000_000, refundDue: 1_500_000, balanceOwed: 0 });
    await pay(s, id, 'REFUND', 1_500_000);
    await as(s.A, {}, (c) => closeBooking(c, id));
    expect((await bk(id)).status).toBe('CLOSED');
  });
});
