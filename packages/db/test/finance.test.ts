import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { JPG, GIF, PNG, mkTenant, runAs, type Opts } from './ctx';
import {
  addDepositAsset, addFee, bookingLedger, confirmBooking, createBooking, createCustomer, createModel, createUnits, depositLedger, ensureDefaultPriceList, extendBooking,
  getFinanceSettings, recordPayment, returnDepositAsset, setDepositRequired, setRule, suggestBookingDeposit, updateFinanceSettings, vietQrFor, voidFee, voidPayment,
  withTenantId, ReadOnlyError, ValidationError, MemoryStorage, type PaymentInput,
} from '../src';
import { ForbiddenError, parseTlv, verifyVietQr, type PriceRule } from '@rentpro/core';
import { FeatureDisabledError } from '@rentpro/tenancy';

let t: TestDb;
beforeAll(async () => { t = await startTestDb(54335); await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')"); }, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);
const D = 86_400_000;
const NOW = Date.now();
const RULE: PriceRule = { hour: 100_000, day: 500_000, week: 2_500_000, month: null, minHours: 0 };

async function shop() {
  const A = await mkTenant(t);
  const cam = await as(A, {}, (c) => createModel(c, { name: 'Sony A7', barcodePrefix: 'CAM', compensationValue: 10_000_000 }));
  const units = await as(A, {}, (c) => createUnits(c, { modelId: cam, quantity: 3 }));
  const list = await as(A, {}, (c) => ensureDefaultPriceList(c));
  await as(A, {}, (c) => setRule(c, list, cam, RULE));
  const cust = await as(A, {}, (c) => createCustomer(c, { name: 'Nguyễn Văn An', phone: '0901234567' }));
  return { A, cam, units, cust };
}
type Shop = Awaited<ReturnType<typeof shop>>;

/** Đơn 24 giờ (tiền thuê 500.000) bắt đầu sau 2 ngày */
const booking = (s: Shop, status: 'QUOTE' | 'HOLD' | 'CONFIRMED' = 'CONFIRMED', over: Record<string, unknown> = {}) =>
  as(s.A, {}, (c) => createBooking(c, { customerId: s.cust, lines: [{ modelId: s.cam, qty: 1 }], start: new Date(NOW + 2 * D), end: new Date(NOW + 3 * D), status, ...over })).then((r) => r.id);

const pay = (s: Shop, o: Opts, i: Partial<PaymentInput> & { bookingId: string }) =>
  as(s.A, o, (c) => recordPayment(c, { kind: 'RENT', method: 'CASH', amount: 100_000, ...i }));

const ledger = (s: Shop, id: string, o: Opts = {}) => as(s.A, o, (c) => bookingLedger(c, id));
const setStatus = (id: string, status: string) =>
  t.admin.query("UPDATE booking SET status=$2, cancel_reason = CASE WHEN $2 = 'CANCELLED' THEN 'test' ELSE cancel_reason END WHERE id=$1", [id, status]);
const win = (n: number) => ({ start: new Date(NOW + (2 + 3 * n) * D), end: new Date(NOW + (3 + 3 * n) * D) }); // khung 24 giờ, mỗi n một khung riêng

describe('cấu hình tài chính', () => {
  it('lưu và đọc lại; tài khoản ngân hàng được kiểm tra; chỉ quản lý trở lên đổi được', async () => {
    const s = await shop();
    const saved = await as(s.A, {}, (c) => updateFinanceSettings(c, { bank: { bin: '970415', account: '113366668888', accountName: 'CUA HANG DEMO' }, deposit: { mode: 'FIXED', value: 500_000 }, contractPattern: 'HD/{year}/{seq:4}' }));
    expect(saved).toMatchObject({ bank: { bin: '970415' }, deposit: { mode: 'FIXED', value: 500_000 } });
    expect((await as(s.A, {}, (c) => getFinanceSettings(c))).contractPattern).toBe('HD/{year}/{seq:4}');
    await expect(as(s.A, {}, (c) => updateFinanceSettings(c, { bank: { bin: '12', account: '113366668888' } }))).rejects.toThrow(/6 chữ số/);
    await expect(as(s.A, {}, (c) => updateFinanceSettings(c, { bank: { bin: '970415', account: 'abc' } }))).rejects.toThrow(/Số tài khoản/);
    await expect(as(s.A, {}, (c) => updateFinanceSettings(c, { contractPattern: 'khong co seq' }))).rejects.toThrow(/seq|chữ, số/);
    await expect(as(s.A, {}, (c) => updateFinanceSettings(c, { deposit: { mode: 'PERCENT_OF_VALUE', value: 500 } }))).rejects.toThrow();
    await expect(as(s.A, {}, (c) => updateFinanceSettings(c, { khongCo: 1 }))).rejects.toThrow();
    await expect(as(s.A, { role: 'STAFF' }, (c) => updateFinanceSettings(c, { deposit: { mode: 'NONE' } }))).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, { role: 'STAFF' }, (c) => getFinanceSettings(c))).rejects.toThrow(ForbiddenError);
  });

  it('nhật ký không lưu số tài khoản đầy đủ', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateFinanceSettings(c, { bank: { bin: '970415', account: '113366668888' } }));
    const log = (await t.admin.query("SELECT data FROM audit_log WHERE tenant_id=$1 AND action='settings.finance'", [s.A])).rows[0].data;
    expect(JSON.stringify(log)).not.toContain('113366668888');
    expect(log.bank.account).toBe('***8888');
  });
});

describe('tiền cọc yêu cầu', () => {
  it('mặc định không yêu cầu; theo % giá trị thiết bị khi xác nhận; theo cố định; làm tròn lên 1.000', async () => {
    const s = await shop();
    const b0 = await booking(s);
    expect((await ledger(s, b0)).deposit.required).toBe(0);
    await as(s.A, {}, (c) => updateFinanceSettings(c, { deposit: { mode: 'PERCENT_OF_VALUE', value: 30 } }));
    const b1 = await booking(s, 'QUOTE', win(1));
    await as(s.A, {}, (c) => confirmBooking(c, b1));
    expect((await ledger(s, b1)).deposit).toMatchObject({ required: 3_000_000, shortfall: 3_000_000, satisfied: false }); // 30% x 10 triệu
    await as(s.A, {}, (c) => updateFinanceSettings(c, { deposit: { mode: 'FIXED', value: 700_000 } }));
    const b2 = await booking(s, 'CONFIRMED', win(2));
    expect((await ledger(s, b2)).deposit.required).toBe(700_000);
    await as(s.A, {}, (c) => updateFinanceSettings(c, { deposit: { mode: 'PERCENT_OF_RENT', value: 33 } }));
    const b3 = await booking(s, 'CONFIRMED', win(3));
    expect((await ledger(s, b3)).deposit.required).toBe(165_000); // 33% x 500.000 = 165.000 (đã tròn nghìn)
  });

  it('tính theo giá trị của đúng chiếc được chọn đích danh và nhân theo số lượng', async () => {
    const s = await shop();
    await t.admin.query('UPDATE equipment_unit SET compensation_value = 20000000 WHERE id=$1', [s.units[0]!.id]);
    await as(s.A, {}, (c) => updateFinanceSettings(c, { deposit: { mode: 'PERCENT_OF_VALUE', value: 10 } }));
    const specific = await as(s.A, {}, (c) => createBooking(c, { customerId: s.cust, lines: [{ modelId: s.cam, qty: 1, unitId: s.units[0]!.id }], start: new Date(NOW + 5 * D), end: new Date(NOW + 6 * D), status: 'CONFIRMED' }));
    expect((await ledger(s, specific.id)).deposit.required).toBe(2_000_000);
    const two = await as(s.A, {}, (c) => createBooking(c, { customerId: s.cust, lines: [{ modelId: s.cam, qty: 2 }], start: new Date(NOW + 8 * D), end: new Date(NOW + 9 * D), status: 'CONFIRMED' }));
    expect((await ledger(s, two.id)).deposit.required).toBe(2_000_000); // 2 x 10 triệu x 10%
  });

  it('tính lại khi gia hạn (đơn chưa giao); hook extension đổi mức cọc; hook lỗi dùng mức gốc', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateFinanceSettings(c, { deposit: { mode: 'PERCENT_OF_RENT', value: 100 } }));
    const b = await booking(s);
    expect((await ledger(s, b)).deposit.required).toBe(500_000);
    await as(s.A, {}, (c) => extendBooking(c, b, new Date(NOW + 5 * D)));
    expect((await ledger(s, b)).deposit.required).toBe(1_500_000);
    expect((await as(s.A, { depositHook: ({ suggested }) => suggested + 100_000 }, (c) => suggestBookingDeposit(c, b))).amount).toBe(1_600_000);
    const bad = await as(s.A, { depositHook: () => { throw new Error('lỗi extension'); } }, (c) => suggestBookingDeposit(c, b));
    expect(bad).toMatchObject({ amount: 1_500_000, warning: expect.stringContaining('lỗi extension') });
  });

  it('nhân viên chỉnh mức cọc trước khi giao; sau khi giao thì không', async () => {
    const s = await shop();
    const b = await booking(s);
    await as(s.A, { role: 'STAFF' }, (c) => setDepositRequired(c, b, 300_000));
    expect((await ledger(s, b)).deposit.required).toBe(300_000);
    await expect(as(s.A, {}, (c) => setDepositRequired(c, b, -1))).rejects.toThrow(/không âm/);
    await expect(as(s.A, { role: 'TECHNICIAN' }, (c) => setDepositRequired(c, b, 1))).rejects.toThrow(ForbiddenError);
    await setStatus(b, 'ACTIVE');
    await expect(as(s.A, {}, (c) => setDepositRequired(c, b, 100_000))).rejects.toThrow(/chưa giao/);
  });
});

describe('thanh toán', () => {
  it('ghi tiền thuê; đơn báo giá chưa được thu tiền; số tiền sai bị từ chối bằng tiếng Việt', async () => {
    const s = await shop();
    const q = await booking(s, 'QUOTE');
    await expect(pay(s, {}, { bookingId: q })).rejects.toThrow(/Đơn còn là báo giá/);
    const b = await booking(s);
    await pay(s, {}, { bookingId: b, amount: 200_000, reference: 'CK 123', method: 'BANK_TRANSFER' });
    const l = await ledger(s, b);
    expect(l.payments).toHaveLength(1);
    expect(l.payments[0]).toMatchObject({ kind: 'RENT', method: 'BANK_TRANSFER', amount: 200_000, reference: 'CK 123' });
    expect(l.paymentStatus).toBe('PARTIAL');
    for (const amount of [0, -5, 1.5, 2_000_000_000_000]) await expect(pay(s, {}, { bookingId: b, amount })).rejects.toThrow(/số nguyên dương/);
    await expect(pay(s, {}, { bookingId: b, kind: 'KHAC' as never })).rejects.toThrow(/Loại khoản thu/);
    await expect(pay(s, {}, { bookingId: b, method: 'VANG' as never })).rejects.toThrow(/Hình thức/);
  });

  it('không thu vượt số còn phải thu; thu đủ thì "đã thanh toán"', async () => {
    const s = await shop();
    const b = await booking(s); // 500.000
    await expect(pay(s, {}, { bookingId: b, amount: 500_001 })).rejects.toThrow(/vượt quá tiền thuê còn phải thu \(500\.000 đ\)/);
    await pay(s, {}, { bookingId: b, amount: 300_000 });
    await expect(pay(s, {}, { bookingId: b, amount: 300_000 })).rejects.toThrow(/200\.000 đ/);
    await pay(s, {}, { bookingId: b, amount: 200_000 });
    expect((await ledger(s, b)).paymentStatus).toBe('PAID');
  });

  it('khóa chống trùng: gửi lại cùng một form không tạo khoản thứ hai; dùng cho đơn khác bị từ chối', async () => {
    const s = await shop();
    const b = await booking(s);
    const key = 'form-abc-123';
    const first = await pay(s, {}, { bookingId: b, amount: 100_000, idempotencyKey: key });
    const second = await pay(s, {}, { bookingId: b, amount: 100_000, idempotencyKey: key });
    expect([first.duplicate, second.duplicate]).toEqual([false, true]);
    expect(second.id).toBe(first.id);
    expect((await ledger(s, b)).payments).toHaveLength(1);
    const other = await booking(s, 'CONFIRMED', { start: new Date(NOW + 10 * D), end: new Date(NOW + 11 * D) });
    await expect(pay(s, {}, { bookingId: other, amount: 100_000, idempotencyKey: key })).rejects.toThrow(/đã được dùng cho đơn khác/);
  });

  it('bấm nhiều lần cùng lúc cùng một khóa: đúng một khoản được ghi', async () => {
    const s = await shop();
    const b = await booking(s);
    const res = await Promise.all(Array.from({ length: 6 }, () => pay(s, {}, { bookingId: b, amount: 100_000, idempotencyKey: 'dbl-click' })));
    expect(res.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(res.map((r) => r.id)).size).toBe(1);
    expect((await ledger(s, b)).settlement.received).toBe(100_000);
  });

  it('hai người thu cùng lúc: tổng không bao giờ vượt số còn phải thu', async () => {
    const s = await shop();
    const b = await booking(s); // còn phải thu 500.000
    const res = await Promise.allSettled([pay(s, {}, { bookingId: b, amount: 300_000 }), pay(s, {}, { bookingId: b, amount: 300_000 }), pay(s, {}, { bookingId: b, amount: 300_000 })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of res) if (r.status === 'rejected') expect(r.reason.message).toMatch(/vượt quá tiền thuê còn phải thu/);
    expect((await ledger(s, b)).settlement.received).toBe(300_000);
  });

  it('phân quyền: nhân viên quầy thu được tiền thuê và cọc nhưng không hoàn tiền/xóa nợ; kỹ thuật viên không thấy tiền', async () => {
    const s = await shop();
    const b = await booking(s);
    await pay(s, { role: 'STAFF' }, { bookingId: b, amount: 100_000 });
    await pay(s, { role: 'STAFF' }, { bookingId: b, kind: 'DEPOSIT', amount: 1_000_000 });
    await expect(pay(s, { role: 'STAFF' }, { bookingId: b, kind: 'REFUND', amount: 1 })).rejects.toThrow(ForbiddenError);
    await expect(pay(s, { role: 'STAFF' }, { bookingId: b, kind: 'WRITE_OFF', amount: 1, note: 'x' })).rejects.toThrow(ForbiddenError);
    await expect(pay(s, { role: 'TECHNICIAN' }, { bookingId: b })).rejects.toThrow(ForbiddenError);
    await expect(ledger(s, b, { role: 'TECHNICIAN' })).rejects.toThrow(ForbiddenError);
    await expect(ledger(s, b, { support: true })).resolves.toBeDefined(); // phiên hỗ trợ có quyền xem sổ như quản lý
  });

  it('gói tắt tính năng, tenant chỉ đọc', async () => {
    const s = await shop();
    const b = await booking(s);
    await expect(pay(s, { off: ['payments'] }, { bookingId: b })).rejects.toThrow(FeatureDisabledError);
    await expect(pay(s, { off: ['deposit'] }, { bookingId: b, kind: 'DEPOSIT' })).rejects.toThrow(FeatureDisabledError);
    await expect(pay(s, { off: ['deposit'] }, { bookingId: b, amount: 100_000 })).resolves.toBeDefined(); // thu tiền thuê không cần gói cọc
    await expect(pay(s, { status: 'READ_ONLY' }, { bookingId: b })).rejects.toThrow(ReadOnlyError);
    await expect(ledger(s, b, { status: 'READ_ONLY' })).resolves.toBeDefined();
  });

  it('cô lập tenant: không thu tiền, không xem sổ của đơn tenant khác', async () => {
    const s = await shop();
    const B = await mkTenant(t);
    const b = await booking(s);
    await expect(as(B, {}, (c) => recordPayment(c, { bookingId: b, kind: 'RENT', method: 'CASH', amount: 1000 }))).rejects.toThrow(/Không tìm thấy/);
    await expect(as(B, {}, (c) => bookingLedger(c, b))).rejects.toThrow(/Không tìm thấy/);
    expect(await as(B, {}, (c) => depositLedger(c))).toEqual([]);
  });
});

describe('hoàn tiền, xóa nợ, hủy khoản', () => {
  it('chỉ hoàn sau khi nhận lại thiết bị hoặc hủy đơn, không vượt số phải hoàn', async () => {
    const s = await shop();
    const b = await booking(s);
    await pay(s, {}, { bookingId: b, amount: 500_000 });
    await pay(s, {}, { bookingId: b, kind: 'DEPOSIT', amount: 2_000_000 });
    await setStatus(b, 'ACTIVE');
    await expect(pay(s, {}, { bookingId: b, kind: 'REFUND', amount: 1_000_000 })).rejects.toThrow(/sau khi đã nhận lại thiết bị/);
    await setStatus(b, 'RETURNED');
    await expect(pay(s, {}, { bookingId: b, kind: 'REFUND', amount: 2_000_001 })).rejects.toThrow(/vượt quá số cửa hàng phải hoàn \(2\.000\.000 đ\)/);
    await pay(s, {}, { bookingId: b, kind: 'REFUND', amount: 1_500_000 });
    await expect(pay(s, {}, { bookingId: b, kind: 'REFUND', amount: 600_000 })).rejects.toThrow(/500\.000 đ/);
    await pay(s, {}, { bookingId: b, kind: 'REFUND', amount: 500_000 });
    expect((await ledger(s, b)).settlement).toMatchObject({ settled: true, refundDue: 0 });
  });

  it('phí phát sinh được trừ vào cọc trước khi hoàn', async () => {
    const s = await shop();
    const b = await booking(s);
    await pay(s, {}, { bookingId: b, amount: 500_000 });
    await pay(s, {}, { bookingId: b, kind: 'DEPOSIT', amount: 2_000_000 });
    await setStatus(b, 'ACTIVE');
    await as(s.A, { role: 'STAFF' }, (c) => addFee(c, b, { kind: 'DAMAGE', description: 'Trầy ống kính', amount: 300_000 }));
    await setStatus(b, 'RETURNED');
    const l = await ledger(s, b);
    expect(l.settlement).toMatchObject({ charges: 800_000, depositApplied: 300_000, refundDue: 1_700_000 });
    await expect(pay(s, {}, { bookingId: b, kind: 'REFUND', amount: 1_700_001 })).rejects.toThrow(/1\.700\.000 đ/);
    await pay(s, {}, { bookingId: b, kind: 'REFUND', amount: 1_700_000 });
    expect((await ledger(s, b)).settlement.settled).toBe(true);
  });

  it('cọc không đủ bù phí: khách trả thêm bằng "phí phát sinh"; không trả thừa', async () => {
    const s = await shop();
    const b = await booking(s);
    await pay(s, {}, { bookingId: b, amount: 500_000 });
    await pay(s, {}, { bookingId: b, kind: 'DEPOSIT', amount: 200_000 });
    await setStatus(b, 'ACTIVE');
    await as(s.A, {}, (c) => addFee(c, b, { kind: 'LOSS', description: 'Mất pin', amount: 1_000_000 }));
    await setStatus(b, 'RETURNED');
    expect((await ledger(s, b)).settlement).toMatchObject({ balanceOwed: 800_000, depositApplied: 200_000 });
    await expect(pay(s, {}, { bookingId: b, kind: 'FEE', amount: 1_000_001 })).rejects.toThrow(/vượt quá phí còn phải thu/);
    await pay(s, {}, { bookingId: b, kind: 'FEE', amount: 800_000 });
    expect((await ledger(s, b)).settlement).toMatchObject({ balanceOwed: 0, refundDue: 0, settled: true });
  });

  it('xóa nợ cần quyền quản lý, có lý do, chỉ khi đã nhận lại thiết bị, không vượt số nợ', async () => {
    const s = await shop();
    const b = await booking(s);
    await pay(s, {}, { bookingId: b, amount: 500_000 });
    await setStatus(b, 'ACTIVE');
    await as(s.A, {}, (c) => addFee(c, b, { kind: 'OTHER', description: 'Phí vệ sinh', amount: 100_000 }));
    await expect(pay(s, {}, { bookingId: b, kind: 'WRITE_OFF', amount: 100_000, note: 'Khách quen' })).rejects.toThrow(/đã nhận lại thiết bị/);
    await setStatus(b, 'RETURNED');
    await expect(pay(s, {}, { bookingId: b, kind: 'WRITE_OFF', amount: 100_000 })).rejects.toThrow(/lý do/);
    await expect(pay(s, {}, { bookingId: b, kind: 'WRITE_OFF', amount: 100_001, note: 'x' })).rejects.toThrow(/vượt quá số khách còn nợ/);
    await pay(s, {}, { bookingId: b, kind: 'WRITE_OFF', amount: 100_000, note: 'Khách quen, miễn phí vệ sinh' });
    expect((await ledger(s, b)).settlement).toMatchObject({ balanceOwed: 0, settled: true, writtenOff: 100_000 });
  });

  it('hủy khoản thu: cần quản lý và lý do; không xóa dữ liệu; số dư tính lại; đơn đóng thì không hủy', async () => {
    const s = await shop();
    const b = await booking(s);
    const { id } = await pay(s, {}, { bookingId: b, amount: 500_000 });
    await expect(as(s.A, { role: 'STAFF' }, (c) => voidPayment(c, id, 'nhầm'))).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, {}, (c) => voidPayment(c, id, '  '))).rejects.toThrow(/lý do/);
    await as(s.A, {}, (c) => voidPayment(c, id, 'Nhập nhầm số tiền'));
    const l = await ledger(s, b);
    expect(l.payments).toHaveLength(1); // vẫn còn dòng, đánh dấu đã hủy
    expect(l.payments[0]).toMatchObject({ voidReason: 'Nhập nhầm số tiền' });
    expect(l.settlement.received).toBe(0);
    await expect(as(s.A, {}, (c) => voidPayment(c, id, 'lần nữa'))).rejects.toThrow(/đã được hủy/);
    await pay(s, {}, { bookingId: b, amount: 500_000 }); // nhập lại được
    await setStatus(b, 'CLOSED');
    const live = (await ledger(s, b)).payments.find((p) => !p.voidedAt)!;
    await expect(as(s.A, {}, (c) => voidPayment(c, live.id, 'x'))).rejects.toThrow(/Đơn đã đóng/);
  });

  it('hủy khoản phí tương tự', async () => {
    const s = await shop();
    const b = await booking(s);
    await setStatus(b, 'ACTIVE');
    const fee = await as(s.A, {}, (c) => addFee(c, b, { kind: 'OTHER', description: 'Phí', amount: 50_000 }));
    expect((await ledger(s, b)).settlement.fees).toBe(50_000);
    await expect(as(s.A, { role: 'STAFF' }, (c) => voidFee(c, fee, 'nhầm'))).rejects.toThrow(ForbiddenError);
    await as(s.A, {}, (c) => voidFee(c, fee, 'Tính nhầm'));
    expect((await ledger(s, b)).settlement.fees).toBe(0);
  });

  it('thêm phí: chỉ đơn đang thuê/đã nhận lại; kiểm tra đầu vào', async () => {
    const s = await shop();
    const b = await booking(s);
    await expect(as(s.A, {}, (c) => addFee(c, b, { kind: 'OTHER', description: 'x', amount: 1000 }))).rejects.toThrow(/đang thuê hoặc đã nhận lại/);
    await setStatus(b, 'ACTIVE');
    await expect(as(s.A, {}, (c) => addFee(c, b, { kind: 'OTHER', description: '  ', amount: 1000 }))).rejects.toThrow(/mô tả/);
    await expect(as(s.A, {}, (c) => addFee(c, b, { kind: 'OTHER', description: 'x', amount: 0 }))).rejects.toThrow(/số nguyên dương/);
    await expect(as(s.A, {}, (c) => addFee(c, b, { kind: 'SAI' as never, description: 'x', amount: 5 }))).rejects.toThrow(/Loại phí/);
    await expect(as(s.A, { role: 'TECHNICIAN' }, (c) => addFee(c, b, { kind: 'OTHER', description: 'x', amount: 5 }))).rejects.toThrow(ForbiddenError);
  });

  it('đơn hủy sau khi cọc: hoàn cọc rồi đóng sổ', async () => {
    const s = await shop();
    const b = await booking(s);
    await pay(s, {}, { bookingId: b, kind: 'DEPOSIT', amount: 500_000 });
    await setStatus(b, 'CANCELLED');
    const l = await ledger(s, b);
    expect(l.settlement).toMatchObject({ charges: 0, refundDue: 500_000 }); // đơn hủy không còn tiền thuê
    await pay(s, {}, { bookingId: b, kind: 'REFUND', amount: 500_000 });
    expect((await ledger(s, b)).paymentStatus).toBe('REFUNDED');
  });
});

describe('sổ cái bất biến ở tầng DB', () => {
  it('app role không xóa, không sửa số tiền, chỉ được đánh dấu hủy', async () => {
    const s = await shop();
    const b = await booking(s);
    await pay(s, {}, { bookingId: b, amount: 100_000 });
    await expect(withTenantId(t.app, s.A, (db) => db.query('DELETE FROM payment'))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, s.A, (db) => db.query('UPDATE payment SET amount=1'))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, s.A, (db) => db.query("UPDATE payment SET kind='REFUND'"))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, s.A, (db) => db.query("UPDATE payment SET voided_at=now()"))).rejects.toThrow(/payment_void_pair/); // phải kèm lý do
    await expect(withTenantId(t.app, s.A, (db) => db.query("UPDATE payment SET voided_at=now(), void_reason='x'"))).resolves.toBeDefined();
    await expect(withTenantId(t.app, s.A, (db) => db.query('DELETE FROM booking_fee'))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, s.A, (db) => db.query('DELETE FROM handover'))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, s.A, (db) => db.query('UPDATE handover SET notes=$1', ['x']))).rejects.toThrow(/permission denied/);
  });

  it('DB chặn khoản âm, loại sai, xóa nợ thiếu lý do; không xóa cứng được đơn đã có thanh toán', async () => {
    const s = await shop();
    const b = await booking(s);
    const ins = (kind: string, amount: number, note: string | null = null) => withTenantId(t.app, s.A, (db) => db.query(
      'INSERT INTO payment(tenant_id,booking_id,kind,method,amount,note) VALUES ($1,$2,$3,$4,$5,$6)', [s.A, b, kind, 'CASH', amount, note]));
    await expect(ins('RENT', -5)).rejects.toThrow(/check/i);
    await expect(ins('RENT', 0)).rejects.toThrow(/check/i);
    await expect(ins('LA', 10)).rejects.toThrow(/check/i);
    await expect(ins('WRITE_OFF', 10)).rejects.toThrow(/payment_writeoff_has_note/);
    await pay(s, {}, { bookingId: b, amount: 100_000 });
    await expect(withTenantId(t.app, s.A, (db) => db.query('DELETE FROM booking WHERE id=$1', [b]))).rejects.toThrow(/foreign key|violates/i);
  });
});

describe('tài sản thế chấp', () => {
  it('nhận tài sản có ảnh; ảnh sai định dạng bị từ chối và không để lại file mồ côi', async () => {
    const s = await shop();
    const b = await booking(s);
    const st = new MemoryStorage();
    const id = await as(s.A, { role: 'STAFF', storage: st }, (c) => addDepositAsset(c, b, { description: 'CCCD gốc', estimatedValue: 0, storageLocation: 'Tủ A', photos: [{ data: PNG }, { data: JPG }] }));
    expect(st.files.size).toBe(2);
    const l = await ledger(s, b);
    expect(l.assets[0]).toMatchObject({ id, description: 'CCCD gốc', status: 'HELD', photoCount: 2, storageLocation: 'Tủ A' });
    const st2 = new MemoryStorage();
    await expect(as(s.A, { storage: st2 }, (c) => addDepositAsset(c, b, { description: 'Laptop', photos: [{ data: PNG }, { data: GIF }] }))).rejects.toThrow(/JPG, PNG/);
    expect(st2.files.size).toBe(0);
    await expect(as(s.A, {}, (c) => addDepositAsset(c, b, { description: '  ' }))).rejects.toThrow(/mô tả/);
    await expect(as(s.A, {}, (c) => addDepositAsset(c, b, { description: 'x', estimatedValue: -1 }))).rejects.toThrow(/không âm/);
    await expect(as(s.A, {}, (c) => addDepositAsset(c, b, { description: 'x', photos: Array(7).fill({ data: PNG }) }))).rejects.toThrow(/Tối đa 6/);
    await expect(as(s.A, { role: 'TECHNICIAN' }, (c) => addDepositAsset(c, b, { description: 'x' }))).rejects.toThrow(ForbiddenError);
    const q = await booking(s, 'QUOTE');
    await expect(as(s.A, {}, (c) => addDepositAsset(c, q, { description: 'x' }))).rejects.toThrow(/đã giữ chỗ/);
  });

  it('giá trị tài sản tính vào mức cọc yêu cầu', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateFinanceSettings(c, { deposit: { mode: 'FIXED', value: 5_000_000 } }));
    const b = await booking(s);
    await pay(s, {}, { bookingId: b, kind: 'DEPOSIT', amount: 2_000_000 });
    expect((await ledger(s, b)).deposit).toMatchObject({ heldMoney: 2_000_000, heldAssets: 0, shortfall: 3_000_000, satisfied: false });
    await as(s.A, {}, (c) => addDepositAsset(c, b, { description: 'Xe máy Wave', estimatedValue: 3_000_000 }));
    expect((await ledger(s, b)).deposit).toMatchObject({ heldAssets: 3_000_000, shortfall: 0, satisfied: true });
  });

  it('trả tài sản: chỉ sau khi nhận lại; khách còn nợ thì giữ, quản lý mới ép trả được', async () => {
    const s = await shop();
    const b = await booking(s);
    const a = await as(s.A, {}, (c) => addDepositAsset(c, b, { description: 'CCCD gốc' }));
    await expect(as(s.A, {}, (c) => returnDepositAsset(c, a, 'ok'))).rejects.toThrow(/sau khi đã nhận lại thiết bị/);
    await setStatus(b, 'ACTIVE');
    await as(s.A, {}, (c) => addFee(c, b, { kind: 'OTHER', description: 'Phí', amount: 100_000 }));
    await setStatus(b, 'RETURNED'); // tiền thuê 500.000 + phí 100.000 chưa trả
    await expect(as(s.A, { role: 'STAFF' }, (c) => returnDepositAsset(c, a, 'ok'))).rejects.toThrow(/còn nợ 600\.000 đ nên chưa trả/);
    await expect(as(s.A, { role: 'STAFF' }, (c) => returnDepositAsset(c, a, 'ok', { force: true }))).rejects.toThrow(ForbiddenError);
    await as(s.A, { role: 'MANAGER' }, (c) => returnDepositAsset(c, a, 'Quản lý cho phép', { force: true }));
    expect((await ledger(s, b)).assets[0]).toMatchObject({ status: 'RETURNED', returnNote: 'Quản lý cho phép' });
    await expect(as(s.A, {}, (c) => returnDepositAsset(c, a, 'lần nữa'))).rejects.toThrow(/đã được trả/);
  });

  it('sổ theo dõi cọc liệt kê đơn đang giữ tiền hoặc tài sản; hết giữ thì biến mất', async () => {
    const s = await shop();
    const b1 = await booking(s);
    const b2 = await booking(s, 'CONFIRMED', { start: new Date(NOW + 10 * D), end: new Date(NOW + 11 * D) });
    await pay(s, {}, { bookingId: b1, kind: 'DEPOSIT', amount: 1_000_000 });
    await as(s.A, {}, (c) => addDepositAsset(c, b2, { description: 'Laptop Dell', estimatedValue: 8_000_000, storageLocation: 'Két' }));
    const led = await as(s.A, {}, (c) => depositLedger(c));
    expect(led.map((r) => r.bookingId).sort()).toEqual([b1, b2].sort());
    expect(led.find((r) => r.bookingId === b1)).toMatchObject({ heldMoney: 1_000_000, customerName: 'Nguyễn Văn An' });
    expect(led.find((r) => r.bookingId === b2)!.assets[0]).toMatchObject({ description: 'Laptop Dell', value: 8_000_000, location: 'Két' });
    await setStatus(b1, 'RETURNED');
    await pay(s, {}, { bookingId: b1, kind: 'RENT', amount: 500_000 });
    await pay(s, {}, { bookingId: b1, kind: 'REFUND', amount: 1_000_000 });
    expect((await as(s.A, {}, (c) => depositLedger(c))).map((r) => r.bookingId)).toEqual([b2]);
    await expect(as(s.A, { role: 'TECHNICIAN' }, (c) => depositLedger(c))).rejects.toThrow(ForbiddenError);
  });
});

describe('mã VietQR thu tiền', () => {
  it('chưa cài tài khoản thì báo cách khắc phục; có tài khoản thì sinh mã hợp lệ với nội dung là số đơn', async () => {
    const s = await shop();
    const b = await booking(s);
    await expect(as(s.A, {}, (c) => vietQrFor(c, b, 100_000))).rejects.toThrow(/Cài đặt → Tài chính/);
    await as(s.A, {}, (c) => updateFinanceSettings(c, { bank: { bin: '970415', account: '113366668888', accountName: 'CUA HANG DEMO' } }));
    const qr = await as(s.A, { role: 'STAFF' }, (c) => vietQrFor(c, b, 123_000));
    expect(verifyVietQr(qr.payload)).toBe(true);
    const top = parseTlv(qr.payload);
    expect(top.find((x) => x.id === '54')!.value).toBe('123000');
    expect(parseTlv(top.find((x) => x.id === '62')!.value)[0]!.value).toMatch(/^DT-\d{4}-\d{5}$/);
    expect(qr.bankLabel).toContain('8888');
    expect(qr.bankLabel).not.toContain('113366668888');
    const stat = await as(s.A, {}, (c) => vietQrFor(c, b));
    expect(parseTlv(stat.payload).find((x) => x.id === '01')!.value).toBe('11'); // không số tiền → mã tĩnh
    await expect(as(s.A, {}, (c) => vietQrFor(c, b, -5))).rejects.toThrow(/số nguyên dương/);
    await expect(as(s.A, { role: 'TECHNICIAN' }, (c) => vietQrFor(c, b, 1000))).rejects.toThrow(ForbiddenError);
  });
});

it('ValidationError là lỗi hiển thị được', () => expect(new ValidationError('x').name).toBe('ValidationError'));
