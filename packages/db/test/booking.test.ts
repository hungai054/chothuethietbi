import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { mkTenant, runAs, type Opts } from './ctx';
import {
  availability, cancelBooking, confirmBooking, createBooking, createCustomer, createModel, createUnits, ensureDefaultPriceList, extendBooking, getBooking,
  getBookingSettings, holdBooking, listBookings, moveBooking, releaseExpiredHolds, setBlacklist, setRule, shortenBooking, swapUnit, timeline, todayBoard,
  transitionUnit, updateBookingSettings, updatePricingSettings, ReadOnlyError, ValidationError, withTenantId, type CreateBookingInput,
} from '../src';
import { ForbiddenError, InvalidBookingTransitionError, type PriceRule } from '@rentpro/core';
import { FeatureDisabledError } from '@rentpro/tenancy';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb(54334);
  await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')");
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);

const H = 3_600_000;
const T0 = new Date('2026-11-02T01:00:00Z'); // 08:00 giờ Việt Nam
const at = (h: number) => new Date(T0.getTime() + h * H);
const RULE: PriceRule = { hour: 100_000, day: 500_000, week: 2_500_000, month: null, minHours: 0 };

/** Cửa hàng mẫu: 1 mẫu theo từng chiếc (3 chiếc, đệm 2 giờ), 1 mẫu theo số lượng (tồn 10), 1 khách. */
async function shop() {
  const A = await mkTenant(t);
  const cam = await as(A, {}, (c) => createModel(c, { name: 'Sony A7', barcodePrefix: 'CAM', bufferMinutes: 120 }));
  const units = await as(A, {}, (c) => createUnits(c, { modelId: cam, quantity: 3 }));
  const cable = await as(A, {}, (c) => createModel(c, { name: 'Cáp HDMI', tracked: false, stockQty: 10 }));
  const list = await as(A, {}, (c) => ensureDefaultPriceList(c));
  await as(A, {}, (c) => setRule(c, list, cam, RULE));
  await as(A, {}, (c) => setRule(c, list, cable, { hour: null, day: 50_000, week: null, month: null, minHours: 0 }));
  const cust = await as(A, {}, (c) => createCustomer(c, { name: 'Nguyễn Văn An', phone: '0901234567' }));
  return { A, cam, units, cable, cust };
}

type Shop = Awaited<ReturnType<typeof shop>>;
const book = (s: Shop, o: Opts, over: Partial<CreateBookingInput> & { qty?: number; unitId?: string; model?: string } = {}) =>
  as(s.A, o, (c) => createBooking(c, {
    customerId: s.cust, start: at(0), end: at(24), status: 'HOLD',
    lines: [{ modelId: over.model ?? s.cam, qty: over.qty ?? 1, unitId: over.unitId ?? null }], ...over,
  }));
const allocs = async (id: string) => (await t.admin.query('SELECT unit_id, status, lower(period) AS s, upper(period) AS e FROM unit_allocation WHERE booking_id=$1 ORDER BY unit_id', [id])).rows;
const status = async (id: string) => (await t.admin.query('SELECT status, cancel_reason FROM booking WHERE id=$1', [id])).rows[0];

describe('tạo đơn', () => {
  it('báo giá không chiếm lịch; có giá từ bảng giá; số đơn tăng dần theo từng cửa hàng', async () => {
    const s = await shop();
    const q1 = await book(s, {}, { status: 'QUOTE' });
    const q2 = await book(s, {}, { status: 'QUOTE' });
    expect(q1.code).toMatch(/^DT-\d{4}-00001$/);
    expect(q2.code).toMatch(/^DT-\d{4}-00002$/);
    expect(await allocs(q1.id)).toHaveLength(0);
    const { booking, lines } = await as(s.A, {}, (c) => getBooking(c, q1.id));
    expect([booking.status, booking.total, lines[0]!.lineTotal]).toEqual(['QUOTE', 500_000, 500_000]);
    expect(booking.quote?.lines[0]?.parts[0]).toMatchObject({ unit: 'day', count: 1 });
    // cửa hàng khác bắt đầu từ 00001
    const s2 = await shop();
    expect((await book(s2, {}, { status: 'QUOTE' })).code).toMatch(/00001$/);
  });

  it('giữ chỗ: tự chọn chiếc rảnh, đặt hạn giữ theo cấu hình (mặc định 24 giờ)', async () => {
    const s = await shop();
    const b = await book(s, {});
    const a = await allocs(b.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.status).toBe('HOLD');
    const row = (await t.admin.query('SELECT hold_expires_at FROM booking WHERE id=$1', [b.id])).rows[0];
    const ms = row.hold_expires_at.getTime() - Date.now();
    expect(ms).toBeGreaterThan(23.9 * H);
    expect(ms).toBeLessThan(24.1 * H);
    // khoảng chiếm = thời gian thuê + 2 giờ đệm
    expect(a[0]!.e.getTime() - at(24).getTime()).toBe(2 * H);
    await as(s.A, {}, (c) => updateBookingSettings(c, { holdHours: 48 }));
    const b2 = await book(s, {}, { start: at(100), end: at(124) });
    const r2 = (await t.admin.query('SELECT hold_expires_at FROM booking WHERE id=$1', [b2.id])).rows[0];
    expect(r2.hold_expires_at.getTime() - Date.now()).toBeGreaterThan(47.9 * H);
  });

  it('xác nhận thẳng: chiếm lịch, trạng thái CONFIRMED, có nhật ký', async () => {
    const s = await shop();
    const b = await book(s, {}, { status: 'CONFIRMED' });
    expect((await allocs(b.id))[0]!.status).toBe('CONFIRMED');
    const d = await as(s.A, {}, (c) => getBooking(c, b.id));
    expect(d.booking.holdExpiresAt).toBeNull();
    expect(d.history.map((h) => h.to_status)).toEqual(['CONFIRMED']);
  });

  it('nhiều chiếc một dòng: chọn đủ số chiếc khác nhau; thiếu thì báo còn bao nhiêu kèm thời điểm sớm nhất, và không để lại gì', async () => {
    const s = await shop();
    const b = await book(s, {}, { qty: 2 });
    expect(new Set((await allocs(b.id)).map((x) => x.unit_id)).size).toBe(2);
    const fail = await book(s, {}, { qty: 2, start: at(1), end: at(10) }).catch((e) => e);
    expect(fail).toBeInstanceOf(ValidationError);
    expect(fail.message).toMatch(/cần 2 chiếc, chỉ còn 1 chiếc rảnh/);
    expect(fail.message).toMatch(/Thời điểm sớm nhất có đủ 2 chiếc/);
    expect((await t.admin.query('SELECT count(*)::int AS n FROM booking WHERE tenant_id=$1', [s.A])).rows[0].n).toBe(1); // đơn lỗi không được lưu
    expect((await t.admin.query('SELECT count(*)::int AS n FROM unit_allocation WHERE tenant_id=$1', [s.A])).rows[0].n).toBe(2);
  });

  it('đặt đích danh: trùng thì báo chiếc khác còn rảnh và khung trống gần nhất của chính chiếc đó', async () => {
    const s = await shop();
    await book(s, {}, { unitId: s.units[0]!.id });
    const e = await book(s, {}, { unitId: s.units[0]!.id, start: at(10), end: at(20) }).catch((x) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.message).toContain(s.units[0]!.barcode);
    expect(e.message).toContain(`Còn rảnh cùng mẫu: ${s.units[1]!.barcode}, ${s.units[2]!.barcode}`);
    expect(e.message).toMatch(/Khung trống gần nhất.*bắt đầu lúc/);
  });

  it('liền kề được, nhưng phải chừa thời gian đệm', async () => {
    const s = await shop();
    const u = s.units[0]!.id;
    await book(s, {}, { unitId: u, start: at(0), end: at(24) }); // chiếm đến 26h (đệm 2h)
    await expect(book(s, {}, { unitId: u, start: at(25), end: at(48) })).rejects.toThrow(/đã được đặt/); // nằm trong đệm
    await expect(book(s, {}, { unitId: u, start: at(26), end: at(48) })).resolves.toBeDefined(); // đúng lúc hết đệm
    // đặt TRƯỚC một đơn khác cũng phải chừa đệm: đơn mới kết thúc lúc 0h thì đệm 2h chồng sang đơn bắt đầu 0h
    await expect(book(s, {}, { unitId: u, start: at(-20), end: at(-1) })).rejects.toThrow(/đã được đặt/);
    await expect(book(s, {}, { unitId: u, start: at(-20), end: at(-2) })).resolves.toBeDefined();
  });

  it('thiết bị bảo trì/mất/thanh lý không đặt được; chiếc sai mẫu, chọn trùng chiếc, số lượng sai bị từ chối', async () => {
    const s = await shop();
    const await_list = await as(s.A, {}, (c) => ensureDefaultPriceList(c));
    await as(s.A, {}, (c) => transitionUnit(c, s.units[0]!.id, 'MAINTENANCE', { reason: 'Vệ sinh' }));
    await expect(book(s, {}, { unitId: s.units[0]!.id })).rejects.toThrow(/không sẵn sàng/);
    // tự chọn thì bỏ qua chiếc bảo trì
    const b = await book(s, {}, { qty: 2 });
    expect((await allocs(b.id)).map((x) => x.unit_id)).not.toContain(s.units[0]!.id);
    await expect(book(s, {}, { unitId: s.units[1]!.id, qty: 2 })).rejects.toThrow(/số lượng là 1/);
    await expect(as(s.A, {}, (c) => createBooking(c, { customerId: s.cust, start: at(0), end: at(5), lines: [{ modelId: s.cam, qty: 1, unitId: s.units[1]!.id }, { modelId: s.cam, qty: 1, unitId: s.units[1]!.id }] }))).rejects.toThrow(/hai lần/);
    const other = await as(s.A, {}, (c) => createModel(c, { name: 'Khác' }));
    await as(s.A, {}, (c) => setRule(c, await_list, other, RULE));
    await expect(book(s, {}, { model: other, unitId: s.units[1]!.id })).rejects.toThrow(/Không tìm thấy/);
  });

  it('kiểm tra đầu vào: thời gian, danh sách trống, khách đen, mẫu chưa có giá', async () => {
    const s = await shop();
    await expect(book(s, {}, { start: at(5), end: at(5) })).rejects.toThrow(/sau thời gian bắt đầu/);
    await expect(book(s, {}, { lines: [] })).rejects.toThrow(/Chưa chọn thiết bị/);
    await expect(book(s, {}, { qty: 0 })).rejects.toThrow(/từ 1 đến 1000/);
    const nop = await as(s.A, {}, (c) => createModel(c, { name: 'Chưa có giá' }));
    await expect(book(s, {}, { model: nop })).rejects.toThrow(/chưa có bảng giá/);
    await as(s.A, {}, (c) => setBlacklist(c, s.cust, true, 'Quỵt tiền'));
    await expect(book(s, {}, {})).rejects.toThrow(/danh sách đen: Quỵt tiền/);
  });

  it('hàng theo số lượng: không đặt vượt tồn kho, đơn không trùng giờ thì độc lập', async () => {
    const s = await shop();
    await book(s, {}, { model: s.cable, qty: 6 });
    const e = await book(s, {}, { model: s.cable, qty: 5, start: at(5), end: at(10) }).catch((x) => x);
    expect(e.message).toMatch(/cần 5, chỉ còn 4/);
    await expect(book(s, {}, { model: s.cable, qty: 4, start: at(5), end: at(10) })).resolves.toBeDefined();
    await expect(book(s, {}, { model: s.cable, qty: 10, start: at(48), end: at(60) })).resolves.toBeDefined();
  });
});

describe('đặt đồng thời: không bao giờ đặt trùng', () => {
  it('8 người cùng đặt đích danh một chiếc: đúng 1 người thành công, 7 người nhận thông báo rõ ràng', async () => {
    const s = await shop();
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => book(s, {}, { unitId: s.units[0]!.id })));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of res) if (r.status === 'rejected') expect(r.reason.message).toMatch(/đã được đặt/);
    expect((await t.admin.query('SELECT count(*)::int AS n FROM booking WHERE tenant_id=$1', [s.A])).rows[0].n).toBe(1);
  });

  it('8 người cùng đặt một chiếc bất kỳ của mẫu có 3 chiếc: đúng 3 người thành công, mỗi người một chiếc khác nhau', async () => {
    const s = await shop();
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => book(s, {})));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of res) if (r.status === 'rejected') expect(r.reason.message).toMatch(/chỉ còn 0 chiếc rảnh/);
    const rows = (await t.admin.query("SELECT unit_id FROM unit_allocation WHERE tenant_id=$1 AND status='HOLD'", [s.A])).rows;
    expect(new Set(rows.map((r) => r.unit_id)).size).toBe(3);
  });

  it('hàng theo số lượng: 6 người cùng đặt 3 trên tồn 10 thì đúng 3 người thành công', async () => {
    const s = await shop();
    const res = await Promise.allSettled(Array.from({ length: 6 }, () => book(s, {}, { model: s.cable, qty: 3 })));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await t.admin.query("SELECT COALESCE(sum(qty),0)::int AS n FROM qty_allocation WHERE tenant_id=$1 AND status='HOLD'", [s.A])).rows[0].n).toBe(9);
  });

  it('số đơn không trùng và không nhảy số dù nhiều đơn tạo cùng lúc (đơn lỗi không tiêu số)', async () => {
    const s = await shop();
    const res = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => book(s, {}, { status: 'QUOTE', start: at(i * 30), end: at(i * 30 + 24) })));
    const codes = res.map((r) => (r.status === 'fulfilled' ? r.value.code : '')).sort();
    expect(new Set(codes).size).toBe(6);
    expect(codes.map((c) => Number(c.slice(-5)))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('giữ chỗ hết hạn', () => {
  it('hết hạn thì tự hủy và trả lịch; người khác đặt được chiếc đó', async () => {
    const s = await shop();
    const b = await book(s, {}, { unitId: s.units[0]!.id });
    await expect(book(s, {}, { unitId: s.units[0]!.id })).rejects.toThrow(/đã được đặt/);
    await t.admin.query("UPDATE booking SET hold_expires_at = now() - interval '1 minute' WHERE id=$1", [b.id]);
    await expect(book(s, {}, { unitId: s.units[0]!.id })).resolves.toBeDefined();
    expect(await status(b.id)).toEqual({ status: 'CANCELLED', cancel_reason: 'Hết hạn giữ chỗ' });
    expect((await allocs(b.id))[0]!.status).toBe('RELEASED');
  });

  it('xác nhận giữ chỗ đã hết hạn thì báo rõ, không cứu được', async () => {
    const s = await shop();
    const b = await book(s, {});
    await t.admin.query("UPDATE booking SET hold_expires_at = now() - interval '1 second' WHERE id=$1", [b.id]);
    await expect(as(s.A, {}, (c) => confirmBooking(c, b.id))).rejects.toThrow(/hết hạn và được tự động hủy/);
  });

  it('releaseExpiredHolds trả về số đơn đã hủy; chỉ hủy giữ chỗ quá hạn, không đụng đơn khác', async () => {
    const s = await shop();
    const h1 = await book(s, {}, { start: at(0), end: at(5) });
    const h2 = await book(s, {}, { start: at(50), end: at(55) });
    const ok = await book(s, {}, { status: 'CONFIRMED', start: at(100), end: at(105) });
    await t.admin.query("UPDATE booking SET hold_expires_at = now() - interval '1 hour' WHERE id = ANY($1::uuid[])", [[h1.id, h2.id]]);
    expect(await as(s.A, {}, (c) => releaseExpiredHolds(c))).toBe(2);
    expect(await as(s.A, {}, (c) => releaseExpiredHolds(c))).toBe(0);
    expect((await status(ok.id)).status).toBe('CONFIRMED');
  });
});

describe('chuyển trạng thái', () => {
  it('báo giá → giữ chỗ → xác nhận; đơn đã xác nhận không giữ chỗ lại', async () => {
    const s = await shop();
    const q = await book(s, {}, { status: 'QUOTE' });
    await as(s.A, {}, (c) => holdBooking(c, q.id));
    expect((await status(q.id)).status).toBe('HOLD');
    expect(await allocs(q.id)).toHaveLength(1);
    await as(s.A, {}, (c) => confirmBooking(c, q.id));
    expect((await allocs(q.id))[0]!.status).toBe('CONFIRMED');
    await expect(as(s.A, {}, (c) => holdBooking(c, q.id))).rejects.toThrow(InvalidBookingTransitionError);
  });

  it('giữ chỗ từ báo giá thất bại nếu lịch đã bị người khác lấy', async () => {
    const s = await shop();
    const u = s.units[0]!.id;
    const q = await book(s, {}, { status: 'QUOTE', unitId: u });
    await book(s, {}, { unitId: u });
    await expect(as(s.A, {}, (c) => holdBooking(c, q.id))).rejects.toThrow(/đã được đặt/);
    expect((await status(q.id)).status).toBe('QUOTE'); // giao dịch hoàn tác, vẫn là báo giá
  });

  it('hủy cần lý do, trả lịch, chỉ hủy được khi chưa giao', async () => {
    const s = await shop();
    const u = s.units[0]!.id;
    const b = await book(s, {}, { status: 'CONFIRMED', unitId: u });
    await expect(as(s.A, {}, (c) => cancelBooking(c, b.id, '  '))).rejects.toThrow(/lý do/);
    await as(s.A, {}, (c) => cancelBooking(c, b.id, 'Khách đổi ý'));
    expect(await status(b.id)).toEqual({ status: 'CANCELLED', cancel_reason: 'Khách đổi ý' });
    await expect(book(s, {}, { unitId: u })).resolves.toBeDefined(); // lịch đã trả
    await expect(as(s.A, {}, (c) => cancelBooking(c, b.id, 'lần nữa'))).rejects.toThrow(InvalidBookingTransitionError);
    const b2 = await book(s, {}, { status: 'CONFIRMED', unitId: s.units[1]!.id });
    await t.admin.query("UPDATE booking SET status='ACTIVE' WHERE id=$1", [b2.id]);
    await expect(as(s.A, {}, (c) => cancelBooking(c, b2.id, 'x'))).rejects.toThrow(/Đang thuê.*Đã hủy/);
  });

  it('hủy hàng theo số lượng trả lại tồn kho', async () => {
    const s = await shop();
    const b = await book(s, {}, { model: s.cable, qty: 10 });
    await expect(book(s, {}, { model: s.cable, qty: 1 })).rejects.toThrow(/chỉ còn 0/);
    await as(s.A, {}, (c) => cancelBooking(c, b.id, 'Hủy'));
    await expect(book(s, {}, { model: s.cable, qty: 10 })).resolves.toBeDefined();
  });
});

describe('gia hạn, rút ngắn, dời lịch', () => {
  it('gia hạn tính thêm tiền theo giá đã chốt, kể cả khi bảng giá đã đổi sau đó', async () => {
    const s = await shop();
    const b = await book(s, {}, { status: 'CONFIRMED', start: at(0), end: at(48) });
    expect((await as(s.A, {}, (c) => getBooking(c, b.id))).booking.total).toBe(1_000_000);
    const list = await as(s.A, {}, (c) => ensureDefaultPriceList(c));
    await as(s.A, {}, (c) => setRule(c, list, s.cam, { ...RULE, day: 900_000 })); // giá mới không ảnh hưởng đơn cũ
    const r = await as(s.A, {}, (c) => extendBooking(c, b.id, at(96)));
    expect(r).toEqual({ oldTotal: 1_000_000, newTotal: 2_000_000, delta: 1_000_000 });
    const d = await as(s.A, {}, (c) => getBooking(c, b.id));
    expect([d.booking.endsAt.getTime(), d.booking.extendedCount]).toEqual([at(96).getTime(), 1]);
    expect((await allocs(b.id))[0]!.e.getTime()).toBe(at(96).getTime() + 2 * H); // lịch kéo dài theo, vẫn gồm đệm
  });

  it('gia hạn bị chặn khi đụng đơn kế tiếp và báo đúng đơn nào; không đổi gì cả', async () => {
    const s = await shop();
    const u = s.units[0]!.id;
    const a = await book(s, {}, { status: 'CONFIRMED', unitId: u, start: at(0), end: at(24) });
    const next = await book(s, {}, { status: 'CONFIRMED', unitId: u, start: at(30), end: at(54) });
    const e = await as(s.A, {}, (c) => extendBooking(c, a.id, at(40))).catch((x) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.message).toContain(next.code);
    expect(e.message).toContain(s.units[0]!.barcode);
    const d = await as(s.A, {}, (c) => getBooking(c, a.id));
    expect([d.booking.endsAt.getTime(), d.booking.total, d.booking.extendedCount]).toEqual([at(24).getTime(), 500_000, 0]);
    // gia hạn vừa đủ (đến 28h; đệm 2h hết lúc 30h) thì được
    await expect(as(s.A, {}, (c) => extendBooking(c, a.id, at(28)))).resolves.toBeDefined();
  });

  it('gia hạn: chỉ khi giờ mới muộn hơn; đơn đã trả/hủy không gia hạn được; đơn đang thuê thì được', async () => {
    const s = await shop();
    const b = await book(s, {}, { status: 'CONFIRMED' });
    await expect(as(s.A, {}, (c) => extendBooking(c, b.id, at(10)))).rejects.toThrow(/phải sau giờ kết thúc hiện tại/);
    await t.admin.query("UPDATE booking SET status='ACTIVE' WHERE id=$1", [b.id]);
    await expect(as(s.A, {}, (c) => extendBooking(c, b.id, at(48)))).resolves.toMatchObject({ delta: 500_000 });
    await t.admin.query("UPDATE booking SET status='RETURNED' WHERE id=$1", [b.id]);
    await expect(as(s.A, {}, (c) => extendBooking(c, b.id, at(72)))).rejects.toThrow(/Chỉ gia hạn được/);
  });

  it('trả sớm đơn đang thuê hoàn phần chưa dùng; chính sách "không hoàn" giữ nguyên giá', async () => {
    const s = await shop();
    const b = await book(s, {}, { status: 'CONFIRMED', start: at(0), end: at(72) }); // 3 ngày = 1.5tr
    await t.admin.query("UPDATE booking SET status='ACTIVE' WHERE id=$1", [b.id]);
    const r = await as(s.A, {}, (c) => shortenBooking(c, b.id, at(26)));
    expect(r).toEqual({ oldTotal: 1_500_000, newTotal: 700_000, delta: -800_000 }); // 26h = 1 ngày + 2 giờ
    expect((await allocs(b.id))[0]!.e.getTime()).toBe(at(26).getTime() + 2 * H);
    await expect(book(s, {}, { unitId: (await allocs(b.id))[0]!.unit_id, start: at(28), end: at(40) })).resolves.toBeDefined(); // lịch trả sớm được tái sử dụng

    const s2 = await shop();
    await as(s2.A, {}, (c) => updatePricingSettings(c, { earlyReturn: 'NO_REFUND' }));
    const b2 = await book(s2, {}, { status: 'CONFIRMED', start: at(0), end: at(72) });
    await t.admin.query("UPDATE booking SET status='ACTIVE' WHERE id=$1", [b2.id]);
    // cấu hình chỉ áp dụng cho đơn tạo sau khi đổi: giá đã chốt theo chính sách lúc đặt
    expect((await as(s2.A, {}, (c) => shortenBooking(c, b2.id, at(26)))).delta).toBe(0);
  });

  it('rút ngắn đơn chưa giao tính lại giá theo thời gian mới; từ chối giờ không hợp lệ', async () => {
    const s = await shop();
    const b = await book(s, {}, { status: 'CONFIRMED', start: at(0), end: at(72) });
    await expect(as(s.A, {}, (c) => shortenBooking(c, b.id, at(100)))).rejects.toThrow(/sớm hơn/);
    await expect(as(s.A, {}, (c) => shortenBooking(c, b.id, at(-1)))).rejects.toThrow(/sau giờ bắt đầu/);
    expect((await as(s.A, {}, (c) => shortenBooking(c, b.id, at(24)))).newTotal).toBe(500_000);
  });

  it('dời lịch: đổi cả đơn và phân bổ, giữ thời lượng; trùng thì báo; không tự va chạm với chính mình', async () => {
    const s = await shop();
    const u = s.units[0]!.id;
    const a = await book(s, {}, { status: 'CONFIRMED', unitId: u, start: at(0), end: at(24) });
    await book(s, {}, { status: 'CONFIRMED', unitId: u, start: at(100), end: at(124) });
    await as(s.A, {}, (c) => moveBooking(c, a.id, at(10))); // dời chồng lên vị trí cũ của chính nó: phải được
    const d = await as(s.A, {}, (c) => getBooking(c, a.id));
    expect([d.booking.startsAt.getTime(), d.booking.endsAt.getTime()]).toEqual([at(10).getTime(), at(34).getTime()]);
    const e = await as(s.A, {}, (c) => moveBooking(c, a.id, at(90))).catch((x) => x);
    expect(e.message).toMatch(/trùng với đơn khác/);
    expect((await as(s.A, {}, (c) => getBooking(c, a.id))).booking.startsAt.getTime()).toBe(at(10).getTime());
  });

  it('dời báo giá không đụng phân bổ; đơn đang thuê không dời được', async () => {
    const s = await shop();
    const q = await book(s, {}, { status: 'QUOTE' });
    await as(s.A, {}, (c) => moveBooking(c, q.id, at(200)));
    expect(await allocs(q.id)).toHaveLength(0);
    const b = await book(s, {}, { status: 'CONFIRMED', start: at(500), end: at(524) });
    await t.admin.query("UPDATE booking SET status='ACTIVE' WHERE id=$1", [b.id]);
    await expect(as(s.A, {}, (c) => moveBooking(c, b.id, at(600)))).rejects.toThrow(/chưa giao/);
  });

  it('đổi sang chiếc khác cùng mẫu; từ chối chiếc bận, sai mẫu, đang bảo trì', async () => {
    const s = await shop();
    const a = await book(s, {}, { status: 'CONFIRMED', unitId: s.units[0]!.id });
    await book(s, {}, { status: 'CONFIRMED', unitId: s.units[1]!.id });
    const al = (await allocs(a.id))[0]!;
    const allocId = (await t.admin.query('SELECT id FROM unit_allocation WHERE booking_id=$1', [a.id])).rows[0].id;
    await expect(as(s.A, {}, (c) => swapUnit(c, allocId, s.units[1]!.id))).rejects.toThrow(/đã được đặt/);
    const other = await as(s.A, {}, (c) => createModel(c, { name: 'Khác' }));
    const [ou] = await as(s.A, {}, (c) => createUnits(c, { modelId: other }));
    await expect(as(s.A, {}, (c) => swapUnit(c, allocId, ou!.id))).rejects.toThrow(/cùng mẫu/);
    await as(s.A, {}, (c) => transitionUnit(c, s.units[2]!.id, 'MAINTENANCE', { reason: 'x' }));
    await expect(as(s.A, {}, (c) => swapUnit(c, allocId, s.units[2]!.id))).rejects.toThrow(/không sẵn sàng/);
    expect(al.unit_id).toBe(s.units[0]!.id);
  });
});

describe('tra cứu còn trống', () => {
  it('đếm chiếc rảnh theo mẫu, tính đệm, giữ chỗ, bảo trì và hàng theo số lượng', async () => {
    const s = await shop();
    await book(s, {}, { status: 'CONFIRMED', unitId: s.units[0]!.id });
    await book(s, {}, { unitId: s.units[1]!.id });
    await as(s.A, {}, (c) => transitionUnit(c, s.units[2]!.id, 'MAINTENANCE', { reason: 'x' }));
    await book(s, {}, { model: s.cable, qty: 4 });
    const av = await as(s.A, {}, (c) => availability(c, at(2), at(10)));
    const cam = av.find((m) => m.modelId === s.cam)!;
    const cable = av.find((m) => m.modelId === s.cable)!;
    expect([cam.total, cam.free, cam.freeUnits.length]).toEqual([3, 0, 0]);
    expect([cable.total, cable.free]).toEqual([10, 6]);
    // sau khi đơn kết thúc (cả đệm 2 giờ) thì rảnh lại
    const later = await as(s.A, {}, (c) => availability(c, at(26), at(30)));
    expect(later.find((m) => m.modelId === s.cam)!.free).toBe(2); // chiếc bảo trì vẫn loại
    const mid = await as(s.A, {}, (c) => availability(c, at(25), at(30)));
    expect(mid.find((m) => m.modelId === s.cam)!.free).toBe(0); // 25h còn nằm trong đệm
    await expect(as(s.A, {}, (c) => availability(c, at(5), at(5)))).rejects.toThrow(/sau thời gian bắt đầu/);
  });

  it('giữ chỗ hết hạn không còn bị tính là bận', async () => {
    const s = await shop();
    const b = await book(s, {}, { qty: 3 });
    expect((await as(s.A, {}, (c) => availability(c, at(1), at(5)))).find((m) => m.modelId === s.cam)!.free).toBe(0);
    await t.admin.query("UPDATE booking SET hold_expires_at = now() - interval '1 second' WHERE id=$1", [b.id]);
    expect((await as(s.A, {}, (c) => availability(c, at(1), at(5)))).find((m) => m.modelId === s.cam)!.free).toBe(3);
  });
});

describe('timeline', () => {
  it('mỗi hàng một thiết bị, kèm các thanh đặt lịch trong cửa sổ', async () => {
    const s = await shop();
    const b = await book(s, {}, { status: 'CONFIRMED', unitId: s.units[0]!.id });
    await book(s, {}, { unitId: s.units[1]!.id, start: at(500), end: at(520) }); // ngoài cửa sổ
    const rows = await as(s.A, {}, (c) => timeline(c, at(-24), at(100)));
    const row = rows.find((r) => r.unitId === s.units[0]!.id)!;
    expect(row.bars).toHaveLength(1);
    expect(row.bars[0]).toMatchObject({ bookingId: b.id, status: 'CONFIRMED', customer: 'Nguyễn Văn An' });
    expect(rows.find((r) => r.unitId === s.units[1]!.id)!.bars).toHaveLength(0);
    expect(rows.every((r) => r.unitStatus !== 'RETIRED')).toBe(true);
  });

  it('cần gói có booking.timeline (gọi thẳng cũng bị chặn) và giới hạn cửa sổ 92 ngày', async () => {
    const s = await shop();
    await expect(as(s.A, { off: ['booking.timeline'] }, (c) => timeline(c, at(0), at(48)))).rejects.toThrow(FeatureDisabledError);
    await expect(as(s.A, {}, (c) => timeline(c, at(0), at(100 * 24)))).rejects.toThrow(/92 ngày/);
    await expect(as(s.A, { off: ['booking.timeline'] }, (c) => listBookings(c))).resolves.toBeDefined(); // các chức năng cơ bản vẫn dùng được
  });
});

describe('bảng hôm nay', () => {
  it('phân loại cần giao, cần nhận, quá hạn, giữ chỗ sắp hết hạn', async () => {
    const s = await shop();
    const now = new Date('2026-11-02T03:00:00Z'); // 10:00 sáng 2/11 giờ VN
    const deliver = await book(s, {}, { status: 'CONFIRMED', unitId: s.units[0]!.id, start: new Date('2026-11-02T05:00:00Z'), end: new Date('2026-11-03T05:00:00Z') });
    const late = await book(s, {}, { status: 'CONFIRMED', unitId: s.units[1]!.id, start: new Date('2026-10-30T05:00:00Z'), end: new Date('2026-11-01T05:00:00Z') });
    const receive = await book(s, {}, { status: 'CONFIRMED', unitId: s.units[2]!.id, start: new Date('2026-10-31T05:00:00Z'), end: new Date('2026-11-02T08:00:00Z') });
    const overdue = await book(s, {}, { status: 'CONFIRMED', model: s.cable, qty: 1, start: new Date('2026-10-30T05:00:00Z'), end: new Date('2026-11-01T05:00:00Z') });
    await t.admin.query("UPDATE booking SET status='ACTIVE' WHERE id = ANY($1::uuid[])", [[receive.id, overdue.id]]);
    const hold = await book(s, {}, { start: at(300), end: at(310) });
    await t.admin.query("UPDATE booking SET hold_expires_at = $2 WHERE id=$1", [hold.id, new Date(now.getTime() + 2 * H)]);
    const board = await as(s.A, {}, (c) => todayBoard(c, now));
    expect(board.toDeliver.map((r) => r.id)).toEqual([deliver.id]);
    expect(board.toReceive.map((r) => r.id)).toEqual([receive.id]);
    expect(board.overdue.map((r) => r.id)).toEqual([overdue.id]);
    expect(board.lateDelivery.map((r) => r.id)).toEqual([late.id]);
    expect(board.holdsExpiring.map((r) => r.id)).toEqual([hold.id]);
  });
});

describe('danh sách và chi tiết', () => {
  it('lọc theo trạng thái, mã, tên/SĐT khách; phân trang', async () => {
    const s = await shop();
    const other = await as(s.A, {}, (c) => createCustomer(c, { name: 'Trần Thị Bích', phone: '0912345678' }));
    for (let i = 0; i < 4; i++) await book(s, {}, { status: 'QUOTE', start: at(i * 30), end: at(i * 30 + 5) });
    await as(s.A, {}, (c) => createBooking(c, { customerId: other, lines: [{ modelId: s.cam, qty: 1 }], start: at(500), end: at(510), status: 'CONFIRMED' }));
    expect((await as(s.A, {}, (c) => listBookings(c, { status: 'QUOTE' }))).total).toBe(4);
    expect((await as(s.A, {}, (c) => listBookings(c, { q: 'bích' }))).total).toBe(1);
    expect((await as(s.A, {}, (c) => listBookings(c, { q: '0912 345' }))).total).toBe(1);
    expect((await as(s.A, {}, (c) => listBookings(c, { q: '00003' }))).rows[0]!.code).toMatch(/00003$/);
    const p = await as(s.A, {}, (c) => listBookings(c, { pageSize: 2, page: 3 }));
    expect([p.total, p.rows.length]).toEqual([5, 1]);
    await expect(as(s.A, {}, (c) => listBookings(c, { q: "'; DROP TABLE booking;--" }))).resolves.toMatchObject({ total: 0 });
  });

  it('chi tiết đơn có dòng, thiết bị được phân bổ, lịch sử và báo giá đã chốt', async () => {
    const s = await shop();
    const b = await book(s, {}, { status: 'QUOTE', qty: 2 });
    await as(s.A, {}, (c) => holdBooking(c, b.id));
    await as(s.A, {}, (c) => confirmBooking(c, b.id));
    const d = await as(s.A, {}, (c) => getBooking(c, b.id));
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatchObject({ qty: 2, modelName: 'Sony A7', lineTotal: 1_000_000 });
    expect(d.allocations).toHaveLength(2);
    expect(d.history.map((h) => h.to_status)).toEqual(['CONFIRMED', 'HOLD', 'QUOTE']);
    expect(d.booking.quote?.total).toBe(1_000_000);
    await expect(as(s.A, {}, (c) => getBooking(c, '00000000-0000-0000-0000-000000000000'))).rejects.toThrow(/Không tìm thấy/);
  });
});

describe('quyền, gói, chỉ đọc, cô lập tenant', () => {
  it('nhân viên quầy đặt và hủy được; kỹ thuật viên chỉ xem; chỉ quản lý trở lên đổi cấu hình', async () => {
    const s = await shop();
    const b = await book(s, { role: 'STAFF' });
    await expect(as(s.A, { role: 'STAFF' }, (c) => cancelBooking(c, b.id, 'Khách hủy'))).resolves.toBeUndefined();
    await expect(book(s, { role: 'TECHNICIAN' })).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, { role: 'TECHNICIAN' }, (c) => listBookings(c))).resolves.toBeDefined();
    await expect(as(s.A, { role: 'STAFF' }, (c) => updateBookingSettings(c, { holdHours: 5 }))).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, { role: 'MANAGER' }, (c) => updateBookingSettings(c, { holdHours: 5 }))).resolves.toMatchObject({ holdHours: 5 });
  });

  it('gói tắt booking, tenant chỉ đọc', async () => {
    const s = await shop();
    const b = await book(s, {});
    await expect(book(s, { off: ['booking'] })).rejects.toThrow(FeatureDisabledError);
    await expect(as(s.A, { off: ['booking'] }, (c) => listBookings(c))).rejects.toThrow(FeatureDisabledError);
    await expect(book(s, { status: 'READ_ONLY' })).rejects.toThrow(ReadOnlyError);
    await expect(as(s.A, { status: 'READ_ONLY' }, (c) => cancelBooking(c, b.id, 'x'))).rejects.toThrow(ReadOnlyError);
    await expect(as(s.A, { status: 'READ_ONLY' }, (c) => listBookings(c))).resolves.toBeDefined();
  });

  it('tenant B không thấy, không sửa, không đặt thiết bị của tenant A', async () => {
    const s = await shop();
    const B = await mkTenant(t);
    const b = await book(s, {}, { unitId: s.units[0]!.id });
    expect((await as(B, {}, (c) => listBookings(c))).total).toBe(0);
    await expect(as(B, {}, (c) => getBooking(c, b.id))).rejects.toThrow(/Không tìm thấy/);
    await expect(as(B, {}, (c) => cancelBooking(c, b.id, 'hack'))).rejects.toThrow(/Không tìm thấy/);
    await expect(as(B, {}, (c) => confirmBooking(c, b.id))).rejects.toThrow(/Không tìm thấy/);
    await expect(as(B, {}, (c) => extendBooking(c, b.id, at(99)))).rejects.toThrow(/Không tìm thấy/);
    expect((await as(B, {}, (c) => timeline(c, at(0), at(48)))).length).toBe(0);
    expect(await status(b.id)).toMatchObject({ status: 'HOLD' });
  });

  it('chặn ở tầng DB: app role không tự chèn phân bổ trùng, không sửa nhật ký trạng thái', async () => {
    const s = await shop();
    const b = await book(s, {}, { unitId: s.units[0]!.id });
    const dup = withTenantId(t.app, s.A, (db) => db.query(
      `INSERT INTO unit_allocation(tenant_id,booking_id,unit_id,period,status) VALUES ($1,$2,$3,tstzrange($4::timestamptz,$5::timestamptz,'[)'),'HOLD')`,
      [s.A, b.id, s.units[0]!.id, at(1), at(5)]));
    await expect(dup).rejects.toThrow(/unit_allocation_no_overlap/);
    await expect(withTenantId(t.app, s.A, (db) => db.query('UPDATE booking_status_log SET reason=$1', ['x']))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, s.A, (db) => db.query("UPDATE booking SET status='HOLD', hold_expires_at=NULL WHERE id=$1", [b.id]))).rejects.toThrow(/booking_hold_has_expiry/);
  });
});

describe('cấu hình đặt lịch', () => {
  it('đổi số giờ giữ chỗ và mẫu số đơn; kiểm tra giá trị', async () => {
    const s = await shop();
    expect(await as(s.A, {}, (c) => getBookingSettings(c))).toEqual({ v: 1 });
    await as(s.A, {}, (c) => updateBookingSettings(c, { holdHours: 12, codePattern: 'HD/{year}/{seq:4}' }));
    const q = await book(s, {}, { status: 'QUOTE' });
    expect(q.code).toMatch(/^HD\/\d{4}\/0001$/);
    await expect(as(s.A, {}, (c) => updateBookingSettings(c, { holdHours: 0 }))).rejects.toThrow();
    await expect(as(s.A, {}, (c) => updateBookingSettings(c, { holdHours: 1000 }))).rejects.toThrow();
    await expect(as(s.A, {}, (c) => updateBookingSettings(c, { codePattern: 'khong co seq' }))).rejects.toThrow(/seq|chữ, số/);
    await expect(as(s.A, {}, (c) => updateBookingSettings(c, { khongCo: 1 }))).rejects.toThrow();
  });
});
