import { describe, it, expect } from 'vitest';
import {
  InvalidOrderTransitionError, assertOrderTransition, evaluatePlan, findMaintenanceWindow, nextOrderStatuses, orderCost, partsCost, pendingChecklist, validateParts, validatePlanTriggers,
} from '../src';

const TZ = 'Asia/Ho_Chi_Minh';
const at = (iso: string) => new Date(iso);

describe('máy trạng thái phiếu', () => {
  it('đường đi hợp lệ: chờ → đang làm → hoàn thành / không sửa được → thanh lý', () => {
    assertOrderTransition('PENDING', 'IN_PROGRESS');
    assertOrderTransition('IN_PROGRESS', 'DONE');
    assertOrderTransition('IN_PROGRESS', 'UNREPAIRABLE');
    assertOrderTransition('UNREPAIRABLE', 'DISPOSED');
    assertOrderTransition('PENDING', 'CANCELLED');
  });
  it('chặn đi tắt, quay lại và rời trạng thái cuối, thông báo tiếng Việt', () => {
    expect(() => assertOrderTransition('PENDING', 'DONE')).toThrow(InvalidOrderTransitionError);
    expect(() => assertOrderTransition('DONE', 'IN_PROGRESS')).toThrow(/Không thể chuyển phiếu từ "Hoàn thành" sang "Đang làm"/);
    expect(() => assertOrderTransition('IN_PROGRESS', 'CANCELLED')).toThrow();
    expect(() => assertOrderTransition('UNREPAIRABLE', 'DONE')).toThrow();
    for (const s of ['DONE', 'DISPOSED', 'CANCELLED'] as const) expect(nextOrderStatuses(s)).toEqual([]);
  });
});

describe('chi phí và checklist', () => {
  it('tổng chi phí = linh kiện + công + sửa ngoài', () => {
    const parts = [{ name: 'Cảm biến', qty: 1, unitCost: 1_500_000 }, { name: 'Ốc', qty: 4, unitCost: 5_000 }];
    expect(partsCost(parts)).toBe(1_520_000);
    expect(orderCost(parts, 200_000, 100_000)).toBe(1_820_000);
    expect(orderCost([], 0)).toBe(0);
  });
  it('kiểm tra linh kiện', () => {
    expect(validateParts([{ name: 'A', qty: 1, unitCost: 0 }])).toBeNull();
    expect(validateParts([{ name: ' ', qty: 1, unitCost: 1 }])).toMatch(/Tên linh kiện/);
    expect(validateParts([{ name: 'A', qty: 0, unitCost: 1 }])).toMatch(/số lượng/);
    expect(validateParts([{ name: 'A', qty: 1.5, unitCost: 1 }])).toMatch(/số lượng/);
    expect(validateParts([{ name: 'A', qty: 1, unitCost: -1 }])).toMatch(/đơn giá/);
  });
  it('mục checklist chưa xong', () => {
    expect(pendingChecklist([{ text: 'Vệ sinh cảm biến', done: true }, { text: 'Cập nhật firmware', done: false }])).toEqual(['Cập nhật firmware']);
  });
});

describe('kế hoạch định kỳ', () => {
  it('phải có ít nhất một điều kiện hợp lệ; số giờ/lượt cần gói cho phép', () => {
    expect(validatePlanTriggers({}, true)).toMatch(/ít nhất một điều kiện/);
    expect(validatePlanTriggers({ everyDays: 0 }, true)).toMatch(/số nguyên dương/);
    expect(validatePlanTriggers({ everyDays: 30.5 }, true)).toMatch(/số nguyên dương/);
    expect(validatePlanTriggers({ everyDays: 90 }, false)).toBeNull();
    expect(validatePlanTriggers({ everyHours: 100 }, false)).toMatch(/nâng cấp gói/);
    expect(validatePlanTriggers({ everyDays: 90, everyRentals: 20 }, true)).toBeNull();
  });
  it('điều kiện nào đến trước thì kích hoạt, nêu lý do', () => {
    const t = { everyDays: 90, everyHours: 100, everyRentals: 20 };
    expect(evaluatePlan(t, { daysSince: 10, hoursUsed: 5, rentals: 1 }, true)).toMatchObject({ due: false, reasons: [] });
    expect(evaluatePlan(t, { daysSince: 91, hoursUsed: 5, rentals: 1 }, true).reasons).toEqual([expect.stringContaining('91 ngày')]);
    expect(evaluatePlan(t, { daysSince: 10, hoursUsed: 120, rentals: 1 }, true).reasons).toEqual([expect.stringContaining('120 giờ')]);
    const both = evaluatePlan(t, { daysSince: 10, hoursUsed: 5, rentals: 20 }, true);
    expect(both).toMatchObject({ due: true });
    expect(both.reasons[0]).toContain('20 lượt');
    expect(evaluatePlan(t, { daysSince: 100, hoursUsed: 200, rentals: 30 }, true).reasons).toHaveLength(3);
  });
  it('tiến độ theo từng điều kiện; gói không cho theo giờ/lượt thì bỏ qua hai điều kiện đó', () => {
    const t = { everyDays: 100, everyHours: 50 };
    expect(evaluatePlan(t, { daysSince: 50, hoursUsed: 25, rentals: 0 }, true).progress).toEqual({ days: 0.5, hours: 0.5 });
    const off = evaluatePlan(t, { daysSince: 10, hoursUsed: 999, rentals: 999 }, false);
    expect(off).toMatchObject({ due: false, progress: { days: 0.1 } });
    expect(evaluatePlan({ everyDays: 30 }, { daysSince: 30, hoursUsed: 0, rentals: 0 }, false).due).toBe(true); // đúng ngưỡng là đến hạn
  });
});

describe('tìm khung giờ bảo trì', () => {
  const busy = (s: string, e: string) => ({ start: at(s), end: at(e) });
  it('bắt đầu 08:00 giờ địa phương của ngày kế tiếp nếu hôm nay đã quá 08:00', () => {
    const w = findMaintenanceWindow({ from: at('2027-03-01T10:00:00+07:00'), durationHours: 4, busy: [], timeZone: TZ })!;
    expect(w.start.toISOString()).toBe(at('2027-03-02T08:00:00+07:00').toISOString());
    expect(w.end.toISOString()).toBe(at('2027-03-02T12:00:00+07:00').toISOString());
  });
  it('trước 08:00 thì lấy luôn 08:00 hôm nay', () => {
    expect(findMaintenanceWindow({ from: at('2027-03-01T06:00:00+07:00'), durationHours: 2, busy: [], timeZone: TZ })!.start.toISOString()).toBe(at('2027-03-01T08:00:00+07:00').toISOString());
  });
  it('bỏ qua ngày có lịch bận trùng, chọn ngày rảnh đầu tiên', () => {
    const w = findMaintenanceWindow({
      from: at('2027-03-01T10:00:00+07:00'), durationHours: 4, timeZone: TZ,
      busy: [busy('2027-03-02T09:00:00+07:00', '2027-03-02T10:00:00+07:00'), busy('2027-03-03T06:00:00+07:00', '2027-03-03T08:30:00+07:00')],
    })!;
    expect(w.start.toISOString()).toBe(at('2027-03-04T08:00:00+07:00').toISOString());
  });
  it('lịch bận kết thúc đúng lúc khung bắt đầu thì không trùng', () => {
    const w = findMaintenanceWindow({ from: at('2027-03-01T10:00:00+07:00'), durationHours: 4, timeZone: TZ, busy: [busy('2027-03-01T20:00:00+07:00', '2027-03-02T08:00:00+07:00')] })!;
    expect(w.start.toISOString()).toBe(at('2027-03-02T08:00:00+07:00').toISOString());
  });
  it('kín lịch trong số ngày tối đa thì trả null', () => {
    expect(findMaintenanceWindow({ from: at('2027-03-01T10:00:00+07:00'), durationHours: 4, timeZone: TZ, maxDays: 3, busy: [busy('2027-03-01T00:00:00+07:00', '2027-03-20T00:00:00+07:00')] })).toBeNull();
  });
  it('múi giờ khác cho giờ bắt đầu khác', () => {
    expect(findMaintenanceWindow({ from: at('2027-03-01T00:00:00Z'), durationHours: 1, busy: [], timeZone: 'UTC' })!.start.toISOString()).toBe('2027-03-01T08:00:00.000Z');
  });
});
