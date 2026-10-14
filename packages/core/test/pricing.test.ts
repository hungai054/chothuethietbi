import { describe, it, expect } from 'vitest';
import {
  quoteRental, lateFee, repriceForNewEnd, earlyReturn, applyPricingHook, cheapestCover, calendarDaysTouched, durationHours,
  DEFAULT_PRICING_CONFIG, PricingError, type PriceRule, type PricingConfig, type QuoteInput, type Quote,
} from '../src';

const H = 3_600_000;
const D = 24 * H;
// 2026-11-02 08:00 giờ Việt Nam (UTC+7) = 01:00Z
const T0 = new Date('2026-11-02T01:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * H);

const RULE: PriceRule = { hour: 100_000, day: 500_000, week: 2_500_000, month: 8_000_000, minHours: 0 };
const cfg = (over: Partial<PricingConfig> = {}): PricingConfig => ({ ...DEFAULT_PRICING_CONFIG, ...over });
const input = (hours: number, over: Partial<QuoteInput> = {}, rule: PriceRule = RULE): QuoteInput => ({
  lines: [{ modelId: 'm1', name: 'Sony A7', qty: 1, rule }], start: T0, end: at(hours), config: cfg(), ...over,
});
const parts = (q: Quote) => q.lines[0]!.parts.map((p) => `${p.count}${p.unit}`).join('+');

describe('tính giá: chọn tổ hợp rẻ nhất', () => {
  it('3 giờ = 3 x giá giờ', () => {
    const q = quoteRental(input(3));
    expect(parts(q)).toBe('3hour');
    expect(q.total).toBe(300_000);
  });
  it('1 ngày (24 giờ) = giá ngày, rẻ hơn 24 giờ lẻ', () => {
    const q = quoteRental(input(24));
    expect(parts(q)).toBe('1day');
    expect(q.total).toBe(500_000);
  });
  it('giờ lẻ vượt giá một ngày thì tính một ngày (10 giờ = 1 ngày)', () => {
    expect(parts(quoteRental(input(10)))).toBe('1day');
    expect(quoteRental(input(5)).total).toBe(500_000); // 5 giờ = đúng bằng 1 ngày, vẫn hợp lệ
    expect(quoteRental(input(4)).total).toBe(400_000);
  });
  it('25 giờ = 1 ngày + 1 giờ, rẻ hơn 2 ngày', () => {
    const q = quoteRental(input(25));
    expect(parts(q)).toBe('1day+1hour');
    expect(q.total).toBe(600_000);
  });
  it('phút lẻ làm tròn lên giờ', () => {
    expect(quoteRental({ ...input(3), end: new Date(T0.getTime() + 3 * H + 60_000) }).total).toBe(400_000);
    expect(durationHours(T0, new Date(T0.getTime() + 3 * H))).toBe(3);
  });
  it('9 ngày = 1 tuần + 2 ngày (rẻ hơn 9 ngày lẻ hoặc 2 tuần)', () => {
    const q = quoteRental(input(9 * 24));
    expect(parts(q)).toBe('1week+2day');
    expect(q.total).toBe(3_500_000);
  });
  it('6 ngày tính 1 tuần vì rẻ hơn 6 ngày lẻ', () => {
    const q = quoteRental(input(6 * 24));
    expect(parts(q)).toBe('1week');
    expect(q.total).toBe(2_500_000);
  });
  it('35 ngày = 1 tháng + 1 tuần (cùng giá với 1 tháng + 5 ngày nhưng ít đơn vị hơn)', () => {
    const q = quoteRental(input(35 * 24));
    expect(parts(q)).toBe('1month+1week');
    expect(q.total).toBe(10_500_000);
  });
  it('chỉ có giá ngày: 25 giờ làm tròn lên 2 ngày', () => {
    const q = quoteRental(input(25, {}, { hour: null, day: 500_000, week: null, month: null, minHours: 0 }));
    expect(parts(q)).toBe('2day');
    expect(q.total).toBe(1_000_000);
  });
  it('chỉ có giá giờ', () => {
    expect(quoteRental(input(30, {}, { hour: 10_000, day: null, week: null, month: null, minHours: 0 })).total).toBe(300_000);
  });
  it('số giờ tối thiểu: thuê 1 giờ vẫn tính tối thiểu 3 giờ', () => {
    expect(quoteRental(input(1, {}, { ...RULE, minHours: 3 })).total).toBe(300_000);
    expect(quoteRental(input(5, {}, { ...RULE, minHours: 3 })).total).toBe(500_000);
  });
  it('nhân theo số lượng và cộng nhiều dòng', () => {
    const q = quoteRental({
      ...input(24), lines: [
        { modelId: 'a', name: 'A', qty: 2, rule: RULE },
        { modelId: 'b', name: 'B', qty: 1, rule: { hour: null, day: 300_000, week: null, month: null, minHours: 0 } },
      ],
    });
    expect(q.lines.map((l) => l.total)).toEqual([1_000_000, 300_000]);
    expect(q.subtotal).toBe(1_300_000);
  });
});

describe('ngày thuê: mốc 24 giờ và ngày lịch', () => {
  it('qua đêm 22:00 → 08:00 hôm sau (10 giờ): mốc 24 giờ tính 1 ngày', () => {
    const start = new Date('2026-11-02T15:00:00Z'); // 22:00 VN
    const end = new Date('2026-11-03T01:00:00Z'); // 08:00 VN hôm sau
    expect(quoteRental({ ...input(10), start, end }).total).toBe(500_000);
  });
  it('qua đêm theo ngày lịch tính 2 ngày vì chạm 2 ngày lịch', () => {
    const start = new Date('2026-11-02T15:00:00Z');
    const end = new Date('2026-11-03T01:00:00Z');
    const q = quoteRental({ ...input(10), start, end, config: cfg({ dayMode: 'CALENDAR' }) });
    expect(q.calendarDays).toBe(2);
    expect(q.total).toBe(1_000_000);
  });
  it('ngày lịch: kết thúc đúng 00:00 không tính sang ngày mới; theo múi giờ của cửa hàng', () => {
    expect(calendarDaysTouched(new Date('2026-11-02T01:00:00Z'), new Date('2026-11-02T17:00:00Z'), 'Asia/Ho_Chi_Minh')).toBe(1);
    // cùng khoảng thời gian nhưng múi giờ UTC thì chạm 2 ngày
    expect(calendarDaysTouched(new Date('2026-11-02T23:00:00Z'), new Date('2026-11-03T02:00:00Z'), 'UTC')).toBe(2);
    expect(calendarDaysTouched(new Date('2026-11-02T23:00:00Z'), new Date('2026-11-03T02:00:00Z'), 'Asia/Ho_Chi_Minh')).toBe(1);
  });
  it('ngày lịch: cùng ngày thì tính giờ nhưng không vượt giá một ngày', () => {
    const c = cfg({ dayMode: 'CALENDAR' });
    expect(quoteRental({ ...input(3), config: c }).total).toBe(300_000);
    expect(quoteRental({ ...input(8), config: c }).total).toBe(500_000);
  });
  it('ngày lịch: nhiều ngày dùng tuần/tháng theo số ngày', () => {
    const q = quoteRental({ ...input(9 * 24 - 1), config: cfg({ dayMode: 'CALENDAR' }) }); // 08:00 ngày 2 → 07:00 ngày 11 = chạm 10 ngày
    expect(q.calendarDays).toBe(10);
    expect(parts(q)).toBe('1week+3day');
    expect(q.total).toBe(4_000_000);
  });
});

describe('phí trễ hạn', () => {
  const lines = [{ modelId: 'm', name: 'A', qty: 1, rule: RULE }];
  const c = cfg({ graceMinutes: 30, lateFee: { mode: 'PER_HOUR', amount: 50_000 } });
  const end = at(24);
  const late = (min: number, config = c) => lateFee({ scheduledEnd: end, returnedAt: new Date(end.getTime() + min * 60_000), lines, config });

  it('trả đúng giờ hoặc sớm: không phí', () => {
    expect(late(0).amount).toBe(0);
    expect(late(-90).amount).toBe(0);
  });
  it('trễ trong ân hạn (kể cả đúng 30 phút): không phí', () => {
    const r = late(20);
    expect(r).toMatchObject({ amount: 0, withinGrace: true, billedHours: 0 });
    expect(late(30).amount).toBe(0);
  });
  it('trễ ngoài ân hạn: tính phần trễ sau ân hạn, làm tròn lên giờ', () => {
    expect(late(31)).toMatchObject({ billedHours: 1, amount: 50_000 });
    expect(late(130)).toMatchObject({ billedHours: 2, amount: 100_000 }); // (130-30)=100 phút → 2 giờ
    expect(late(90)).toMatchObject({ billedHours: 1, amount: 50_000 }); // 60 phút đúng → 1 giờ
  });
  it('nhân theo số lượng thiết bị', () => {
    const r = lateFee({ scheduledEnd: end, returnedAt: new Date(end.getTime() + 150 * 60_000), lines: [{ ...lines[0]!, qty: 3 }], config: c });
    expect(r.amount).toBe(50_000 * 2 * 3);
  });
  it('phí theo % giá ngày: tỷ lệ theo giờ trễ', () => {
    const p = cfg({ graceMinutes: 0, lateFee: { mode: 'PERCENT_OF_DAY', percent: 150 } });
    // 12 giờ trễ x 150% x 500k / 24 = 375k
    expect(late(12 * 60, p).amount).toBe(375_000);
  });
  it('% giá ngày cần có giá ngày', () => {
    const p = cfg({ graceMinutes: 0, lateFee: { mode: 'PERCENT_OF_DAY', percent: 100 } });
    expect(() => lateFee({ scheduledEnd: end, returnedAt: at(30), lines: [{ ...lines[0]!, rule: { hour: null, day: null, week: 1_000_000, month: null, minHours: 0 } }], config: p })).toThrow(/giá theo ngày/);
  });
});

describe('gia hạn và trả sớm', () => {
  it('gia hạn 2 → 4 ngày: khách trả thêm đúng chênh lệch', () => {
    const r = repriceForNewEnd(input(48), at(96));
    expect([r.before.total, r.after.total, r.delta]).toEqual([1_000_000, 2_000_000, 1_000_000]);
  });
  it('gia hạn vượt mốc tuần được hưởng giá tuần', () => {
    const r = repriceForNewEnd(input(6 * 24), at(8 * 24)); // 6 ngày = 1 tuần (2.5M); 8 ngày = tuần + ngày (3M)
    expect(r.delta).toBe(500_000);
    expect(parts(r.after)).toBe('1week+1day');
  });
  it('trả sớm: hoàn phần chưa dùng', () => {
    const r = earlyReturn(input(72), at(26)); // thuê 3 ngày, trả sau 26 giờ → 1 ngày + 2 giờ
    expect([r.before.total, r.after.total, r.delta]).toEqual([1_500_000, 700_000, -800_000]);
  });
  it('trả sớm nhưng chính sách không hoàn tiền: giữ nguyên', () => {
    const r = earlyReturn(input(72, { config: cfg({ earlyReturn: 'NO_REFUND' }) }), at(26));
    expect(r.delta).toBe(0);
  });
  it('trả sớm không bao giờ đắt hơn giá gốc; trả muộn không dùng hàm này', () => {
    const r = earlyReturn(input(72), at(80));
    expect(r.delta).toBe(0);
    expect(() => earlyReturn(input(72), T0)).toThrow(PricingError);
  });
});

describe('giảm giá, giao nhận, VAT', () => {
  it('giảm % + phí giao nhận + VAT 10%', () => {
    const q = quoteRental(input(48, { discount: { type: 'PERCENT', value: 10 }, deliveryFee: 50_000, config: cfg({ vatEnabled: true, vatPercent: 10 }) }));
    expect(q.subtotal).toBe(1_000_000);
    expect(q.discount?.amount).toBe(100_000);
    expect(q.vatBase).toBe(950_000);
    expect(q.vat).toBe(95_000);
    expect(q.total).toBe(1_045_000);
  });
  it('VAT tắt thì không tính', () => {
    const q = quoteRental(input(48, { config: cfg({ vatEnabled: false }) }));
    expect([q.vat, q.total]).toEqual([0, 1_000_000]);
  });
  it('giảm theo số tiền không vượt quá tạm tính; phần trăm quá 100 bị từ chối', () => {
    expect(quoteRental(input(24, { discount: { type: 'AMOUNT', value: 9_999_999 } })).total).toBe(0);
    expect(() => quoteRental(input(24, { discount: { type: 'PERCENT', value: 101 } }))).toThrow(/100%/);
    expect(() => quoteRental(input(24, { discount: { type: 'AMOUNT', value: -1 } }))).toThrow();
  });
  it('làm tròn VAT ra số nguyên VND', () => {
    const q = quoteRental(input(1, { config: cfg({ vatEnabled: true, vatPercent: 8 }) }, { hour: 33_333, day: null, week: null, month: null, minHours: 0 }));
    expect(Number.isInteger(q.vat)).toBe(true);
    expect(q.total).toBe(33_333 + Math.round(33_333 * 0.08));
  });
});

describe('hook điều chỉnh giá của extension', () => {
  const base = () => quoteRental(input(48));
  const c = cfg({ vatEnabled: true, vatPercent: 10 });

  it('thêm dòng điều chỉnh có nhãn, VAT tính trên số đã điều chỉnh', () => {
    const q = applyPricingHook(quoteRental(input(48, { config: c })), (qq) => [{ label: 'Phụ thu cuối tuần +20%', amount: Math.round(qq.subtotal * 0.2), source: 'extension' }], c, { start: new Date(), end: new Date() });
    expect(q.adjustments).toEqual([{ label: 'Phụ thu cuối tuần +20%', amount: 200_000, source: 'extension' }]);
    expect(q.vatBase).toBe(1_200_000);
    expect(q.total).toBe(1_320_000);
  });
  it('cho phép điều chỉnh âm (ưu đãi)', () => {
    const q = applyPricingHook(base(), () => [{ label: 'Ưu đãi đối tác', amount: -100_000, source: 'extension' }], cfg(), { start: new Date(), end: new Date() });
    expect(q.total).toBe(900_000);
  });
  it('hook ném lỗi: bỏ qua, báo giá giữ nguyên và có cảnh báo', () => {
    const b = base();
    const q = applyPricingHook(b, () => { throw new Error('boom'); }, cfg(), { start: new Date(), end: new Date() });
    expect(q.total).toBe(b.total);
    expect(q.adjustments).toEqual([]);
    expect(q.warnings[0]).toMatch(/bỏ qua.*boom/);
  });
  it('hook trả dữ liệu sai (nhãn rỗng, số lẻ, quá lớn, không phải mảng): bỏ qua', () => {
    for (const bad of [
      [{ label: '', amount: 1, source: 'extension' }], [{ label: 'x', amount: 1.5, source: 'extension' }],
      [{ label: 'x', amount: 99_999_999, source: 'extension' }], 'oops', null,
    ]) {
      const q = applyPricingHook(base(), (() => bad) as never, cfg(), { start: new Date(), end: new Date() });
      expect(q.total).toBe(1_000_000);
      expect(q.warnings.length).toBe(1);
    }
  });
  it('hook không sửa được các dòng gốc (nhận bản sao)', () => {
    const b = base();
    const q = applyPricingHook(b, (qq) => { qq.lines[0]!.total = 1; qq.subtotal = 1; return []; }, cfg(), { start: new Date(), end: new Date() });
    expect(q.lines[0]!.total).toBe(1_000_000);
    expect(q.total).toBe(1_000_000);
  });
  it('không có hook: trả nguyên báo giá', () => {
    const b = base();
    expect(applyPricingHook(b, undefined, cfg(), { start: new Date(), end: new Date() })).toBe(b);
  });
});

describe('kiểm tra đầu vào', () => {
  it('thời gian không hợp lệ', () => {
    expect(() => quoteRental(input(0))).toThrow(/sau thời gian bắt đầu/);
    expect(() => quoteRental({ ...input(5), end: at(-1) })).toThrow(PricingError);
    expect(() => quoteRental(input(367 * 24))).toThrow(/366 ngày/);
  });
  it('bảng giá và số lượng không hợp lệ', () => {
    expect(() => quoteRental(input(5, {}, { hour: null, day: null, week: null, month: null, minHours: 0 }))).toThrow(/ít nhất một mức giá/);
    expect(() => quoteRental(input(5, {}, { ...RULE, day: -1 }))).toThrow(/số nguyên không âm/);
    expect(() => quoteRental(input(5, {}, { ...RULE, day: 1.5 }))).toThrow();
    expect(() => quoteRental({ ...input(5), lines: [{ modelId: 'x', name: 'X', qty: 0, rule: RULE }] })).toThrow(/số lượng/);
    expect(() => quoteRental({ ...input(5), lines: [] })).toThrow(/ít nhất một thiết bị/);
  });
});

describe('tính chất của động cơ (kiểm tra ngẫu nhiên có hạt giống cố định)', () => {
  // PRNG xác định để test lặp lại được
  let seed = 12345;
  const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };

  it('không bao giờ đắt hơn cách tính đơn giản; không giảm khi thời lượng tăng; luôn là số nguyên', () => {
    for (let t = 0; t < 40; t++) {
      const hour = (1 + rnd(50)) * 10_000;
      const day = hour * (3 + rnd(20));
      const week = day * (3 + rnd(4));
      const month = week * (3 + rnd(2));
      const rule: PriceRule = { hour, day, week, month, minHours: 0 };
      let prev = 0;
      for (let h = 1; h <= 900; h += 1 + rnd(7)) {
        const { cost, parts: ps } = cheapestCover(h, rule, { hour: 1, day: 24, week: 168, month: 720 });
        expect(cost).toBeLessThanOrEqual(h * hour);
        expect(cost).toBeLessThanOrEqual(Math.ceil(h / 24) * day);
        expect(cost).toBeLessThanOrEqual(Math.ceil(h / 168) * week);
        expect(cost).toBeLessThanOrEqual(Math.ceil(h / 720) * month);
        expect(cost).toBeGreaterThanOrEqual(prev);
        expect(Number.isInteger(cost)).toBe(true);
        const covered = ps.reduce((a, p) => a + p.count * { hour: 1, day: 24, week: 168, month: 720 }[p.unit], 0);
        expect(covered).toBeGreaterThanOrEqual(h);
        prev = cost;
      }
    }
  });
});
