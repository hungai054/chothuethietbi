import { describe, expect, it } from 'vitest';
import {
  CouponError, addCycle, applyCoupon, assertCouponUsable, dueRenewalReminder, mrrOf, newPayCode, planPrice, prorateChange, statusForPhase, subscriptionPhase,
} from '../src';

const d = (s: string) => new Date(s);

describe('chu kỳ thuê bao', () => {
  it('cộng tháng theo lịch, ngày 31 không tràn sang tháng sau', () => {
    expect(addCycle(d('2027-01-31T00:00:00Z'), 'MONTH').toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(addCycle(d('2028-01-31T00:00:00Z'), 'MONTH').toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(addCycle(d('2027-03-15T10:00:00Z'), 'MONTH').toISOString()).toBe('2027-04-15T10:00:00.000Z');
  });
  it('cộng năm, kể cả 29/2', () => {
    expect(addCycle(d('2028-02-29T00:00:00Z'), 'YEAR').toISOString()).toBe('2029-02-28T00:00:00.000Z');
    expect(addCycle(d('2027-11-30T00:00:00Z'), 'MONTH', 3).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });
  it('giá theo chu kỳ và MRR', () => {
    const p = { price_month: 799_000, price_year: 7_990_000 };
    expect(planPrice(p, 'YEAR')).toBe(7_990_000);
    expect(mrrOf(7_990_000, 'YEAR')).toBe(665_833);
    expect(mrrOf(799_000, 'MONTH')).toBe(799_000);
  });
});

describe('mã giảm giá', () => {
  it('giảm theo % và theo số tiền, không âm', () => {
    expect(applyCoupon(1_000_000, { percentOff: 20 })).toEqual({ discount: 200_000, total: 800_000 });
    expect(applyCoupon(100_000, { amountOff: 500_000 })).toEqual({ discount: 100_000, total: 0 });
    expect(applyCoupon(100_000, null)).toEqual({ discount: 0, total: 100_000 });
  });
  it('từ chối mã hết hạn, hết lượt, tắt, sai gói', () => {
    const base = { code: 'X', active: true, redeemed: 0 };
    const now = d('2027-01-01T00:00:00Z');
    expect(() => assertCouponUsable({ ...base, active: false }, 'pro', now)).toThrow(CouponError);
    expect(() => assertCouponUsable({ ...base, validUntil: d('2026-12-31T00:00:00Z') }, 'pro', now)).toThrow('hết hạn');
    expect(() => assertCouponUsable({ ...base, maxRedemptions: 2, redeemed: 2 }, 'pro', now)).toThrow('hết lượt');
    expect(() => assertCouponUsable({ ...base, planCodes: ['basic'] }, 'pro', now)).toThrow('không áp dụng');
    expect(() => assertCouponUsable({ ...base, planCodes: ['pro'] }, 'pro', now)).not.toThrow();
  });
});

describe('đổi gói giữa kỳ', () => {
  const periodStart = d('2027-01-01T00:00:00Z');
  const periodEnd = d('2027-01-31T00:00:00Z'); // 30 ngày
  it('nâng cấp: trả chênh lệch theo ngày còn lại', () => {
    const p = prorateChange({ oldPrice: 300_000, newPrice: 900_000, periodStart, periodEnd, now: d('2027-01-16T00:00:00Z') });
    expect(p.totalDays).toBe(30);
    expect(p.daysLeft).toBe(15);
    expect(p.credit).toBe(150_000);
    expect(p.cost).toBe(450_000);
    expect(p.amountDue).toBe(300_000);
    expect(p.creditLeft).toBe(0);
  });
  it('hạ gói: không phải trả thêm, còn dư', () => {
    const p = prorateChange({ oldPrice: 900_000, newPrice: 300_000, periodStart, periodEnd, now: d('2027-01-16T00:00:00Z') });
    expect(p.amountDue).toBe(0);
    expect(p.creditLeft).toBe(300_000);
  });
  it('hết kỳ thì không tính gì; ngày chưa bắt đầu không vượt quá kỳ', () => {
    expect(prorateChange({ oldPrice: 1, newPrice: 100_000, periodStart, periodEnd, now: d('2027-02-05T00:00:00Z') }).amountDue).toBe(0);
    expect(prorateChange({ oldPrice: 0, newPrice: 300_000, periodStart, periodEnd, now: d('2026-12-01T00:00:00Z') }).amountDue).toBe(300_000);
  });
});

describe('giai đoạn hết hạn', () => {
  const ends = d('2027-03-01T00:00:00Z');
  const cfg = { graceDays: 3, lockDays: 30 };
  it('còn hạn, ân hạn, chỉ đọc, khóa', () => {
    expect(subscriptionPhase(d('2027-02-28T00:00:00Z'), ends, cfg).phase).toBe('ACTIVE');
    expect(subscriptionPhase(d('2027-03-02T00:00:00Z'), ends, cfg).phase).toBe('GRACE');
    expect(subscriptionPhase(d('2027-03-10T00:00:00Z'), ends, cfg).phase).toBe('READ_ONLY');
    expect(subscriptionPhase(d('2027-04-20T00:00:00Z'), ends, cfg).phase).toBe('SUSPENDED');
  });
  it('không hạn (hợp đồng ký ngoài) luôn hoạt động', () => {
    expect(subscriptionPhase(d('2099-01-01T00:00:00Z'), null).phase).toBe('ACTIVE');
  });
  it('ép trạng thái tenant chỉ ở chỉ đọc/khóa', () => {
    expect(statusForPhase('ACTIVE')).toBeNull();
    expect(statusForPhase('GRACE')).toBeNull();
    expect(statusForPhase('READ_ONLY')).toBe('READ_ONLY');
    expect(statusForPhase('SUSPENDED')).toBe('SUSPENDED');
  });
});

describe('nhắc gia hạn', () => {
  const ends = d('2027-03-10T00:00:00Z');
  it('mốc 7 ngày, 1 ngày, đã hết hạn; không gửi lại mốc đã gửi', () => {
    expect(dueRenewalReminder(d('2027-03-01T00:00:00Z'), ends, [])).toBeNull();
    expect(dueRenewalReminder(d('2027-03-03T00:00:00Z'), ends, [])).toBe(7);
    expect(dueRenewalReminder(d('2027-03-03T00:00:00Z'), ends, [7])).toBeNull();
    expect(dueRenewalReminder(d('2027-03-09T12:00:00Z'), ends, [7])).toBe(1);
    expect(dueRenewalReminder(d('2027-03-11T00:00:00Z'), ends, [7, 1])).toBe(0);
  });
  it('treo lâu chỉ phát mốc mới nhất', () => {
    expect(dueRenewalReminder(d('2027-03-12T00:00:00Z'), ends, [])).toBe(0);
  });
  it('không hạn thì không nhắc', () => {
    expect(dueRenewalReminder(d('2027-03-12T00:00:00Z'), null, [])).toBeNull();
  });
});

describe('mã chuyển khoản', () => {
  it('bắt đầu bằng RP, 10 ký tự, không ký tự dễ nhầm', () => {
    const c = newPayCode((n) => Uint8Array.from({ length: n }, (_, i) => i * 37));
    expect(c).toMatch(/^RP[A-HJ-NP-Z2-9]{8}$/);
  });
});
