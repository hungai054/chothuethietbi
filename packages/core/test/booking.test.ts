import { describe, it, expect } from 'vitest';
import {
  BOOKING_STATUSES, assertBookingTransition, canBookingTransition, canExtend, canReschedule, nextBookingStatuses, InvalidBookingTransitionError, HOLDS_INVENTORY,
  earliestStartWithCapacity, occupiedRange, overlaps, toPgRange, findFreeWindow, quantityFree, holdExpiry, isHoldExpired, conflictMessage, AvailabilityError, type Range,
  formatDocNumber, validateDocPattern, DEFAULT_BOOKING_PATTERN, upgradeBookingSettings,
} from '../src';

const H = 3_600_000;
const T = new Date('2026-11-02T01:00:00Z').getTime();
const at = (h: number) => new Date(T + h * H);
const r = (a: number, b: number): Range => ({ start: at(a), end: at(b) });

describe('trạng thái đơn thuê', () => {
  it('luồng chuẩn hợp lệ', () => {
    const path = ['QUOTE', 'HOLD', 'CONFIRMED', 'ACTIVE', 'RETURNED', 'CLOSED'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canBookingTransition(path[i]!, path[i + 1]!)).toBe(true);
  });
  it('báo giá có thể xác nhận thẳng hoặc hủy; hủy được khi chưa giao', () => {
    expect(canBookingTransition('QUOTE', 'CONFIRMED')).toBe(true);
    for (const s of ['QUOTE', 'HOLD', 'CONFIRMED'] as const) expect(canBookingTransition(s, 'CANCELLED')).toBe(true);
  });
  it('đã giao thì không hủy được; đã đóng/hủy là điểm cuối; không đi lùi', () => {
    expect(canBookingTransition('ACTIVE', 'CANCELLED')).toBe(false);
    expect(canBookingTransition('RETURNED', 'ACTIVE')).toBe(false);
    expect(nextBookingStatuses('CLOSED')).toEqual([]);
    expect(nextBookingStatuses('CANCELLED')).toEqual([]);
    expect(() => assertBookingTransition('HOLD', 'ACTIVE')).toThrow(InvalidBookingTransitionError);
    expect(() => assertBookingTransition('HOLD', 'ACTIVE')).toThrow(/Giữ chỗ.*Đang thuê/);
  });
  it('trạng thái nào chiếm lịch thiết bị', () => {
    expect([...BOOKING_STATUSES].filter((s) => HOLDS_INVENTORY.has(s))).toEqual(['HOLD', 'CONFIRMED', 'ACTIVE']);
  });
  it('quy tắc đổi lịch và gia hạn', () => {
    expect(canReschedule('CONFIRMED')).toBe(true);
    expect(canReschedule('ACTIVE')).toBe(false);
    expect(canExtend('ACTIVE')).toBe(true);
    expect(canExtend('RETURNED')).toBe(false);
    expect(canExtend('CANCELLED')).toBe(false);
  });
});

describe('khoảng chiếm dụng và đệm', () => {
  it('đệm cộng vào sau giờ trả', () => {
    const o = occupiedRange(at(0), at(24), 120);
    expect(o.end.getTime() - at(24).getTime()).toBe(2 * H);
    expect(o.start).toEqual(at(0));
  });
  it('từ chối thời gian sai và đệm sai', () => {
    expect(() => occupiedRange(at(5), at(5), 0)).toThrow(AvailabilityError);
    expect(() => occupiedRange(at(5), at(1), 0)).toThrow(/sau thời gian bắt đầu/);
    expect(() => occupiedRange(at(0), at(5), -1)).toThrow(/đệm/);
    expect(() => occupiedRange(at(0), at(5), 1.5)).toThrow();
  });
  it('khoảng nửa mở: liền kề không trùng, chồng dù 1 phút thì trùng', () => {
    expect(overlaps(r(0, 10), r(10, 20))).toBe(false);
    expect(overlaps(r(10, 20), r(0, 10))).toBe(false);
    expect(overlaps(r(0, 10), { start: new Date(at(10).getTime() - 60_000), end: at(20) })).toBe(true);
    expect(overlaps(r(0, 10), r(2, 4))).toBe(true);
    expect(overlaps(r(2, 4), r(0, 10))).toBe(true);
    expect(overlaps(r(0, 5), r(6, 8))).toBe(false);
  });
  it('đệm khiến hai đơn sát nhau bị trùng', () => {
    const a = occupiedRange(at(0), at(24), 120); // trả 24h, đệm đến 26h
    const b = occupiedRange(at(25), at(48), 120); // nhận lúc 25h: nằm trong đệm
    const c = occupiedRange(at(26), at(48), 120); // nhận đúng lúc hết đệm
    expect(overlaps(a, b)).toBe(true);
    expect(overlaps(a, c)).toBe(false);
  });
  it('chuỗi tstzrange nửa mở cho Postgres', () => {
    expect(toPgRange(r(0, 1))).toBe('[2026-11-02T01:00:00.000Z,2026-11-02T02:00:00.000Z)');
  });
});

describe('khung trống gần nhất', () => {
  it('trống ngay nếu không có gì bận', () => {
    expect(findFreeWindow([], at(5), 10 * H)).toEqual(at(5));
  });
  it('nhảy qua khoảng bận chồng lên điểm bắt đầu', () => {
    expect(findFreeWindow([r(0, 30)], at(5), 10 * H)).toEqual(at(30));
  });
  it('dùng khe trống nếu đủ dài, bỏ qua khe quá ngắn', () => {
    const busy = [r(0, 10), r(15, 40), r(100, 120)];
    expect(findFreeWindow(busy, at(0), 4 * H)).toEqual(at(10)); // khe 10→15 dài 5h đủ cho 4h
    expect(findFreeWindow(busy, at(0), 6 * H)).toEqual(at(40)); // khe 5h không đủ 6h; khe 40→100 đủ
    expect(findFreeWindow(busy, at(0), 70 * H)).toEqual(at(120)); // không khe nào đủ 70h trước 120
  });
  it('tính cả đệm vào độ dài cần', () => {
    expect(findFreeWindow([r(0, 10), r(14, 40)], at(0), 3 * H, 2 * H)).toEqual(at(40)); // khe 4h không đủ 3h + 2h đệm
    expect(findFreeWindow([r(0, 10), r(15, 40)], at(0), 3 * H, 2 * H)).toEqual(at(10)); // khe 5h vừa đủ
  });
  it('không phụ thuộc thứ tự đầu vào; khoảng bận kết thúc trước mốc bắt đầu bị bỏ qua', () => {
    expect(findFreeWindow([r(15, 40), r(0, 10)], at(12), 2 * H)).toEqual(at(12));
    expect(findFreeWindow([r(0, 10)], at(20), 5 * H)).toEqual(at(20));
  });
});

describe('hàng quản lý theo số lượng', () => {
  const stock = 10;
  it('không có đơn nào: còn đủ tồn kho', () => {
    expect(quantityFree(stock, [], r(0, 10))).toBe(10);
  });
  it('đơn trùng thời gian trừ số lượng; đơn không trùng thì không', () => {
    const b = [{ range: r(0, 10), qty: 4 }, { range: r(20, 30), qty: 5 }];
    expect(quantityFree(stock, b, r(5, 8))).toBe(6);
    expect(quantityFree(stock, b, r(10, 20))).toBe(10);
  });
  it('tính đỉnh đồng thời, không cộng các đơn nối tiếp nhau', () => {
    const b = [{ range: r(0, 10), qty: 6 }, { range: r(10, 20), qty: 6 }]; // nối tiếp, không bao giờ cùng lúc
    expect(quantityFree(stock, b, r(0, 20))).toBe(4); // đỉnh = 6
  });
  it('các đơn chồng nhau cộng dồn tại thời điểm giao nhau, lấy đỉnh', () => {
    const b = [{ range: r(0, 10), qty: 4 }, { range: r(5, 15), qty: 3 }, { range: r(12, 20), qty: 6 }];
    // 5–10: 4+3 = 7;  12–15: 3+6 = 9  → đỉnh 9
    expect(quantityFree(stock, b, r(0, 20))).toBe(1);
    expect(quantityFree(stock, b, r(0, 4))).toBe(6); // chỉ đơn đầu (4)
    expect(quantityFree(stock, b, r(16, 20))).toBe(4); // chỉ đơn cuối (6)
  });
  it('không bao giờ trả số âm', () => {
    expect(quantityFree(5, [{ range: r(0, 10), qty: 9 }], r(0, 10))).toBe(0);
  });
});

describe('giữ chỗ', () => {
  it('hết hạn sau số giờ cấu hình', () => {
    const now = new Date('2026-11-02T00:00:00Z');
    expect(holdExpiry(now, 24).toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(() => holdExpiry(now, 0)).toThrow(AvailabilityError);
    expect(() => holdExpiry(now, 24 * 31)).toThrow();
  });
  it('kiểm tra hết hạn tại đúng thời điểm', () => {
    const exp = new Date('2026-11-03T00:00:00Z');
    expect(isHoldExpired(exp, new Date('2026-11-02T23:59:59Z'))).toBe(false);
    expect(isHoldExpired(exp, exp)).toBe(true);
    expect(isHoldExpired(null, exp)).toBe(false);
  });
});

describe('thông báo trùng lịch', () => {
  const fmt = (d: Date) => d.toISOString().slice(0, 16);
  it('gợi ý chiếc khác và khung trống gần nhất', () => {
    const m = conflictMessage({ freeUnitCodes: ['CAM-000002', 'CAM-000003'], nextStart: at(30), fmt });
    expect(m).toContain('đã được đặt');
    expect(m).toContain('CAM-000002, CAM-000003');
    expect(m).toContain('2026-11-03T07:00');
  });
  it('rút gọn khi nhiều gợi ý, bỏ phần không có', () => {
    const m = conflictMessage({ freeUnitCodes: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], nextStart: null, fmt });
    expect(m).toContain('A, B, C, D, E…');
    expect(m).not.toContain('Khung trống');
    expect(conflictMessage({ freeUnitCodes: [], nextStart: null, fmt })).not.toContain('Còn rảnh');
  });
});

describe('số đơn thuê', () => {
  it('định dạng theo mẫu mặc định', () => {
    expect(formatDocNumber(DEFAULT_BOOKING_PATTERN, 2026, 1)).toBe('DT-2026-00001');
    expect(formatDocNumber(DEFAULT_BOOKING_PATTERN, 2027, 123456)).toBe('DT-2027-123456');
    expect(formatDocNumber('HD/{year}/{seq:3}', 2026, 7)).toBe('HD/2026/007');
  });
  it('kiểm tra mẫu', () => {
    expect(validateDocPattern(DEFAULT_BOOKING_PATTERN)).toBeNull();
    expect(validateDocPattern('DT-{year}')).toMatch(/seq/);
    expect(validateDocPattern('DT-{foo}-{seq:4}')).toMatch(/chỉ dùng/);
    expect(validateDocPattern('DT {seq:4}')).toMatch(/chữ, số/);
    expect(validateDocPattern('X'.repeat(40) + '{seq:4}')).toMatch(/30 ký tự/);
  });
});

describe('cấu hình đặt lịch', () => {
  it('rỗng thì dùng mặc định; giá trị sai bị bỏ', () => {
    expect(upgradeBookingSettings(undefined)).toEqual({ v: 1 });
    expect(upgradeBookingSettings({ holdHours: 48 })).toMatchObject({ holdHours: 48 });
    expect(upgradeBookingSettings({ holdHours: -3 })).toEqual({ v: 1 });
    expect(upgradeBookingSettings({ khongCo: 1 })).toEqual({ v: 1 });
  });
});

describe('thời điểm sớm nhất có đủ số chiếc', () => {
  const units = [[r(0, 30)], [r(0, 10), r(20, 40)], []]; // chiếc 3 luôn rảnh
  it('đủ ngay từ đầu nếu chiếc rảnh tồn tại', () => {
    expect(earliestStartWithCapacity(units, at(5), 4 * H, 0, 1)).toEqual(at(5));
  });
  it('cần 2 chiếc: chờ đến khi chiếc thứ hai rảnh đủ dài', () => {
    // t=10: chiếc 2 rảnh nhưng bận lại từ 20 (chỉ 10h) → với 4h là đủ; chiếc 1 bận đến 30
    expect(earliestStartWithCapacity(units, at(5), 4 * H, 0, 2)).toEqual(at(10));
    // cần 15h thì chiếc 2 (10→20 chỉ 10h) không đủ → phải đợi chiếc 1 rảnh lúc 30
    expect(earliestStartWithCapacity(units, at(5), 15 * H, 0, 2)).toEqual(at(30));
  });
  it('cần cả 3 chiếc', () => {
    expect(earliestStartWithCapacity(units, at(0), 5 * H, 0, 3)).toEqual(at(40));
  });
  it('tính cả đệm; không đủ chiếc thì null', () => {
    expect(earliestStartWithCapacity([[r(0, 10)], [r(0, 10)]], at(0), 2 * H, 0, 2)).toEqual(at(10));
    expect(earliestStartWithCapacity(units, at(0), 2 * H, 0, 4)).toBeNull();
    expect(earliestStartWithCapacity(units, at(0), 2 * H, 0, 0)).toBeNull();
  });
});
